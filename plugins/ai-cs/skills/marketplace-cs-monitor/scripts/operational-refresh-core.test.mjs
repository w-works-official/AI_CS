import assert from "node:assert/strict";
import { assessOperationalRefresh } from "./operational-refresh-core.mjs";

const base = {
  range: { start: "2026-08-04", end: "2026-09-03" },
  records: [{ source_key: "smartstore:talktalk:one" }],
  channels: {
    smartstore_talktalk: {
      market: "smartstore", channel: "talktalk", attempted: true, error: "",
      collected_count: 1, history_scan_complete: true,
      history_expected_total: 1, history_observed_total: 1,
      history_window_start: "2026-08-04", history_error: "",
    },
  },
};

assert.equal(assessOperationalRefresh(base, [{
  source_key: "smartstore:talktalk:one", occurred_at: "2026-09-03",
}]).ready, true);

const missing = assessOperationalRefresh(base, [{
  source_key: "smartstore:talktalk:two", occurred_at: "2026-09-01",
}]);
assert.equal(missing.ready, false);
assert.equal(missing.channels.smartstore_talktalk.missing_previous_count, 1);
assert.equal(missing.blockers[0].reason, "PREVIOUS_IN_RANGE_CASES_MISSING");

const incomplete = structuredClone(base);
incomplete.channels.smartstore_talktalk.history_scan_complete = false;
incomplete.channels.smartstore_talktalk.history_error = "PAGINATION_COMPLETENESS_UNPROVEN";
const warned = assessOperationalRefresh(incomplete, []);
assert.equal(warned.ready, true);
assert.equal(warned.warnings[0].reason, "PAGINATION_COMPLETENESS_UNPROVEN");

const mismatch = structuredClone(base);
mismatch.channels.smartstore_talktalk.history_expected_total = 2;
assert.equal(assessOperationalRefresh(mismatch, []).ready, false);

console.log("operational-refresh-core tests passed");
