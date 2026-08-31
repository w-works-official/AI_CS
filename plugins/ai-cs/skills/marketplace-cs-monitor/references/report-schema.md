# Masked report schema

## Raw in-memory input

```js
{
  mode: "changes_today",
  range: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
  collected_at: "ISO-8601",
  duration_ms: 0,
  channels: {
    smartstore_comments: { market: "smartstore", channel: "comments", attempted: true, visible_total: 0, records: [] },
    smartstore_customer_qna: { market: "smartstore", channel: "customer_qna", attempted: true, visible_total: 0, records: [] },
    smartstore_customer_center: { market: "smartstore", channel: "customer_center", attempted: true, visible_total: 0, records: [] },
    smartstore_talktalk: { market: "smartstore", channel: "talktalk", attempted: true, visible_total: 0, records: [] },
    zigzag_order_inquiry: { market: "zigzag", channel: "order_inquiry", attempted: true, visible_total: 0, records: [] },
    zigzag_item_question: { market: "zigzag", channel: "item_question", attempted: true, visible_total: 0, records: [] },
    ably_inquiry: { market: "ably", channel: "inquiry", attempted: true, visible_total: 0, records: [] }
  }
}
```

Each channel may also provide `filter`, `sort`, `skipped_count`, `read_state_transition_count`, and `error`. Keep raw values in memory only. `read_state_transition_count` is normally zero and is used for Smartstore TalkTalk details opened while unread.

## Normalized masked record

Required fields:

- `market`, `channel`
- `source_key`: hashed logical identity
- `content_hash`: hash of masked content and response state
- `change_state`: `NEW`, `CHANGED`, or `UNCHANGED`
- `occurred_at`, `status`, `category`
- `customer_masked`
- `subject`, `preview`, `product_name`
- `source_url`, `source_url_kind`: an allowlisted HTTPS marketplace URL and `EXACT`, `LIST`, or `UNAVAILABLE`
- `source_reference`: a masked or hashed lookup label only; never a raw token, cookie, or credential
- `product_url`, `product_thumbnail_url`: optional allowlisted HTTPS marketplace URLs
- `order_no_masked`, `product_order_no_masked`
- `messages[]`, `seller_replies[]`
- `last_actor`: `customer`, `seller`, `automatic`, or `unknown`
- `reply_state`: `NEEDS_REPLY`, `ANSWERED`, `NO_REPLY`, or `REVIEW`
- `ai_draft`: empty unless an AI draft was explicitly generated
- `ai_draft_origin`: `AI` when populated
- `ai_draft_purpose`: `REPLY` for `NEEDS_REPLY`, or `EVAL` for an explicitly requested `ANSWERED` shadow evaluation
- `ai_draft_required_checks`: explicit human checks, or why no reference example was available
- `ai_draft_pii_scan`: `PASS` only after the generated text is scanned again
- `pii_scan`: `PASS` or `REVIEW`

`source_key` uses the stable marketplace ID when available. `content_hash` excludes collection time and run duration.
Link fields are excluded from `content_hash`, so a harmless route or filter change does not turn an otherwise unchanged inquiry into `CHANGED`. Reject non-HTTPS URLs, non-marketplace hosts, embedded credentials, authentication-like query keys or fragments, and query values containing an unmasked phone or email before writing the masked report.

## Channel report

Each channel returns:

- `attempted`
- `visible_total`
- `collected_count`
- `skipped_count`
- `new_count`
- `changed_count`
- `unchanged_count`
- `needs_reply_count`
- `read_state_transition_count`
- `error`

The top-level report also includes total duration, prepared count, duplicate count, missing-key/hash counts, `talktalk_read_state_transitions`, and `marketplace_write_actions: 0`. The write-action field covers prohibited operational actions; an authorized TalkTalk read marker is an explicitly reported observational side effect, not a reply or operational status action.

For deterministic stale-case reconciliation, each channel may also include only masked/hashed snapshot evidence:

- `open_queue_complete`: true only after the whole authoritative unanswered view was read and its count matched;
- `open_queue_scope` and `open_queue_window_start`: the marketplace window covered by the snapshot;
- `open_queue_visible_total` and `open_queue_observed_count`: these must match for a complete snapshot;
- `open_queue_source_keys[]`: hashed source keys only, never raw marketplace IDs.

An incomplete or mismatched snapshot cannot change a stored case. On the sync target, one consecutive absence becomes `REVIEW`, two becomes `CLOSED`, and a later reappearance becomes `NEEDS_REPLY`. `CLOSED` is a local review state only; it never closes anything in a marketplace and the original masked case/messages remain stored.

## Comparison boundary

Compare only records returned inside the same locked scope. A previous record absent from an ordinary collection is `NOT_SEEN`; do not archive, delete, or label it deleted. The only exception is the separate complete, count-matched unanswered-queue reconciliation contract described above.

Google Sheets or Notion persistence must store normalized masked records only. Keep human replies and `ai_draft` in separate columns so reviewers can always distinguish them. An `EVAL` draft remains comparison-only: it must not change `reply_state`, reply-needed counts, or the verified human-answer library.
