import { z } from "zod";

const shortText = z.string().max(500);
const maskedText = z.string().max(20_000);
const dateText = z.string().max(64);

export const channelKeySchema = z.enum([
  "smartstore_comments",
  "smartstore_customer_qna",
  "smartstore_customer_center",
  "smartstore_talktalk",
  "zigzag_order_inquiry",
  "zigzag_item_question",
  "ably_inquiry",
]);

export const messageSchema = z.object({
  direction: z.enum(["customer", "seller", "automatic", "system", "unknown"]),
  at: dateText,
  text: maskedText,
  image_count: z.number().int().min(0).max(100),
}).strict();

export const sellerReplySchema = z.object({
  at: dateText,
  text: maskedText,
}).strict();

export const maskedRecordSchema = z.object({
  market: z.enum(["smartstore", "zigzag", "ably"]),
  channel: z.enum(["comments", "customer_qna", "customer_center", "talktalk", "order_inquiry", "item_question", "inquiry"]),
  source_key: z.string().regex(/^(smartstore|zigzag|ably):[a-z_]+:[a-f0-9]{24}$/),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  change_state: z.enum(["NEW", "CHANGED", "UNCHANGED"]),
  occurred_at: dateText,
  status: shortText,
  category: shortText,
  customer_masked: z.string().max(300),
  subject: maskedText,
  preview: maskedText,
  product_id: shortText.optional().default(""),
  product_name: maskedText,
  order_no_masked: shortText,
  product_order_no_masked: shortText,
  messages: z.array(messageSchema).max(500),
  seller_replies: z.array(sellerReplySchema).max(500),
  last_actor: z.enum(["customer", "seller", "automatic", "system", "unknown"]),
  reply_state: z.enum(["NEEDS_REPLY", "ANSWERED", "NO_REPLY", "REVIEW"]),
  ai_draft: maskedText,
  ai_draft_origin: z.union([z.literal("AI"), z.literal("")]),
  ai_draft_required_checks: maskedText.optional().default(""),
  ai_draft_pii_scan: z.enum(["PASS", "REVIEW"]),
  pii_scan: z.literal("PASS"),
}).strict();

export const channelReportSchema = z.object({
  attempted: z.boolean(),
  visible_total: z.number().int().min(0),
  collected_count: z.number().int().min(0),
  skipped_count: z.number().int().min(0),
  new_count: z.number().int().min(0),
  changed_count: z.number().int().min(0),
  unchanged_count: z.number().int().min(0),
  needs_reply_count: z.number().int().min(0),
  read_state_transition_count: z.number().int().min(0),
  error: z.string().max(1000),
  filter: shortText.optional().default(""),
  sort: shortText.optional().default(""),
}).strict();

export const maskedReportSchema = z.object({
  schema_version: z.literal(1),
  mode: z.enum(["changes_today", "today", "manual_test"]),
  range: z.object({ start: z.string().max(32).optional(), end: z.string().max(32).optional() }).strict(),
  collected_at: dateText,
  duration_ms: z.number().int().min(0).max(86_400_000),
  summary: z.object({
    prepared_count: z.number().int().min(0).max(2_000),
    new_count: z.number().int().min(0),
    changed_count: z.number().int().min(0),
    unchanged_count: z.number().int().min(0),
    needs_reply_count: z.number().int().min(0),
    duplicate_count: z.literal(0),
    missing_key_count: z.literal(0),
    missing_hash_count: z.literal(0),
    talktalk_read_state_transitions: z.number().int().min(0),
    marketplace_write_actions: z.literal(0),
  }).strict(),
  channels: z.object({
    smartstore_comments: channelReportSchema,
    smartstore_customer_qna: channelReportSchema,
    smartstore_customer_center: channelReportSchema,
    smartstore_talktalk: channelReportSchema,
    zigzag_order_inquiry: channelReportSchema,
    zigzag_item_question: channelReportSchema,
    ably_inquiry: channelReportSchema,
  }).strict(),
  records: z.array(maskedRecordSchema).max(2_000),
}).strict();

export const overviewInputSchema = z.object({}).strict();

export const listCasesInputSchema = z.object({
  record_type: z.enum(["LIVE"]).optional(),
  market: z.enum(["SMARTSTORE", "ZIGZAG", "ABLY"]).optional(),
  channel: z.string().max(100).optional(),
  ui_type: z.enum(["CHAT", "POST"]).optional(),
  reply_state: z.enum(["NEEDS_REPLY", "ANSWERED", "NO_REPLY_REQUIRED", "REVIEW"]).optional(),
  ai_draft_state: z.enum(["NONE", "READY", "APPROVED", "REJECTED", "USED"]).optional(),
  limit: z.number().int().min(1).max(50).default(50),
  cursor: z.number().int().min(0).default(0),
}).strict();

export const getCaseInputSchema = z.object({
  case_key: z.string().min(1).max(200),
}).strict();

export const searchAnswersInputSchema = z.object({
  query: z.string().min(2).max(500),
  market: z.enum(["SMARTSTORE", "ZIGZAG", "ABLY"]).optional(),
  channel: z.string().max(100).optional(),
  intent: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(3).default(3),
}).strict();

export const syncRunInputSchema = z.object({
  run_id: z.string().regex(/^SYNC_[a-f0-9]{24}$/).optional(),
  report: maskedReportSchema,
  model: z.string().min(1).max(100).default("Codex"),
  prompt_version: z.string().min(1).max(100).default("marketplace-cs-monitor-v1"),
}).strict();

export const reviewDraftInputSchema = z.object({
  draft_id: z.string().min(1).max(300),
  draft_state: z.enum(["APPROVED", "REJECTED", "USED"]),
  review_note: z.string().max(1_000).default(""),
  human_revision: maskedText.optional().default(""),
}).strict();

export const environmentOutputSchema = z.object({
  environment: z.enum(["development", "production"]),
  auto_send: z.literal(false),
  marketplace_write_actions: z.literal(0),
  browser_collection: z.literal("LOCAL_CHROME_PLUGIN_REQUIRED"),
});

export const healthOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  service: z.string(),
  schema_version: z.string(),
  write_policy: z.string(),
});

export const overviewOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  total_live: z.number().int().min(0),
  needs_reply: z.number().int().min(0),
  answered: z.number().int().min(0),
  review: z.number().int().min(0),
  no_reply_required: z.number().int().min(0),
  ai_ready: z.number().int().min(0),
  by_market: z.record(z.string(), z.number().int().min(0)),
});

const caseSummarySchema = z.object({
  case_key: z.string(),
  record_type: z.string(),
  market: z.string(),
  channel: z.string(),
  ui_type: z.string(),
  occurred_at: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  customer_masked: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  subject: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  preview: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  reply_state: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  ai_draft_state: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).passthrough();

export const listCasesOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  total: z.number().int().min(0),
  cursor: z.number().int().min(0),
  next_cursor: z.number().int().min(0).nullable(),
  items: z.array(caseSummarySchema),
});

export const getCaseOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  case: caseSummarySchema,
  messages: z.array(z.record(z.string(), z.unknown())),
  drafts: z.array(z.record(z.string(), z.unknown())),
  human_reply_source: z.literal("MARKETPLACE_ONLY"),
});

const verifiedAnswerSchema = z.object({
  example_id: z.string(),
  intent: z.string(),
  market: z.string(),
  channel: z.string(),
  risk_level: z.enum(["STANDARD", "REVIEW_REQUIRED"]),
  customer_question: z.string(),
  product_name: z.string(),
  human_answer: z.string(),
  required_checks: z.string(),
  score: z.number(),
  last_verified_at: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).strict();

export const searchAnswersOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  reference_source: z.literal("VERIFIED_HUMAN_ANSWER_ONLY"),
  examples: z.array(verifiedAnswerSchema).max(3),
});

export const syncRunOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  run_id: z.string(),
  duplicate_run: z.boolean(),
  prepared_count: z.number().int().min(0).optional(),
  inserted_cases: z.number().int().min(0),
  updated_cases: z.number().int().min(0),
  inserted_messages: z.number().int().min(0),
  inserted_drafts: z.number().int().min(0),
});

export const reviewDraftOutputSchema = environmentOutputSchema.extend({
  ok: z.boolean(),
  draft_id: z.string(),
  case_key: z.string(),
  draft_state: z.enum(["APPROVED", "REJECTED", "USED"]),
  reviewed_at: z.string(),
  reply_state_changed: z.literal(false),
  human_revision_saved: z.boolean(),
});

export type SyncRunInput = z.infer<typeof syncRunInputSchema>;
export type ReviewDraftInput = z.infer<typeof reviewDraftInputSchema>;
