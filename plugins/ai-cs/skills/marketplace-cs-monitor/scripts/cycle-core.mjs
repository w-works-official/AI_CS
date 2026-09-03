export const CHANNEL_CYCLE_ORDER = Object.freeze([
  "comments",
  "customer_qna",
  "customer_center",
  "talktalk",
  "zigzag_order_inquiry",
  "zigzag_item_question",
  "ably_inquiry",
]);

const normalizeRequested = (channels) => {
  const requested = new Set((channels ?? []).map((value) => String(value || "").trim()).filter(Boolean));
  const unknown = [...requested].filter((channel) => !CHANNEL_CYCLE_ORDER.includes(channel));
  if (unknown.length) throw new Error(`CYCLE_CHANNEL_UNSUPPORTED:${unknown.join(",")}`);
  return CHANNEL_CYCLE_ORDER.filter((channel) => requested.has(channel));
};

export function createChannelCycle(channels, { cycleId, startedAt = new Date().toISOString() } = {}) {
  const ordered = normalizeRequested(channels);
  if (!ordered.length) throw new Error("CYCLE_CHANNELS_REQUIRED");
  const id = String(cycleId || `CYCLE_${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`);
  return {
    cycle_id: id,
    started_at: startedAt,
    finished_at: "",
    state: "RUNNING",
    marketplace_write_actions: 0,
    channels: ordered.map((channel, index) => ({
      channel,
      sequence: index + 1,
      state: "PENDING",
      started_at: "",
      finished_at: "",
      error: "",
      sync_run_id: "",
      screenshot_count: 0,
    })),
  };
}

export function startNextChannel(cycle, at = new Date().toISOString()) {
  if (cycle.state !== "RUNNING") throw new Error("CYCLE_NOT_RUNNING");
  if (cycle.channels.some((item) => item.state === "RUNNING")) throw new Error("CYCLE_CHANNEL_ALREADY_RUNNING");
  const next = cycle.channels.find((item) => item.state === "PENDING");
  if (!next) return null;
  next.state = "RUNNING";
  next.started_at = at;
  return next;
}

export function finishChannel(cycle, channel, result, at = new Date().toISOString()) {
  const target = cycle.channels.find((item) => item.channel === channel);
  if (!target || target.state !== "RUNNING") throw new Error(`CYCLE_CHANNEL_NOT_RUNNING:${channel}`);
  const ok = result?.ok === true;
  target.state = ok ? "COMPLETED" : "FAILED";
  target.finished_at = at;
  target.error = ok ? "" : String(result?.error || "CHANNEL_FAILED").slice(0, 200);
  target.sync_run_id = ok ? String(result?.sync_run_id || "") : "";
  target.screenshot_count = ok ? Math.max(0, Number(result?.screenshot_count || 0) || 0) : 0;
  if (Number(result?.marketplace_write_actions || 0) !== 0) throw new Error("MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED");
  if (!cycle.channels.some((item) => item.state === "PENDING" || item.state === "RUNNING")) {
    cycle.state = cycle.channels.some((item) => item.state === "FAILED") ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    cycle.finished_at = at;
  }
  return target;
}

export function cycleSummary(cycle) {
  return {
    cycle_id: cycle.cycle_id,
    state: cycle.state,
    completed: cycle.channels.filter((item) => item.state === "COMPLETED").length,
    failed: cycle.channels.filter((item) => item.state === "FAILED").length,
    pending: cycle.channels.filter((item) => item.state === "PENDING").length,
    screenshot_count: cycle.channels.reduce((total, item) => total + Number(item.screenshot_count || 0), 0),
    marketplace_write_actions: 0,
  };
}
