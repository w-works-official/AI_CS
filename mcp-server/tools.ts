import { McpServer } from "@modelcontextprotocol/server";
import type { Principal } from "./auth.ts";
import { requireScope } from "./auth.ts";
import { AppsScriptClient } from "./apps-script-client.ts";
import {
  getCaseInputSchema,
  getCaseOutputSchema,
  healthOutputSchema,
  listCasesInputSchema,
  listCasesOutputSchema,
  overviewInputSchema,
  overviewOutputSchema,
  reviewDraftInputSchema,
  reviewDraftOutputSchema,
  searchAnswersInputSchema,
  searchAnswersOutputSchema,
  syncRunInputSchema,
  syncRunOutputSchema,
} from "./schemas.ts";
import { assertMaskedHumanRevision, assertSafeSync, makeRunId, safeToolError } from "./safety.ts";

type JsonObject = Record<string, unknown>;

function success(principal: Principal, payload: JsonObject) {
  const structuredContent = {
    ...payload,
    environment: principal.target.name,
    auto_send: false as const,
    marketplace_write_actions: 0 as const,
    browser_collection: "LOCAL_CHROME_PLUGIN_REQUIRED" as const,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown, principal: Principal) {
  const safe = safeToolError(error);
  const result: {
    isError: true;
    content: Array<{ type: "text"; text: string }>;
    _meta?: Record<string, unknown>;
  } = {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: safe, auto_send: false, marketplace_write_actions: 0 }) }],
  };
  if (safe.startsWith("SCOPE_REQUIRED:")) {
    const resource = principal.authInfo.resource ?? new URL("https://invalid.local/mcp");
    const metadata = `${resource.origin}/.well-known/oauth-protected-resource`;
    result._meta = {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="The linked account needs an additional CS permission"`,
      ],
    };
  }
  return result;
}

const securityMeta = (scopes: string[]) => ({ securitySchemes: [{ type: "oauth2", scopes }] });

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const sheetWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const reviewWriteAnnotations = {
  ...sheetWriteAnnotations,
  idempotentHint: false,
};

export function createCsMcpServer(principal: Principal, client = new AppsScriptClient(principal.target)): McpServer {
  const server = new McpServer(
    { name: "pink-rocket-ai-cs", version: "0.1.0" },
    {
      instructions: `Environment is fixed to ${principal.target.name} by verified account identity. All marketplace collection is read-only. Never type or send a marketplace reply. Only masked Google Sheets sync and human draft-review metadata are writable.`,
    },
  );

  server.registerTool("get_cs_health", {
    title: "Get CS service health",
    description: "Checks the authenticated account environment and its dedicated Apps Script connection. Does not access Chrome or change data.",
    inputSchema: overviewInputSchema,
    outputSchema: healthOutputSchema,
    annotations: readAnnotations,
    _meta: securityMeta(["cs:read"]),
  }, async () => {
    try {
      requireScope(principal, "cs:read");
      return success(principal, await client.read("health"));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("get_cs_overview", {
    title: "Get CS overview",
    description: "Returns masked case counts from the account's fixed environment. It cannot select another environment.",
    inputSchema: overviewInputSchema,
    outputSchema: overviewOutputSchema,
    annotations: readAnnotations,
    _meta: securityMeta(["cs:read"]),
  }, async () => {
    try {
      requireScope(principal, "cs:read");
      return success(principal, await client.read("overview"));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("list_cs_cases", {
    title: "List masked CS cases",
    description: "Lists only masked CS case summaries with allowlisted filters and a maximum page size of 50.",
    inputSchema: listCasesInputSchema,
    outputSchema: listCasesOutputSchema,
    annotations: readAnnotations,
    _meta: securityMeta(["cs:read"]),
  }, async (input) => {
    try {
      requireScope(principal, "cs:read");
      return success(principal, await client.read("cases", input));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("get_cs_case", {
    title: "Get one masked CS case",
    description: "Returns masked messages, AI drafts, and marketplace-observed human replies for one exact case key.",
    inputSchema: getCaseInputSchema,
    outputSchema: getCaseOutputSchema,
    annotations: readAnnotations,
    _meta: securityMeta(["cs:read"]),
  }, async (input) => {
    try {
      requireScope(principal, "cs:read");
      return success(principal, await client.read("case", input));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("search_verified_answers", {
    title: "Search verified human answers",
    description: "Returns up to three masked, enabled, PII-checked human answer examples from the fixed environment for grounding an AI draft. It never returns AI drafts as references.",
    inputSchema: searchAnswersInputSchema,
    outputSchema: searchAnswersOutputSchema,
    annotations: readAnnotations,
    _meta: securityMeta(["cs:read"]),
  }, async (input) => {
    try {
      requireScope(principal, "cs:read");
      assertMaskedHumanRevision(input.query);
      return success(principal, await client.read("answerLibrary", input));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("sync_masked_cs_run", {
    title: "Synchronize a masked CS run",
    description: "Writes only a schema-valid, PII-free, read-only collection report to the account's fixed Google Sheet. The run_id is idempotent and marketplace_write_actions must be zero.",
    inputSchema: syncRunInputSchema,
    outputSchema: syncRunOutputSchema,
    annotations: sheetWriteAnnotations,
    _meta: securityMeta(["cs:sync"]),
  }, async (input) => {
    try {
      requireScope(principal, "cs:sync");
      assertSafeSync(input);
      const runId = makeRunId(input.report);
      if (input.run_id && input.run_id !== runId) throw new Error("RUN_ID_CONTENT_MISMATCH");
      return success(principal, await client.write("syncRun", { ...input, run_id: runId }));
    } catch (error) {
      return failure(error, principal);
    }
  });

  server.registerTool("review_ai_draft", {
    title: "Review an AI draft",
    description: "Records human review state and an optional separately stored human revision in Google Sheets. It never types into or sends to a marketplace.",
    inputSchema: reviewDraftInputSchema,
    outputSchema: reviewDraftOutputSchema,
    annotations: reviewWriteAnnotations,
    _meta: securityMeta(["cs:review"]),
  }, async (input) => {
    try {
      requireScope(principal, "cs:review");
      assertMaskedHumanRevision(input.human_revision);
      return success(principal, await client.write("reviewDraft", input));
    } catch (error) {
      return failure(error, principal);
    }
  });

  return server;
}
