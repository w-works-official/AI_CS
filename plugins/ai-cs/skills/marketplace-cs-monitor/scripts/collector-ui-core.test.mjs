import assert from "node:assert/strict";
import {
  CHAT_ACTORS,
  assessChatHistoryLoad,
  detectAuthChallengeState,
  filterChatMessages,
  findLastValidCustomerTurn,
  isChatUiControlText,
  isDateInRange,
  isVerifiedEmptyGridState,
  normalizeChatActor,
  normalizeChatConversation,
  normalizeChatMessage,
  normalizeFlexibleDate,
  parseTalktalkTotalText,
  stripKnownActorPrefix,
} from "./collector-ui-core.mjs";

assert.equal(parseTalktalkTotalText("전체 64"), 64);
assert.equal(parseTalktalkTotalText("전체 (1,234건)"), 1234);
assert.equal(parseTalktalkTotalText("전체 문의 7개"), 7);
assert.equal(parseTalktalkTotalText("전체 메뉴"), null);
assert.equal(stripKnownActorPrefix("홍길동요 제품은 하나 가격이죠?", "홍길동"), "요 제품은 하나 가격이죠?");
assert.equal(stripKnownActorPrefix("홍길동 : 배송은 언제 오나요?", "홍길동"), "배송은 언제 오나요?");
assert.equal(stripKnownActorPrefix("배송은 언제 오나요?", "홍길동"), "배송은 언제 오나요?");
assert.equal(stripKnownActorPrefix("고*** 배송은 언제 오나요?", "고***"), "고*** 배송은 언제 오나요?");

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

assert.equal(normalizeChatActor("other_msg"), CHAT_ACTORS.CUSTOMER);
assert.equal(normalizeChatActor("my_msg"), CHAT_ACTORS.SELLER);
assert.equal(normalizeChatActor("notification"), CHAT_ACTORS.AUTOMATIC);
assert.equal(normalizeChatActor("day_separator"), CHAT_ACTORS.SYSTEM);
assert.equal(normalizeChatActor("unrecognized-css-class"), CHAT_ACTORS.UNKNOWN);

assert.deepEqual(normalizeChatMessage({
  direction: "my_msg",
  text: "  확인 후 안내드리겠습니다.  ",
  image_count: "2",
  at: " 오전 10:01 ",
}, 3), {
  direction: "seller",
  text: "확인 후 안내드리겠습니다.",
  image_count: 2,
  at: "오전 10:01",
  sequence: 3,
  actor: "SELLER",
  actor_raw: "my_msg",
  is_control: false,
});

const normalizedConversation = normalizeChatConversation([
  { direction: "system", text: "2026.09.01" },
  { class_name: "other_msg", text: "배송은 언제 되나요?", at: "10:00" },
  { class_name: "my_msg", text: "확인 중입니다.", at: "10:01" },
  { direction: "customer", text: "문의 종료하기", at: "10:02" },
  { direction: "customer", text: "오늘 출고 가능한가요?", at: "10:03" },
]);
assert.equal(normalizedConversation.conversation_complete, true);
assert.equal(normalizedConversation.conversation_incomplete_reason, "");
assert.equal(normalizedConversation.messages[1].actor, "CUSTOMER");
assert.equal(normalizedConversation.messages[2].actor, "SELLER");
assert.equal(normalizedConversation.last_customer_turn.text, "오늘 출고 가능한가요?");
assert.equal(normalizedConversation.last_customer_turn.message_index, 3);

const imageOnlyTurn = findLastValidCustomerTurn([
  { direction: "seller", text: "사진을 보내주세요" },
  { direction: "customer", text: "", image_count: 1 },
]);
assert.equal(imageOnlyTurn.ok, true);
assert.equal(imageOnlyTurn.image_only, true);
assert.equal(imageOnlyTurn.image_count, 1);

const incompleteHistory = normalizeChatConversation([
  { direction: "customer", text: "이전 대화가 더 있어요" },
], { has_more_history: true });
assert.equal(incompleteHistory.conversation_complete, false);
assert.equal(incompleteHistory.conversation_incomplete_reason, "HISTORY_NOT_FULLY_LOADED");
assert.equal(incompleteHistory.last_customer_turn.text, "이전 대화가 더 있어요");

const actorUncertain = normalizeChatConversation([
  { direction: "mystery-bubble", text: "누가 쓴 말인지 확인 필요" },
]);
assert.equal(actorUncertain.conversation_complete, false);
assert.equal(actorUncertain.conversation_incomplete_reason, "ACTOR_UNCERTAIN");

const noContent = normalizeChatConversation([{ direction: "customer", text: "문의 종료하기" }]);
assert.equal(noContent.conversation_complete, false);
assert.equal(noContent.conversation_incomplete_reason, "NO_CONTENT_MESSAGES");
assert.equal(noContent.last_customer_turn, null);
assert.equal(noContent.last_customer_turn_reason, "CUSTOMER_TURN_NOT_FOUND");

const systemOnly = normalizeChatConversation([{ direction: "system", text: "2026.09.01" }]);
assert.equal(systemOnly.conversation_complete, false);
assert.equal(systemOnly.conversation_incomplete_reason, "NO_CONTENT_MESSAGES");

assert.deepEqual(assessChatHistoryLoad({
  attempts: 6,
  stable_passes: 3,
  reached_boundary: true,
  loading: false,
  has_more_control: false,
  message_count: 12,
}), {
  complete: true,
  stop_reason: "",
  attempts: 6,
  message_count: 12,
  has_more_history: false,
});
assert.equal(assessChatHistoryLoad({ attempts: 30, stable_passes: 0 }).stop_reason, "HISTORY_LOAD_LIMIT");
assert.equal(assessChatHistoryLoad({ attempts: 3, stable_passes: 2, reached_boundary: true }).stop_reason, "HISTORY_NOT_FULLY_LOADED");

assert.equal(detectAuthChallengeState("https://accounts.example.com/login", ""), "LOGIN_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "2단계 인증 코드를 입력하세요"), "TWO_FACTOR_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "로봇이 아닙니다"), "CAPTCHA_REQUIRED");
assert.equal(detectAuthChallengeState("https://seller.example.com", "문의관리 로그인 기록"), "");

console.log("collector UI core: PASS");
