# Private ChatGPT plugin development

## Current implementation boundary

The existing GitHub Pages review UI and Sites production API are immutable deployment boundaries for this development MCP work. The private MCP is packaged as a separate Cloudflare Workers Free development Worker from the same repository and a separate `mcp-development` branch. It does not reuse or deploy the project in `.openai/hosting.json`.

The private plugin has two cooperating halves:

1. The bundled `marketplace-cs-monitor` skill uses the official Chrome capability and the exact Chrome profile selected by the user. It reads seven seller-center channels, stops at authentication challenges, normalizes in memory, and emits only masked records.
2. The remote `/mcp` endpoint authenticates the ChatGPT account, fixes it to one server-side environment, and exposes narrow Google Sheets tools. It cannot see local Chrome and never accepts a marketplace write action, Apps Script URL, API key, or environment parameter.

The Cloudflare entry point is `worker/mcp-development.ts`. Its bundle excludes React, Next, Vinext, the review frontend, static assets, and Sites configuration. The Wrangler configuration contains no production target or paid Cloudflare binding.

## Local package test

1. Copy `.env.example` to ignored `.env.local` and use development-only placeholder/test credentials.
2. Keep `AI_CS_PRODUCTION_ENABLED=false`.
3. Start the existing app with `pnpm dev`.
4. Use `.agents/plugins/marketplace.json` as the repo-local test marketplace. The plugin root is `plugins/ai-cs`.
5. Validate the package:

   ```powershell
   py -3 "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py" plugins/ai-cs
   ```

The local `.mcp.json` points to `http://127.0.0.1:3000/mcp`. It is for local plugin testing only. ChatGPT web needs a stable HTTPS deployment and a registered private MCP connection.

For the isolated Worker boundary, use:

```powershell
pnpm check:mcp-worker
```

This command runs contract tests, a Wrangler dry run, a 3 MB Free-plan size check, a frontend-marker scan, and a paid-binding scan. It does not log in to Cloudflare or deploy anything.

## Personal ChatGPT connection after approved deployment

These steps change external account and deployment state and must not be run until explicitly approved.

1. Confirm that the selected Cloudflare account is on Workers Free and has sufficient unused daily request capacity. Do not add a payment method or enable Workers Paid.
2. Create only `ai-cs-mcp-development` on the free `workers.dev` domain. Do not create a production Worker, custom domain, KV, D1, R2, Durable Object, Queue, Workers AI, Workflow, or Cron Trigger.
3. Configure an OAuth/OIDC application that supports Authorization Code with PKCE S256, refresh/revocation, and the scopes `cs:read`, `cs:sync`, and `cs:review`. The recommended default is a separate Auth0 development tenant because OpenAI explicitly documents Auth0 for MCP authorization; this is an external service choice and is not created automatically.
4. Enter Worker secrets through the Cloudflare Dashboard or the hidden `wrangler secret put` prompt. Never paste them into chat, shell history, Wrangler configuration, or Git.
5. Deploy the development Worker and verify:
   - `https://ai-cs-mcp-development.<account>.workers.dev/healthz`
   - `https://ai-cs-mcp-development.<account>.workers.dev/.well-known/oauth-protected-resource`
   - `https://ai-cs-mcp-development.<account>.workers.dev/mcp`
6. In personal ChatGPT: Settings → Security and login → enable Developer mode.
7. Under ChatGPT Plugins, add the HTTPS MCP URL and complete OAuth with the personal development identity.
8. Copy the generated `plugin_asdk_app...` ID into a local untracked `plugins/ai-cs/.app.json`, using `.app.example.json` as the template.
9. Install the repo-local plugin package. Do not submit it publicly.
10. Verify `get_cs_health` first. The response must say `development`, `auto_send=false`, `marketplace_write_actions=0`, and `LOCAL_CHROME_PLUGIN_REQUIRED`.
11. Verify `get_cs_overview`, `list_cs_cases`, and `get_cs_case` before enabling either Sheet-writing scope.
12. Verify `search_verified_answers` returns at most three enabled, masked, human-answer examples from the development test library.
13. Connect the official Chrome capability, explicitly select the intended Chrome profile, and perform a collection-only dry run. Stop if login, CAPTCHA, 2FA, or account confirmation appears.
14. Call `sync_masked_cs_run` only with a synthetic masked report or the approved test Sheet. Replay the identical report and confirm `duplicate_run=true`.

## Remote MCP tools

| Tool | Required scope | Effect |
|---|---|---|
| `get_cs_health` | `cs:read` | Authenticated environment and Apps Script health only |
| `get_cs_overview` | `cs:read` | Masked aggregate counts |
| `list_cs_cases` | `cs:read` | Masked case summaries, allowlisted filters, max 50 |
| `get_cs_case` | `cs:read` | One masked case, messages, AI drafts, observed human replies |
| `search_verified_answers` | `cs:read` | Up to three masked, enabled, PII-checked human answer examples |
| `sync_masked_cs_run` | `cs:sync` | Idempotent masked report sync to the fixed environment's Sheet |
| `review_ai_draft` | `cs:review` | Draft review state and separately stored human revision only |

No tool accepts a general HTTP request, URL, environment switch, marketplace action, reply text destination, cookie, or token.
