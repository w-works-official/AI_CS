import assert from "node:assert/strict";
import test from "node:test";
import worker, { type WorkerBindings } from "./mcp-development.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "./cs-data/types.ts";

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

test("the CS API remains unavailable until an explicit development D1 binding exists", async () => {
  const response = await worker.fetch(request("/api/cs/health"), bindings());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "D1_NOT_CONFIGURED",
    environment: "development",
    auto_send: false,
    marketplace_write_actions: 0,
  });
});

test("a bound development D1 exposes only the local CS health route", async () => {
  const statement: D1PreparedStatement = {
    bind() { return this; },
    async first<T>() { return { ok: 1 } as T; },
    async all<T>() { return { results: [] as T[], success: true, meta: {} }; },
    async run() { return { results: [], success: true, meta: {} }; },
  };
  const database: D1Database = {
    prepare() { return statement; },
    async batch<T>() { return [] as D1Result<T>[]; },
  };
  const response = await worker.fetch(request("/api/cs/health"), bindings({ AI_CS_DB: database }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "ai-cs-d1-repository",
    schema_version: "v1",
    write_policy: "MASKED_DTO_ONLY",
    environment: "development",
    auto_send: false,
    marketplace_write_actions: 0,
  });
});
