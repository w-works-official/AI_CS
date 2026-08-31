import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticateRequest, oauthChallenge, safeAuthError, validateRequestOrigin, type TokenVerifier } from "./auth.ts";
import { loadServerConfig, type ServerConfig } from "./config.ts";
import { createCsMcpServer } from "./tools.ts";

export function createAuthenticatedMcpHandler(options: {
  config?: ServerConfig;
  verifier?: TokenVerifier;
} = {}) {
  const config = options.config ?? loadServerConfig();

  return async function handle(request: Request): Promise<Response> {
    const originRejection = validateRequestOrigin(request, config);
    if (originRejection) return originRejection;

    let principal;
    try {
      principal = await authenticateRequest(request, config, options.verifier);
    } catch (error) {
      const challenge = oauthChallenge(config);
      const body = await challenge.json() as Record<string, unknown>;
      return Response.json({ ...body, error: safeAuthError(error) }, { status: 401, headers: challenge.headers });
    }

    const handler = createMcpHandler(() => createCsMcpServer(principal), {
      legacy: "stateless",
      responseMode: "json",
      onerror: () => undefined,
    });
    return handler.fetch(request, { authInfo: principal.authInfo });
  };
}
