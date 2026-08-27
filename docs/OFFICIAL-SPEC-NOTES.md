# Official OpenAI plugin and MCP requirements used

The implementation follows these primary sources checked on 2026-08-25:

- [OpenAI plugin concepts](https://developers.openai.com/plugins/concepts/plugins): a plugin packages skills, MCP connections, and optional UI.
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server): use the official MCP SDK, explicit schemas, safe tool annotations, and a stable HTTPS Streamable HTTP endpoint.
- [MCP authentication](https://developers.openai.com/plugins/build/auth): private MCP servers use OAuth protected-resource metadata, per-tool security schemes, authorization-server discovery, resource indicators, PKCE S256, and verified JWT claims. OpenAI recommends an established provider and documents Auth0 as one option.
- [Build and package plugins](https://developers.openai.com/plugins/build/plugins): `.codex-plugin/plugin.json`, skill folders, `.mcp.json`, and registered `.app.json` composition.
- [Connect and test in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt): enable developer mode, register the private MCP connection, copy its `plugin_asdk_app...` ID, and test privately before any distribution.
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): `@modelcontextprotocol/server` v2, `McpServer`, `createMcpHandler`, Streamable HTTP, and caller-supplied verified auth information.

This repository intentionally commits only `.app.example.json`. A real `.app.json` depends on an external private ChatGPT connection and remains ignored until that approved setup step.
