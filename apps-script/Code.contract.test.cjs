const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  Boolean,
  RegExp,
  isNaN,
  Utilities: {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    computeDigest(_algorithm, value) {
      return [...crypto.createHash("sha256").update(String(value)).digest()].map((byte) => byte > 127 ? byte - 256 : byte);
    },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/Code.gs`, "utf8"), context);

const record = {
  market: "smartstore",
  channel: "comments",
  source_key: "smartstore:comments:test",
  content_hash: "hash-1",
  occurred_at: "2026-08-25 10:00",
  status: "미답변",
  category: "상품 정보",
  customer_masked: "고***",
  subject: "길이 문의",
  preview: "8mm가 가능한가요?",
  product_id: "12345678901",
  product_name: "샘플 피어싱",
  order_no_masked: "2026****1234",
  messages: [{ direction: "customer", at: "2026-08-25 10:00", text: "8mm가 가능한가요?", image_count: 0 }],
  seller_replies: [],
  last_actor: "customer",
  reply_state: "NEEDS_REPLY",
  ai_draft: "안녕하세요. 옵션 확인 후 안내드리겠습니다.",
  ai_draft_origin: "AI",
  pii_scan: "PASS",
};

context.assertMaskedRecord_(record);
assert.throws(() => context.assertMaskedRecord_({ ...record, preview: "010-1234-5678" }), /UNMASKED_PHONE/);

const draft = context.prepareDraft_(record, [], {}, new Date("2026-08-25T01:01:00Z"), {});
assert.equal(draft.isNew, true);
assert.equal(draft.object.draft_text, record.ai_draft);
assert.equal(draft.object.draft_state, "READY");
assert.equal(draft.object.content_hash, undefined);

const caseObject = context.caseObjectFromRecord_(record, null, "NEW", draft.object, new Date("2026-08-25T01:01:00Z"));
assert.equal(caseObject.subject, record.subject);
assert.equal(caseObject.preview, record.preview);
assert.equal(caseObject.source_status, "미답변");
assert.equal(caseObject.reply_required, true);
assert.equal(caseObject.ai_draft_state, "READY");
assert.equal(caseObject.active_ai_draft_preview, record.ai_draft);
assert.equal(caseObject.title, undefined);

const messages = context.prepareMessages_(record, new Date("2026-08-25T01:01:00Z"));
assert.equal(messages.length, 1);
assert.match(messages[0].message_key, /^MSG2:/);
assert.equal(messages[0].actor_type, "CUSTOMER");
assert.equal(messages[0].message_text_masked, "8mm가 가능한가요?");
assert.equal(messages[0].message_id, undefined);

const repeated = context.prepareMessages_({
  ...record,
  messages: [
    { source_message_id: '_msgId1', direction: 'customer', at: '오전 10:00', text: '네', image_count: 0 },
    { source_message_id: '_msgId2', direction: 'customer', at: '오전 10:00', text: '네', image_count: 0 },
  ],
}, new Date('2026-08-25T01:01:00Z'));
assert.equal(repeated.length, 2);
assert.notEqual(repeated[0].message_key, repeated[1].message_key);

assert.equal(context.mapReplyState_("NO_REPLY"), "NO_REPLY_REQUIRED");
assert.equal(context.channelInfo_("zigzag", "item_question").channel, "상품 문의");

console.log("Pink Rocket CS Apps Script sync contract: PASS");
