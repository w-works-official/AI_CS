# Cloudflare Workers Free development MCP

## Boundary

This document covers the one approved development-only MCP Worker and its D1 review API. It does not authorize a production Worker, secret rotation, OAuth project changes, or any change to Apps Script or Google Sheets.

The Worker must remain on Cloudflare Workers Free. Do not enable Workers Paid, attach a custom domain, or add a billable binding. The only public address is the free `workers.dev` URL.

## Local-only checks

```powershell
pnpm check:mcp-worker
```

The check must prove all of the following before any external approval request:

- the Worker entry is `worker/mcp-development.ts`;
- the public Worker URL, Auth0 issuer, and `development` environment are fixed in the development-only Worker entry;
- no plain-text variable or `AI_CS_PROD_*` binding is configured;
- the Worker configuration does not set a paid-only CPU override; the Workers Free plan enforces its 10 ms CPU limit;
- the uncompressed bundle is below 3 MB;
- React, Next, Vinext, RSC, and frontend assets are absent;
- the only storage binding is the development D1 database `AI_CS_DB`; KV, R2, Durable Objects, Queues, Workers AI, Workflows, services, Vectorize, and Cron bindings are absent;
- `/healthz` returns liveness only and does not call Apps Script;
- unauthenticated `/mcp` returns a protected-resource OAuth challenge;
- OAuth protected-resource metadata advertises only the development MCP URL and scopes.

## Development D1 review API

The review desk data path uses one development-only D1 database. The Worker still fails closed when `AI_CS_DB` is missing, and the checked-in binding points only to `ai-cs-development`.

- migration: `worker/cs-data/migrations/0001_initial.sql`
- repository: `worker/cs-data/repository.ts`
- masked report adapter: `worker/cs-store-adapter.ts`
- narrow HTTP boundary: `worker/cs-api.ts`
- routes: `GET /api/cs/health`, `GET /api/cs/overview`, `GET /api/cs/cases`, `GET /api/cs/cases/:caseKey`, `POST /api/cs/sync`, `POST /api/cs/drafts`, and `PATCH /api/cs/drafts/:draftId/review`

Writes require the existing development sync secret, fixed `environment=development`, `auto_send=false`, and `marketplace_write_actions=0`. The API has no marketplace send, completion, order mutation, arbitrary URL, proxy, or deletion route. Only allowlisted marketplace URLs may be stored for the review-page original/product links.

The local test suite applies the migration to Node's in-memory SQLite engine and verifies `run_id` idempotency, masked data rejection, REPLY/EVAL separation, human-review audit events, fixed marketplace-write count zero, and indexed read performance with synthetic data.

The development database was created on the Cloudflare Free allowance and migration `0001_initial.sql` was applied. No production database, paid storage, custom domain, or additional Cloudflare service is configured.

To run the unauthenticated surface locally without an upstream, run:

```powershell
pnpm dev:mcp-worker
```

The Worker starts with `upstream_configured=false` until all three development secrets are registered under a separate approval. Never use an operating Sheet, production Apps Script URL, marketplace cookie, browser token, or raw customer data in the local Worker test.

## Current development deployment

The approved development Worker is deployed at `https://ai-cs-mcp-development.kimhyein0214.workers.dev`. The current bundle is below the Workers Free 3 MB uncompressed limit, includes no frontend assets, and has observability disabled. `/healthz`, `/api/cs/health`, OAuth protected-resource metadata, unauthenticated MCP rejection, unknown-path rejection, and wrong-method rejection are verified after deployment.

The existing development secrets remain registered in Cloudflare and are not copied into D1 or the repository:

- `AI_CS_DEV_ALLOWED_SUBJECTS`
- `AI_CS_DEV_APPS_SCRIPT_URL`
- `AI_CS_DEV_APPS_SCRIPT_KEY`

Do not display, echo, log, export, or commit those values.

## Free-only configuration

The Worker configuration intentionally has:

- no production environment;
- no automatic deployment workflow or production deploy script;
- no automatic GitHub deployment workflow;
- `workers_dev=true` and `preview_urls=false`;
- no `limits.cpu_ms` override, because Cloudflare rejects CPU overrides on Free and the plan itself enforces 10 ms;
- no plain-text variable or committed secret;
- one development D1 binding and no other storage, AI, queue, workflow, cron, service, or custom-domain binding;
- observability logs disabled to reduce data exposure.

If the account stops being Workers Free, if payment enrollment is required, or if a Free-limit check fails, stop without deploying further changes.

## Verified health sequence

1. `GET /healthz` returns `development`, configured liveness, `upstream_checked=false`, `auto_send=false`, and `marketplace_write_actions=0` without calling Apps Script.
2. `GET /.well-known/oauth-protected-resource` returns the exact `workers.dev/mcp` resource and OAuth issuer.
3. Unauthenticated `GET /mcp` returns `401` with `WWW-Authenticate`.
4. `GET /api/cs/health` verifies the D1 schema without customer data.
5. Read-only D1 overview and list calls are verified before any write.
6. D1 sync requires the existing hidden development sync key. A mismatched local key is rejected with `401`; do not rotate or expose the registered Worker secret merely to force a test.

Free-limit exhaustion must fail closed. Do not enable a paid plan as a fallback.
