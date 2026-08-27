import test from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { AppsScriptClient } from "./apps-script-client.ts";
import type { Principal } from "./auth.ts";
import { createCsMcpServer } from "./tools.ts";

function principal(scopes = ["cs:read", "cs:sync", "cs:review"]): Principal {
  const authInfo: AuthInfo = { token: "never-log", clientId: "test", scopes, resource: new URL("https://ai-cs.example.com/mcp") };
  return {
    subject: "personal-subject",
    clientId: "test",
    scopes: new Set(scopes),
    target: { name: "development", appsScriptUrl: "https://script.google.com/macros/s/dev/exec", appsScriptKey: "secret" },
    authInfo,
  };
}

async function connected(scopes?: string[]) {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const fake = {
    async read(action: string) {
      if (action === "health") return { ok: true, service: "test", schema_version: "cs-sheet-v1", write_policy: "MASKED_SYNC_AND_DRAFT_REVIEW_ONLY", environment: "development", auto_send: false };
      if (action === "answerLibrary") return {
        ok: true,
        reference_source: "VERIFIED_HUMAN_ANSWER_ONLY",
        examples: [{
          example_id: "ANS_test",
          intent: "배송",
          market: "SMARTSTORE",
          channel: "톡톡 상담",
          risk_level: "REVIEW_REQUIRED",
          customer_question: "배송은 언제 되나요?",
          product_name: "샘플 피어싱",
          human_answer: "주문 상태 확인 후 안내드리겠습니다.",
          required_checks: "실제 주문 및 출고 상태 확인",
          score: 16,
          last_verified_at: "2026-08-25T01:01:00Z",
        }],
        environment: "development",
        auto_send: false,
        marketplace_write_actions: 0,
      };
      return { ok: true, environment: "development", auto_send: false };
    },
    async write(action: string, body: Record<string, unknown>) {
      calls.push({ action, body });
      return { ok: true, run_id: String(body.run_id ?? ""), duplicate_run: false, inserted_cases: 0, updated_cases: 0, inserted_messages: 0, inserted_drafts: 0, environment: "development", auto_send: false, marketplace_write_actions: 0 };
    },
  } as unknown as AppsScriptClient;
  const server = createCsMcpServer(principal(scopes), fake);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, calls };
}

test("MCP exposes only seven narrowly scoped tools with schemas", async () => {
  const { client, server } = await connected();
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "get_cs_case",
      "get_cs_health",
      "get_cs_overview",
      "list_cs_cases",
      "review_ai_draft",
      "search_verified_answers",
      "sync_masked_cs_run",
    ]);
    assert.ok(result.tools.every((tool) => tool.inputSchema && tool.outputSchema));
    assert.ok(result.tools.every((tool) => Array.isArray(tool._meta?.securitySchemes)));
    assert.equal(result.tools.find((tool) => tool.name === "get_cs_health")?.annotations?.readOnlyHint, true);
    assert.equal(result.tools.find((tool) => tool.name === "sync_masked_cs_run")?.annotations?.destructiveHint, false);
    assert.equal(result.tools.find((tool) => tool.name === "sync_masked_cs_run")?.annotations?.idempotentHint, true);
    assert.equal(result.tools.find((tool) => tool.name === "review_ai_draft")?.annotations?.idempotentHint, false);
    assert.equal(result.tools.find((tool) => tool.name === "search_verified_answers")?.annotations?.readOnlyHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("health reports the fixed environment and never-send boundary", async () => {
  const { client, server } = await connected();
  try {
    const result = await client.callTool({ name: "get_cs_health", arguments: {} });
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(result.isError, undefined);
    assert.equal(output.environment, "development");
    assert.equal(output.auto_send, false);
    assert.equal(output.marketplace_write_actions, 0);
    assert.equal(output.browser_collection, "LOCAL_CHROME_PLUGIN_REQUIRED");
  } finally {
    await client.close();
    await server.close();
  }
});

test("missing scope is denied inside the tool contract", async () => {
  const { client, server } = await connected(["cs:read"]);
  try {
    const result = await client.callTool({ name: "review_ai_draft", arguments: { draft_id: "DRAFT:test", draft_state: "REJECTED", review_note: "no", human_revision: "" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /SCOPE_REQUIRED:cs:review/);
    assert.match(JSON.stringify(result._meta), /mcp\/www_authenticate/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("verified answer search returns only bounded human-reference results", async () => {
  const { client, server } = await connected();
  try {
    const result = await client.callTool({
      name: "search_verified_answers",
      arguments: { query: "배송 출고 문의", market: "SMARTSTORE", intent: "배송", limit: 3 },
    });
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(output.reference_source, "VERIFIED_HUMAN_ANSWER_ONLY");
    assert.equal((output.examples as unknown[]).length, 1);
    assert.equal(output.auto_send, false);
    assert.equal(output.marketplace_write_actions, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
