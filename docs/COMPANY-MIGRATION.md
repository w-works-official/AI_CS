# Company account migration checklist

Do not perform this checklist until development acceptance and explicit production approval.

## Prepare without switching traffic

- [ ] Development tests, including PII rejection and idempotent replay, are green.
- [ ] The company uses a separate OAuth client and a company-controlled identity.
- [ ] The company subject appears only in `AI_CS_PROD_ALLOWED_SUBJECTS`.
- [ ] `Pink Rocket CS 운영 데이터 v1` has the required schema, including a distinct `human_revision` column in `03_AI_DRAFTS`.
- [ ] A separate production Apps Script deployment has `CS_ENVIRONMENT=production`, a production-only `CS_API_KEY`, the production Sheet ID, and `CS_PRODUCTION_ENABLED=true`.
- [ ] No development key, URL, Sheet ID, test row, OAuth subject, or OAuth client is reused.
- [ ] Backup/export and rollback ownership are recorded.

## Approved production cutover

- [ ] Register the production Apps Script URL/key as Sites production secrets.
- [ ] Set `AI_CS_PRODUCTION_ENABLED=true` only after the values above exist.
- [ ] Connect the same private HTTPS MCP URL from the company ChatGPT account and authenticate with the company identity.
- [ ] Create a company-local `.app.json` from `.app.example.json`; do not copy the personal account's `plugin_asdk_app...` registration.
- [ ] Install the same `plugins/ai-cs` package privately; do not submit it publicly.
- [ ] Call `get_cs_health` and require `environment=production` before any other tool.
- [ ] Run health and read-only tools first. Confirm the development identity is denied production access.
- [ ] Perform the first write with one synthetic, masked, reversible test case approved for the production Sheet.
- [ ] Replay the same `run_id` and require `duplicate_run=true` with zero inserted rows.
- [ ] Confirm the review UI labels `production` and contains no development records.
- [ ] Confirm `auto_send=false`, `marketplace_write_actions=0`, and no marketplace response was typed or sent.

## Rollback

Disable `AI_CS_PRODUCTION_ENABLED`, revoke the company OAuth connection if necessary, and rotate the production Apps Script key. Do not point production identities at the development Sheet as a fallback.
