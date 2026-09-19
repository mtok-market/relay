export function normalizeFeeSchedule(schedule) {
  if (!Array.isArray(schedule) || !schedule.length || schedule.length > 64) throw new TypeError('fee schedule must contain 1..64 activation records');
  let previous = -1;
  return schedule.map(({ effectiveAtMs, feeBps }, index) => {
    if (!Number.isSafeInteger(effectiveAtMs) || effectiveAtMs <= previous || (index === 0 && effectiveAtMs !== 0)) {
      throw new TypeError('fee activations must start at 0 and increase in integer milliseconds');
    }
    if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new TypeError('feeBps must be an integer from 0 to 10000');
    previous = effectiveAtMs;
    return { effectiveAtMs, feeBps };
  });
}

// Schedules are normalized when configuration is loaded. Historical payments
// use their verified block time, never the relay's boot or first-observation time.
export function feeBpsAt(schedule, timeMs) {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new TypeError('verified payment time is required for fee policy');
  return schedule.findLast(entry => entry.effectiveAtMs <= timeMs).feeBps;
}

// A buyer can read config immediately before an activation, then mine just
// after it. The previous rate is valid for one minute, never for a relay's lifetime.
export function paymentFeeBpsAt(schedule, paidAtMs) {
  const start = Math.max(0, paidAtMs - 60_000);
  let minimum = Math.min(feeBpsAt(schedule, paidAtMs), feeBpsAt(schedule, start));
  for (const entry of schedule) {
    if (entry.effectiveAtMs > start && entry.effectiveAtMs <= paidAtMs) minimum = Math.min(minimum, entry.feeBps);
  }
  return minimum;
}
