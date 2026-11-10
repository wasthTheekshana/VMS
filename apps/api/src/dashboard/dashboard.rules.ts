const COLOMBO_OFFSET_MS = 5.5 * 3600_000;
const DAY = 86_400_000;

export type Granularity = 'day' | 'week' | 'month';
export type Period = 'today' | '7d' | '30d';

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Colombo "today" as a UTC-midnight timestamp of that calendar date (an arithmetic helper, not an instant). */
function colomboDateMs(now: Date): number {
  const l = new Date(now.getTime() + COLOMBO_OFFSET_MS);
  return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
}

/** Bucket start dates ("YYYY-MM-DD", Colombo calendar), oldest first. Matches Postgres date_trunc output. */
export function bucketLabels(g: Granularity, now = new Date()): string[] {
  const today = colomboDateMs(now);
  if (g === 'day') return Array.from({ length: 30 }, (_, i) => ymd(today - (29 - i) * DAY));
  if (g === 'week') {
    const dow = (new Date(today).getUTCDay() + 6) % 7; // Monday = 0, as date_trunc('week')
    const monday = today - dow * DAY;
    return Array.from({ length: 12 }, (_, i) => ymd(monday - (11 - i) * 7 * DAY));
  }
  const d = new Date(today);
  return Array.from({ length: 12 }, (_, i) =>
    ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (11 - i), 1)));
}

/** Start instant (UTC) of a Colombo calendar date. */
export const instantOf = (label: string) => new Date(Date.parse(`${label}T00:00:00.000Z`) - COLOMBO_OFFSET_MS);

export function periodStart(p: Period, now = new Date()): Date {
  const days = p === 'today' ? 0 : p === '7d' ? 6 : 29;
  return new Date(instantOf(ymd(colomboDateMs(now))).getTime() - days * DAY);
}

export function todayBounds(now = new Date()): { start: Date; end: Date } {
  const start = instantOf(ymd(colomboDateMs(now)));
  return { start, end: new Date(start.getTime() + DAY) };
}

/** Merge sparse SQL rows into the full label list so charts have no gaps. */
export function fill(labels: string[], rows: { bucket: string; n: number }[]): { bucket: string; count: number }[] {
  const m = new Map(rows.map((r) => [r.bucket, r.n]));
  return labels.map((bucket) => ({ bucket, count: m.get(bucket) ?? 0 }));
}
