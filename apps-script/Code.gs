const CS_SHEETS = Object.freeze({
  OVERVIEW: '00_OVERVIEW',
  CASES: '01_CASES',
  MESSAGES: '02_MESSAGES',
  DRAFTS: '03_AI_DRAFTS',
  RUNS: '04_SYNC_RUNS',
  RULES: '05_RULES',
  ANSWERS: '06_ANSWER_LIBRARY',
  CONFIG: '99_CONFIG',
});

const CS_WRITE_POLICY = 'MASKED_SYNC_AND_DRAFT_REVIEW_ONLY';
const CS_ALLOWED_DRAFT_STATES = Object.freeze(['APPROVED', 'REJECTED', 'USED']);
const CS_MAX_SYNC_RECORDS = 2000;
const CS_D1_DEVELOPMENT_API_URL = 'https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs';
const CS_D1_RELAY_ACTIONS = Object.freeze(['reviewDraft', 'upsertTemplate', 'setTemplateState', 'reviewLibraryEntry']);
const CS_D1_RELAY_FIELDS = Object.freeze({
  reviewDraft: Object.freeze([
    'draft_state', 'review_note', 'human_revision', 'purpose',
    'composition_source_type', 'composition_source_id', 'composition_source_version',
    'base_text_hash', 'final_text_hash', 'unresolved_variables', 'source_content_hash',
    'environment', 'auto_send', 'marketplace_write_actions',
  ]),
  upsertTemplate: Object.freeze([
    'template_key', 'template_version', 'template_name', 'template_text',
    'market', 'channel', 'intent', 'required_checks', 'quality_state',
    'environment', 'auto_send', 'marketplace_write_actions',
  ]),
  setTemplateState: Object.freeze(['quality_state', 'environment', 'auto_send', 'marketplace_write_actions']),
  reviewLibraryEntry: Object.freeze(['quality_state', 'review_note', 'environment', 'auto_send', 'marketplace_write_actions']),
});
const CS_RECONCILIATION_COLUMNS = Object.freeze([
  'last_status_verified_at',
  'status_missing_count',
  'status_source',
  'completion_reason',
]);
const CS_LINK_COLUMNS = Object.freeze([
  'source_url_kind',
  'source_reference',
  'product_url',
  'product_thumbnail_url',
  'image_count',
]);

function isTruthy_(value) {
  return value === true || value === 1 || /^(?:1|true|yes|y)$/i.test(String(value || ''));
}

function doGet(e) {
  try {
    const request = normalizeRequest_(e);
    authorize_(request);
    assertRequestEnvironment_(request);
    const action = String(request.action || 'health');
    return json_(dispatchRead_(action, request));
  } catch (error) {
    return errorJson_(error);
  }
}

function doPost(e) {
  try {
    const request = normalizeRequest_(e);
    authorize_(request);
    assertRequestEnvironment_(request);
    const action = String(request.action || '');

    if (['health', 'overview', 'dashboard', 'cases', 'case', 'caseBatch', 'caseIndex', 'answerLibrary'].indexOf(action) !== -1) {
      return json_(dispatchRead_(action, request));
    }

    assertWriteKeyConfigured_();

    if (CS_D1_RELAY_ACTIONS.indexOf(action) !== -1 && isD1RelayConfigured_()) {
      return json_(relayD1Write_(action, request));
    }

    if (action === 'syncRun') {
      return json_(withDocumentLock_(function () {
        return syncRun_(request);
      }));
    }

    if (action === 'reviewDraft') {
      return json_(withDocumentLock_(function () {
        return reviewDraft_(request);
      }));
    }

    if (CS_D1_RELAY_ACTIONS.indexOf(action) !== -1) {
      throw new Error('CS_D1_RELAY_NOT_CONFIGURED');
    }

    return json_({
      ok: false,
      error: 'WRITE_NOT_ALLOWED',
      write_policy: CS_WRITE_POLICY,
    });
  } catch (error) {
    return errorJson_(error);
  }
}

function dispatchRead_(action, request) {
  if (action === 'health') return health_();
  if (action === 'overview') return overview_();
  if (action === 'dashboard') return dashboard_(request);
  if (action === 'cases') return listCases_(request);
  if (action === 'case') return getCase_(request.case_key, request.fresh);
  if (action === 'caseBatch') return getCaseBatch_(request.case_keys, request.fresh);
  if (action === 'caseIndex') return caseIndex_();
  if (action === 'answerLibrary') return searchVerifiedAnswers_(request);
  throw new Error('UNKNOWN_ACTION');
}

function health_() {
  getSpreadsheet_();
  return {
    ok: true,
    service: 'pink-rocket-cs-review-api',
    schema_version: 'cs-sheet-v1',
    write_policy: CS_WRITE_POLICY,
    write_key_configured: Boolean(PropertiesService.getScriptProperties().getProperty('CS_API_KEY')),
    d1_relay_configured: isD1RelayConfigured_(),
    auto_send: false,
    now: new Date().toISOString(),
  };
}

function isD1RelayConfigured_() {
  return Boolean(PropertiesService.getScriptProperties().getProperty('CS_D1_SYNC_KEY'));
}

function relayD1Write_(action, request) {
  if (currentEnvironment_() !== 'development') throw new Error('D1_RELAY_DEVELOPMENT_ONLY');
  const syncKey = String(PropertiesService.getScriptProperties().getProperty('CS_D1_SYNC_KEY') || '');
  if (!syncKey) throw new Error('CS_D1_RELAY_NOT_CONFIGURED');
  if (String(request.environment || '') !== 'development'
    || request.auto_send !== false
    || Number(request.marketplace_write_actions || 0) !== 0) {
    throw new Error('DEVELOPMENT_SAFETY_REQUIRED');
  }

  const target = d1RelayTarget_(action, request);
  const allowedFields = CS_D1_RELAY_FIELDS[action];
  const body = {};
  allowedFields.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(request, field)) body[field] = request[field];
  });
  assertD1RelayPayload_(body);

  const response = UrlFetchApp.fetch(target.url, {
    method: target.method,
    contentType: 'application/json',
    headers: {
      Accept: 'application/json',
      'X-CS-Sync-Key': syncKey,
    },
    payload: JSON.stringify(body),
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = Number(response.getResponseCode());
  let payload;
  try {
    payload = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('CS_D1_RELAY_RESPONSE_INVALID');
  }
  if (status < 200 || status >= 300 || !payload || payload.ok === false) {
    const code = payload && payload.error ? String(payload.error).slice(0, 100) : 'HTTP_' + status;
    throw new Error('CS_D1_RELAY_FAILED:' + code);
  }
  if (payload.environment !== 'development'
    || payload.auto_send !== false
    || Number(payload.marketplace_write_actions || 0) !== 0) {
    throw new Error('UNSAFE_D1_RELAY_RESPONSE');
  }
  return payload;
}

function d1RelayTarget_(action, request) {
  if (action === 'reviewDraft') {
    const draftId = relayId_(request.draft_id, 'INVALID_DRAFT_ID');
    return { method: 'patch', url: CS_D1_DEVELOPMENT_API_URL + '/drafts/' + encodeURIComponent(draftId) + '/review' };
  }
  if (action === 'upsertTemplate') {
    return { method: 'post', url: CS_D1_DEVELOPMENT_API_URL + '/templates' };
  }
  if (action === 'setTemplateState') {
    const templateId = relayId_(request.template_id, 'INVALID_TEMPLATE_ID');
    return { method: 'patch', url: CS_D1_DEVELOPMENT_API_URL + '/templates/' + encodeURIComponent(templateId) };
  }
  if (action === 'reviewLibraryEntry') {
    const libraryEntryId = relayId_(request.library_entry_id, 'INVALID_LIBRARY_ENTRY_ID');
    return { method: 'patch', url: CS_D1_DEVELOPMENT_API_URL + '/library/' + encodeURIComponent(libraryEntryId) };
  }
  throw new Error('WRITE_NOT_ALLOWED');
}

function relayId_(value, errorCode) {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9:_-]{1,300}$/.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function assertD1RelayPayload_(value) {
  const serialized = JSON.stringify(value || {});
  if (serialized.length > 100000) throw new Error('CS_D1_RELAY_PAYLOAD_TOO_LARGE');
  if (/(?:^|[^0-9])01[016789][-. ]?\d{3,4}[-. ]?\d{4}(?:[^0-9]|$)/.test(serialized)) throw new Error('UNMASKED_PHONE');
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)) throw new Error('UNMASKED_EMAIL');
  if (/\b\d{12,}\b/.test(serialized)) throw new Error('UNMASKED_LONG_NUMBER');
}

function syncRun_(request) {
  const report = request.report;
  if (!report || Number(report.schema_version) !== 1) throw new Error('INVALID_REPORT_SCHEMA');
  const records = Array.isArray(report.records) ? report.records : [];
  if (records.length > CS_MAX_SYNC_RECORDS) throw new Error('SYNC_BATCH_TOO_LARGE');
  if (Number(report.summary && report.summary.marketplace_write_actions || 0) !== 0) {
    throw new Error('MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED');
  }

  const runId = String(request.run_id || makeRunId_(report));
  const spreadsheet = getSpreadsheet_();
  const casesSheet = requiredSheet_(spreadsheet, CS_SHEETS.CASES);
  const messagesSheet = requiredSheet_(spreadsheet, CS_SHEETS.MESSAGES);
  const draftsSheet = requiredSheet_(spreadsheet, CS_SHEETS.DRAFTS);
  const runsSheet = requiredSheet_(spreadsheet, CS_SHEETS.RUNS);
  ensureColumns_(casesSheet, CS_RECONCILIATION_COLUMNS.concat(CS_LINK_COLUMNS));
  const casesTable = readTable_(casesSheet);
  const messagesTable = readTable_(messagesSheet);
  const draftsTable = readTable_(draftsSheet);
  const runsTable = readTable_(runsSheet);

  const runPrefix = runId + ':';
  const existingRun = runsTable.rows.some(function (row) {
    return String(row.values[runsTable.headerMap.run_id] || '').indexOf(runPrefix) === 0;
  });
  if (existingRun) {
    return {
      ok: true,
      run_id: runId,
      duplicate_run: true,
      inserted_cases: 0,
      updated_cases: 0,
      inserted_messages: 0,
      inserted_drafts: 0,
      marketplace_write_actions: 0,
      auto_send: false,
    };
  }

  const keys = {};
  records.forEach(function (record) {
    assertMaskedRecord_(record);
    const key = String(record.source_key || '');
    if (keys[key]) throw new Error('DUPLICATE_SOURCE_KEY:' + key);
    keys[key] = true;
  });

  const caseRowsByKey = objectRowsBy_(casesTable, 'case_key');
  const messageIds = objectKeys_(messagesTable, 'message_key');
  const draftIds = objectKeys_(draftsTable, 'draft_id');
  const existingDrafts = objectsFromTable_(draftsTable);
  const now = new Date();
  const caseUpdates = [];
  const caseAppends = [];
  const messageAppends = [];
  const draftAppends = [];
  const results = [];

  records.forEach(function (record) {
    const key = String(record.source_key);
    const existingRow = caseRowsByKey[key];
    const existing = existingRow ? objectFromRow_(casesTable, existingRow) : null;
    const serverChangeState = !existing
      ? 'NEW'
      : String(existing.content_hash || '') === String(record.content_hash || '')
        ? 'UNCHANGED'
        : 'CHANGED';

    const preparedDraft = prepareDraft_(record, existingDrafts, draftIds, now, request);
    if (preparedDraft.isNew) {
      draftAppends.push(preparedDraft.object);
      existingDrafts.push(preparedDraft.object);
      draftIds[preparedDraft.object.draft_id] = true;
    }

    const caseObject = caseObjectFromRecord_(record, existing, serverChangeState, preparedDraft.object, now);
    if (existingRow) caseUpdates.push({ rowNumber: existingRow.rowNumber, object: caseObject });
    else caseAppends.push(caseObject);

    prepareMessages_(record, now).forEach(function (message) {
      if (messageIds[message.message_key]) return;
      messageIds[message.message_key] = true;
      messageAppends.push(message);
    });

    results.push({
      source_key: key,
      market: String(record.market || ''),
      channel: String(record.channel || ''),
      change_state: serverChangeState,
      reply_state: caseObject.reply_state,
    });
  });

  const reconciliation = prepareOpenQueueReconciliation_(report, casesTable, keys, now);
  reconciliation.updates.forEach(function (item) { caseUpdates.push(item); });
  reconciliation.results.forEach(function (item) { results.push(item); });

  caseUpdates.forEach(function (item) {
    writeObjectRow_(casesSheet, casesTable, item.rowNumber, item.object);
  });
  appendObjects_(casesSheet, casesTable, caseAppends);
  appendObjects_(messagesSheet, messagesTable, messageAppends);
  appendObjects_(draftsSheet, draftsTable, draftAppends);

  const runRows = buildRunRows_(report, runId, results, now);
  appendObjects_(runsSheet, runsTable, runRows);
  invalidateReadCache_();

  return {
    ok: true,
    run_id: runId,
    duplicate_run: false,
    prepared_count: records.length,
    inserted_cases: caseAppends.length,
    updated_cases: caseUpdates.length,
    new_count: results.filter(function (row) { return row.change_state === 'NEW'; }).length,
    changed_count: results.filter(function (row) { return row.change_state === 'CHANGED'; }).length,
    unchanged_count: results.filter(function (row) { return row.change_state === 'UNCHANGED'; }).length,
    inserted_messages: messageAppends.length,
    inserted_drafts: draftAppends.length,
    reconciliation_checked_cases: reconciliation.checked,
    reconciliation_review_cases: reconciliation.review,
    reconciliation_closed_cases: reconciliation.closed,
    reconciliation_reopened_cases: reconciliation.reopened,
    marketplace_write_actions: 0,
    auto_send: false,
  };
}

function caseObjectFromRecord_(record, existing, changeState, draft, now) {
  const replyState = mapReplyState_(record.reply_state);
  const sellerReplies = Array.isArray(record.seller_replies) ? record.seller_replies : [];
  const lastSeller = sellerReplies.length ? sellerReplies[sellerReplies.length - 1] : null;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  const channelInfo = channelInfo_(record.market, record.channel);
  const old = existing || {};
  const recordSourceUrl = safeMarketplaceUrl_(record.source_url, 'source_url');
  const oldSourceUrl = safeMarketplaceUrl_(old.source_url, 'source_url');
  const sourceUrl = recordSourceUrl || oldSourceUrl || channelInfo.sourceUrl;
  const sourceUrlKind = normalizeSourceUrlKind_(record.source_url_kind || old.source_url_kind, Boolean(recordSourceUrl || oldSourceUrl));
  const sourceReference = String(record.source_reference || old.source_reference || '');
  const productUrl = safeMarketplaceUrl_(record.product_url, 'product_url') || safeMarketplaceUrl_(old.product_url, 'product_url');
  const productThumbnailUrl = safeMarketplaceUrl_(record.product_thumbnail_url, 'product_thumbnail_url') || safeMarketplaceUrl_(old.product_thumbnail_url, 'product_thumbnail_url');
  const imageCount = Array.isArray(record.messages)
    ? record.messages.reduce(function (total, message) { return total + Math.max(Number(message.image_count || 0), 0); }, 0)
    : Math.max(Number(old.image_count || 0), 0);
  const humanReplyExists = replyState === 'ANSWERED' || sellerReplies.length > 0 || String(record.last_actor) === 'seller' || old.human_reply_exists === true;
  const changedAt = changeState === 'UNCHANGED' && old.last_changed_at ? old.last_changed_at : now;
  const activeDraft = draft || (old.active_ai_draft_id ? {
    draft_id: old.active_ai_draft_id,
    draft_text: old.active_ai_draft_preview,
    draft_state: old.ai_draft_state,
  } : null);
  const completionReason = replyState === 'ANSWERED'
    ? 'SELLER_REPLY_CONFIRMED'
    : replyState === 'NO_REPLY_REQUIRED'
      ? 'NO_REPLY_REQUIRED_CONFIRMED'
      : '';

  return {
    case_key: String(record.source_key),
    record_type: 'LIVE',
    market: channelInfo.market,
    channel: channelInfo.channel,
    ui_type: channelInfo.uiType,
    source_url: sourceUrl,
    source_url_kind: sourceUrlKind,
    source_reference: sourceReference,
    product_url: productUrl,
    product_thumbnail_url: productThumbnailUrl,
    image_count: imageCount,
    occurred_at: toDateOrBlank_(record.occurred_at) || old.occurred_at || '',
    last_message_at: toDateOrBlank_(lastMessage && lastMessage.at || record.occurred_at) || old.last_message_at || '',
    customer_masked: String(record.customer_masked || ''),
    category: String(record.category || ''),
    subject: String(record.subject || record.category || ''),
    preview: String(record.preview || lastMessage && lastMessage.text || ''),
    product_id: String(record.product_id || ''),
    product_name: String(record.product_name || ''),
    order_no_masked: String(record.order_no_masked || record.product_order_no_masked || ''),
    source_status: String(record.status || ''),
    last_actor: mapActor_(record.last_actor) || old.last_actor || '',
    reply_required: replyState === 'NEEDS_REPLY',
    reply_state: replyState,
    human_reply_exists: humanReplyExists,
    human_reply_at: toDateOrBlank_(lastSeller && lastSeller.at) || old.human_reply_at || '',
    latest_human_reply_preview: String(lastSeller && lastSeller.text || old.latest_human_reply_preview || ''),
    active_ai_draft_id: String(activeDraft && activeDraft.draft_id || ''),
    active_ai_draft_preview: String(activeDraft && activeDraft.draft_text || ''),
    ai_draft_state: String(activeDraft && activeDraft.draft_state || 'NONE'),
    content_hash: String(record.content_hash),
    change_state: changeState,
    first_seen_at: old.first_seen_at || now,
    last_seen_at: now,
    last_changed_at: changedAt,
    last_status_verified_at: now,
    status_missing_count: 0,
    status_source: 'COLLECTED_DETAIL_OR_STATUS',
    completion_reason: completionReason,
    pii_scan: String(record.pii_scan || 'REVIEW') === 'PASS' ? 'PASS' : 'WARNING',
    sync_error: '',
  };
}

function prepareOpenQueueReconciliation_(report, casesTable, collectedKeys, now) {
  const updates = [];
  const results = [];
  let checked = 0;
  let review = 0;
  let closed = 0;
  let reopened = 0;

  Object.keys(report.channels || {}).forEach(function (channelKey) {
    const snapshot = report.channels[channelKey] || {};
    if (snapshot.open_queue_complete !== true) return;
    const openKeys = Array.isArray(snapshot.open_queue_source_keys) ? snapshot.open_queue_source_keys : null;
    if (!openKeys) throw new Error('OPEN_QUEUE_SOURCE_KEYS_REQUIRED:' + channelKey);
    if (Number(snapshot.open_queue_visible_total) !== openKeys.length) {
      throw new Error('OPEN_QUEUE_TOTAL_MISMATCH:' + channelKey);
    }
    const unique = {};
    openKeys.forEach(function (key) {
      const value = String(key || '');
      if (!value) throw new Error('OPEN_QUEUE_SOURCE_KEY_REQUIRED:' + channelKey);
      if (unique[value]) throw new Error('OPEN_QUEUE_DUPLICATE_SOURCE_KEY:' + channelKey);
      unique[value] = true;
    });

    const info = channelInfoFromKey_(channelKey);
    const windowStart = dateValue_(snapshot.open_queue_window_start);
    casesTable.rows.forEach(function (row) {
      const existing = objectFromRow_(casesTable, row);
      const key = String(existing.case_key || '');
      if (!key || collectedKeys[key]) return;
      if (String(existing.record_type || '') !== 'LIVE') return;
      if (String(existing.market || '') !== info.market || String(existing.channel || '') !== info.channel) return;
      if (windowStart && dateValue_(existing.occurred_at) < windowStart) return;

      const isOpen = Boolean(unique[key]);
      const oldState = mapReplyState_(existing.reply_state);
      const oldMissing = Math.max(Number(existing.status_missing_count || 0), 0);
      const priorMissingReview = oldState === 'REVIEW' && String(existing.status_source || '') === 'OPEN_QUEUE_MISSING';
      if (!isOpen && oldState !== 'NEEDS_REPLY' && !priorMissingReview) return;

      checked += 1;
      const next = Object.assign({}, existing, {
        last_status_verified_at: now,
        sync_error: '',
      });

      if (isOpen) {
        next.reply_required = true;
        next.reply_state = 'NEEDS_REPLY';
        next.source_status = '현재 미답변 목록에서 확인';
        next.status_missing_count = 0;
        next.status_source = 'OPEN_QUEUE';
        next.completion_reason = '';
        next.change_state = oldState === 'NEEDS_REPLY' && oldMissing === 0 ? 'UNCHANGED' : 'CHANGED';
        if (next.change_state === 'CHANGED') {
          next.content_hash = sha256_(['RECONCILE', existing.content_hash || '', 'OPEN', now.toISOString()].join('|'));
          next.last_changed_at = now;
          reopened += 1;
        }
      } else {
        const missingCount = oldMissing + 1;
        const shouldClose = missingCount >= 2;
        next.reply_required = !shouldClose;
        next.reply_state = shouldClose ? 'CLOSED' : 'REVIEW';
        next.source_status = shouldClose ? '처리 종료 · 미답변 목록 2회 연속 미노출' : '재확인 필요 · 미답변 목록 1회 미노출';
        next.status_missing_count = missingCount;
        next.status_source = 'OPEN_QUEUE_MISSING';
        next.completion_reason = shouldClose ? 'OPEN_QUEUE_MISSING_TWICE' : '';
        next.change_state = 'CHANGED';
        next.content_hash = sha256_(['RECONCILE', existing.content_hash || '', missingCount, next.reply_state].join('|'));
        next.last_changed_at = now;
        // A case that disappeared from the complete open queue is no longer safe
        // to present as AI-ready, even while we wait for the second observation.
        // Keep the historical draft row for audit, but detach it from the case.
        next.active_ai_draft_id = '';
        next.active_ai_draft_preview = '';
        next.ai_draft_state = 'NONE';
        if (shouldClose) {
          closed += 1;
        } else {
          review += 1;
        }
      }

      updates.push({ rowNumber: row.rowNumber, object: next });
      results.push({
        source_key: key,
        market: info.rawMarket,
        channel: info.rawChannel,
        change_state: next.change_state,
        reply_state: next.reply_state,
      });
    });
  });

  return { updates: updates, results: results, checked: checked, review: review, closed: closed, reopened: reopened };
}

function prepareMessages_(record, now) {
  const result = [];
  const input = [];
  (Array.isArray(record.messages) ? record.messages : []).forEach(function (message, index) {
    input.push({
      at: message.at,
      actor: message.direction,
      text: message.text,
      image_count: message.image_count,
      source_message_id: String(message.source_message_id || ('sequence-' + (index + 1))),
    });
  });
  (Array.isArray(record.seller_replies) ? record.seller_replies : []).forEach(function (reply, index) {
    input.push({
      at: reply.at,
      actor: 'seller',
      text: reply.text,
      image_count: 0,
      source_message_id: String(reply.source_message_id || ('seller-reply-' + (index + 1))),
    });
  });

  input.forEach(function (message, index) {
    const actor = mapActor_(message.actor);
    const text = String(message.text || '');
    const sourceMessageId = String(message.source_message_id || ('sequence-' + (index + 1)));
    const contentHash = sha256_([record.source_key, sourceMessageId, index + 1, actor, message.at || '', text, Number(message.image_count || 0)].join('|'));
    result.push({
      message_key: 'MSG2:' + String(record.source_key) + ':' + contentHash.slice(0, 20),
      record_type: 'LIVE',
      case_key: String(record.source_key),
      sequence: index + 1,
      message_at: toDateOrBlank_(message.at),
      actor_type: actor,
      message_type: Number(message.image_count || 0) > 0 && !text ? 'IMAGE' : 'TEXT',
      message_text_masked: text,
      image_count: Number(message.image_count || 0),
      message_hash: contentHash,
      first_seen_at: now,
    });
  });
  return result;
}

function prepareDraft_(record, existingDrafts, draftIds, now, request) {
  const text = String(record.ai_draft || '').trim();
  if (!text) return { object: null, isNew: false };
  const replyState = mapReplyState_(record.reply_state);
  const requestedPurpose = String(record.ai_draft_purpose || '').toUpperCase();
  const purpose = requestedPurpose || (replyState === 'NEEDS_REPLY' ? 'REPLY' : '');
  const isReplyDraft = replyState === 'NEEDS_REPLY' && purpose === 'REPLY';
  const isEvaluationDraft = replyState === 'ANSWERED' && purpose === 'EVAL';
  if (!isReplyDraft && !isEvaluationDraft) throw new Error('AI_DRAFT_REPLY_STATE_MISMATCH');
  if (String(record.ai_draft_origin || '') !== 'AI') throw new Error('AI_DRAFT_ORIGIN_REQUIRED');
  if (String(record.ai_draft_pii_scan || '') !== 'PASS') throw new Error('AI_DRAFT_PII_SCAN_REQUIRED');
  assertMaskedText_(text, 'ai_draft');
  const contentHash = sha256_([record.source_key, text].join('|'));
  const draftId = 'DRAFT:' + String(record.source_key) + ':' + contentHash.slice(0, 20);
  const existing = existingDrafts.find(function (draft) { return String(draft.draft_id) === draftId; });
  if (existing) return { object: existing, isNew: false };
  const versions = existingDrafts
    .filter(function (draft) { return String(draft.case_key) === String(record.source_key); })
    .map(function (draft) { return Number(draft.version || 0); });
  return {
    isNew: !draftIds[draftId],
    object: {
      draft_id: draftId,
      record_type: isEvaluationDraft ? 'EVAL' : 'LIVE',
      case_key: String(record.source_key),
      version: (versions.length ? Math.max.apply(null, versions) : 0) + 1,
      generated_at: now,
      model: String(request.model || record.ai_model || 'Codex'),
      prompt_version: String(request.prompt_version || 'marketplace-cs-monitor-v1'),
      draft_text: text,
      required_checks: String(record.ai_draft_required_checks || '사람 검토 필수 · 자동 전송 금지'),
      draft_state: isEvaluationDraft ? 'EVAL' : 'READY',
      pii_scan: 'PASS',
      reviewed_at: '',
      review_note: '',
      used_at: '',
    },
  };
}

function buildRunRows_(report, runId, results, now) {
  const rows = [];
  const channels = report.channels || {};
  const finishedAt = toDateOrBlank_(report.collected_at) || now;
  const duration = Number(report.duration_ms || 0);
  const startedAt = new Date(finishedAt.getTime() - duration);
  Object.keys(channels).forEach(function (key) {
    const source = channels[key] || {};
    if (!source.attempted && !source.error) return;
    const info = channelInfoFromKey_(key);
    const scoped = results.filter(function (row) {
      return String(row.market).toLowerCase() === info.rawMarket && String(row.channel) === info.rawChannel;
    });
    rows.push({
      run_id: runId + ':' + key,
      record_type: 'LIVE',
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: duration,
      market: info.market,
      channel: info.channel,
      visible_total: Number(source.visible_total || 0),
      collected_count: Number(source.collected_count == null ? scoped.length : source.collected_count),
      new_count: scoped.filter(function (row) { return row.change_state === 'NEW'; }).length,
      changed_count: scoped.filter(function (row) { return row.change_state === 'CHANGED'; }).length,
      needs_reply_count: scoped.filter(function (row) { return row.reply_state === 'NEEDS_REPLY'; }).length,
      skipped_count: Number(source.skipped_count || 0),
      login_state: source.error ? 'UNKNOWN' : source.attempted ? 'SIGNED_IN' : 'UNKNOWN',
      error_message: String(source.error || ''),
      write_actions: 0,
      mode: 'READ_ONLY',
    });
  });
  return rows;
}

function assertMaskedRecord_(record) {
  if (!record || !record.source_key) throw new Error('SOURCE_KEY_REQUIRED');
  if (!record.content_hash) throw new Error('CONTENT_HASH_REQUIRED');
  if (String(record.pii_scan || '') !== 'PASS') throw new Error('PII_SCAN_PASS_REQUIRED');
  if (record.customer_masked && String(record.customer_masked).indexOf('*') === -1) {
    throw new Error('CUSTOMER_NOT_MASKED');
  }
  assertMaskedText_(record.customer_masked, 'customer_masked');
  assertMaskedText_(record.subject, 'subject');
  assertMaskedText_(record.preview, 'preview');
  (Array.isArray(record.messages) ? record.messages : []).forEach(function (message) {
    assertMaskedText_(message.text, 'message');
  });
  (Array.isArray(record.seller_replies) ? record.seller_replies : []).forEach(function (reply) {
    assertMaskedText_(reply.text, 'seller_reply');
  });
  ['order_no_masked', 'product_order_no_masked'].forEach(function (field) {
    const value = String(record[field] || '');
    if (/^\d{10,}$/.test(value)) throw new Error('UNMASKED_LONG_NUMBER:' + field);
  });
  assertMaskedText_(record.source_reference, 'source_reference');
  safeMarketplaceUrl_(record.source_url, 'source_url');
  safeMarketplaceUrl_(record.product_url, 'product_url');
  safeMarketplaceUrl_(record.product_thumbnail_url, 'product_thumbnail_url');
  normalizeSourceUrlKind_(record.source_url_kind, Boolean(record.source_url));
}

function assertMaskedText_(value, field) {
  const text = String(value || '');
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(text)) throw new Error('UNMASKED_PHONE:' + field);
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) throw new Error('UNMASKED_EMAIL:' + field);
}

function normalizeSourceUrlKind_(value, hasSourceUrl) {
  const kind = String(value || '').toUpperCase();
  if (!kind) return hasSourceUrl ? 'LIST' : 'UNAVAILABLE';
  if (['EXACT', 'LIST', 'UNAVAILABLE'].indexOf(kind) === -1) throw new Error('INVALID_SOURCE_URL_KIND');
  if (kind === 'EXACT' && !hasSourceUrl) throw new Error('SOURCE_URL_KIND_MISMATCH');
  if (kind === 'UNAVAILABLE' && hasSourceUrl) throw new Error('SOURCE_URL_KIND_MISMATCH');
  return kind;
}

function safeMarketplaceUrl_(value, field) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^https:\/\//i.test(text)) throw new Error('UNSAFE_MARKETPLACE_URL:' + field);
  const authorityMatch = text.match(/^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  if (!authorityMatch || authorityMatch[1].indexOf('@') !== -1) throw new Error('UNSAFE_MARKETPLACE_URL:' + field);
  const host = String(authorityMatch[1].split(':')[0] || '').toLowerCase();
  const allowed = ['naver.com', 'kakaostyle.com', 'a-bly.com'].some(function (suffix) {
    return host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix;
  });
  if (!allowed) throw new Error('UNSAFE_MARKETPLACE_URL:' + field);

  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch (error) { /* Keep the original value for conservative checks. */ }
  const queryOrFragment = (decoded.match(/[?#]([\s\S]*)$/) || [])[1] || '';
  const sensitiveParts = ['token', 'secret', 'session', 'cookie', 'auth', 'authorization', 'password', 'passwd', 'credential', 'signature', 'jwt', 'apikey', 'accesskey', 'refreshtoken'];
  const sensitiveUrlKey = queryOrFragment.split(/[&#]/).some(function (pair) {
    const rawKey = String(pair || '').split('=')[0] || '';
    let key = rawKey;
    try { key = decodeURIComponent(rawKey); } catch (error) { /* Reject through normalized raw text below when possible. */ }
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized === 'key' || sensitiveParts.some(function (part) { return normalized.indexOf(part) !== -1; });
  });
  if (sensitiveUrlKey) {
    throw new Error('SENSITIVE_MARKETPLACE_URL_PARAMETER:' + field);
  }
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(queryOrFragment)) throw new Error('UNMASKED_PHONE:' + field);
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(queryOrFragment)) throw new Error('UNMASKED_EMAIL:' + field);
  return text;
}

function channelInfo_(market, channel) {
  return channelInfoFromKey_(String(market).toLowerCase() + '_' + String(channel));
}

function channelInfoFromKey_(key) {
  const map = {
    smartstore_comments: { rawMarket: 'smartstore', rawChannel: 'comments', market: 'SMARTSTORE', channel: '문의 관리', uiType: 'POST', sourceUrl: 'https://sell.smartstore.naver.com/#/comment/' },
    smartstore_customer_qna: { rawMarket: 'smartstore', rawChannel: 'customer_qna', market: 'SMARTSTORE', channel: '고객문의 관리', uiType: 'POST', sourceUrl: 'https://sell.smartstore.naver.com/#/naverpay/qnas' },
    smartstore_customer_center: { rawMarket: 'smartstore', rawChannel: 'customer_center', market: 'SMARTSTORE', channel: '고객센터 문의 관리', uiType: 'POST', sourceUrl: 'https://sell.smartstore.naver.com/#/seller/customer-center-cs' },
    smartstore_talktalk: { rawMarket: 'smartstore', rawChannel: 'talktalk', market: 'SMARTSTORE', channel: '톡톡 상담', uiType: 'CHAT', sourceUrl: 'https://sell.smartstore.naver.com/#/talktalk/chat' },
    zigzag_order_inquiry: { rawMarket: 'zigzag', rawChannel: 'order_inquiry', market: 'ZIGZAG', channel: '주문 문의', uiType: 'POST', sourceUrl: 'https://partners.kakaostyle.com/shop/pink-rocket/order_inquiry' },
    zigzag_item_question: { rawMarket: 'zigzag', rawChannel: 'item_question', market: 'ZIGZAG', channel: '상품 문의', uiType: 'POST', sourceUrl: 'https://partners.kakaostyle.com/shop/pink-rocket/item_question' },
    ably_inquiry: { rawMarket: 'ably', rawChannel: 'inquiry', market: 'ABLY', channel: '문의 관리', uiType: 'CHAT', sourceUrl: 'https://my.a-bly.com/inquiry' },
  };
  const info = map[key];
  if (!info) throw new Error('UNKNOWN_CHANNEL:' + key);
  return info;
}

function mapReplyState_(value) {
  const state = String(value || 'REVIEW');
  if (state === 'NO_REPLY') return 'NO_REPLY_REQUIRED';
  if (['NEEDS_REPLY', 'ANSWERED', 'NO_REPLY_REQUIRED', 'REVIEW', 'CLOSED'].indexOf(state) !== -1) return state;
  return 'REVIEW';
}

function mapActor_(value) {
  const actor = String(value || '').toLowerCase();
  const map = { customer: 'CUSTOMER', seller: 'SELLER', automatic: 'AUTOMATIC', system: 'SYSTEM' };
  return map[actor] || '';
}

function makeRunId_(report) {
  return 'SYNC_' + sha256_([report.collected_at || new Date().toISOString(), (report.records || []).map(function (row) {
    const draftHash = sha256_([row.ai_draft || '', row.ai_draft_purpose || '', row.ai_draft_required_checks || '', row.ai_draft_pii_scan || ''].join('|')).slice(0, 16);
    return row.source_key + ':' + row.content_hash + ':' + draftHash;
  }).join('|')].join('|')).slice(0, 24);
}

function sha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); })
    .join('');
}

function toDateOrBlank_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T') + ':00+09:00';
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? '' : parsed;
}

function requiredSheet_(spreadsheet, name) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('SHEET_NOT_FOUND:' + name);
  return sheet;
}

function ensureColumns_(sheet, requiredHeaders) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (value) {
    return String(value || '').trim();
  });
  const missing = requiredHeaders.filter(function (header) { return headers.indexOf(header) === -1; });
  if (!missing.length) return;
  sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
}

function objectRowsBy_(table, field) {
  const result = {};
  const index = table.headerMap[field];
  table.rows.forEach(function (row) { result[String(row.values[index] || '')] = row; });
  return result;
}

function objectKeys_(table, field) {
  const rows = objectRowsBy_(table, field);
  const result = {};
  Object.keys(rows).forEach(function (key) { if (key) result[key] = true; });
  return result;
}

function objectsFromTable_(table) {
  return table.rows.map(function (row) { return objectFromRow_(table, row); });
}

function objectFromRow_(table, row) {
  const object = {};
  table.headers.forEach(function (header, index) { object[header] = row.values[index]; });
  return object;
}

function writeObjectRow_(sheet, table, rowNumber, object) {
  const values = table.headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
  });
  sheet.getRange(rowNumber, 1, 1, table.headers.length).setValues([values]);
}

function appendObjects_(sheet, table, objects) {
  if (!objects.length) return;
  let rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  const neededLastRow = rowNumber + objects.length - 1;
  if (neededLastRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), neededLastRow - sheet.getMaxRows());
  const values = objects.map(function (object) {
    return table.headers.map(function (header) {
      return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
    });
  });
  sheet.getRange(rowNumber, 1, values.length, table.headers.length).setValues(values);
}

function overview_() {
  const cases = getObjects_(CS_SHEETS.CASES);
  return overviewFromCases_(cases);
}

function overviewFromCases_(cases) {
  const live = cases.map(publicCase_).filter(function (row) { return row.record_type === 'LIVE'; });
  const count = function (field, value) {
    return live.filter(function (row) { return String(row[field] || '') === value; }).length;
  };

  const byMarket = {};
  live.forEach(function (row) {
    const market = String(row.market || 'UNKNOWN');
    byMarket[market] = (byMarket[market] || 0) + 1;
  });

  return {
    ok: true,
    total_live: live.length,
    needs_reply: count('reply_state', 'NEEDS_REPLY'),
    answered: count('reply_state', 'ANSWERED'),
    review: count('reply_state', 'REVIEW'),
    no_reply_required: count('reply_state', 'NO_REPLY_REQUIRED'),
    closed: count('reply_state', 'CLOSED'),
    ai_ready: count('ai_draft_state', 'READY'),
    by_market: byMarket,
    auto_send: false,
  };
}

function listCases_(request) {
  return listCasesFromRows_(getObjects_(CS_SHEETS.CASES), request);
}

function listCasesFromRows_(caseRows, request) {
  const limit = Math.min(Math.max(Number(request.limit || 50), 1), 200);
  const cursor = Math.max(Number(request.cursor || 0), 0);
  const filters = ['record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state'];
  let rows = caseRows.map(publicCase_);

  filters.forEach(function (field) {
    if (!request[field]) return;
    rows = rows.filter(function (row) {
      return String(row[field] || '') === String(request[field]);
    });
  });

  if (!request.record_type) {
    rows = rows.filter(function (row) { return row.record_type === 'LIVE'; });
  }
  if (!request.reply_state) {
    rows = rows.filter(function (row) { return String(row.reply_state || '') !== 'CLOSED'; });
  }

  rows.sort(function (a, b) {
    const priority = { NEEDS_REPLY: 0, REVIEW: 1, ANSWERED: 2, NO_REPLY_REQUIRED: 3, CLOSED: 4 };
    const pa = priority[a.reply_state] == null ? 9 : priority[a.reply_state];
    const pb = priority[b.reply_state] == null ? 9 : priority[b.reply_state];
    if (pa !== pb) return pa - pb;
    return dateValue_(b.last_changed_at) - dateValue_(a.last_changed_at);
  });

  const items = rows.slice(cursor, cursor + limit).map(publicCase_);
  return {
    ok: true,
    total: rows.length,
    cursor: cursor,
    next_cursor: cursor + items.length < rows.length ? cursor + items.length : null,
    items: items,
  };
}

function dashboard_(request) {
  const safeRequest = Object.assign({}, request, {
    limit: Math.min(Math.max(Number(request.limit || 50), 1), 100),
    cursor: 0,
  });
  const cacheKey = dashboardCacheKey_(safeRequest);
  const cached = isTruthy_(request.fresh) ? null : readJsonCache_(cacheKey);
  if (cached) return cached;

  const cases = getObjects_(CS_SHEETS.CASES);
  const listing = listCasesFromRows_(cases, safeRequest);
  const payload = Object.assign({ ok: true, overview: overviewFromCases_(cases) }, listing);
  writeJsonCache_(cacheKey, payload, 45);
  return payload;
}

function getCase_(caseKey, fresh) {
  if (!caseKey) throw new Error('CASE_KEY_REQUIRED');
  const batch = getCaseBatch_(String(caseKey), fresh);
  if (!batch.items.length) throw new Error('CASE_NOT_FOUND');
  return Object.assign({ ok: true }, batch.items[0]);
}

function normalizeCaseKeys_(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const keys = raw.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
  if (!keys.length) throw new Error('CASE_KEYS_REQUIRED');
  if (keys.length > 3) throw new Error('CASE_BATCH_TOO_LARGE');
  const unique = {};
  keys.forEach(function (key) {
    if (key.length > 300 || !/^[A-Za-z0-9:_-]+$/.test(key)) throw new Error('CASE_KEY_INVALID');
    if (unique[key]) throw new Error('DUPLICATE_CASE_KEY');
    unique[key] = true;
  });
  return keys;
}

function detailFromRows_(caseRow, allMessages, allDrafts) {
  const caseKey = String(caseRow.case_key || '');
  const caseMessages = allMessages.filter(function (row) { return String(row.case_key) === caseKey; });
  const versionTwoMessages = caseMessages.filter(function (row) {
    return String(row.message_key || '').indexOf('MSG2:') === 0;
  });
  const messages = (versionTwoMessages.length ? versionTwoMessages : caseMessages)
    .filter(function (row) { return !isUiControlText_(row.message_text_masked); })
    .sort(function (a, b) { return Number(a.sequence || 0) - Number(b.sequence || 0); });
  const drafts = allDrafts
    .filter(function (row) { return String(row.case_key) === caseKey; })
    .sort(function (a, b) { return Number(b.version || 0) - Number(a.version || 0); });
  return {
    case: publicCase_(caseRow),
    messages: messages,
    drafts: drafts,
    human_reply_source: 'MARKETPLACE_ONLY',
    auto_send: false,
  };
}

function getCaseBatch_(caseKeysValue, fresh) {
  const keys = normalizeCaseKeys_(caseKeysValue);
  const cacheKey = 'caseBatch:' + String(PropertiesService.getScriptProperties().getProperty('CS_READ_CACHE_VERSION') || '0') + ':' + keys.join(',');
  const cached = isTruthy_(fresh) ? null : readJsonCache_(cacheKey);
  if (cached) return cached;

  const allCases = getObjects_(CS_SHEETS.CASES);
  const allMessages = getObjects_(CS_SHEETS.MESSAGES);
  const allDrafts = getObjects_(CS_SHEETS.DRAFTS);
  const caseMap = {};
  allCases.forEach(function (row) { caseMap[String(row.case_key || '')] = row; });
  const items = keys.filter(function (key) { return Boolean(caseMap[key]); }).map(function (key) {
    return detailFromRows_(caseMap[key], allMessages, allDrafts);
  });
  const payload = {
    ok: true,
    items: items,
    not_found_keys: keys.filter(function (key) { return !caseMap[key]; }),
    human_reply_source: 'MARKETPLACE_ONLY',
    auto_send: false,
  };
  writeJsonCache_(cacheKey, payload, 30);
  return payload;
}

function caseIndex_() {
  const liveRows = getObjects_(CS_SHEETS.CASES)
    .filter(function (row) { return String(row.record_type || '') === 'LIVE'; });
  const rows = liveRows.slice(0, 5000).map(function (row) {
      return {
        source_key: String(row.case_key || ''),
        content_hash: String(row.content_hash || ''),
        ai_draft_state: String(row.ai_draft_state || 'NONE'),
        reply_state: String(row.reply_state || ''),
        last_seen_at: serializeCell_(row.last_seen_at),
      };
    })
    .filter(function (row) { return row.source_key && row.content_hash; });
  return { ok: true, items: rows, total: rows.length, total_available: liveRows.length, truncated: liveRows.length > rows.length };
}

function searchVerifiedAnswers_(request) {
  const query = String(request.query || '').trim();
  if (query.length < 2 || query.length > 500) throw new Error('ANSWER_QUERY_INVALID');
  assertMaskedText_(query, 'answer_query');
  const limit = Math.min(Math.max(Number(request.limit || 3), 1), 3);
  const queryTokens = answerTokens_(query);
  const requestedMarket = String(request.market || '').toUpperCase();
  const requestedChannel = String(request.channel || '');
  const requestedIntent = String(request.intent || '');

  const examples = getObjects_(CS_SHEETS.ANSWERS)
    .filter(function (row) {
      const enabled = row.enabled === true || /^(true|use|yes|1)$/i.test(String(row.enabled || ''));
      return enabled && String(row.quality_state || '') === 'USE' && String(row.pii_scan || '') === 'PASS';
    })
    .map(function (row) {
      const rowMarket = String(row.market || '').toUpperCase();
      const rowChannel = String(row.channel || '');
      const rowIntent = String(row.intent || '');
      const haystackTokens = answerTokens_([
        rowIntent,
        row.category,
        row.customer_question,
        row.product_name,
        row.keywords,
      ].join(' '));
      const overlap = queryTokens.filter(function (token) { return haystackTokens.indexOf(token) !== -1; }).length;
      let score = overlap;
      if (requestedIntent && rowIntent === requestedIntent) score += 12;
      if (requestedMarket && rowMarket === requestedMarket) score += 2;
      if (requestedChannel && rowChannel === requestedChannel) score += 2;
      return { row: row, score: score };
    })
    .filter(function (item) { return item.score > 0; })
    .sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      return dateValue_(b.row.last_verified_at) - dateValue_(a.row.last_verified_at);
    })
    .slice(0, limit)
    .map(function (item) { return publicAnswerExample_(item.row, item.score); });

  return {
    ok: true,
    reference_source: 'VERIFIED_HUMAN_ANSWER_ONLY',
    examples: examples,
  };
}

function answerTokens_(value) {
  const matches = String(value || '').toLowerCase().match(/[가-힣a-z0-9.]{2,}/g) || [];
  return matches.filter(function (token, index) { return matches.indexOf(token) === index; });
}

function publicAnswerExample_(row, score) {
  const question = String(row.customer_question || '');
  const answer = String(row.human_answer || '');
  const productName = String(row.product_name || '');
  assertMaskedText_(question, 'answer_customer_question');
  assertMaskedText_(answer, 'answer_human_answer');
  assertMaskedText_(productName, 'answer_product_name');
  if (/\b\d{10,}\b/.test([question, answer, productName].join(' '))) throw new Error('UNMASKED_LONG_NUMBER:answer_library');
  return {
    example_id: String(row.example_id || ''),
    intent: String(row.intent || ''),
    market: String(row.market || ''),
    channel: String(row.channel || ''),
    risk_level: String(row.risk_level || '') === 'STANDARD' ? 'STANDARD' : 'REVIEW_REQUIRED',
    customer_question: question,
    product_name: productName,
    human_answer: answer,
    required_checks: String(row.required_checks || ''),
    enabled: true,
    quality_state: 'USE',
    pii_scan: 'PASS',
    score: Number(score || 0),
    last_verified_at: serializeCell_(row.last_verified_at),
  };
}

function reviewDraft_(request) {
  const draftId = String(request.draft_id || '');
  const nextState = String(request.draft_state || '');
  const note = String(request.review_note || '').slice(0, 1000);
  const humanRevision = String(request.human_revision || '').trim();
  if (!draftId) throw new Error('DRAFT_ID_REQUIRED');
  if (CS_ALLOWED_DRAFT_STATES.indexOf(nextState) === -1) {
    throw new Error('INVALID_DRAFT_STATE');
  }

  const draftSheet = getSpreadsheet_().getSheetByName(CS_SHEETS.DRAFTS);
  const draftData = readTable_(draftSheet);
  const draftIdCol = draftData.headerMap.draft_id;
  const stateCol = draftData.headerMap.draft_state;
  const reviewedAtCol = draftData.headerMap.reviewed_at;
  const noteCol = draftData.headerMap.review_note;
  const humanRevisionCol = draftData.headerMap.human_revision;
  if (humanRevision) {
    if (humanRevisionCol == null) throw new Error('HUMAN_REVISION_COLUMN_REQUIRED');
    assertMaskedText_(humanRevision, 'human_revision');
  }
  const target = draftData.rows.find(function (row) {
    return String(row.values[draftIdCol]) === draftId;
  });
  if (!target) throw new Error('DRAFT_NOT_FOUND');

  const now = new Date();
  draftSheet.getRange(target.rowNumber, stateCol + 1).setValue(nextState);
  draftSheet.getRange(target.rowNumber, reviewedAtCol + 1).setValue(now);
  draftSheet.getRange(target.rowNumber, noteCol + 1).setValue(note);
  if (humanRevision) draftSheet.getRange(target.rowNumber, humanRevisionCol + 1).setValue(humanRevision);

  const caseKey = String(target.values[draftData.headerMap.case_key] || '');
  const caseSheet = getSpreadsheet_().getSheetByName(CS_SHEETS.CASES);
  const caseData = readTable_(caseSheet);
  const caseRow = caseData.rows.find(function (row) {
    return String(row.values[caseData.headerMap.case_key]) === caseKey;
  });
  if (caseRow && String(caseRow.values[caseData.headerMap.active_ai_draft_id] || '') === draftId) {
    caseSheet.getRange(caseRow.rowNumber, caseData.headerMap.ai_draft_state + 1).setValue(nextState);
  }
  invalidateReadCache_();

  return {
    ok: true,
    draft_id: draftId,
    case_key: caseKey,
    draft_state: nextState,
    reviewed_at: now.toISOString(),
    reply_state_changed: false,
    human_revision_saved: Boolean(humanRevision),
    marketplace_write_actions: 0,
    auto_send: false,
  };
}

function publicCase_(row) {
  const copy = Object.assign({}, row);
  if (isUiControlText_(copy.preview)) {
    copy.preview = '과거 수집 데이터 · 원문 재확인 필요';
  }
  // A one-pass open-queue miss is intentionally REVIEW, but its historical
  // draft must not remain actionable in the dashboard while status is unsure.
  if (String(copy.reply_state || '') === 'REVIEW' && String(copy.status_source || '') === 'OPEN_QUEUE_MISSING') {
    copy.active_ai_draft_id = '';
    copy.active_ai_draft_preview = '';
    copy.ai_draft_state = 'NONE';
  }
  delete copy.sync_error;
  return copy;
}

function isUiControlText_(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return [
    '문의 계속하기', '문의 종료하기', '상담 계속하기', '상담 종료하기',
    '답변하기', '답변 수정', '답변 등록', '메시지 보내기', '전송',
  ].indexOf(normalized) !== -1;
}

function getObjects_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('SHEET_NOT_FOUND:' + sheetName);
  const table = readTable_(sheet);
  return table.rows.map(function (row) {
    const result = {};
    table.headers.forEach(function (header, index) {
      result[header] = serializeCell_(row.values[index]);
    });
    return result;
  });
}

function dashboardCacheKey_(request) {
  const fields = ['record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state', 'limit'];
  const version = String(PropertiesService.getScriptProperties().getProperty('CS_READ_CACHE_VERSION') || '0');
  return 'dashboard:' + version + ':' + fields.map(function (field) {
    return field + '=' + String(request[field] || '');
  }).join('&');
}

function readJsonCache_(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    return null;
  }
}

function writeJsonCache_(key, payload, seconds) {
  try {
    const value = JSON.stringify(payload);
    if (value.length <= 90000) CacheService.getScriptCache().put(key, value, seconds);
  } catch (error) {
    // Cache failure must never block the read-only CS dashboard.
  }
}

function invalidateReadCache_() {
  PropertiesService.getScriptProperties().setProperty('CS_READ_CACHE_VERSION', String(Date.now()));
}

function readTable_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values.length) return { headers: [], headerMap: {}, rows: [] };
  const headers = values[0].map(function (value) { return String(value || '').trim(); });
  const headerMap = {};
  headers.forEach(function (header, index) { headerMap[header] = index; });
  const rows = values.slice(1)
    .map(function (row, index) { return { rowNumber: index + 2, values: row }; })
    .filter(function (row) { return String(row.values[0] || '') !== ''; });
  return { headers: headers, headerMap: headerMap, rows: rows };
}

function normalizeRequest_(e) {
  const params = Object.assign({}, e && e.parameter ? e.parameter : {});
  if (e && e.postData && e.postData.contents) {
    const body = JSON.parse(e.postData.contents);
    Object.keys(body || {}).forEach(function (key) { params[key] = body[key]; });
  }
  return params;
}

function authorize_(request) {
  const requiredKey = PropertiesService.getScriptProperties().getProperty('CS_API_KEY');
  if (!requiredKey) throw new Error('CS_API_KEY_NOT_CONFIGURED');
  if (String(request.api_key || '') !== requiredKey) throw new Error('UNAUTHORIZED');
}

function currentEnvironment_() {
  const environment = String(PropertiesService.getScriptProperties().getProperty('CS_ENVIRONMENT') || '');
  if (['development', 'production'].indexOf(environment) === -1) throw new Error('CS_ENVIRONMENT_NOT_CONFIGURED');
  if (environment === 'production' && PropertiesService.getScriptProperties().getProperty('CS_PRODUCTION_ENABLED') !== 'true') {
    throw new Error('CS_PRODUCTION_DISABLED');
  }
  return environment;
}

function assertRequestEnvironment_(request) {
  if (String(request.environment || '') !== currentEnvironment_()) throw new Error('ENVIRONMENT_MISMATCH');
}

function assertWriteKeyConfigured_() {
  if (!PropertiesService.getScriptProperties().getProperty('CS_API_KEY')) {
    throw new Error('CS_API_KEY_NOT_CONFIGURED');
  }
}

function getSpreadsheet_() {
  const configuredId = PropertiesService.getScriptProperties().getProperty('CS_SPREADSHEET_ID');
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('SPREADSHEET_NOT_CONFIGURED');
  return active;
}

function withDocumentLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function serializeCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function dateValue_(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function json_(payload) {
  const safePayload = Object.assign({}, payload, {
    environment: currentEnvironment_(),
    marketplace_write_actions: 0,
    auto_send: false,
  });
  return ContentService
    .createTextOutput(JSON.stringify(safePayload))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorJson_(error) {
  const environment = String(PropertiesService.getScriptProperties().getProperty('CS_ENVIRONMENT') || 'unconfigured');
  return ContentService.createTextOutput(JSON.stringify({
    ok: false,
    error: String(error && error.message ? error.message : error),
    environment: environment,
    write_policy: CS_WRITE_POLICY,
    marketplace_write_actions: 0,
    auto_send: false,
  })).setMimeType(ContentService.MimeType.JSON);
}

function testHealth() {
  Logger.log(JSON.stringify(health_(), null, 2));
  testD1RelayHealth();
}

function testD1RelayHealth() {
  const response = UrlFetchApp.fetch('https://ai-cs-mcp-development.kimhyein0214.workers.dev/healthz', {
    method: 'get',
    headers: { Accept: 'application/json' },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  Logger.log(JSON.stringify({
    status: Number(response.getResponseCode()),
    ok: Number(response.getResponseCode()) === 200,
  }, null, 2));
}

function testOverview() {
  Logger.log(JSON.stringify(overview_(), null, 2));
}
