import { colomboDayBounds, isValidNic, maskPhone, newReferenceNo } from './visit-rules';

describe('isValidNic', () => {
  it.each(['199512345678', '951234567V', '951234567x', 'B1234567', ' 1995 1234 5678 ', '95-1234567v'])('accepts %s', (n) => {
    expect(isValidNic(n)).toBe(true);
  });
  it.each(['', '12345', '95123456VV', '1995123456789', 'AB123456', "1'; DROP TABLE--"])('rejects %s', (n) => {
    expect(isValidNic(n)).toBe(false);
  });
});

describe('colomboDayBounds', () => {
  it('uses the Sri Lanka calendar day, not UTC', () => {
    // 2026-11-06 20:00 UTC is already 2026-11-07 01:30 in Colombo
    const { start, end } = colomboDayBounds(new Date('2026-11-06T20:00:00Z'));
    expect(start.toISOString()).toBe('2026-11-06T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-07T18:30:00.000Z');
  });
  it('covers 05:00 Colombo morning on the same day', () => {
    const { start } = colomboDayBounds(new Date('2026-11-07T00:00:00Z')); // 05:30 Colombo
    expect(start.toISOString()).toBe('2026-11-06T18:30:00.000Z');
  });
});

describe('newReferenceNo', () => {
  it('has the expected shape and is unique enough', () => {
    const now = new Date('2026-11-06T20:00:00Z');
    const refs = new Set(Array.from({ length: 500 }, () => newReferenceNo(now)));
    expect(refs.size).toBe(500);
    for (const r of refs) expect(r).toMatch(/^V-20261107-[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('maskPhone', () => {
  it('keeps only the last three digits', () => {
    expect(maskPhone('0771234567')).toBe('*******567');
    expect(maskPhone(null)).toBeNull();
  });
});
