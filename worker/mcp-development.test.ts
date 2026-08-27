import assert from "node:assert/strict";
import test from "node:test";
import worker, { type WorkerBindings } from "./mcp-development.ts";

function bindings(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://ai-cs-mcp-development.kimhyein0214.workers.dev${path}`, init);
}

test("development liveness does not call or expose the upstream", async () => {
  const response = await worker.fetch(request("/healthz"), bindings());
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.deepEqual(payload, {
    ok: true,
    service: "pink-rocket-ai-cs-mcp",
    environment: "development",
    configured: true,
    upstream_configured: false,
    upstream_checked: false,
    auto_send: false,
    marketplace_write_actions: 0,
  });
  assert.equal(JSON.stringify(payload).includes("TEST_ONLY"), false);
});

test("protected resource metadata advertises the development MCP resource", async () => {
  const response = await worker.fetch(request("/.well-known/oauth-protected-resource"), bindings());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    resource: "https://ai-cs-mcp-development.kimhyein0214.workers.dev/mcp",
    authorization_servers: ["https://dev-blxg5bl1665a4fn8.us.auth0.com/"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["cs:read", "cs:sync", "cs:review"],
  });
});

test("unauthenticated MCP request returns the OAuth challenge", async () => {
  const response = await worker.fetch(request("/mcp"), bindings());
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://ai-cs-mcp-development.kimhyein0214.workers.dev/.well-known/oauth-protected-resource"',
  );
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.error, "AUTH_REQUIRED");
  assert.equal(payload.auto_send, false);
  assert.equal(payload.marketplace_write_actions, 0);
});

test("the Worker rejects production configuration", async () => {
  const enabled = await worker.fetch(request("/healthz"), bindings({ AI_CS_PRODUCTION_ENABLED: "true" }));
  assert.equal(enabled.status, 503);

  const productionSecret = await worker.fetch(request("/healthz"), bindings({ AI_CS_PROD_APPS_SCRIPT_KEY: "FORBIDDEN" }));
  assert.equal(productionSecret.status, 503);
});

test("the Worker fails closed when only some development secrets exist", async () => {
  const response = await worker.fetch(request("/healthz"), bindings({ AI_CS_DEV_ALLOWED_SUBJECTS: "development-user" }));
  assert.equal(response.status, 503);
});

test("the Worker rejects the wrong host, methods, and unknown routes", async () => {
  const wrongHost = await worker.fetch(new Request("https://wrong.example/mcp"), bindings());
  assert.equal(wrongHost.status, 403);

  const wrongMethod = await worker.fetch(request("/.well-known/oauth-protected-resource", { method: "POST" }), bindings());
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const missing = await worker.fetch(request("/not-a-route"), bindings());
  assert.equal(missing.status, 404);
});
