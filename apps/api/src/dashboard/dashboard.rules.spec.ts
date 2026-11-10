import { bucketLabels, fill, periodStart, todayBounds } from './dashboard.rules';

const now = new Date('2026-11-07T04:30:00Z'); // Saturday 07 Nov 2026, 10:00 in Colombo

describe('bucketLabels', () => {
  it('day: last 30 Colombo dates ending today', () => {
    const l = bucketLabels('day', now);
    expect(l).toHaveLength(30);
    expect(l[29]).toBe('2026-11-07');
    expect(l[0]).toBe('2026-10-09');
  });
  it('day: uses the Colombo date even when UTC is still the previous day', () => {
    expect(bucketLabels('day', new Date('2026-11-06T20:00:00Z')).at(-1)).toBe('2026-11-07');
  });
  it('week: Monday-based like date_trunc(week), 12 buckets', () => {
    const l = bucketLabels('week', now);
    expect(l).toHaveLength(12);
    expect(l[11]).toBe('2026-11-02'); // Monday of that week
    expect(new Date(l[0]).getUTCDay()).toBe(1);
  });
  it('month: first of month, 12 buckets, across a year boundary', () => {
    const l = bucketLabels('month', new Date('2026-02-10T00:00:00Z'));
    expect(l[11]).toBe('2026-02-01');
    expect(l[0]).toBe('2025-03-01');
  });
});

describe('periods', () => {
  it('today starts at Colombo midnight; 7d reaches back 6 more days', () => {
    expect(todayBounds(now).start.toISOString()).toBe('2026-11-06T18:30:00.000Z');
    expect(periodStart('7d', now).toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });
});

describe('fill', () => {
  it('adds zero buckets for missing days', () => {
    expect(fill(['a', 'b', 'c'], [{ bucket: 'b', n: 4 }])).toEqual([
      { bucket: 'a', count: 0 }, { bucket: 'b', count: 4 }, { bucket: 'c', count: 0 },
    ]);
  });
});
