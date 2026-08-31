# Cloudflare Workers Free development MCP

## Boundary

This document covers one development-only MCP Worker. It does not authorize account creation, login, secret registration, Worker creation, deployment, OAuth project creation, or any change to GitHub Pages, Sites production, Apps Script, or Google Sheets.

The Worker must remain on Cloudflare Workers Free. Do not enable Workers Paid, attach a custom domain, or add a billable binding. The only public address is the free `workers.dev` URL.

## Local-only checks

```powershell
pnpm check:mcp-worker
```

The check must prove all of the following before any external approval request:

- the Worker entry is `worker/mcp-development.ts`;
- the public Worker URL, Auth0 issuer, and `development` environment are fixed in the development-only Worker entry;
- no plain-text variable, secret, or `AI_CS_PROD_*` binding is configured;
- the Worker configuration does not set a paid-only CPU override; the Workers Free plan enforces its 10 ms CPU limit;
- the uncompressed bundle is below 3 MB;
- React, Next, Vinext, RSC, and frontend assets are absent;
- KV, D1, R2, Durable Objects, Queues, Workers AI, Workflows, services, Vectorize, and Cron bindings are absent;
- `/healthz` returns liveness only and does not call Apps Script;
- unauthenticated `/mcp` returns a protected-resource OAuth challenge;
- OAuth protected-resource metadata advertises only the development MCP URL and scopes.

To run the unauthenticated surface locally without an upstream, run:

```powershell
pnpm dev:mcp-worker
```

The Worker starts with `upstream_configured=false` until all three development secrets are registered under a separate approval. Never use an operating Sheet, production Apps Script URL, marketplace cookie, browser token, or raw customer data in the local Worker test.

## External approval gate

Stop after local validation. Before any external action, report the exact files, bundle size, tests, planned Worker name, intended `workers.dev` URL pattern, Cloudflare account plan, and secrets that the user must enter. Obtain explicit approval before continuing.

After a separate secret-registration approval, the user enters these secrets in the Cloudflare Dashboard or an interactive hidden prompt:

- `AI_CS_DEV_ALLOWED_SUBJECTS`
- `AI_CS_DEV_APPS_SCRIPT_URL`
- `AI_CS_DEV_APPS_SCRIPT_KEY`

Do not display, echo, log, export, or commit those values.

## Free-only configuration

The Worker configuration intentionally has:

- no production environment;
- no deployment script in `package.json`;
- no automatic GitHub deployment workflow;
- `workers_dev=true` and `preview_urls=false`;
- no `limits.cpu_ms` override, because Cloudflare rejects CPU overrides on Free and the plan itself enforces 10 ms;
- no plain-text variable or secret in the initial deployment;
- no storage, AI, queue, workflow, cron, service, or custom-domain binding;
- observability logs disabled to reduce data exposure.

Cloudflare account creation and the first deployment remain manual approval steps. If the account is not Workers Free, if payment enrollment is required, or if a Free-limit check fails, stop without deploying.

## Health sequence after a future approved deployment

1. `GET /healthz` returns `development`, `upstream_configured=false`, `upstream_checked=false`, `auto_send=false`, and `marketplace_write_actions=0`.
2. `GET /.well-known/oauth-protected-resource` returns the exact `workers.dev/mcp` resource and OAuth issuer.
3. Unauthenticated `GET /mcp` returns `401` with `WWW-Authenticate`.
4. Authenticated `get_cs_health` checks the development Apps Script connection.
5. Read-only tools are verified before either Sheet-writing scope.
6. A synthetic masked sync is tested only after separate approval for the development test Sheet.

Free-limit exhaustion must fail closed. Do not enable a paid plan as a fallback.
