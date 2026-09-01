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
