import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticatedMcpHandler } from "./handler.ts";
import type { ServerConfig } from "./config.ts";

const config: ServerConfig = {
  publicOrigin: "https://ai-cs.example.com",
  resourceUrl: "https://ai-cs.example.com/mcp",
  oauthIssuer: "https://identity.example.com",
  oauthJwksUrl: "https://identity.example.com/jwks.json",
  oauthAudience: "https://ai-cs.example.com/mcp",
  allowedOrigins: new Set(["https://chatgpt.com", "https://ai-cs.example.com"]),
  productionEnabled: false,
  subjectEnvironment: new Map([["personal-subject", "development"]]),
  targets: {
    development: { name: "development", appsScriptUrl: "https://script.google.com/macros/s/dev/exec", appsScriptKey: "dev-secret" },
    production: { name: "production", appsScriptUrl: "", appsScriptKey: "" },
  },
};

test("knowing the MCP URL without a bearer token returns an OAuth challenge", async () => {
  const handler = createAuthenticatedMcpHandler({ config, verifier: async () => ({}) });
  const response = await handler(new Request("https://ai-cs.example.com/mcp", {
    method: "POST",
    headers: { Origin: "https://chatgpt.com", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.auto_send, false);
  assert.equal(body.marketplace_write_actions, 0);
});

test("unexpected browser origin is rejected before authentication", async () => {
  const handler = createAuthenticatedMcpHandler({ config, verifier: async () => ({}) });
  const response = await handler(new Request("https://ai-cs.example.com/mcp", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "ORIGIN_NOT_ALLOWED" });
});
