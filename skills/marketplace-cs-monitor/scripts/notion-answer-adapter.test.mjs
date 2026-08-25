import assert from "node:assert/strict";
import { notionPageToAnswerRecords, parseMessageFlow } from "./notion-answer-adapter.mjs";

const page = JSON.stringify({ text: `<page><properties>
{"원본키":"talk:test","채널":"톡톡 상담","분류":"옵션변경 문의","상품명":"테스트 피어싱","date:발생일:start":"2026-08-20","url":"https://app.notion.com/test"}
</properties><content>
## 메시지 흐름
### 1. 고객 · 오전 9:00
\`\`\`plain text
0.8mm 바로 변경 가능한가요?
\`\`\`
### 2. 판매자
\`\`\`plain text
안녕하세요
\`\`\`
### 3. 판매자 · 오전 9:10
\`\`\`plain text
해당 상품은 0.8mm 바로 변경 가능합니다.
\`\`\`
### 4. 고객
\`\`\`plain text
네 감사합니다
\`\`\`
</content></page>` });

assert.equal(parseMessageFlow(page).length, 4);
const result = notionPageToAnswerRecords(page);
assert.equal(result.records.length, 1);
assert.equal(result.records[0].source_key, "talk:test:pair:1");
assert.match(result.records[0].seller_replies[0].text, /변경 가능합니다/);

console.log("marketplace-cs-monitor notion answer adapter: PASS");

const postPage = `## 문의 정보
- 채널: 문의 관리
## 문의 내용
\`\`\`text
낱개로 한 개만 오는 상품인가요?
\`\`\`
## 기존 답변
### 답변 1
\`\`\`text
네, 해당 옵션은 낱개 한 개 구성입니다.
\`\`\``;
const post = notionPageToAnswerRecords(postPage, { source_key: "comment:test", channel: "문의 관리" });
assert.equal(post.records.length, 1);
assert.match(post.records[0].messages[0].text, /낱개/);
