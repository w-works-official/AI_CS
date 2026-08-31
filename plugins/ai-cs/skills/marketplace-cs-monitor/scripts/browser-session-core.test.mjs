import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireCollectorLock,
  inspectGoogleChromeSession,
  normalizeLoopbackCdpUrl,
  resolveBrowserSession,
} from "./browser-session-core.mjs";

assert.equal(normalizeLoopbackCdpUrl("http://127.0.0.1:9222/json"), "http://127.0.0.1:9222");
assert.throws(() => normalizeLoopbackCdpUrl("https://example.com"), /LOOPBACK_CDP_URL_REQUIRED/);
assert.throws(() => normalizeLoopbackCdpUrl("http://user:pass@127.0.0.1:9222"), /CDP_CREDENTIALS_NOT_ALLOWED/);

const temp = await mkdtemp(path.join(os.tmpdir(), "market-cs-browser-"));
try {
  const sessionFile = path.join(temp, "active-browser.json");
  await writeFile(sessionFile, JSON.stringify({ cdp_url: "http://localhost:9333", session_label: "operator-selected", browser_endpoint_id: "browser-a" }), "utf8");
  const fromFile = await resolveBrowserSession({ env: { LOCALAPPDATA: temp, CS_BROWSER_SESSION_FILE: sessionFile } });
  assert.equal(fromFile.cdp_url, "http://localhost:9333");
  assert.equal(fromFile.source, "session_file");

  const fromEnv = await resolveBrowserSession({ env: { SMARTSTORE_CDP_URL: "http://127.0.0.1:9444" } });
  assert.equal(fromEnv.source, "environment");

  const inspected = await inspectGoogleChromeSession(fromFile, {
    fetchImpl: async () => new Response(JSON.stringify({ Browser: "Chrome/140", "User-Agent": "Chrome/140", webSocketDebuggerUrl: "ws://localhost:9333/devtools/browser/browser-a" })),
  });
  assert.equal(inspected.browser_family, "chrome");
  await assert.rejects(
    () => inspectGoogleChromeSession(fromFile, {
      fetchImpl: async () => new Response(JSON.stringify({ Browser: "Chrome/140", "User-Agent": "Chrome/140", webSocketDebuggerUrl: "ws://localhost:9333/devtools/browser/browser-b" })),
    }),
    /ACTIVE_CS_CHROME_SESSION_CHANGED/,
  );
  await assert.rejects(
    () => inspectGoogleChromeSession(fromFile, {
      fetchImpl: async () => new Response(JSON.stringify({ Browser: "Whale/4", "User-Agent": "Whale/4 Chrome/140" })),
    }),
    /WHALE_CDP_NOT_ALLOWED/,
  );

  const lockEnv = { LOCALAPPDATA: temp, CS_COLLECTOR_LOCK_FILE: path.join(temp, "collector.lock") };
  const release = await acquireCollectorLock({ env: lockEnv });
  await assert.rejects(() => acquireCollectorLock({ env: lockEnv }), /CS_COLLECTOR_ALREADY_RUNNING/);
  await release();
  const releaseAgain = await acquireCollectorLock({ env: lockEnv });
  await releaseAgain();
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log("marketplace-cs-monitor browser session core: PASS");
