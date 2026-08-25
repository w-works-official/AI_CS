const CS_SHEETS = Object.freeze({
  OVERVIEW: '00_OVERVIEW',
  CASES: '01_CASES',
  MESSAGES: '02_MESSAGES',
  DRAFTS: '03_AI_DRAFTS',
  RUNS: '04_SYNC_RUNS',
  RULES: '05_RULES',
  CONFIG: '99_CONFIG',
});

const CS_WRITE_POLICY = 'MASKED_SYNC_AND_DRAFT_REVIEW_ONLY';
const CS_ALLOWED_DRAFT_STATES = Object.freeze(['APPROVED', 'REJECTED', 'USED']);
const CS_MAX_SYNC_RECORDS = 2000;

function doGet(e) {
  try {
    const request = normalizeRequest_(e);
    authorize_(request);
    const action = String(request.action || 'health');

    if (action === 'health') return json_(health_());
    if (action === 'overview') return json_(overview_());
    if (action === 'cases') return json_(listCases_(request));
    if (action === 'case') return json_(getCase_(request.case_key));

    return json_({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (error) {
    return errorJson_(error);
  }
}

function doPost(e) {
  try {
    const request = normalizeRequest_(e);
    authorize_(request);
    assertWriteKeyConfigured_();
    const action = String(request.action || '');

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

    return json_({
      ok: false,
      error: 'WRITE_NOT_ALLOWED',
      write_policy: CS_WRITE_POLICY,
    });
  } catch (error) {
    return errorJson_(error);
  }
}

function health_() {
  const spreadsheet = getSpreadsheet_();
  return {
    ok: true,
    service: 'pink-rocket-cs-review-api',
    spreadsheet_id: spreadsheet.getId(),
    schema_version: 'cs-sheet-v1',
    write_policy: CS_WRITE_POLICY,
    write_key_configured: Boolean(PropertiesService.getScriptProperties().getProperty('CS_API_KEY')),
    auto_send: false,
    now: new Date().toISOString(),
  };
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

  caseUpdates.forEach(function (item) {
    writeObjectRow_(casesSheet, casesTable, item.rowNumber, item.object);
  });
  appendObjects_(casesSheet, casesTable, caseAppends);
  appendObjects_(messagesSheet, messagesTable, messageAppends);
  appendObjects_(draftsSheet, draftsTable, draftAppends);

  const runRows = buildRunRows_(report, runId, results, now);
  appendObjects_(runsSheet, runsTable, runRows);

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
  const humanReplyExists = replyState === 'ANSWERED' || sellerReplies.length > 0 || String(record.last_actor) === 'seller' || old.human_reply_exists === true;
  const changedAt = changeState === 'UNCHANGED' && old.last_changed_at ? old.last_changed_at : now;
  const activeDraft = draft || (old.active_ai_draft_id ? {
    draft_id: old.active_ai_draft_id,
    draft_text: old.active_ai_draft_preview,
    draft_state: old.ai_draft_state,
  } : null);

  return {
    case_key: String(record.source_key),
    record_type: 'LIVE',
    market: channelInfo.market,
    channel: channelInfo.channel,
    ui_type: channelInfo.uiType,
    source_url: channelInfo.sourceUrl,
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
    pii_scan: String(record.pii_scan || 'REVIEW') === 'PASS' ? 'PASS' : 'WARNING',
    sync_error: '',
  };
}

function prepareMessages_(record, now) {
  const result = [];
  const input = [];
  const signatures = {};
  const pushUnique = function (message) {
    const signature = [String(message.actor || ''), String(message.at || ''), String(message.text || ''), Number(message.image_count || 0)].join('|');
    if (signatures[signature]) return;
    signatures[signature] = true;
    input.push(message);
  };
  (Array.isArray(record.messages) ? record.messages : []).forEach(function (message) {
    pushUnique({ at: message.at, actor: message.direction, text: message.text, image_count: message.image_count });
  });
  (Array.isArray(record.seller_replies) ? record.seller_replies : []).forEach(function (reply) {
    pushUnique({ at: reply.at, actor: 'seller', text: reply.text, image_count: 0 });
  });

  input.forEach(function (message, index) {
    const actor = mapActor_(message.actor);
    const text = String(message.text || '');
    const contentHash = sha256_([record.source_key, index + 1, actor, message.at || '', text, Number(message.image_count || 0)].join('|'));
    result.push({
      message_key: 'MSG:' + String(record.source_key) + ':' + contentHash.slice(0, 20),
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
  if (!text || mapReplyState_(record.reply_state) !== 'NEEDS_REPLY') return { object: null, isNew: false };
  if (String(record.ai_draft_origin || '') !== 'AI') throw new Error('AI_DRAFT_ORIGIN_REQUIRED');
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
      record_type: 'LIVE',
      case_key: String(record.source_key),
      version: (versions.length ? Math.max.apply(null, versions) : 0) + 1,
      generated_at: now,
      model: String(request.model || record.ai_model || 'Codex'),
      prompt_version: String(request.prompt_version || 'marketplace-cs-monitor-v1'),
      draft_text: text,
      required_checks: String(record.ai_draft_required_checks || '사람 검토 필수 · 자동 전송 금지'),
      draft_state: 'READY',
      pii_scan: String(record.ai_draft_pii_scan || record.pii_scan || 'REVIEW') === 'PASS' ? 'PASS' : 'WARNING',
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
}

function assertMaskedText_(value, field) {
  const text = String(value || '');
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(text)) throw new Error('UNMASKED_PHONE:' + field);
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) throw new Error('UNMASKED_EMAIL:' + field);
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
    ably_inquiry: { rawMarket: 'ably', rawChannel: 'inquiry', market: 'ABLY', channel: '문의 관리', uiType: 'CHAT', sourceUrl: 'https://seller.a-bly.com/' },
  };
  const info = map[key];
  if (!info) throw new Error('UNKNOWN_CHANNEL:' + key);
  return info;
}

function mapReplyState_(value) {
  const state = String(value || 'REVIEW');
  if (state === 'NO_REPLY') return 'NO_REPLY_REQUIRED';
  if (['NEEDS_REPLY', 'ANSWERED', 'NO_REPLY_REQUIRED', 'REVIEW'].indexOf(state) !== -1) return state;
  return 'REVIEW';
}

function mapActor_(value) {
  const actor = String(value || '').toLowerCase();
  const map = { customer: 'CUSTOMER', seller: 'SELLER', automatic: 'AUTOMATIC', system: 'SYSTEM' };
  return map[actor] || '';
}

function makeRunId_(report) {
  return 'SYNC_' + sha256_([report.collected_at || new Date().toISOString(), (report.records || []).map(function (row) { return row.source_key + ':' + row.content_hash; }).join('|')].join('|')).slice(0, 24);
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
  const live = cases.filter(function (row) { return row.record_type === 'LIVE'; });
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
    ai_ready: count('ai_draft_state', 'READY'),
    by_market: byMarket,
    auto_send: false,
  };
}

function listCases_(request) {
  const limit = Math.min(Math.max(Number(request.limit || 50), 1), 200);
  const cursor = Math.max(Number(request.cursor || 0), 0);
  const filters = ['record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state'];
  let rows = getObjects_(CS_SHEETS.CASES);

  filters.forEach(function (field) {
    if (!request[field]) return;
    rows = rows.filter(function (row) {
      return String(row[field] || '') === String(request[field]);
    });
  });

  if (!request.record_type) {
    rows = rows.filter(function (row) { return row.record_type === 'LIVE'; });
  }

  rows.sort(function (a, b) {
    const priority = { NEEDS_REPLY: 0, REVIEW: 1, ANSWERED: 2, NO_REPLY_REQUIRED: 3 };
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

function getCase_(caseKey) {
  if (!caseKey) throw new Error('CASE_KEY_REQUIRED');
  const caseRow = getObjects_(CS_SHEETS.CASES).find(function (row) {
    return String(row.case_key) === String(caseKey);
  });
  if (!caseRow) throw new Error('CASE_NOT_FOUND');

  const messages = getObjects_(CS_SHEETS.MESSAGES)
    .filter(function (row) { return String(row.case_key) === String(caseKey); })
    .sort(function (a, b) { return Number(a.sequence || 0) - Number(b.sequence || 0); });

  const drafts = getObjects_(CS_SHEETS.DRAFTS)
    .filter(function (row) { return String(row.case_key) === String(caseKey); })
    .sort(function (a, b) { return Number(b.version || 0) - Number(a.version || 0); });

  return {
    ok: true,
    case: publicCase_(caseRow),
    messages: messages,
    drafts: drafts,
    human_reply_source: 'MARKETPLACE_ONLY',
    auto_send: false,
  };
}

function reviewDraft_(request) {
  const draftId = String(request.draft_id || '');
  const nextState = String(request.draft_state || '');
  const note = String(request.review_note || '').slice(0, 1000);
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
  const target = draftData.rows.find(function (row) {
    return String(row.values[draftIdCol]) === draftId;
  });
  if (!target) throw new Error('DRAFT_NOT_FOUND');

  const now = new Date();
  draftSheet.getRange(target.rowNumber, stateCol + 1).setValue(nextState);
  draftSheet.getRange(target.rowNumber, reviewedAtCol + 1).setValue(now);
  draftSheet.getRange(target.rowNumber, noteCol + 1).setValue(note);

  const caseKey = String(target.values[draftData.headerMap.case_key] || '');
  const caseSheet = getSpreadsheet_().getSheetByName(CS_SHEETS.CASES);
  const caseData = readTable_(caseSheet);
  const caseRow = caseData.rows.find(function (row) {
    return String(row.values[caseData.headerMap.case_key]) === caseKey;
  });
  if (caseRow && String(caseRow.values[caseData.headerMap.active_ai_draft_id] || '') === draftId) {
    caseSheet.getRange(caseRow.rowNumber, caseData.headerMap.ai_draft_state + 1).setValue(nextState);
  }

  return {
    ok: true,
    draft_id: draftId,
    case_key: caseKey,
    draft_state: nextState,
    reviewed_at: now.toISOString(),
    reply_state_changed: false,
    marketplace_write_actions: 0,
    auto_send: false,
  };
}

function publicCase_(row) {
  const copy = Object.assign({}, row);
  delete copy.sync_error;
  return copy;
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
  if (!requiredKey) return;
  if (String(request.api_key || '') !== requiredKey) throw new Error('UNAUTHORIZED');
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
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorJson_(error) {
  return json_({
    ok: false,
    error: String(error && error.message ? error.message : error),
    write_policy: CS_WRITE_POLICY,
    auto_send: false,
  });
}

function testHealth() {
  Logger.log(JSON.stringify(health_(), null, 2));
}

function testOverview() {
  Logger.log(JSON.stringify(overview_(), null, 2));
}
