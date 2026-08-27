import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function runtimeRoot(env = process.env) {
  const base = env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, "PinkRocketCS");
}

export function defaultSessionFile(env = process.env) {
  return env.CS_BROWSER_SESSION_FILE || path.join(runtimeRoot(env), "active-browser.json");
}

export function defaultLockFile(env = process.env) {
  return env.CS_COLLECTOR_LOCK_FILE || path.join(runtimeRoot(env), "smartstore-collector.lock");
}

export function normalizeLoopbackCdpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("INVALID_CDP_URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("LOOPBACK_CDP_URL_REQUIRED");
  }
  if (url.username || url.password) throw new Error("CDP_CREDENTIALS_NOT_ALLOWED");
  return url.origin;
}

export async function resolveBrowserSession({ env = process.env, readFileImpl = readFile } = {}) {
  if (env.SMARTSTORE_CDP_URL) {
    return {
      cdp_url: normalizeLoopbackCdpUrl(env.SMARTSTORE_CDP_URL),
      source: "environment",
      session_label: "explicit-cdp",
    };
  }

  const sessionFile = defaultSessionFile(env);
  let parsed;
  try {
    const raw = await readFileImpl(sessionFile, "utf8");
    parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("ACTIVE_CS_CHROME_SESSION_NOT_FOUND");
    throw new Error("ACTIVE_CS_CHROME_SESSION_INVALID");
  }
  return {
    cdp_url: normalizeLoopbackCdpUrl(parsed?.cdp_url),
    source: "session_file",
    session_label: String(parsed?.session_label || "local-cs-chrome").slice(0, 80),
    browser_pid: Number(parsed?.browser_pid) || null,
    browser_endpoint_id: String(parsed?.browser_endpoint_id || "").slice(0, 120),
    registered_at: String(parsed?.registered_at || ""),
  };
}

export async function inspectGoogleChromeSession(session, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("FETCH_NOT_AVAILABLE");
  const endpoint = new URL("/json/version", session.cdp_url).toString();
  let response;
  try {
    response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new Error("ACTIVE_CS_CHROME_UNREACHABLE");
  }
  if (!response.ok) throw new Error(`CDP_VERSION_CHECK_FAILED:${response.status}`);
  const version = await response.json();
  const identity = `${version.Browser || ""} ${version["User-Agent"] || ""}`;
  if (/Whale/i.test(identity)) throw new Error("WHALE_CDP_NOT_ALLOWED");
  if (!/Chrome/i.test(identity)) throw new Error("GOOGLE_CHROME_CDP_REQUIRED");
  const endpointId = String(version.webSocketDebuggerUrl || "").split("/devtools/browser/").pop() || "";
  if (session.browser_endpoint_id && endpointId !== session.browser_endpoint_id) {
    throw new Error("ACTIVE_CS_CHROME_SESSION_CHANGED");
  }
  return { ...session, browser_family: "chrome" };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function existingLockIsActive(lockFile, ttlMs) {
  try {
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    const startedAt = Date.parse(lock?.started_at || "");
    const fresh = Number.isFinite(startedAt) && Date.now() - startedAt < ttlMs;
    return fresh && processIsAlive(Number(lock?.pid));
  } catch {
    return false;
  }
}

export async function acquireCollectorLock({ env = process.env, ttlMs = DEFAULT_LOCK_TTL_MS } = {}) {
  const lockFile = defaultLockFile(env);
  await mkdir(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf8");
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        await rm(lockFile, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await existingLockIsActive(lockFile, ttlMs)) throw new Error("CS_COLLECTOR_ALREADY_RUNNING");
      await rm(lockFile, { force: true });
    }
  }
  throw new Error("CS_COLLECTOR_LOCK_FAILED");
}
