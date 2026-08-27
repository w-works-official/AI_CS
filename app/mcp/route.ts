import { createAuthenticatedMcpHandler } from "@/mcp-server/handler";

export const dynamic = "force-dynamic";

let cachedHandler: ReturnType<typeof createAuthenticatedMcpHandler> | undefined;

function handler() {
  cachedHandler ??= createAuthenticatedMcpHandler();
  return cachedHandler;
}

export async function GET(request: Request) {
  return handler()(request);
}

export async function POST(request: Request) {
  return handler()(request);
}

export async function DELETE(request: Request) {
  return handler()(request);
}
