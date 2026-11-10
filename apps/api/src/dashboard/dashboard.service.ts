import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth.types';
import { visitScope } from '../common/scope';
import { Sheet } from '../records/export';
import { bucketLabels, fill, Granularity, instantOf, Period, periodStart, todayBounds } from './dashboard.rules';

/**
 * Raw-SQL twin of visitScope() for the two roles that may see the dashboard. The e2e suite asserts that a
 * department admin's numbers exclude other departments, so the two cannot silently drift apart.
 */
function scopeSql(actor: AuthUser): Prisma.Sql {
  if (actor.role === 'super_admin') return Prisma.sql`TRUE`;
  if (actor.role === 'dept_admin' && actor.departmentId) return Prisma.sql`v.department_id = ${actor.departmentId}::uuid`;
  throw new ForbiddenException();
}

const TZ = 'Asia/Colombo';
const TRUNC: Record<Granularity, Prisma.Sql> = { day: Prisma.sql`'day'`, week: Prisma.sql`'week'`, month: Prisma.sql`'month'` };

export interface DashboardData {
  kpis: {
    visitors: { value: number; previous: number };
    checkedIn: number;
    checkedOut: { value: number; previous: number };
    preRegistrations: { value: number; previous: number };
  };
  byPurpose: { label: string; count: number }[];
  recent: { id: string; fullName: string; status: string; timeIn: Date | null; guardRoom: string; pass: string | null }[];
  generatedAt: string;
  period: Period;
  granularity: Granularity;
  onPremises: { total: number; byGuardRoom: { id: string; name: string; count: number }[] };
  today: { expected: number; arrived: number; walkIns: number };
  checkInsByGuardRoom: { id: string; name: string; count: number }[];
  byPassCategory: { id: string | null; name: string; count: number }[];
  byDepartment: { id: string | null; name: string; count: number }[];
  topCompanies: { company: string; count: number }[];
  hourly: { hour: number; count: number }[];
  trend: { bucket: string; count: number }[];
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: AuthUser, period: Period = 'today', granularity: Granularity = 'day', now = new Date(), guardRoomId?: string): Promise<DashboardData> {
    const base = visitScope(actor); // throws for roles without a dashboard scope
    // Optional location filter: ANDed onto the caller's scope, so it can only narrow what they may see.
    const scope: Prisma.VisitWhereInput = guardRoomId ? { AND: [base, { guardRoomId }] } : base;
    const sql = guardRoomId ? Prisma.sql`${scopeSql(actor)} AND v.guard_room_id = ${guardRoomId}::uuid` : scopeSql(actor);
    const { start: dayStart, end: dayEnd } = todayBounds(now);
    const yStart = new Date(dayStart.getTime() - 86_400_000);
    const since = periodStart(period, now);
    const labels = bucketLabels(granularity, now);
    const trendSince = instantOf(labels[0]);

    const day = (f: 'timeIn' | 'timeOut', a: Date, b: Date): Prisma.VisitWhereInput => ({ AND: [scope, { [f]: { gte: a, lt: b } }] });
    const [arrivedToday, arrivedYday, outToday, outYday, expectedYday, purposes, recent] = await Promise.all([
      this.prisma.visit.count({ where: day('timeIn', dayStart, dayEnd) }),
      this.prisma.visit.count({ where: day('timeIn', yStart, dayStart) }),
      this.prisma.visit.count({ where: day('timeOut', dayStart, dayEnd) }),
      this.prisma.visit.count({ where: day('timeOut', yStart, dayStart) }),
      this.prisma.visit.count({ where: { AND: [scope, { source: 'pre_registered', status: { not: 'cancelled' }, expectedAt: { gte: yStart, lt: dayStart } }] } }),
      this.prisma.$queryRaw<{ p: string; n: bigint }[]>`
        SELECT MIN(COALESCE(NULLIF(btrim(v.purpose), ''), 'Not specified')) AS p, COUNT(*) AS n
        FROM visits v WHERE ${sql} AND COALESCE(v.time_in, v.expected_at, v.created_at) >= ${since} AND v.status <> 'cancelled'
        GROUP BY lower(COALESCE(NULLIF(btrim(v.purpose), ''), 'Not specified')) ORDER BY n DESC`,
      this.prisma.visit.findMany({
        where: { AND: [scope, { timeIn: { not: null } }] }, orderBy: { timeIn: 'desc' }, take: 6,
        select: { id: true, status: true, timeIn: true, visitor: { select: { fullName: true } }, guardRoom: { select: { name: true } }, passCategory: { select: { name: true } } },
      }),
    ]);

    const [onPrem, expected, arrived, walkIns, byRoomToday, byPass, byDept, companies, hourly, trend] = await Promise.all([
      this.prisma.visit.groupBy({ by: ['guardRoomId'], where: { AND: [scope, { status: 'on_premises' }] }, _count: { _all: true } }),
      this.prisma.visit.count({ where: { AND: [scope, { source: 'pre_registered', status: { not: 'cancelled' }, expectedAt: { gte: dayStart, lt: dayEnd } }] } }),
      this.prisma.visit.count({ where: { AND: [scope, { source: 'pre_registered', timeIn: { not: null }, expectedAt: { gte: dayStart, lt: dayEnd } }] } }),
      this.prisma.visit.count({ where: { AND: [scope, { source: 'walk_in', timeIn: { gte: dayStart, lt: dayEnd } }] } }),
      this.prisma.visit.groupBy({ by: ['guardRoomId'], where: { AND: [scope, { timeIn: { gte: dayStart, lt: dayEnd } }] }, _count: { _all: true } }),
      this.prisma.visit.groupBy({ by: ['passCategoryId'], where: { AND: [scope, { timeIn: { gte: since } }] }, _count: { _all: true } }),
      this.prisma.visit.groupBy({ by: ['departmentId'], where: { AND: [scope, { timeIn: { gte: since } }] }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ company: string; n: bigint }[]>`
        SELECT MIN(btrim(vr.company)) AS company, COUNT(*) AS n
        FROM visits v JOIN visitors vr ON vr.id = v.visitor_id
        WHERE ${sql} AND v.time_in >= ${since} AND btrim(coalesce(vr.company, '')) <> ''
        GROUP BY lower(btrim(vr.company)) ORDER BY n DESC, company LIMIT 10`,
      this.prisma.$queryRaw<{ h: number; n: bigint }[]>`
        SELECT EXTRACT(HOUR FROM (v.time_in AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS h, COUNT(*) AS n
        FROM visits v WHERE ${sql} AND v.time_in >= ${dayStart} AND v.time_in < ${dayEnd} GROUP BY h`,
      this.prisma.$queryRaw<{ bucket: string; n: bigint }[]>`
        SELECT to_char(date_trunc(${TRUNC[granularity]}, (v.time_in AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS bucket, COUNT(*) AS n
        FROM visits v WHERE ${sql} AND v.time_in >= ${trendSince} GROUP BY bucket`,
    ]);

    const [rooms, passes, depts] = await Promise.all([
      this.prisma.guardRoom.findMany({ select: { id: true, name: true } }),
      this.prisma.passCategory.findMany({ select: { id: true, name: true } }),
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);
    const name = (list: { id: string; name: string }[], id: string | null, fallback: string) =>
      list.find((x) => x.id === id)?.name ?? fallback;
    const hours = new Map(hourly.map((r) => [r.h, Number(r.n)]));

    const top = purposes.slice(0, 3).map((r) => ({ label: r.p, count: Number(r.n) }));
    const rest = purposes.slice(3).reduce((a, r) => a + Number(r.n), 0);
    const onPremTotal = onPrem.reduce((a, g) => a + g._count._all, 0);

    return {
      kpis: {
        visitors: { value: arrivedToday, previous: arrivedYday },
        checkedIn: onPremTotal,
        checkedOut: { value: outToday, previous: outYday },
        preRegistrations: { value: expected, previous: expectedYday },
      },
      byPurpose: rest ? [...top, { label: 'Others', count: rest }] : top,
      recent: recent.map((r) => ({ id: r.id, fullName: r.visitor.fullName, status: r.status, timeIn: r.timeIn, guardRoom: r.guardRoom.name, pass: r.passCategory?.name ?? null })),
      generatedAt: now.toISOString(),
      period,
      granularity,
      onPremises: {
        total: onPrem.reduce((a, g) => a + g._count._all, 0),
        byGuardRoom: onPrem.map((g) => ({ id: g.guardRoomId, name: name(rooms, g.guardRoomId, 'Unknown'), count: g._count._all })),
      },
      today: { expected, arrived, walkIns },
      checkInsByGuardRoom: byRoomToday.map((g) => ({ id: g.guardRoomId, name: name(rooms, g.guardRoomId, 'Unknown'), count: g._count._all })),
      byPassCategory: byPass.map((g) => ({ id: g.passCategoryId, name: name(passes, g.passCategoryId, 'Unassigned'), count: g._count._all })),
      byDepartment: byDept.map((g) => ({ id: g.departmentId, name: name(depts, g.departmentId, 'Unknown'), count: g._count._all })),
      topCompanies: companies.map((c) => ({ company: c.company, count: Number(c.n) })),
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hours.get(hour) ?? 0 })),
      trend: fill(labels, trend.map((t) => ({ bucket: t.bucket, n: Number(t.n) }))),
    };
  }

  /** FR-26: the dashboard summary as report sheets. */
  static sheets(d: DashboardData): Sheet[] {
    const two = (a: string, b: string) => [{ header: a, key: 'a', width: 34 }, { header: b, key: 'b', width: 12 }];
    return [
      { name: 'Summary', columns: two('Measure', 'Value'), rows: [
        { a: 'Visitors on premises now', b: d.onPremises.total },
        { a: 'Expected today', b: d.today.expected },
        { a: 'Expected and arrived today', b: d.today.arrived },
        { a: 'Walk-ins today', b: d.today.walkIns },
      ] },
      { name: 'Check-ins by guard room (today)', columns: two('Guard room', 'Check-ins'), rows: d.checkInsByGuardRoom.map((g) => ({ a: g.name, b: g.count })) },
      { name: `Visits by pass category (${d.period})`, columns: two('Pass category', 'Visits'), rows: d.byPassCategory.map((g) => ({ a: g.name, b: g.count })) },
      { name: `Visits by department (${d.period})`, columns: two('Department', 'Visits'), rows: d.byDepartment.map((g) => ({ a: g.name, b: g.count })) },
      { name: `Top companies (${d.period})`, columns: two('Company', 'Visits'), rows: d.topCompanies.map((g) => ({ a: g.company, b: g.count })) },
      { name: 'Arrivals by hour (today)', columns: two('Hour', 'Arrivals'), rows: d.hourly.map((h) => ({ a: `${String(h.hour).padStart(2, '0')}:00`, b: h.count })) },
      { name: `Trend (per ${d.granularity})`, columns: two('Period starting', 'Visits'), rows: d.trend.map((t) => ({ a: t.bucket, b: t.count })) },
    ];
  }
}
