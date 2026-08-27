import { createAuthenticatedMcpHandler } from "../mcp-server/handler.ts";
import { loadServerConfig, type ServerConfig } from "../mcp-server/config.ts";

export type WorkerBindings = {
  AI_CS_RUNTIME_ENVIRONMENT?: string;
  AI_CS_PUBLIC_ORIGIN?: string;
  AI_CS_RESOURCE_URL?: string;
  AI_CS_OAUTH_ISSUER?: string;
  AI_CS_OAUTH_JWKS_URL?: string;
  AI_CS_OAUTH_AUDIENCE?: string;
  AI_CS_ALLOWED_ORIGINS?: string;
  AI_CS_DEV_ALLOWED_SUBJECTS?: string;
  AI_CS_DEV_APPS_SCRIPT_URL?: string;
  AI_CS_DEV_APPS_SCRIPT_KEY?: string;
  AI_CS_PRODUCTION_ENABLED?: string;
  AI_CS_PROD_ALLOWED_SUBJECTS?: string;
  AI_CS_PROD_APPS_SCRIPT_URL?: string;
  AI_CS_PROD_APPS_SCRIPT_KEY?: string;
};

type Runtime = {
  config: ServerConfig;
  mcp: (request: Request) => Promise<Response>;
};

const runtimeCache = new WeakMap<object, Runtime>();

function developmentConfig(env: WorkerBindings): ServerConfig {
  if (env.AI_CS_RUNTIME_ENVIRONMENT !== "development") {
    throw new Error("DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  if (env.AI_CS_PRODUCTION_ENABLED !== "false") {
    throw new Error("PRODUCTION_MUST_BE_DISABLED");
  }
  if (env.AI_CS_PROD_ALLOWED_SUBJECTS || env.AI_CS_PROD_APPS_SCRIPT_URL || env.AI_CS_PROD_APPS_SCRIPT_KEY) {
    throw new Error("PRODUCTION_CONFIG_FORBIDDEN");
  }

  return loadServerConfig({
    NODE_ENV: "production",
    AI_CS_PUBLIC_ORIGIN: env.AI_CS_PUBLIC_ORIGIN,
    AI_CS_RESOURCE_URL: env.AI_CS_RESOURCE_URL,
    AI_CS_OAUTH_ISSUER: env.AI_CS_OAUTH_ISSUER,
    AI_CS_OAUTH_JWKS_URL: env.AI_CS_OAUTH_JWKS_URL,
    AI_CS_OAUTH_AUDIENCE: env.AI_CS_OAUTH_AUDIENCE,
    AI_CS_ALLOWED_ORIGINS: env.AI_CS_ALLOWED_ORIGINS,
    AI_CS_DEV_ALLOWED_SUBJECTS: env.AI_CS_DEV_ALLOWED_SUBJECTS,
    AI_CS_DEV_APPS_SCRIPT_URL: env.AI_CS_DEV_APPS_SCRIPT_URL,
    AI_CS_DEV_APPS_SCRIPT_KEY: env.AI_CS_DEV_APPS_SCRIPT_KEY,
    AI_CS_PRODUCTION_ENABLED: "false",
  });
}

function runtimeFor(env: WorkerBindings): Runtime {
  const cacheKey = env as object;
  const cached = runtimeCache.get(cacheKey);
  if (cached) return cached;

  const config = developmentConfig(env);
  const runtime = {
    config,
    mcp: createAuthenticatedMcpHandler({ config }),
  };
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

function json(body: unknown, status = 200, cacheControl = "no-store"): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function methodNotAllowed(allowed: string[]): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: allowed.join(", "),
      "Cache-Control": "no-store",
    },
  });
}

function hostMatches(request: Request, config: ServerConfig): boolean {
  return new URL(request.url).host === new URL(config.publicOrigin).host;
}

async function fetchWorker(request: Request, env: WorkerBindings): Promise<Response> {
  let runtime: Runtime;
  try {
    runtime = runtimeFor(env);
  } catch {
    return json({
      ok: false,
      error: "DEVELOPMENT_WORKER_NOT_CONFIGURED",
      environment: "development",
      auto_send: false,
      marketplace_write_actions: 0,
    }, 503);
  }

  if (!hostMatches(request, runtime.config)) {
    return json({ ok: false, error: "HOST_NOT_ALLOWED" }, 403);
  }

  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
    const body = {
      ok: true,
      service: "pink-rocket-ai-cs-mcp",
      environment: "development",
      configured: true,
      upstream_checked: false,
      auto_send: false,
      marketplace_write_actions: 0,
    };
    return request.method === "HEAD" ? new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } }) : json(body);
  }

  if (url.pathname === "/.well-known/oauth-protected-resource") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json({
      resource: runtime.config.resourceUrl,
      authorization_servers: [runtime.config.oauthIssuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["cs:read", "cs:sync", "cs:review"],
    }, 200, "public, max-age=300");
  }

  if (url.pathname === "/mcp") {
    if (!new Set(["GET", "POST", "DELETE"]).has(request.method)) {
      return methodNotAllowed(["GET", "POST", "DELETE"]);
    }
    return runtime.mcp(request);
  }

  return json({ ok: false, error: "NOT_FOUND" }, 404);
}

export default {
  fetch: fetchWorker,
} satisfies ExportedHandler<WorkerBindings>;
