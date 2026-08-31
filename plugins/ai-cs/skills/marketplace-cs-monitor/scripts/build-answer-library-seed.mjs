import fs from "node:fs";
import readline from "node:readline";
import { buildAnswerLibrary } from "./answer-library-core.mjs";
import { notionPageToAnswerRecords } from "./notion-answer-adapter.mjs";

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const input = arg("input");
const output = arg("output");
const dataSourceId = arg("data-source", "c8eca414-a4e1-42ea-bc86-46796aa172cf");
const perIntent = Math.max(1, Number(arg("per-intent", "15")) || 15);
if (!input) throw new Error("--input is required");

function parseCreateResult(payload) {
  const text = payload?.result?.Ok?.content?.find?.((block) => block?.type === "text")?.text;
  if (!text) return [];
  try { return JSON.parse(text).pages ?? []; } catch { return []; }
}

const records = [];
const sourcePages = new Set();
let createCalls = 0;
const reader = readline.createInterface({ input: fs.createReadStream(input, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of reader) {
  if (!line.includes("notion.notion-create-pages")) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const payload = event?.payload;
  if (payload?.type !== "mcp_tool_call_end" || payload?.invocation?.tool !== "notion.notion-create-pages") continue;
  const invocation = payload.invocation.arguments ?? {};
  if (invocation?.parent?.data_source_id !== dataSourceId) continue;
  createCalls += 1;
  const pages = invocation.pages ?? [];
  const created = parseCreateResult(payload);
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index] ?? {};
    const properties = page.properties ?? {};
    const createdPage = created[index] ?? {};
    const sourceKey = String(properties["원본키"] ?? "").trim();
    if (!sourceKey || sourcePages.has(sourceKey) || properties["기존답변"] !== "__YES__") continue;
    sourcePages.add(sourceKey);
    const parsed = notionPageToAnswerRecords(page.content ?? "", {
      source_key: sourceKey,
      channel: properties["채널"],
      category: properties["분류"],
      product_name: properties["상품명"],
      occurred_at: properties["date:발생일:start"],
      url: createdPage.url ?? "",
    });
    for (const record of parsed.records) {
      record.source_url = createdPage.url ?? "";
      records.push(record);
    }
  }
}

const built = buildAnswerLibrary(records, { verifiedAt: new Date().toISOString() });
const deduped = [...new Map(built.map((entry) => [entry.answer_hash, entry])).values()];
for (const entry of deduped) {
  entry.quality_state = entry.risk_level === "STANDARD" ? "USE" : "REVIEW";
  entry.note = "노션 3개월 사람답변에서 생성 · AI 자동 전송 금지";
}

const grouped = new Map();
for (const entry of deduped) {
  if (!grouped.has(entry.intent)) grouped.set(entry.intent, []);
  grouped.get(entry.intent).push(entry);
}
const score = (entry) => {
  const question = String(entry.customer_question ?? "");
  const answer = String(entry.human_answer ?? "");
  let value = entry.quality_state === "USE" ? 50 : 10;
  if (question.length >= 10 && question.length <= 500) value += 10;
  if (answer.length >= 20 && answer.length <= 800) value += 10;
  if (/불편|죄송/.test(answer) && entry.risk_level === "REVIEW_REQUIRED") value += 3;
  if (/도와드릴 수 없|어쩔 수|매정|기재되어있는 기준/.test(answer)) value -= 30;
  return value;
};

const selected = [];
for (const entries of grouped.values()) {
  entries.sort((a, b) => score(b) - score(a) || String(b.source_reply_at).localeCompare(String(a.source_reply_at)));
  selected.push(...entries.slice(0, perIntent));
}
selected.sort((a, b) => a.intent.localeCompare(b.intent) || b.quality_state.localeCompare(a.quality_state));

const stats = {
  create_calls: createCalls,
  answered_source_pages: sourcePages.size,
  extracted_turn_pairs: records.length,
  pii_safe_unique_pairs: deduped.length,
  curated_examples: selected.length,
  curated_use: selected.filter((entry) => entry.quality_state === "USE").length,
  curated_review: selected.filter((entry) => entry.quality_state === "REVIEW").length,
  by_intent: Object.fromEntries([...grouped].map(([intent, entries]) => [intent, { total: entries.length, selected: Math.min(entries.length, perIntent) }])),
};

const result = { stats, entries: selected };
if (output) fs.writeFileSync(output, JSON.stringify(result), "utf8");
console.log(JSON.stringify(stats));
