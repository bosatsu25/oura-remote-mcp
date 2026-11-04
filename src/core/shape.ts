/**
 * Transform raw Oura documents into compact, stable tool outputs.
 * Keeping outputs small matters: Claude's tool-result cap is ~150k characters.
 */

export interface OuraSleepDoc {
  id: string;
  day: string;
  type: "long_sleep" | "sleep" | "late_nap" | "rest" | string;
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_duration: number | null;
  time_in_bed: number | null;
  efficiency: number | null;
  latency: number | null;
  awake_time: number | null;
  deep_sleep_duration: number | null;
  light_sleep_duration: number | null;
  rem_sleep_duration: number | null;
  average_hrv: number | null;
  average_heart_rate: number | null;
  lowest_heart_rate: number | null;
  average_breath: number | null;
  restless_periods?: number | null;
}

export interface OuraDailySleepDoc {
  day: string;
  score: number | null;
  contributors: Record<string, number | null>;
}

export interface OuraDailyReadinessDoc {
  day: string;
  score: number | null;
  temperature_deviation: number | null;
  temperature_trend_deviation?: number | null;
  contributors: Record<string, number | null>;
}

export interface OuraHeartRateSample {
  bpm: number;
  source: string;
  timestamp: string;
}

const secToHours = (s: number | null): number | null => (s === null ? null : Math.round((s / 3600) * 100) / 100);

export interface SleepPeriodOut {
  day: string;
  type: string;
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_h: number | null;
  time_in_bed_h: number | null;
  efficiency_pct: number | null;
  latency_min: number | null;
  awake_min: number | null;
  deep_h: number | null;
  light_h: number | null;
  rem_h: number | null;
  average_hrv_ms: number | null;
  average_hr_bpm: number | null;
  lowest_hr_bpm: number | null;
  average_breath_rpm: number | null;
}

export function shapeSleepPeriods(docs: OuraSleepDoc[], includeAllPeriods: boolean): SleepPeriodOut[] {
  return docs
    .filter((d) => includeAllPeriods || d.type === "long_sleep")
    .sort((a, b) => a.bedtime_start.localeCompare(b.bedtime_start))
    .map((d) => ({
      day: d.day,
      type: d.type,
      bedtime_start: d.bedtime_start,
      bedtime_end: d.bedtime_end,
      total_sleep_h: secToHours(d.total_sleep_duration),
      time_in_bed_h: secToHours(d.time_in_bed),
      efficiency_pct: d.efficiency,
      latency_min: d.latency === null ? null : Math.round(d.latency / 60),
      awake_min: d.awake_time === null ? null : Math.round(d.awake_time / 60),
      deep_h: secToHours(d.deep_sleep_duration),
      light_h: secToHours(d.light_sleep_duration),
      rem_h: secToHours(d.rem_sleep_duration),
      average_hrv_ms: d.average_hrv,
      average_hr_bpm: d.average_heart_rate,
      lowest_hr_bpm: d.lowest_heart_rate,
      average_breath_rpm: d.average_breath,
    }));
}

export function shapeDailySleep(docs: OuraDailySleepDoc[]): Array<{ day: string; score: number | null; contributors: Record<string, number | null> }> {
  return docs
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, score: d.score, contributors: d.contributors ?? {} }));
}

export function shapeReadiness(docs: OuraDailyReadinessDoc[]): Array<{
  day: string;
  score: number | null;
  temperature_deviation_c: number | null;
  contributors: Record<string, number | null>;
}> {
  return docs
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      day: d.day,
      score: d.score,
      temperature_deviation_c: d.temperature_deviation,
      contributors: d.contributors ?? {},
    }));
}

export interface HourlyHr {
  hour_start: string; // ISO, UTC, truncated to the hour
  samples: number;
  min_bpm: number;
  avg_bpm: number;
  max_bpm: number;
}

/** Aggregate 5-minute samples into hourly buckets (UTC). Keeps output bounded. */
export function aggregateHeartRateHourly(samples: OuraHeartRateSample[]): HourlyHr[] {
  const buckets = new Map<string, { n: number; min: number; max: number; sum: number }>();
  for (const s of samples) {
    if (typeof s.bpm !== "number" || !Number.isFinite(s.bpm)) continue;
    const t = new Date(s.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    t.setUTCMinutes(0, 0, 0);
    const key = t.toISOString();
    const b = buckets.get(key);
    if (!b) buckets.set(key, { n: 1, min: s.bpm, max: s.bpm, sum: s.bpm });
    else {
      b.n += 1;
      b.min = Math.min(b.min, s.bpm);
      b.max = Math.max(b.max, s.bpm);
      b.sum += s.bpm;
    }
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour_start, b]) => ({
      hour_start,
      samples: b.n,
      min_bpm: b.min,
      avg_bpm: Math.round(b.sum / b.n),
      max_bpm: b.max,
    }));
}
