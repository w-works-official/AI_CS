import assert from "node:assert/strict";
import { filterChatMessages, isChatUiControlText, parseTalktalkTotalText } from "./collector-ui-core.mjs";

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

console.log("collector UI core: PASS");
