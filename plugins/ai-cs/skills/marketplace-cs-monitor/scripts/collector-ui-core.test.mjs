import assert from "node:assert/strict";
import { detectAuthChallengeState, filterChatMessages, isChatUiControlText, parseTalktalkTotalText } from "./collector-ui-core.mjs";

assert.equal(parseTalktalkTotalText("전체 64"), 64);
assert.equal(parseTalktalkTotalText("전체 (1,234건)"), 1234);
assert.equal(parseTalktalkTotalText("전체 문의 7개"), 7);
assert.equal(parseTalktalkTotalText("전체 메뉴"), null);

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
