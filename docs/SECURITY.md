# AI CS security model

## Environment isolation

Environment selection is derived from the verified OAuth `sub` claim:

- `AI_CS_DEV_ALLOWED_SUBJECTS` maps only to `development`;
- `AI_CS_PROD_ALLOWED_SUBJECTS` maps only to `production`;
- overlap is a startup error;
- production is rejected unless `AI_CS_PRODUCTION_ENABLED=true`;
- each environment has a separate Apps Script URL and key;
- the review web page also uses one server-fixed `AI_CS_WEB_ENVIRONMENT` per deployment.

No MCP tool or prompt can select an environment. A development identity cannot call the production target even if it knows the production URL.

## OAuth requirements

Use an issuer that provides OAuth Authorization Code with PKCE S256, refresh-token rotation or equivalent replay protection, token revocation, and signed JWT access tokens. The MCP server validates issuer, audience/resource, expiry, signature, subject, and scopes through the issuer's JWKS. The endpoint returns an RFC 9728 protected-resource metadata challenge when authentication is missing or invalid.

Use an established provider rather than implementing an authorization server in this repository. The development default recommendation is a dedicated Auth0 tenant with CIMD or DCR support and resource-indicator/audience propagation. Production should use a separately controlled tenant/client or an equivalently isolated company configuration.

Recommended token policy:

- access token lifetime: 15–60 minutes;
- refresh token: rotating and revocable;
- separate OAuth clients for personal development and company production;
- exact redirect URIs supplied by ChatGPT during private connection setup;
- revoke the personal client or remove its allowed subject before production cutover.

## Secret handling

Apps Script URLs and keys, OAuth client secrets, tokens, and real `.app.json` registrations are server-side or ignored local configuration only. They must not appear in Git, tool output, application logs, browser storage, or error messages. The Apps Script key is added only inside the server-to-server client and is sent in a POST body, never in a request URL.

## Data and action boundary

Raw customer data exists only in memory during browser collection. Before any persistence, the report must pass the strict schema, `pii_scan=PASS`, duplicate and count reconciliation, masked-customer check, AI origin check, and PII regex scan. Apps Script repeats the checks.

Allowed Sheet writes are masked sync records and draft review metadata. Marketplace replies, reply-field typing, completion, closure, refunds, exchanges, cancellations, order changes, customer notes, and tags are not represented by any tool. Smartstore TalkTalk detail inspection may cause unread-to-read and is counted separately. `marketplace_write_actions` remains zero.

## Revocation

For a compromised or retired account:

1. revoke its OAuth session/refresh token at the issuer;
2. remove its subject from the server-side allowlist;
3. rotate only that environment's Apps Script key;
4. redeploy the existing project after approval;
5. verify the old identity receives `ACCOUNT_NOT_AUTHORIZED` and the other environment is unaffected.
