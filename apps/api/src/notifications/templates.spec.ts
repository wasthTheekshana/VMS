import { clean, formatColombo, hostSms, inAppText, latestCutoff, toE164LK, visitorSms } from './templates';

const ctx = { referenceNo: 'V-20261107-ABC234', visitorName: 'Nimal Perera', hostName: 'Kamal', guardRoomName: 'Gate 1', expectedAt: new Date('2026-11-07T09:00:00Z') };

describe('templates', () => {
  it('formats times in Sri Lanka time', () => {
    expect(formatColombo(new Date('2026-11-07T09:00:00Z'))).toBe('07 Nov 2026, 14:30');
  });
  it('builds the visitor SMS with reference, time, guard room and host (FR-18)', () => {
    const s = visitorSms('pre_registered', ctx);
    expect(s).toContain('V-20261107-ABC234');
    expect(s).toContain('07 Nov 2026, 14:30');
    expect(s).toContain('Gate 1');
    expect(s).toContain('Kamal');
  });
  it('never puts NIC-like or phone data in in-app text', () => {
    for (const e of ['pre_registered', 'walk_in', 'checked_in', 'checked_out', 'overstay', 'blacklist_hit'] as const) {
      expect(JSON.stringify(inAppText(e, ctx))).not.toMatch(/\d{9,}/);
    }
  });
  it('strips control characters so names cannot forge extra lines', () => {
    expect(clean('Bob\r\nBcc: evil@x.com')).not.toMatch(/[\r\n]/);
    expect(hostSms('checked_in', { ...ctx, visitorName: 'A\nB' })).not.toContain('\n');
  });
});

describe('toE164LK', () => {
  it.each([
    ['0771234567', '+94771234567'], ['771234567', '+94771234567'], ['94771234567', '+94771234567'],
    ['+94 77 123 4567', '+94771234567'], ['+14155550123', '+14155550123'],
  ])('%s -> %s', (i, o) => expect(toE164LK(i)).toBe(o));
  it.each(['', 'abc', '123', null, undefined])('rejects %s', (i) => expect(toE164LK(i as any)).toBeNull());
});

describe('latestCutoff', () => {
  it('is today at the cut-off once it has passed, otherwise yesterday (Colombo time)', () => {
    // 21:00 Colombo on 7 Nov = 15:30Z
    expect(latestCutoff(new Date('2026-11-07T15:30:00Z'), '20:00').toISOString()).toBe('2026-11-07T14:30:00.000Z');
    // 10:00 Colombo on 7 Nov = 04:30Z -> yesterday's cut-off
    expect(latestCutoff(new Date('2026-11-07T04:30:00Z'), '20:00').toISOString()).toBe('2026-11-06T14:30:00.000Z');
  });
  it('rejects a malformed setting', () => {
    expect(() => latestCutoff(new Date(), '8pm')).toThrow();
  });
});
