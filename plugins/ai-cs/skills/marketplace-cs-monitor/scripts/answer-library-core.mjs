import { createHash } from "node:crypto";
import { maskSensitiveText } from "./report-core.mjs";
import { isCustomerAcknowledgement } from "./conversation-policy.mjs";

export const ANSWER_LIBRARY_HEADERS = [
  "example_id",
  "enabled",
  "quality_state",
  "risk_level",
  "intent",
  "market",
  "channel",
  "category",
  "customer_question",
  "product_name",
  "human_answer",
  "required_checks",
  "keywords",
  "source_case_key",
  "source_url",
  "source_reply_at",
  "last_verified_at",
  "pii_scan",
  "answer_hash",
  "note",
];

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

const STOPWORDS = new Set([
  "고객님", "안녕하세요", "감사합니다", "문의", "문의주신", "제품", "상품", "경우", "확인", "부탁드립니다",
  "다른", "언제든지", "말씀해주세요", "좋은", "하루", "이용해주셔서", "관련", "현재", "가능", "합니다",
]);

function hasUnmaskedPii(value) {
  const text = compact(value);
  return /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b\d{12,}\b/.test(text)
    || /(?:계좌|은행|입금자|주문번호|송장번호|운송장|주소)/.test(text)
    || /[가-힣]{2,4}\s*(?:이름으로|명의로|입금(?:했|드렸))/.test(text)
    || (text.match(/\d/g)?.length ?? 0) >= 10 && /[- ]/.test(text);
}

function isGenericAnswer(value) {
  const text = compact(value);
  if (text.length < 10 || isCustomerAcknowledgement(text)) return true;
  return /^(안녕하세요\s*)?(확인|처리|전달)(했습니다|하겠습니다|드리겠습니다)?[.!~ ]*$/.test(text)
    || /어떤\s*(제품|상품).*말씀하시는걸까요/.test(text)
    || /제품명.*(?:알려|말씀).*주세요/.test(text);
}

export function classifyIntent(value, fallback = "") {
  const text = compact(`${fallback} ${value}`);
  const rules = [
    ["교환·반품", /교환|반품|회수|착불/],
    ["배송", /배송|출고|발송|도착|누락|택배/],
    ["옵션·바변경", /바변경|바 변경|바길이|바 길이|라블렛|얇은\s*바|0\.8\s*mm|옵션변경/],
    ["재고·입고", /재입고|입고|품절|재고|단종/],
    ["가격·구성", /낱개|세트|수량|몇\s*개|가격|금액/],
    ["상품하자", /하자|불량|변색|내구성|파손/],
    ["취소·환불", /취소|환불|입금/],
  ];
  const matched = rules.find(([, pattern]) => pattern.test(text))?.[0];
  if (matched) return matched;
  const fallbackText = compact(fallback);
  if (/결제/.test(fallbackText)) return "취소·환불";
  if (/상품|사이즈|기타/.test(fallbackText)) return "상품정보";
  return fallbackText || "상품정보";
}

export function requiredChecksFor(intent) {
  const checks = {
    "교환·반품": "접수 상태 · 회수 방식 · 비용 정책 확인",
    "배송": "실제 주문 · 출고 · 배송 상태 확인",
    "옵션·바변경": "상품별 바변경 가능 여부 · 주문 옵션 확인",
    "재고·입고": "실재고 · 재입고 · 단종 여부 확인",
    "가격·구성": "판매 단위 · 옵션 · 현재 가격 확인",
    "상품하자": "사진 · 주문내역 · 교환/보상 정책 확인",
    "취소·환불": "접수 상태 · 환불 수단 · 금액 · 처리기한 확인",
  };
  return checks[intent] ?? "상품 상세정보 · 주문 상태 · 현재 운영정책 확인";
}

function riskLevelFor(intent, text) {
  if (/환불|입금|보상|책임|계좌|무료|착불|교환|반품|취소|회수|처리|전달/.test(compact(text))) return "REVIEW_REQUIRED";
  if (["배송", "재고·입고", "상품하자", "취소·환불"].includes(intent)) return "REVIEW_REQUIRED";
  return "STANDARD";
}

export function extractKeywords(value, limit = 12) {
  const tokens = compact(value).toLowerCase().match(/[가-힣a-z0-9.]{2,}/g) ?? [];
  const unique = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token) || unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= limit) break;
  }
  return unique;
}

function deriveQuestionAndAnswer(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const replies = Array.isArray(record?.seller_replies) ? record.seller_replies : [];
  const customerIndexes = messages
    .map((message, index) => message?.direction === "customer" && !isCustomerAcknowledgement(message?.text) ? index : -1)
    .filter((index) => index >= 0);
  const lastCustomerIndex = customerIndexes.at(-1) ?? -1;
  const customerMessage = lastCustomerIndex >= 0 ? messages[lastCustomerIndex] : null;

  if (replies.length) {
    return {
      question: compact(customerMessage?.text ?? record?.preview ?? record?.subject),
      answer: compact(replies.at(-1)?.text),
      replyAt: compact(replies.at(-1)?.at),
    };
  }

  if (lastCustomerIndex < 0) return null;
  const sellerMessages = messages.slice(lastCustomerIndex + 1).filter((message) => message?.direction === "seller" && compact(message?.text));
  if (!sellerMessages.length) return null;
  return {
    question: compact(customerMessage?.text),
    answer: compact(sellerMessages.map((message) => message.text).join("\n")),
    replyAt: compact(sellerMessages.at(-1)?.at),
  };
}

export function buildAnswerLibrary(records, { verifiedAt = new Date().toISOString() } = {}) {
  const entries = [];
  const seen = new Set();

  for (const record of records ?? []) {
    if (record?.reply_state !== "ANSWERED" || record?.pii_scan !== "PASS") continue;
    const pair = deriveQuestionAndAnswer(record);
    if (!pair?.question || !pair?.answer || isCustomerAcknowledgement(pair.question) || isGenericAnswer(pair.answer)) continue;

    const question = maskSensitiveText(pair.question);
    const answer = maskSensitiveText(pair.answer);
    if (hasUnmaskedPii(question) || hasUnmaskedPii(answer)) continue;

    const intent = classifyIntent(`${question} ${answer}`, record?.category);
    const answerHash = sha256(`${question}|${answer}`);
    const exampleId = `ANS_${sha256(`${record?.source_key}|${answerHash}`).slice(0, 24)}`;
    if (seen.has(exampleId)) continue;
    seen.add(exampleId);

    entries.push({
      example_id: exampleId,
      enabled: true,
      quality_state: "USE",
      risk_level: riskLevelFor(intent, `${question} ${answer}`),
      intent,
      market: compact(record?.market).toUpperCase(),
      channel: compact(record?.channel),
      category: compact(record?.category),
      customer_question: question,
      product_name: maskSensitiveText(record?.product_name),
      human_answer: answer,
      required_checks: requiredChecksFor(intent),
      keywords: extractKeywords(`${question} ${record?.product_name} ${record?.category}`).join(", "),
      source_case_key: compact(record?.source_key),
      source_url: compact(record?.source_url ?? record?.notion_url),
      source_reply_at: pair.replyAt,
      last_verified_at: compact(verifiedAt),
      pii_scan: "PASS",
      answer_hash: answerHash,
      note: "검증된 사람답변에서 생성 · 자동 전송 금지",
    });
  }

  return entries;
}

export function toSheetRows(entries, { includeHeader = true } = {}) {
  const rows = (entries ?? []).map((entry) => ANSWER_LIBRARY_HEADERS.map((header) => entry?.[header] ?? ""));
  return includeHeader ? [ANSWER_LIBRARY_HEADERS, ...rows] : rows;
}

export function parseSheetRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const headers = rows[0].map(compact);
  return rows.slice(1).filter((row) => row.some((value) => compact(value))).map((row) => {
    const entry = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    entry.enabled = entry.enabled === true || /^(true|use|yes|1)$/i.test(compact(entry.enabled));
    return entry;
  });
}

function overlapScore(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  const matches = queryTokens.filter((token) => candidate.has(token)).length;
  return matches / Math.max(queryTokens.length, candidate.size);
}

export function retrieveAnswerExamples(inquiry, entries, { limit = 3, minScore = 4 } = {}) {
  const queryText = compact(`${inquiry?.category} ${inquiry?.subject} ${inquiry?.preview} ${inquiry?.product_name}`);
  const queryIntent = classifyIntent(queryText, inquiry?.category);
  const queryTokens = extractKeywords(queryText, 24);

  return (entries ?? [])
    .filter((entry) => entry?.enabled === true && entry?.quality_state === "USE" && entry?.pii_scan === "PASS")
    .map((entry) => {
      let score = 0;
      const reasons = [];
      if (entry.intent === queryIntent) { score += 12; reasons.push("같은 문의유형"); }
      if (compact(entry.market).toUpperCase() === compact(inquiry?.market).toUpperCase()) { score += 2; reasons.push("같은 마켓"); }
      if (compact(entry.channel) === compact(inquiry?.channel)) { score += 2; reasons.push("같은 채널"); }
      const overlap = overlapScore(queryTokens, extractKeywords(`${entry.customer_question} ${entry.product_name} ${entry.keywords}`, 24));
      score += Math.round(overlap * 10);
      if (overlap > 0) reasons.push("질문 키워드 유사");
      return { ...entry, score, matched_reasons: reasons };
    })
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || compact(b.last_verified_at).localeCompare(compact(a.last_verified_at)))
    .slice(0, Math.max(1, limit));
}

export function buildDraftContext(inquiry, entries, options = {}) {
  const examples = retrieveAnswerExamples(inquiry, entries, options);
  return {
    inquiry: {
      market: compact(inquiry?.market),
      channel: compact(inquiry?.channel),
      category: compact(inquiry?.category),
      subject: maskSensitiveText(inquiry?.subject),
      preview: maskSensitiveText(inquiry?.preview),
      product_name: maskSensitiveText(inquiry?.product_name),
    },
    examples: examples.map((entry) => ({
      example_id: entry.example_id,
      intent: entry.intent,
      risk_level: entry.risk_level,
      customer_question: entry.customer_question,
      human_answer: entry.human_answer,
      required_checks: entry.required_checks,
      score: entry.score,
    })),
    required_checks: [...new Set(examples.map((entry) => entry.required_checks).filter(Boolean))],
    generation_policy: [
      "참고답변의 말투와 검증된 절차만 참고하고 고객별 식별정보는 복사하지 않습니다.",
      "가격·재고·주문·배송·환불 상태는 현재 화면에서 확인되지 않으면 단정하지 않습니다.",
      "AI 추천답변으로 표시하고 사람이 검토하기 전에는 전송하지 않습니다.",
    ],
    reference_ids: examples.map((entry) => entry.example_id),
  };
}
