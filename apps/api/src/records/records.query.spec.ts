import { buildOrderBy, buildWhere, colomboDayStart, dateRangeClause, RecordsQuery } from './records.query';

const hash = (n: string) => `h(${n})`;
const q = (o: Partial<RecordsQuery>) => Object.assign(new RecordsQuery(), o);

describe('colomboDayStart / dateRangeClause', () => {
  it('treats dates as Sri Lanka calendar days', () => {
    expect(colomboDayStart('2026-11-07').toISOString()).toBe('2026-11-06T18:30:00.000Z');
  });
  it('makes `to` inclusive and falls back to expectedAt for visits that never arrived', () => {
    const c = dateRangeClause('2026-11-07', '2026-11-07') as any;
    const range = { gte: new Date('2026-11-06T18:30:00Z'), lt: new Date('2026-11-07T18:30:00Z') };
    expect(c.OR[0]).toEqual({ timeIn: range });
    expect(c.OR[1]).toEqual({ timeIn: null, expectedAt: range });
  });
  it('returns nothing when no dates are given', () => {
    expect(dateRangeClause()).toBeUndefined();
  });
});

describe('buildWhere', () => {
  it('is empty without filters', () => expect(buildWhere(q({}), hash)).toEqual({}));
  it('combines every filter with AND', () => {
    const w = buildWhere(q({ guardRoomId: 'g', passCategoryId: 'p', departmentId: 'd', status: 'on_premises', company: 'acme' }), hash) as any;
    expect(w.AND).toEqual(expect.arrayContaining([
      { guardRoomId: 'g' }, { passCategoryId: 'p' }, { departmentId: 'd' }, { status: 'on_premises' },
      { visitor: { company: { contains: 'acme', mode: 'insensitive' } } },
    ]));
  });
  it('searches by NIC hash only when the text is a valid NIC (never by decrypting)', () => {
    const nic = JSON.stringify(buildWhere(q({ q: '199512345678' }), hash));
    expect(nic).toContain('h(199512345678)');
    expect(JSON.stringify(buildWhere(q({ q: 'perera' }), hash))).not.toContain('nicHash');
  });
});

describe('buildOrderBy', () => {
  it('maps relation sorts and adds a stable tiebreak', () => {
    expect(buildOrderBy('guardRoom', 'asc')).toEqual([{ guardRoom: { name: 'asc' } }, { id: 'asc' }]);
    expect(buildOrderBy()).toEqual([{ timeIn: 'desc' }, { id: 'asc' }]);
  });
});
