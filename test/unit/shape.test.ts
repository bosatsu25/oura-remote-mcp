import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateHeartRateHourly, shapeReadiness, shapeSleepPeriods, type OuraSleepDoc } from "../../src/core/shape";

const base: OuraSleepDoc = {
  id: "x",
  day: "2026-11-03",
  type: "long_sleep",
  bedtime_start: "2026-11-03T01:40:00+09:00",
  bedtime_end: "2026-11-03T07:50:00+09:00",
  total_sleep_duration: 19800,
  time_in_bed: 22200,
  efficiency: 89,
  latency: 600,
  awake_time: 2400,
  deep_sleep_duration: 3600,
  light_sleep_duration: 12600,
  rem_sleep_duration: 3600,
  average_hrv: 41,
  average_heart_rate: 58.5,
  lowest_heart_rate: 49,
  average_breath: 13.2,
};

describe("shape", () => {
  it("keeps only long_sleep by default and converts units", () => {
    const docs: OuraSleepDoc[] = [
      { ...base, id: "nap", type: "late_nap", bedtime_start: "2026-11-03T15:00:00+09:00" },
      base,
      { ...base, id: "rest", type: "rest", bedtime_start: "2026-11-03T13:00:00+09:00" },
    ];
    const out = shapeSleepPeriods(docs, false);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.total_sleep_h, 5.5);
    assert.equal(out[0]!.latency_min, 10);
    assert.equal(out[0]!.awake_min, 40);
    assert.equal(out[0]!.lowest_hr_bpm, 49);
    assert.equal(shapeSleepPeriods(docs, true).length, 3);
    // sorted by bedtime_start
    assert.equal(shapeSleepPeriods(docs, true)[0]!.type, "long_sleep");
  });

  it("tolerates nulls", () => {
    const out = shapeSleepPeriods([{ ...base, total_sleep_duration: null, latency: null, awake_time: null, average_hrv: null }], false);
    assert.equal(out[0]!.total_sleep_h, null);
    assert.equal(out[0]!.latency_min, null);
    assert.equal(out[0]!.average_hrv_ms, null);
  });

  it("shapes readiness with contributors and sorts by day", () => {
    const out = shapeReadiness([
      { day: "2026-11-03", score: 70, temperature_deviation: -0.2, contributors: { resting_heart_rate: 80 } },
      { day: "2026-11-02", score: 65, temperature_deviation: null, contributors: { resting_heart_rate: 75 } },
    ]);
    assert.deepEqual(out.map((d) => d.day), ["2026-11-02", "2026-11-03"]);
    assert.equal(out[1]!.temperature_deviation_c, -0.2);
  });

  it("aggregates heart rate into hourly UTC buckets and ignores junk", () => {
    const out = aggregateHeartRateHourly([
      { bpm: 60, source: "sleep", timestamp: "2026-11-03T01:05:00+00:00" },
      { bpm: 50, source: "sleep", timestamp: "2026-11-03T01:55:00+00:00" },
      { bpm: 70, source: "awake", timestamp: "2026-11-03T02:10:00+00:00" },
      { bpm: Number.NaN, source: "awake", timestamp: "2026-11-03T02:20:00+00:00" },
      { bpm: 80, source: "awake", timestamp: "not a date" },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { hour_start: "2026-11-03T01:00:00.000Z", samples: 2, min_bpm: 50, avg_bpm: 55, max_bpm: 60 });
    assert.equal(out[1]!.samples, 1);
  });
});
