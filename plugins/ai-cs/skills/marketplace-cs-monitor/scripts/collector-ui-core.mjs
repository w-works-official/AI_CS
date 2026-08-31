const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

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
