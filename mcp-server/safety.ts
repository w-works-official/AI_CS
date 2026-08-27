import { createHash } from "node:crypto";
import type { SyncRunInput } from "./schemas.ts";

const piiPatterns = [
  { code: "UNMASKED_PHONE", pattern: /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/ },
  { code: "UNMASKED_EMAIL", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: "UNMASKED_LONG_NUMBER", pattern: /\b\d{10,}\b/ },
  { code: "UNMASKED_RESIDENT_ID", pattern: /\b\d{6}[- ]?[1-8]\d{6}\b/ },
];

function scanText(value: unknown, path: string): void {
  if (typeof value !== "string") return;
  for (const item of piiPatterns) {
    if (item.pattern.test(value)) throw new Error(`PII_SCAN_FAILED:${item.code}:${path}`);
  }
}

function walk(value: unknown, path = "report"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, `${path}.${key}`));
    return;
  }
  scanText(value, path);
}

export function assertSafeSync(input: SyncRunInput): void {
  const report = input.report;
  if (report.summary.marketplace_write_actions !== 0) throw new Error("MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED");
  if (report.summary.prepared_count !== report.records.length) throw new Error("REPORT_COUNT_MISMATCH");
  const stateTotal = report.summary.new_count + report.summary.changed_count + report.summary.unchanged_count;
  if (stateTotal !== report.records.length) throw new Error("REPORT_STATE_TOTAL_MISMATCH");
  const keys = report.records.map((record) => record.source_key);
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_SOURCE_KEY");
  for (const record of report.records) {
    if (record.customer_masked && !record.customer_masked.includes("*")) throw new Error("PII_SCAN_FAILED:CUSTOMER_NOT_MASKED");
    if (record.ai_draft && (record.ai_draft_origin !== "AI" || record.ai_draft_pii_scan !== "PASS")) {
      throw new Error("AI_DRAFT_SAFETY_CHECK_FAILED");
    }
  }
  walk(report);
}

export function assertMaskedHumanRevision(text: string): void {
  walk({ human_revision: text }, "review");
}

export function makeRunId(report: SyncRunInput["report"]): string {
  const identity = [
    report.collected_at,
    ...report.records.map((record) => `${record.source_key}:${record.content_hash}`),
  ].join("|");
  return `SYNC_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : "TOOL_FAILED";
  if (/https?:\/\//i.test(message) || /token|secret|api[_ -]?key/i.test(message)) return "TOOL_FAILED";
  return message.slice(0, 300);
}
