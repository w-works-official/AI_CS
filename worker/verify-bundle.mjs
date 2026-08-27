import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const bundlePath = path.join(root, ".wrangler", "mcp-development-dry-run", "mcp-development.js");
const configPath = path.join(root, "wrangler.mcp-development.jsonc");
const maxFreeWorkerBytes = 3 * 1024 * 1024;

const [bundle, configText, bundleStat] = await Promise.all([
  readFile(bundlePath, "utf8"),
  readFile(configPath, "utf8"),
  stat(bundlePath),
]);

const config = JSON.parse(configText);
assert.ok(bundleStat.size < maxFreeWorkerBytes, `MCP Worker bundle is ${bundleStat.size} bytes; expected less than ${maxFreeWorkerBytes}`);

for (const marker of ["react-server-dom-webpack", "vinext-client-assets", "_next/static", "PINK ROCKET · CS REVIEW"]) {
  assert.equal(bundle.includes(marker), false, `Frontend marker found in MCP Worker bundle: ${marker}`);
}

assert.equal(config.name, "ai-cs-mcp-development");
assert.equal(config.main, "worker/mcp-development.ts");
assert.equal(config.workers_dev, true);
assert.equal(config.preview_urls, false);
assert.equal(Object.hasOwn(config, "limits"), false);
assert.equal(config.observability?.enabled, false);
assert.equal(Object.hasOwn(config, "vars"), false);
assert.equal(Object.hasOwn(config, "secrets"), false);

for (const forbiddenBinding of ["ai", "analytics_engine_datasets", "browser", "d1_databases", "durable_objects", "hyperdrive", "kv_namespaces", "queues", "r2_buckets", "services", "tail_consumers", "triggers", "vectorize", "workflows"] ) {
  assert.equal(Object.hasOwn(config, forbiddenBinding), false, `Forbidden Cloudflare binding found: ${forbiddenBinding}`);
}

console.log(JSON.stringify({
  ok: true,
  bundle: path.relative(root, bundlePath),
  bytes: bundleStat.size,
  free_worker_limit_bytes: maxFreeWorkerBytes,
  frontend_markers: 0,
  paid_bindings: 0,
  plain_text_vars: 0,
  secrets: 0,
  observability: false,
  free_plan_cpu_ms: 10,
  cpu_limit_source: "workers_free_plan",
  environment: "development",
  production_enabled: false,
}));
