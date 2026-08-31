import { loadServerConfig } from "@/mcp-server/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = loadServerConfig();
    return Response.json({
      resource: config.resourceUrl,
      authorization_servers: [config.oauthIssuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["cs:read", "cs:sync", "cs:review"],
      resource_documentation: `${config.publicOrigin}/docs/plugin-security`,
    }, {
      headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return Response.json({ error: "MCP_AUTH_NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
