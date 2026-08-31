import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { targetForSubject, type EnvironmentTarget, type ServerConfig } from "./config.ts";

export type Principal = {
  subject: string;
  clientId: string;
  scopes: Set<string>;
  expiresAt?: number;
  target: EnvironmentTarget;
  authInfo: AuthInfo;
};

export type TokenVerifier = (token: string, config: ServerConfig) => Promise<JWTPayload>;

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyJwt(token: string, config: ServerConfig): Promise<JWTPayload> {
  let jwks = remoteJwks.get(config.oauthJwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.oauthJwksUrl));
    remoteJwks.set(config.oauthJwksUrl, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.oauthIssuer,
    audience: config.oauthAudience,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["sub", "exp", "iat"],
  });
  return payload;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) throw new Error("AUTH_REQUIRED");
  return match[1];
}

function scopesFromPayload(payload: JWTPayload): Set<string> {
  const raw = typeof payload.scope === "string"
    ? payload.scope.split(/\s+/)
    : typeof payload.scp === "string"
      ? payload.scp.split(/\s+/)
    : Array.isArray(payload.scp)
      ? payload.scp
      : [];
  return new Set(raw.map(String).filter(Boolean));
}

export async function authenticateRequest(
  request: Request,
  config: ServerConfig,
  verifier: TokenVerifier = verifyJwt,
): Promise<Principal> {
  const token = bearerToken(request);
  const payload = await verifier(token, config);
  const subject = String(payload.sub ?? "");
  if (!subject) throw new Error("AUTH_SUBJECT_REQUIRED");
  const target = targetForSubject(config, subject);
  const scopes = scopesFromPayload(payload);
  const resource = typeof payload.resource === "string" ? payload.resource : typeof payload.aud === "string" ? payload.aud : "";
  if (resource && resource !== config.resourceUrl && resource !== config.oauthAudience) {
    throw new Error("AUTH_RESOURCE_MISMATCH");
  }
  const clientId = String(payload.client_id ?? payload.azp ?? "unknown");
  const expiresAt = typeof payload.exp === "number" ? payload.exp : undefined;
  return {
    subject,
    clientId,
    scopes,
    expiresAt,
    target,
    authInfo: {
      token,
      clientId,
      scopes: [...scopes],
      expiresAt,
      resource: new URL(config.resourceUrl),
      extra: { subject, environment: target.name },
    },
  };
}

export function requireScope(principal: Principal, scope: "cs:read" | "cs:sync" | "cs:review"): void {
  if (!principal.scopes.has(scope)) throw new Error(`SCOPE_REQUIRED:${scope}`);
}

export function oauthChallenge(config: ServerConfig): Response {
  const metadata = `${config.publicOrigin}/.well-known/oauth-protected-resource`;
  return Response.json(
    { ok: false, error: "UNAUTHORIZED", environment: "unresolved", auto_send: false, marketplace_write_actions: 0 },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer resource_metadata="${metadata}"`,
      },
    },
  );
}

export function validateRequestOrigin(request: Request, config: ServerConfig): Response | null {
  const url = new URL(request.url);
  const publicUrl = new URL(config.publicOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.host !== publicUrl.host && !(process.env.NODE_ENV !== "production" && local)) {
    return Response.json({ ok: false, error: "HOST_NOT_ALLOWED" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && !config.allowedOrigins.has(origin)) {
    return Response.json({ ok: false, error: "ORIGIN_NOT_ALLOWED" }, { status: 403 });
  }
  return null;
}

export function safeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "AUTH_FAILED";
  const allowed = new Set([
    "AUTH_REQUIRED",
    "AUTH_SUBJECT_REQUIRED",
    "AUTH_RESOURCE_MISMATCH",
    "ACCOUNT_NOT_AUTHORIZED",
    "PRODUCTION_DISABLED",
  ]);
  return allowed.has(message) ? message : "AUTH_FAILED";
}
