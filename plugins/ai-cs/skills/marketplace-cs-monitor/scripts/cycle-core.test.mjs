import assert from "node:assert/strict";
import { CHANNEL_CYCLE_ORDER, createChannelCycle, cycleSummary, finishChannel, startNextChannel } from "./cycle-core.mjs";

const cycle = createChannelCycle(["ably_inquiry", "comments", "talktalk"], {
  cycleId: "CYCLE_test",
  startedAt: "2026-09-03T00:00:00.000Z",
});
assert.deepEqual(cycle.channels.map((item) => item.channel), ["comments", "talktalk", "ably_inquiry"]);
assert.equal(startNextChannel(cycle, "2026-09-03T00:00:01.000Z").channel, "comments");
assert.throws(() => startNextChannel(cycle), /CYCLE_CHANNEL_ALREADY_RUNNING/);
finishChannel(cycle, "comments", { ok: true, sync_run_id: "SYNC_1", screenshot_count: 2, marketplace_write_actions: 0 });
assert.equal(startNextChannel(cycle).channel, "talktalk");
finishChannel(cycle, "talktalk", { ok: false, error: "SELECTOR_CHANGED", marketplace_write_actions: 0 });
assert.equal(startNextChannel(cycle).channel, "ably_inquiry");
finishChannel(cycle, "ably_inquiry", { ok: true, sync_run_id: "SYNC_3", screenshot_count: 1, marketplace_write_actions: 0 });
assert.deepEqual(cycleSummary(cycle), {
  cycle_id: "CYCLE_test", state: "COMPLETED_WITH_ERRORS", completed: 2, failed: 1, pending: 0,
  screenshot_count: 3, marketplace_write_actions: 0,
});
assert.throws(() => createChannelCycle(["unknown"]), /CYCLE_CHANNEL_UNSUPPORTED/);
assert.throws(() => createChannelCycle([]), /CYCLE_CHANNELS_REQUIRED/);
assert.deepEqual(CHANNEL_CYCLE_ORDER.slice(0, 2), ["comments", "customer_qna"]);

console.log("marketplace-cs-monitor channel cycle core: PASS");
