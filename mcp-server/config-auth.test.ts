import test from "node:test";
import assert from "node:assert/strict";
import { authenticateRequest, requireScope } from "./auth.ts";
import { loadServerConfig, targetForSubject } from "./config.ts";

function env(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    AI_CS_PUBLIC_ORIGIN: "https://ai-cs.example.com",
    AI_CS_RESOURCE_URL: "https://ai-cs.example.com/mcp",
    AI_CS_OAUTH_ISSUER: "https://identity.example.com",
    AI_CS_OAUTH_JWKS_URL: "https://identity.example.com/jwks.json",
    AI_CS_OAUTH_AUDIENCE: "https://ai-cs.example.com/mcp",
    AI_CS_DEV_ALLOWED_SUBJECTS: "personal-subject",
    AI_CS_PROD_ALLOWED_SUBJECTS: "company-subject",
    AI_CS_DEV_APPS_SCRIPT_URL: "https://script.google.com/macros/s/dev/exec",
    AI_CS_DEV_APPS_SCRIPT_KEY: "dev-secret",
    AI_CS_PRODUCTION_ENABLED: "false",
  };
  return Object.assign(base, overrides);
}

test("server-side subject mapping cannot be overridden by input", () => {
  const config = loadServerConfig(env());
  assert.equal(targetForSubject(config, "personal-subject").name, "development");
  assert.throws(() => targetForSubject(config, "company-subject"), /PRODUCTION_DISABLED/);
  assert.throws(() => targetForSubject(config, "unknown"), /ACCOUNT_NOT_AUTHORIZED/);
});

test("same OAuth subject cannot belong to development and production", () => {
  assert.throws(
    () => loadServerConfig(env({ AI_CS_PROD_ALLOWED_SUBJECTS: "personal-subject" })),
    /SERVER_CONFIG_SUBJECT_ENVIRONMENT_OVERLAP/,
  );
});

test("OAuth issuer preserves its exact trailing slash for JWT issuer checks", () => {
  const config = loadServerConfig(env({ AI_CS_OAUTH_ISSUER: "https://tenant.example.com/" }));
  assert.equal(config.oauthIssuer, "https://tenant.example.com/");
  const withoutSlash = loadServerConfig(env({ AI_CS_OAUTH_ISSUER: "https://tenant.example.com" }));
  assert.equal(withoutSlash.oauthIssuer, "https://tenant.example.com");
});

test("verified token becomes a development principal with explicit scopes", async () => {
  const config = loadServerConfig(env());
  const now = Math.floor(Date.now() / 1000);
  const request = new Request("https://ai-cs.example.com/mcp", { headers: { Authorization: "Bearer opaque-test-token" } });
  const principal = await authenticateRequest(request, config, async () => ({
    sub: "personal-subject",
    aud: config.oauthAudience,
    iss: config.oauthIssuer,
    iat: now,
    exp: now + 900,
    client_id: "personal-client",
    scope: "cs:read cs:sync",
  }));
  assert.equal(principal.target.name, "development");
  requireScope(principal, "cs:read");
  assert.throws(() => requireScope(principal, "cs:review"), /SCOPE_REQUIRED:cs:review/);
});
