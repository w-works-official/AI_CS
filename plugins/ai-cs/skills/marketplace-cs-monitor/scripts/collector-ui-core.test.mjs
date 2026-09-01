import assert from "node:assert/strict";
import {
  detectAuthChallengeState,
  filterChatMessages,
  isChatUiControlText,
  isDateInRange,
  isVerifiedEmptyGridState,
  normalizeFlexibleDate,
  parseTalktalkTotalText,
} from "./collector-ui-core.mjs";

assert.equal(parseTalktalkTotalText("전체 64"), 64);
assert.equal(parseTalktalkTotalText("전체 (1,234건)"), 1234);
assert.equal(parseTalktalkTotalText("전체 문의 7개"), 7);
assert.equal(parseTalktalkTotalText("전체 메뉴"), null);

assert.equal(normalizeFlexibleDate("2026.08.25 15:29:28", "2026-09-01"), "2026-08-25");
assert.equal(normalizeFlexibleDate("2026/9/1 오전 10:20", "2026-09-01"), "2026-09-01");
assert.equal(normalizeFlexibleDate("어제", "2026-09-01"), "2026-08-31");
assert.equal(isDateInRange("2026.08.25 15:29:28", { start: "2026-09-01", end: "2026-09-01" }), false);
assert.equal(isDateInRange("2026.09.01 09:30:00", { start: "2026-09-01", end: "2026-09-01" }), true);

assert.equal(isVerifiedEmptyGridState({ gridVisible: true, headerCount: 8, rowCount: 0, loadingVisible: false }), true);
assert.equal(isVerifiedEmptyGridState({ gridVisible: false, headerCount: 8, rowCount: 0, loadingVisible: false }), false);
assert.equal(isVerifiedEmptyGridState({ gridVisible: true, headerCount: 0, rowCount: 0, loadingVisible: false }), false);
assert.equal(isVerifiedEmptyGridState({ gridVisible: true, headerCount: 8, rowCount: 0, loadingVisible: true }), false);

assert.equal(isChatUiControlText(" 문의 종료하기 "), true);
assert.equal(isChatUiControlText("배송 문의 종료하기 부탁드려요"), false);
assert.deepEqual(filterChatMessages([
  { direction: "customer", text: "배송은 언제 되나요?", image_count: 0 },
  { direction: "customer", text: "문의 종료하기", image_count: 0 },
  { direction: "customer", text: "", image_count: 1 },
]), [
  { direction: "customer", text: "배송은 언제 되나요?", image_count: 0 },
  { direction: "customer", text: "", image_count: 1 },
]);

assert.equal(detectAuthChallengeState("https://accounts.example.com/login", ""), "LOGIN_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "2단계 인증 코드를 입력하세요"), "TWO_FACTOR_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "로봇이 아닙니다"), "CAPTCHA_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "문의관리 로그인 기록"), "");

console.log("collector UI core: PASS");
