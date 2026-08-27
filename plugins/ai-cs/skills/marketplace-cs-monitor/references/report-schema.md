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
- `order_no_masked`, `product_order_no_masked`
- `messages[]`, `seller_replies[]`
- `last_actor`: `customer`, `seller`, `automatic`, or `unknown`
- `reply_state`: `NEEDS_REPLY`, `ANSWERED`, `NO_REPLY`, or `REVIEW`
- `ai_draft`: empty unless an AI draft was explicitly generated
- `ai_draft_origin`: `AI` when populated
- `pii_scan`: `PASS` or `REVIEW`

`source_key` uses the stable marketplace ID when available. `content_hash` excludes collection time and run duration.

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

## Comparison boundary

Compare only records returned inside the same locked scope. A previous record absent from the current scope is `NOT_SEEN`; do not archive, delete, or label it deleted.

Google Sheets or Notion persistence must store normalized masked records only. Keep human replies and `ai_draft` in separate columns so reviewers can always distinguish them.
