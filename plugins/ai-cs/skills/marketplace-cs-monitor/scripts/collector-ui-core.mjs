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

export function detectAuthChallengeState(urlValue, visibleTextValue) {
  const url = compact(urlValue).toLowerCase();
  const visibleText = compact(visibleTextValue);
  if (/captcha|recaptcha/.test(url) || /자동\s*입력\s*방지|로봇이\s*아닙니다|보안\s*문자/.test(visibleText)) return "CAPTCHA_REQUIRED";
  if (/two.?factor|2fa|otp|verification/.test(url) || /2단계\s*인증|인증\s*코드|일회용\s*비밀번호/.test(visibleText)) return "TWO_FACTOR_REQUIRED";
  if (/account.?verify|identity.?verify/.test(url) || /계정\s*확인|본인\s*확인|추가\s*인증/.test(visibleText)) return "ACCOUNT_VERIFICATION_REQUIRED";
  if (/login|signin|sign-in|\/auth(?:[/?#]|$)/.test(url) || /다시\s*로그인|로그인이\s*필요|아이디\s*비밀번호/.test(visibleText)) return "LOGIN_REQUIRED";
  return "";
}
