# Pink Rocket AI CS private plugin

This folder is the installable private plugin package. It contains:

- `.codex-plugin/plugin.json`: plugin manifest;
- `.mcp.json`: local development MCP connection;
- `.app.example.json`: validated template for the private ChatGPT-registered MCP app ID;
- `skills/marketplace-cs-monitor/`: signed-in Chrome collection, masking, comparison, answer-library, and draft rules.

The remote MCP endpoint is implemented by the existing repository application at `/mcp`. The MCP endpoint cannot access the user's local Chrome by itself. Collection requires the official Chrome capability in the same ChatGPT session; persistence and review use the authenticated MCP tools.

Never add a real `.app.json`, OAuth token, Apps Script URL, Apps Script key, cookie, or customer data to this folder.

After ChatGPT creates a private MCP connection, copy `.app.example.json` to ignored `.app.json`, replace only its `id` with the `plugin_asdk_app...` technical ID, and add `"apps": "./.app.json"` to the local manifest. Do not commit either the real registration or its ID.
