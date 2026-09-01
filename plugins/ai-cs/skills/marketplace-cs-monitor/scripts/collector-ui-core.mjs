const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function kstDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const CHAT_UI_CONTROL_TEXTS = new Set([
  "문의 계속하기",
  "문의 종료하기",
  "상담 계속하기",
  "상담 종료하기",
  "답변하기",
  "답변 수정",
  "답변 등록",
  "메시지 보내기",
  "전송",
]);

export const CHAT_ACTORS = Object.freeze({
  CUSTOMER: "CUSTOMER",
  SELLER: "SELLER",
  AUTOMATIC: "AUTOMATIC",
  SYSTEM: "SYSTEM",
  UNKNOWN: "UNKNOWN",
});

const CHAT_ACTOR_ALIASES = Object.freeze({
  [CHAT_ACTORS.CUSTOMER]: new Set([
    "customer", "buyer", "client", "guest", "user", "other_msg", "other-msg", "incoming", "inbound",
  ]),
  [CHAT_ACTORS.SELLER]: new Set([
    "seller", "merchant", "store", "operator", "manager", "agent", "advisor", "admin", "my_msg", "my-msg", "outgoing", "outbound",
  ]),
  [CHAT_ACTORS.AUTOMATIC]: new Set([
    "automatic", "auto", "bot", "notification", "notice", "automated", "system_notice", "system-notice",
  ]),
  [CHAT_ACTORS.SYSTEM]: new Set([
    "system", "date", "divider", "separator", "history", "timestamp", "day_separator", "day-separator",
  ]),
});

const CHAT_INCOMPLETE_REASON = Object.freeze({
  ACTOR_UNCERTAIN: "ACTOR_UNCERTAIN",
  CONVERSATION_INCOMPLETE: "CONVERSATION_INCOMPLETE",
  HISTORY_NOT_FULLY_LOADED: "HISTORY_NOT_FULLY_LOADED",
  NO_CONTENT_MESSAGES: "NO_CONTENT_MESSAGES",
});

function normalizedActorToken(value) {
  return compact(value).toLowerCase().replace(/\s+/g, "_");
}

function actorValueFrom(message = {}) {
  return message?.actor
    ?? message?.direction
    ?? message?.sender
    ?? message?.role
    ?? message?.class_name
    ?? message?.className
    ?? "";
}

/**
 * Maps the varying marketplace DOM direction labels to one stable actor value.
 * UNKNOWN is intentionally preserved rather than guessed as CUSTOMER or SELLER:
 * a later AI step must be able to hold that conversation for human review.
 */
export function normalizeChatActor(value) {
  const token = normalizedActorToken(value);
  if (!token) return CHAT_ACTORS.UNKNOWN;
  for (const [actor, aliases] of Object.entries(CHAT_ACTOR_ALIASES)) {
    if (aliases.has(token)) return actor;
  }
  if (/(^|[_-])other_msg($|[_-])/.test(token)) return CHAT_ACTORS.CUSTOMER;
  if (/(^|[_-])my_msg($|[_-])/.test(token)) return CHAT_ACTORS.SELLER;
  return CHAT_ACTORS.UNKNOWN;
}

function directionForActor(actor) {
  return actor === CHAT_ACTORS.CUSTOMER ? "customer"
    : actor === CHAT_ACTORS.SELLER ? "seller"
      : actor === CHAT_ACTORS.AUTOMATIC ? "automatic"
        : actor === CHAT_ACTORS.SYSTEM ? "system"
          : "unknown";
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * Produces an additive, backwards-compatible message shape. Existing consumers
 * can keep reading `direction`, while new consumers can use the explicit actor.
 */
export function normalizeChatMessage(message = {}, index = 0) {
  const actorRaw = compact(actorValueFrom(message));
  const actor = normalizeChatActor(actorRaw);
  const text = compact(message?.text ?? message?.body ?? message?.content);
  const imageCount = nonNegativeInteger(message?.image_count ?? message?.imageCount ?? message?.attachments_count);
  return {
    ...message,
    sequence: Number.isFinite(Number(message?.sequence)) ? Number(message.sequence) : index,
    actor,
    actor_raw: actorRaw,
    direction: directionForActor(actor),
    at: compact(message?.at ?? message?.sent_at ?? message?.time ?? message?.created_at),
    text,
    image_count: imageCount,
    is_control: isChatUiControlText(text),
  };
}

/**
 * Returns the newest actionable customer message, skipping UI controls and
 * automatic/system records. Image-only turns are retained as valid turns so
 * that the draft layer can require a human image check instead of guessing.
 */
export function findLastValidCustomerTurn(messages = []) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map((message, index) => normalizeChatMessage(message, index));
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.actor !== CHAT_ACTORS.CUSTOMER || message.is_control) continue;
    if (!message.text && message.image_count === 0) continue;
    return {
      ok: true,
      message_index: index,
      sequence: message.sequence,
      actor: message.actor,
      direction: message.direction,
      at: message.at,
      text: message.text,
      image_count: message.image_count,
      image_only: !message.text && message.image_count > 0,
    };
  }
  return { ok: false, reason: "CUSTOMER_TURN_NOT_FOUND" };
}

function declaredIncompleteReason(options = {}) {
  const explicit = compact(options?.conversation_incomplete_reason ?? options?.incomplete_reason);
  if (explicit) return explicit;
  if (options?.conversation_complete === false) return CHAT_INCOMPLETE_REASON.CONVERSATION_INCOMPLETE;
  if (options?.history_complete === false || options?.loaded_all_messages === false || options?.has_more_history === true) {
    return CHAT_INCOMPLETE_REASON.HISTORY_NOT_FULLY_LOADED;
  }
  return "";
}

/**
 * Normalizes a chat transcript without changing the legacy filter API.
 * `conversation_complete` defaults to true for a non-empty, direction-safe
 * transcript to preserve existing collectors; new collectors can explicitly
 * mark an incomplete scroll/history through the options above.
 */
export function normalizeChatConversation(messages = [], options = {}) {
  const normalizedMessages = filterChatMessages(messages)
    .map((message, index) => normalizeChatMessage(message, index));
  const conversationalMessages = normalizedMessages
    .filter((message) => message.actor === CHAT_ACTORS.CUSTOMER || message.actor === CHAT_ACTORS.SELLER);
  let incompleteReason = declaredIncompleteReason(options);
  if (!incompleteReason && normalizedMessages.some((message) => message.actor === CHAT_ACTORS.UNKNOWN)) {
    incompleteReason = CHAT_INCOMPLETE_REASON.ACTOR_UNCERTAIN;
  }
  if (!incompleteReason && conversationalMessages.length === 0) {
    incompleteReason = CHAT_INCOMPLETE_REASON.NO_CONTENT_MESSAGES;
  }
  const lastCustomerTurn = findLastValidCustomerTurn(normalizedMessages);
  return {
    messages: normalizedMessages,
    conversation_complete: !incompleteReason,
    conversation_incomplete_reason: incompleteReason,
    completeness_source: incompleteReason ? "DECLARED_OR_DETECTED" : "ASSUMED_COMPLETE",
    last_customer_turn: lastCustomerTurn.ok ? lastCustomerTurn : null,
    last_customer_turn_reason: lastCustomerTurn.ok ? "" : lastCustomerTurn.reason,
  };
}

export function assessChatHistoryLoad({
  attempts = 0,
  max_attempts = 30,
  stable_passes = 0,
  reached_boundary = false,
  loading = false,
  has_more_control = false,
  message_count = 0,
} = {}) {
  const complete = Number(stable_passes) >= 3
    && reached_boundary === true
    && loading !== true
    && has_more_control !== true;
  return {
    complete,
    stop_reason: complete ? "" : (Number(attempts) >= Number(max_attempts) ? "HISTORY_LOAD_LIMIT" : "HISTORY_NOT_FULLY_LOADED"),
    attempts: nonNegativeInteger(attempts),
    message_count: nonNegativeInteger(message_count),
    has_more_history: has_more_control === true || loading === true || reached_boundary !== true,
  };
}

export function isChatUiControlText(value) {
  return CHAT_UI_CONTROL_TEXTS.has(compact(value));
}

export function filterChatMessages(messages = []) {
  return messages.filter((message) => {
    const text = compact(message?.text);
    return (text || Number(message?.image_count ?? 0) > 0) && !isChatUiControlText(text);
  });
}

export function parseTalktalkTotalText(value) {
  const text = compact(value);
  const match = text.match(/^전체(?:\s*문의)?\s*(?:\(|\[)?\s*([\d,]+)\s*(?:건|개)?\s*(?:\)|\])?$/);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

export function normalizeFlexibleDate(label, endDate) {
  const text = compact(label);
  const iso = text.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  if (/오늘|방금|\d+\s*(?:분|시간)\s*전|오전|오후|^\d{1,2}:\d{2}/.test(text)) return endDate;
  if (/어제/.test(text)) {
    const date = new Date(`${endDate}T00:00:00+09:00`);
    date.setDate(date.getDate() - 1);
    return kstDate(date);
  }
  const md = text.match(/(?:^|\s)(\d{1,2})\s*(?:[./]|월)\s*(\d{1,2})(?:\s*일)?/);
  return md ? `${endDate.slice(0, 4)}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}` : "";
}

export function isDateInRange(label, range) {
  const normalized = normalizeFlexibleDate(label, range?.end);
  return Boolean(normalized && normalized >= range?.start && normalized <= range?.end);
}

export function isVerifiedEmptyGridState({ gridVisible, headerCount, rowCount, loadingVisible }) {
  return Boolean(gridVisible && Number(headerCount) >= 8 && Number(rowCount) === 0 && !loadingVisible);
}

export function detectAuthChallengeState(urlValue, visibleTextValue) {
  const url = compact(urlValue).toLowerCase();
  const visibleText = compact(visibleTextValue);
  if (/captcha|recaptcha/.test(url) || /자동\s*입력\s*방지|로봇이\s*아닙니다|보안\s*문자/.test(visibleText)) return "CAPTCHA_REQUIRED";
  if (/two.?factor|2fa|otp|verification/.test(url) || /2단계\s*인증|인증\s*코드|일회용\s*비밀번호/.test(visibleText)) return "TWO_FACTOR_REQUIRED";
  if (/account.?verify|identity.?verify/.test(url) || /계정\s*확인|본인\s*확인|추가\s*인증/.test(visibleText)) return "ACCOUNT_VERIFICATION_REQUIRED";
  if (/login|signin|sign-in|\/auth(?:[/?#]|$)/.test(url) || /다시\s*로그인|로그인이\s*필요|아이디\s*비밀번호/.test(visibleText)) return "LOGIN_REQUIRED";
  return "";
}
