const ALLOWED_REVIEW_STATES = new Set(["APPROVED", "REJECTED"]);
const ALLOWED_REVIEW_KEYS = new Set(["draft_id", "draft_state", "review_note", "human_revision"]);

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function assertMaskedReviewText(value: string): void {
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(value)) throw new Error("UNMASKED_PHONE");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) throw new Error("UNMASKED_EMAIL");
  if (/\b\d{12,}\b/.test(value)) throw new Error("UNMASKED_LONG_NUMBER");
}

export function normalizeReviewRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REVIEW_REQUEST");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REVIEW_KEYS.has(key)) throw new Error(`REVIEW_PARAM_NOT_ALLOWED:${key}`);
  }
  const draftId = safeText(raw.draft_id, 300);
  const draftState = safeText(raw.draft_state, 20).toUpperCase();
  const reviewNote = safeText(raw.review_note, 1000);
  const humanRevision = safeText(raw.human_revision, 4000);
  if (!draftId) throw new Error("DRAFT_ID_REQUIRED");
  if (!ALLOWED_REVIEW_STATES.has(draftState)) throw new Error("INVALID_DRAFT_STATE");
  if (draftState === "APPROVED" && !humanRevision) throw new Error("HUMAN_REVISION_REQUIRED");
  assertMaskedReviewText(reviewNote);
  assertMaskedReviewText(humanRevision);
  return {
    action: "reviewDraft" as const,
    draft_id: draftId,
    draft_state: draftState as "APPROVED" | "REJECTED",
    review_note: reviewNote,
    human_revision: humanRevision,
  };
}

