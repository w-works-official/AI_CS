import { createAuthenticatedMcpHandler } from "../mcp-server/handler.ts";
import { loadServerConfig, type ServerConfig } from "../mcp-server/config.ts";

export type WorkerBindings = {
  AI_CS_DEV_ALLOWED_SUBJECTS?: string;
  AI_CS_DEV_APPS_SCRIPT_URL?: string;
  AI_CS_DEV_APPS_SCRIPT_KEY?: string;
  [name: string]: string | undefined;
};

type Runtime = {
  config: ServerConfig;
  upstreamConfigured: boolean;
  mcp: (request: Request) => Promise<Response>;
};

const runtimeCache = new WeakMap<object, Runtime>();

const publicOrigin = "https://ai-cs-mcp-development.kimhyein0214.workers.dev";
const resourceUrl = `${publicOrigin}/mcp`;
const oauthIssuer = "https://dev-blxg5bl1665a4fn8.us.auth0.com/";
const oauthJwksUrl = `${oauthIssuer}.well-known/jwks.json`;

function developmentConfig(env: WorkerBindings): { config: ServerConfig; upstreamConfigured: boolean } {
  if (Object.keys(env).some((name) => name.startsWith("AI_CS_PROD"))) {
    throw new Error("PRODUCTION_CONFIG_FORBIDDEN");
  }

  const developmentSecrets = [
    env.AI_CS_DEV_ALLOWED_SUBJECTS,
    env.AI_CS_DEV_APPS_SCRIPT_URL,
    env.AI_CS_DEV_APPS_SCRIPT_KEY,
  ].map((value) => String(value ?? "").trim());
  const suppliedSecretCount = developmentSecrets.filter(Boolean).length;
  if (suppliedSecretCount !== 0 && suppliedSecretCount !== developmentSecrets.length) {
    throw new Error("DEVELOPMENT_SECRETS_INCOMPLETE");
  }

  const upstreamConfigured = suppliedSecretCount === developmentSecrets.length;
  if (upstreamConfigured) {
    return {
      config: loadServerConfig({
        NODE_ENV: "production",
        AI_CS_PUBLIC_ORIGIN: publicOrigin,
        AI_CS_RESOURCE_URL: resourceUrl,
        AI_CS_OAUTH_ISSUER: oauthIssuer,
        AI_CS_OAUTH_JWKS_URL: oauthJwksUrl,
        AI_CS_OAUTH_AUDIENCE: resourceUrl,
        AI_CS_ALLOWED_ORIGINS: "https://chatgpt.com",
        AI_CS_DEV_ALLOWED_SUBJECTS: developmentSecrets[0],
        AI_CS_DEV_APPS_SCRIPT_URL: developmentSecrets[1],
        AI_CS_DEV_APPS_SCRIPT_KEY: developmentSecrets[2],
        AI_CS_PRODUCTION_ENABLED: "false",
      }),
      upstreamConfigured,
    };
  }

  return {
    config: {
      publicOrigin,
      resourceUrl,
      oauthIssuer,
      oauthJwksUrl,
      oauthAudience: resourceUrl,
      allowedOrigins: new Set([publicOrigin, "https://chatgpt.com", "https://chat.openai.com"]),
      productionEnabled: false,
      subjectEnvironment: new Map(),
      targets: {
        development: { name: "development", appsScriptUrl: "", appsScriptKey: "" },
        production: { name: "production", appsScriptUrl: "", appsScriptKey: "" },
      },
    },
    upstreamConfigured,
  };
}

function runtimeFor(env: WorkerBindings): Runtime {
  const cacheKey = env as object;
  const cached = runtimeCache.get(cacheKey);
  if (cached) return cached;

  const { config, upstreamConfigured } = developmentConfig(env);
  const runtime = {
    config,
    upstreamConfigured,
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
      upstream_configured: runtime.upstreamConfigured,
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
