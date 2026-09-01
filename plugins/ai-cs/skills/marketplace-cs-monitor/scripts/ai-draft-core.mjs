import { classifyIntent, requiredChecksFor, retrieveAnswerExamples } from "./answer-library-core.mjs";
import { inspectUnmaskedPii, maskSensitiveText } from "./report-core.mjs";

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const ACTIVE_DRAFT_STATES = new Set(["READY", "APPROVED", "USED"]);
const CHAT_CHANNELS = new Set(["talktalk", "chat", "inquiry"]);

function skip(sourceKey, reason, {
  purpose = "",
  required_checks = [],
  change_state = "",
  reply_state = "",
} = {}) {
  return {
    source_key: compact(sourceKey),
    reason,
    // Keep `reason` for existing callers and expose a stable machine-readable name
    // for the review UI and run report.
    reason_code: reason,
    purpose: compact(purpose),
    required_checks: [...new Set((required_checks ?? []).map(compact).filter(Boolean))],
    change_state: compact(change_state),
    reply_state: compact(reply_state),
  };
}

function isExplicitFalse(value) {
  return value === false || ["false", "0", "incomplete", "partial"].includes(compact(value).toLowerCase());
}

function isChatRecord(record) {
  const channel = compact(record?.channel).toLowerCase();
  const uiType = compact(record?.ui_type ?? record?.conversation_type).toUpperCase();
  return CHAT_CHANNELS.has(channel) || uiType === "CHAT";
}

function conversationIsIncomplete(record) {
  return [
    record?.conversation_complete,
    record?.messages_complete,
    record?.detail_complete,
  ].some(isExplicitFalse);
}

function conversationIncompleteChecks(record) {
  const detailReason = Array.isArray(record?.conversation_incomplete_reason)
    ? record.conversation_incomplete_reason
    : [record?.conversation_incomplete_reason];
  return ["전체 대화 수집 후 재확인", ...detailReason.map(compact).filter(Boolean)];
}
const UI_CONTROL_TEXT = /^(?:문의\s*종료하기|답변\s*등록|상담\s*완료|처리\s*완료)$/;

function messageActor(message) {
  return compact(message?.direction ?? message?.actor).toLowerCase();
}

function hasActualSellerAnswer(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const replies = Array.isArray(record?.seller_replies) ? record.seller_replies : [];
  return replies.some((reply) => compact(reply?.text ?? reply?.body))
    || messages.some((message) => messageActor(message) === "seller" && compact(message?.text) && !UI_CONTROL_TEXT.test(compact(message.text)));
}

function chatActorCheck(record, purpose) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const meaningfulMessages = messages.filter((message) => !["automatic", "system"].includes(messageActor(message)));
  const lastMeaningful = meaningfulMessages.at(-1);
  const inferredLastActor = messageActor(lastMeaningful);
  const declaredLastActor = compact(record?.last_actor).toLowerCase();

  if (!lastMeaningful || !["customer", "seller"].includes(inferredLastActor)) {
    return { ok: false, reason: "ACTOR_UNCERTAIN", required_checks: ["대화 발신자 방향 확인"] };
  }
  if (["customer", "seller"].includes(declaredLastActor) && declaredLastActor !== inferredLastActor) {
    return { ok: false, reason: "ACTOR_UNCERTAIN", required_checks: ["대화 발신자 방향 불일치 확인"] };
  }
  if (purpose === "REPLY" && inferredLastActor !== "customer") {
    return { ok: false, reason: "ACTOR_UNCERTAIN", required_checks: ["마지막 고객 메시지와 답변 상태 확인"] };
  }
  if (purpose === "EVAL" && inferredLastActor !== "seller") {
    return { ok: false, reason: "ACTOR_UNCERTAIN", required_checks: ["실제 판매자 답변과 마지막 메시지 방향 확인"] };
  }
  return { ok: true };
}

export function extractLastCustomerTurn(record, { allowPostFallback = true } = {}) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageActor(message) !== "customer") continue;
    const text = maskSensitiveText(message?.text);
    if (text && !UI_CONTROL_TEXT.test(text)) {
      return {
        ok: true,
        source: "MESSAGE",
        text,
        at: compact(message?.at),
        message_index: index,
        image_count: Math.max(0, Number(message?.image_count) || 0),
        required_checks: [],
      };
    }
    if (Number(message?.image_count) > 0) {
      return { ok: false, skip_reason: "IMAGE_REVIEW_REQUIRED", required_checks: ["첨부 이미지 원문 확인"] };
    }
  }

  const isPost = compact(record?.channel) !== "talktalk" && compact(record?.channel) !== "inquiry";
  const fallback = maskSensitiveText(record?.preview ?? record?.subject);
  if (allowPostFallback && isPost && fallback && !/과거\s*(?:이관|수집)\s*데이터|본문\s*미수집/.test(fallback)) {
    return {
      ok: true,
      source: "POST_FALLBACK",
      text: fallback,
      at: compact(record?.occurred_at),
      message_index: -1,
      image_count: 0,
      required_checks: ["MESSAGE_CONTEXT_INCOMPLETE"],
    };
  }
  return { ok: false, skip_reason: "CUSTOMER_TURN_NOT_FOUND", required_checks: ["문의 원문 확인"] };
}

export function selectDraftCandidates(report, existingCasesByKey = new Map(), {
  includeAnsweredForEval = false,
  evalLimit = 10,
  onlyNewOrChanged = true,
} = {}) {
  const candidates = [];
  const skipped = [];
  let evalCount = 0;
  for (const record of report?.records ?? []) {
    const changeState = compact(record?.change_state).toUpperCase();
    const replyState = compact(record?.reply_state).toUpperCase();
    if (onlyNewOrChanged && !["NEW", "CHANGED"].includes(changeState)) {
      skipped.push(skip(record?.source_key, "UNCHANGED", { change_state: changeState, reply_state: replyState }));
      continue;
    }
    if (isChatRecord(record) && conversationIsIncomplete(record)) {
      skipped.push(skip(record?.source_key, "CONVERSATION_INCOMPLETE", {
        change_state: changeState,
        reply_state: replyState,
        required_checks: conversationIncompleteChecks(record),
      }));
      continue;
    }
    if (isChatRecord(record)) {
      const actorCheck = chatActorCheck(record, "");
      if (!actorCheck.ok) {
        skipped.push(skip(record?.source_key, actorCheck.reason, {
          change_state: changeState,
          reply_state: replyState,
          required_checks: actorCheck.required_checks,
        }));
        continue;
      }
    }
    let purpose = "";
    if (replyState === "NEEDS_REPLY") purpose = "REPLY";
    else if (replyState === "ANSWERED") {
      if (!includeAnsweredForEval) {
        skipped.push(skip(record?.source_key, "EVAL_DISABLED", { purpose: "EVAL", change_state: changeState, reply_state: replyState }));
        continue;
      }
      if (evalCount >= Math.max(0, Number(evalLimit) || 0)) {
        skipped.push(skip(record?.source_key, "EVAL_LIMIT_REACHED", { purpose: "EVAL", change_state: changeState, reply_state: replyState }));
        continue;
      }
      purpose = "EVAL";
    }
    if (!purpose) {
      skipped.push(skip(record?.source_key, "NO_REPLY_REQUIRED", { change_state: changeState, reply_state: replyState }));
      continue;
    }
    const existing = existingCasesByKey instanceof Map
      ? existingCasesByKey.get(record?.source_key)
      : existingCasesByKey?.[record?.source_key];
    if (changeState !== "CHANGED" && ACTIVE_DRAFT_STATES.has(compact(existing?.ai_draft_state).toUpperCase())) {
      skipped.push(skip(record?.source_key, "ACTIVE_DRAFT_EXISTS", { purpose, change_state: changeState, reply_state: replyState }));
      continue;
    }
    const turn = extractLastCustomerTurn(record);
    if (!turn.ok) {
      skipped.push(skip(record?.source_key, turn.skip_reason, {
        purpose,
        change_state: changeState,
        reply_state: replyState,
        required_checks: turn.required_checks,
      }));
      continue;
    }
    if (purpose === "EVAL" && !hasActualSellerAnswer(record)) {
      skipped.push(skip(record?.source_key, "SELLER_ANSWER_NOT_FOUND", {
        purpose,
        change_state: changeState,
        reply_state: replyState,
        required_checks: ["실제 판매자 답변 원문 확인"],
      }));
      continue;
    }
    if (isChatRecord(record)) {
      const actorCheck = chatActorCheck(record, purpose);
      if (!actorCheck.ok) {
        skipped.push(skip(record?.source_key, actorCheck.reason, {
          purpose,
          change_state: changeState,
          reply_state: replyState,
          required_checks: actorCheck.required_checks,
        }));
        continue;
      }
    }
    const intent = classifyIntent(`${turn.text} ${record?.subject ?? ""} ${record?.product_name ?? ""}`, record?.category);
    candidates.push({
      source_key: compact(record?.source_key),
      purpose,
      intent,
      last_customer_turn: turn,
      inquiry: {
        market: compact(record?.market),
        channel: compact(record?.channel),
        category: compact(record?.category),
        subject: maskSensitiveText(record?.subject),
        preview: turn.text,
        product_name: maskSensitiveText(record?.product_name),
      },
    });
    if (purpose === "EVAL") evalCount += 1;
  }
  return { candidates, skipped };
}

export function buildAnswerSearchRequest(candidate) {
  return {
    query: compact(`${candidate?.intent ?? ""} ${candidate?.last_customer_turn?.text ?? ""} ${candidate?.inquiry?.product_name ?? ""}`).slice(0, 500),
    market: compact(candidate?.inquiry?.market).toUpperCase(),
    channel: compact(candidate?.inquiry?.channel),
    intent: compact(candidate?.intent),
    limit: 3,
  };
}

export function buildAiDraftJob(candidate, verifiedExamples = [], { activeRules = [] } = {}) {
  const normalizedExamples = (verifiedExamples ?? []).map((entry) => ({
    ...entry,
    enabled: entry?.enabled === undefined ? true : entry.enabled,
    quality_state: compact(entry?.quality_state || "USE").toUpperCase(),
    pii_scan: compact(entry?.pii_scan || "PASS").toUpperCase(),
  })).filter((entry) => {
    if (entry.enabled !== true || entry.quality_state !== "USE" || entry.pii_scan !== "PASS") return false;
    if (!compact(entry.example_id) || !compact(entry.customer_question) || !compact(entry.human_answer)) return false;
    return inspectUnmaskedPii(`${entry.customer_question} ${entry.human_answer} ${entry.product_name ?? ""}`).length === 0;
  });
  const examples = retrieveAnswerExamples(candidate?.inquiry, normalizedExamples, { limit: 3, minScore: 0 }).slice(0, 3);
  const referenceIds = examples.map((entry) => compact(entry.example_id)).filter(Boolean);
  const requiredChecks = [
    ...(candidate?.last_customer_turn?.required_checks ?? []),
    requiredChecksFor(candidate?.intent),
    ...examples.map((entry) => compact(entry.required_checks)).filter(Boolean),
    ...(referenceIds.length ? [] : ["검증 답변 없음 · 보수적으로 작성"]),
  ];
  return {
    source_key: compact(candidate?.source_key),
    purpose: compact(candidate?.purpose),
    intent: compact(candidate?.intent),
    inquiry: structuredClone(candidate?.inquiry ?? {}),
    last_customer_turn: structuredClone(candidate?.last_customer_turn ?? {}),
    references: examples.map((entry) => ({
      example_id: compact(entry.example_id),
      intent: compact(entry.intent),
      risk_level: compact(entry.risk_level),
      customer_question: maskSensitiveText(entry.customer_question),
      human_answer: maskSensitiveText(entry.human_answer),
      required_checks: compact(entry.required_checks),
    })),
    active_rules: (activeRules ?? []).map((rule) => maskSensitiveText(rule)).filter(Boolean),
    reference_ids: referenceIds,
    required_checks: [...new Set(requiredChecks.filter(Boolean))],
    generation_policy: [
      "사람이 검수하기 전에는 전송하지 않습니다.",
      "가격·재고·주문·배송·환불·보상 상태를 확인하지 못했으면 단정하지 않습니다.",
      "참고답변의 고객 식별정보와 주문정보를 복사하지 않습니다.",
    ],
  };
}

export function validateGeneratedDraft(candidate, generated) {
  const text = compact(generated?.text ?? generated?.ai_draft);
  if (text.length < 10) return { ok: false, reason: "AI_DRAFT_TOO_SHORT" };
  if (text.length > 2000) return { ok: false, reason: "AI_DRAFT_TOO_LONG" };
  const piiIssues = inspectUnmaskedPii(text);
  if (piiIssues.length) return { ok: false, reason: `AI_DRAFT_UNMASKED_PII:${piiIssues.join(",")}` };
  const requiredChecks = [
    ...(candidate?.required_checks ?? []),
    ...(Array.isArray(generated?.required_checks) ? generated.required_checks : [generated?.required_checks]),
  ].map(compact).filter(Boolean);
  const allowedReferences = new Set((candidate?.reference_ids ?? []).map(compact).filter(Boolean));
  const requestedReferences = (generated?.reference_ids ?? candidate?.reference_ids ?? []).map(compact).filter(Boolean);
  const references = requestedReferences.filter((id) => allowedReferences.has(id)).slice(0, 3);
  if (references.length) requiredChecks.push(`참고 답변: ${references.join(", ")}`);
  return {
    ok: true,
    draft: {
      source_key: compact(candidate?.source_key),
      ai_draft: text,
      ai_draft_origin: "AI",
      ai_draft_purpose: compact(candidate?.purpose),
      ai_draft_required_checks: [...new Set(requiredChecks)].join(" · ") || "사람 검토 필수 · 자동 전송 금지",
      ai_draft_pii_scan: "PASS",
    },
  };
}
