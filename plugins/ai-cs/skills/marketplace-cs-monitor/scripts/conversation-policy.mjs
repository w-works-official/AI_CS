const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function normalizeAcknowledgementText(value) {
  return compact(value)
    .replace(/[,.!~，♡♥️😊🙂👍🙏]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/네에+/g, "네")
    .replace(/감사합니다[아앙]+$/g, "감사합니다")
    .replace(/고맙습니다[아앙]+$/g, "고맙습니다")
    .trim();
}

const ACKNOWLEDGEMENT_TOKENS = new Set([
  "네", "네네", "넵", "넵넵", "넹", "예", "아", "아하",
  "확인", "확인했습니다", "확인했어요", "알겠습니다", "잘", "좋아요",
  "감사", "감사합니다", "고맙습니다",
]);

export function isCustomerAcknowledgement(value) {
  const text = normalizeAcknowledgementText(value);
  if (!text || text.length > 40 || /[?？]/.test(String(value ?? ""))) return false;
  const tokens = text.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => ACKNOWLEDGEMENT_TOKENS.has(token));
}

export { normalizeAcknowledgementText };
