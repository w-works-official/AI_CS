const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function dateOnly(value) {
  const text = compact(value).replaceAll(".", "-");
  const match = text.match(/^(20\d{2}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

function channelPrefix(market, channel) {
  return `${compact(market).toLowerCase()}:${compact(channel).toLowerCase()}:`;
}

export function assessOperationalRefresh(report, previousCases = []) {
  const blockers = [];
  const warnings = [];
  const channels = {};
  const rangeStart = dateOnly(report?.range?.start);
  const rangeEnd = dateOnly(report?.range?.end);

  for (const [channelKey, channel] of Object.entries(report?.channels ?? {})) {
    if (!channel?.attempted) continue;
    const prefix = channelPrefix(channel.market, channel.channel);
    const currentKeys = new Set((report?.records ?? [])
      .map((record) => compact(record?.source_key))
      .filter((key) => key.startsWith(prefix)));
    const previousInRange = (previousCases ?? []).filter((record) => {
      const key = compact(record?.source_key);
      const occurred = dateOnly(record?.occurred_at);
      return key.startsWith(prefix)
        && occurred
        && (!rangeStart || occurred >= rangeStart)
        && (!rangeEnd || occurred <= rangeEnd);
    });
    const missingPreviousKeys = previousInRange
      .map((record) => compact(record.source_key))
      .filter((key) => !currentKeys.has(key));
    const expected = Number(channel.history_expected_total ?? 0) || 0;
    const observed = Number(channel.history_observed_total ?? channel.collected_count ?? 0) || 0;
    const complete = channel.history_scan_complete === true;
    const channelBlockers = [];
    const channelWarnings = [];

    if (compact(channel.error)) channelBlockers.push("CHANNEL_ERROR");
    if (complete && observed < expected) channelBlockers.push("HISTORY_TOTAL_MISMATCH");
    if (complete && missingPreviousKeys.length) channelBlockers.push("PREVIOUS_IN_RANGE_CASES_MISSING");
    if (!complete) channelWarnings.push(compact(channel.history_error) || "HISTORY_SCAN_INCOMPLETE");

    for (const reason of channelBlockers) blockers.push({ channel: channelKey, reason });
    for (const reason of channelWarnings) warnings.push({ channel: channelKey, reason });
    channels[channelKey] = {
      history_scan_complete: complete,
      history_window_start: compact(channel.history_window_start),
      expected_total: expected,
      observed_total: observed,
      previous_in_range_count: previousInRange.length,
      missing_previous_count: missingPreviousKeys.length,
      blockers: channelBlockers,
      warnings: channelWarnings,
    };
  }

  return {
    mode: "ROLLING_HISTORY_REFRESH",
    ready: blockers.length === 0,
    blockers,
    warnings,
    channels,
  };
}
