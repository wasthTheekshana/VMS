import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PiiCrypto } from '../src/common/pii-crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const PW = 'Test-pass-12345';
const tag = `r${Date.now()}`;
const email = (n: string) => `${n}.${tag}@test.local`.toLowerCase();
const base = Date.now() % 1e9;
const nic = (i: number) => `9${String(base).padStart(9, '0')}${String(i).padStart(2, '0')}`;
const acme = `Acme-${tag}`;
const globex = `Globex-${tag}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const ymd = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // today in Colombo

describe('Admin records, dashboard and exports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: PiiCrypto;
  let hr: string, itD: string, roomA: string, roomB: string, p1: string, p2: string;
  const ck: Record<string, string[]> = {};
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (n: string) => ({ Cookie: ck[n] });
  const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.init();
    prisma = app.get(PrismaService);
    crypto = app.get(PiiCrypto);

    hr = (await prisma.department.create({ data: { name: `HR-${tag}` } })).id;
    itD = (await prisma.department.create({ data: { name: `IT-${tag}` } })).id;
    roomA = (await prisma.guardRoom.create({ data: { name: `A-${tag}`, location: 'x' } })).id;
    roomB = (await prisma.guardRoom.create({ data: { name: `B-${tag}`, location: 'x' } })).id;
    p1 = (await prisma.passCategory.create({ data: { name: `P1-${tag}` } })).id;
    p2 = (await prisma.passCategory.create({ data: { name: `P2-${tag}` } })).id;
    const passwordHash = await bcrypt.hash(PW, 4);
    const mk = async (n: string, role: any, extra: object = {}) => {
      ids[n] = (await prisma.user.create({ data: { name: n, username: email(n).toLowerCase(), email: email(n), role, passwordHash, ...extra } })).id;
    };
    await mk('admin', 'super_admin');
    await mk('deptAdminHR', 'dept_admin', { departmentId: hr });
    await mk('hostHR', 'host', { departmentId: hr });
    await mk('guardA', 'guard', { guardRoomId: roomA });
    for (const n of ['admin', 'deptAdminHR', 'hostHR', 'guardA']) {
      const r = await http().post('/api/auth/login').send({ username: email(n), password: PW });
      ck[n] = r.headers['set-cookie'] as unknown as string[];
    }

    const visitor = (i: number, fullName: string, company: string) =>
      prisma.visitor.create({ data: { fullName, nicHash: crypto.hashNic(nic(i)), nicOrLicence: crypto.encrypt(nic(i)), company, phone: '0771234567' } });
    const [a, b, c, d, e] = await Promise.all([
      visitor(1, 'Alice Acme', acme), visitor(2, 'Bob Acme', acme), visitor(3, 'Carol Globex', globex),
      visitor(4, '=SUM(1+1)', globex), visitor(5, 'Eve Old', acme),
    ]);
    const mkVisit = (ref: string, v: { id: string }, o: object) =>
      prisma.visit.create({ data: { referenceNo: `${ref}-${tag.toUpperCase()}`, visitorId: v.id, createdBy: ids.admin, ...(o as any) } });
    const today = new Date();
    ids.v1 = (await mkVisit('R1', a, { departmentId: hr, guardRoomId: roomA, passCategoryId: p1, source: 'pre_registered', status: 'checked_out', expectedAt: today, timeIn: ago(10), timeOut: ago(5) })).id;
    ids.v2 = (await mkVisit('R2', b, { departmentId: hr, guardRoomId: roomA, passCategoryId: p2, source: 'pre_registered', status: 'on_premises', expectedAt: today, timeIn: ago(2) })).id;
    ids.v3 = (await mkVisit('R3', c, { departmentId: itD, guardRoomId: roomB, passCategoryId: p1, source: 'walk_in', status: 'on_premises', timeIn: ago(1) })).id;
    ids.v4 = (await mkVisit('R4', d, { departmentId: itD, guardRoomId: roomB, source: 'pre_registered', status: 'expected', expectedAt: today })).id;
    ids.v5 = (await mkVisit('R5', e, { departmentId: hr, guardRoomId: roomA, source: 'pre_registered', status: 'cancelled', expectedAt: new Date(Date.now() - 5 * 86_400_000) })).id;
  });

  afterAll(async () => {
    await prisma.visit.deleteMany({ where: { createdBy: ids.admin } });
    await prisma.visitor.deleteMany({ where: { nicHash: { in: [1, 2, 3, 4, 5].map((i) => crypto.hashNic(nic(i))) } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `.${tag}@test.local` } } });
    await prisma.passCategory.deleteMany({ where: { id: { in: [p1, p2] } } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.deleteMany({ where: { id: { in: [hr, itD] } } });
    await app.close();
  });

  const list = (who: string, q: Record<string, string | number> = {}) =>
    http().get('/api/records').query({ company: tag, ...q }).set(as(who));
  const refs = (r: request.Response) => r.body.items.map((v: any) => v.referenceNo.split('-')[0]).sort();

  describe('search, filter and sort (FR-23)', () => {
    it('lists everything for a super admin, masked', async () => {
      const r = await list('admin');
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(5);
      const raw = JSON.stringify(r.body);
      expect(raw).not.toContain(nic(1));
      expect(raw).not.toMatch(/nicHash|nicOrLicence/);
      expect(r.body.items[0].visitor.nic).toMatch(/\*/);
    });
    it.each([
      ['guard room', { guardRoomId: () => roomB }, ['R3', 'R4']],
      ['pass category', { passCategoryId: () => p1 }, ['R1', 'R3']],
      ['department', { departmentId: () => itD }, ['R3', 'R4']],
      ['status', { status: () => 'on_premises' }, ['R2', 'R3']],
      ['company', { company: () => `globex-${tag}` }, ['R3', 'R4']],
      ['NIC (exact)', { q: () => nic(2) }, ['R2']],
      ['name', { q: () => 'carol' }, ['R3']],
      ['reference', { q: () => `r1-${tag}` }, ['R1']], // search is case-insensitive
    ])('filters by %s', async (_n, f, expected) => {
      const q = Object.fromEntries(Object.entries(f).map(([k, fn]) => [k, (fn as () => string)()]));
      expect(refs(await list('admin', q))).toEqual(expected);
    });
    it('filters by date: arrival, or expected time for visits that never arrived; excludes old ones', async () => {
      const r = await list('admin', { from: ymd(), to: ymd() });
      expect(refs(r)).toEqual(['R1', 'R2', 'R3', 'R4']); // R5 was expected 5 days ago
    });
    it('sorts and paginates deterministically', async () => {
      const p1r = await list('admin', { sortBy: 'visitor', order: 'asc', pageSize: 2, page: 1 });
      const p2r = await list('admin', { sortBy: 'visitor', order: 'asc', pageSize: 2, page: 2 });
      expect(p1r.body.total).toBe(5);
      expect(p1r.body.items).toHaveLength(2);
      const items = [...p1r.body.items, ...p2r.body.items];
      expect(new Set(items.map((v: any) => v.id)).size).toBe(4); // no overlap between pages
      const names = items.map((v: any) => v.visitor.fullName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
    it('treats search text as data, not SQL', async () => {
      const r = await list('admin', { q: "' OR 1=1 --" });
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(0);
    });
    it('rejects unknown sort fields, oversized pages and malformed dates', async () => {
      expect((await list('admin', { sortBy: 'passwordHash' })).status).toBe(400);
      expect((await list('admin', { pageSize: 1000 })).status).toBe(400);
      expect((await list('admin', { from: 'yesterday' })).status).toBe(400);
      expect((await list('admin', { unknown: 'x' })).status).toBe(400);
    });
    it('shows a full NIC only on the single-record view', async () => {
      const r = await http().get(`/api/records/${ids.v1}`).set(as('admin'));
      expect(r.status).toBe(200);
      expect(r.body.visitor.nic).toBe(nic(1));
    });
  });

  describe('department view and role limits (FR-24)', () => {
    it('confines a department admin to their own department, whatever they ask for', async () => {
      expect(refs(await list('deptAdminHR'))).toEqual(['R1', 'R2', 'R5']);
      expect((await list('deptAdminHR', { departmentId: itD })).body.total).toBe(0); // cannot widen the scope
      expect((await list('deptAdminHR', { guardRoomId: roomB })).body.total).toBe(0);
    });
    it("hides other departments' records on direct access (404)", async () => {
      expect((await http().get(`/api/records/${ids.v3}`).set(as('deptAdminHR'))).status).toBe(404);
      expect((await http().get(`/api/records/${ids.v1}`).set(as('deptAdminHR'))).status).toBe(200);
    });
    it('is closed to hosts and guards', async () => {
      for (const who of ['hostHR', 'guardA']) {
        expect((await http().get('/api/records').set(as(who))).status).toBe(403);
        expect((await http().get('/api/dashboard').set(as(who))).status).toBe(403);
        expect((await http().get('/api/records/export?format=xlsx').set(as(who))).status).toBe(403);
      }
      expect((await http().get('/api/records')).status).toBe(401);
    });
  });

  describe('export (FR-26)', () => {
    it('exports filtered records to Excel: masked NICs, formulas neutralised, one row per record', async () => {
      const r = await binary(http().get('/api/records/export').query({ format: 'xlsx', company: tag }).set(as('admin')));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('spreadsheetml');
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="visitor-records-\d{8}\.xlsx"/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as any);
      const ws = wb.getWorksheet('Visitor records')!;
      expect(ws.rowCount).toBe(6); // header + 5
      const all: string[] = [];
      ws.eachRow((row) => row.eachCell((c) => all.push(String(c.value))));
      expect(all.join('|')).not.toContain(nic(1));
      expect(all).toContain("'=SUM(1+1)");
      expect(all).toContain(`R3-${tag.toUpperCase()}`);
    });
    it('exports to PDF', async () => {
      const r = await binary(http().get('/api/records/export').query({ format: 'pdf', company: tag }).set(as('admin')));
      expect(r.status).toBe(200);
      expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
    it('applies the same scope to exports, and requires a valid format', async () => {
      const r = await binary(http().get('/api/records/export').query({ format: 'xlsx', company: tag }).set(as('deptAdminHR')));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as any);
      expect(wb.getWorksheet('Visitor records')!.rowCount).toBe(4); // header + R1, R2, R5
      expect((await http().get('/api/records/export?format=csv').set(as('admin'))).status).toBe(400);
      expect((await http().get('/api/records/export').set(as('admin'))).status).toBe(400);
    });
    it('never writes the search text, which can be a full NIC, into the append-only audit log', async () => {
      await binary(http().get('/api/records/export').query({ format: 'xlsx', q: nic(1) }).set(as('admin')));
      const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'export', entity: 'visit', userId: ids.admin }, orderBy: { createdAt: 'desc' } });
      const written = JSON.stringify(row.afterJson);
      expect(written).not.toContain(nic(1));
      expect(written).toContain('[redacted]'); // the fact that a search was used is kept
    });
    it('audits who exported what', async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: 'export', entity: 'visit', userId: ids.admin } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(rows.map((r) => r.afterJson))).toContain('"format":"xlsx"');
    });
  });

  describe('dashboard (FR-25)', () => {
    it('gives a department admin numbers for their own department only', async () => {
      const r = await http().get('/api/dashboard').set(as('deptAdminHR'));
      expect(r.status).toBe(200);
      const d = r.body;
      expect(d.onPremises.total).toBe(1); // R2 only; R3 is IT
      expect(d.today).toEqual({ expected: 2, arrived: 2, walkIns: 0 });
      expect(d.byDepartment).toEqual([{ id: hr, name: `HR-${tag}`, count: 2 }]);
      expect(d.topCompanies).toEqual([{ company: acme, count: 2 }]);
      expect(d.checkInsByGuardRoom.map((g: any) => g.id)).toEqual([roomA]);
      expect(d.hourly).toHaveLength(24);
      expect(d.hourly.reduce((a: number, h: any) => a + h.count, 0)).toBe(2);
      expect(d.trend).toHaveLength(30);
      expect(d.trend.at(-1).count).toBe(2);
      // regression: the stored UTC time must be bucketed by its Sri Lanka hour (it was shifted by 5.5 h)
      const v2 = await prisma.visit.findUniqueOrThrow({ where: { id: ids.v2 } });
      const colomboHour = new Date(v2.timeIn!.getTime() + 5.5 * 3600_000).getUTCHours();
      expect(d.hourly[colomboHour].count).toBeGreaterThanOrEqual(1);
      // redesign widgets: KPI cards, purpose donut, recent visitors
      expect(d.kpis).toMatchObject({ visitors: { value: 2 }, checkedIn: 1, checkedOut: { value: 1 }, preRegistrations: { value: 2 } });
      expect(d.byPurpose).toEqual([{ label: 'Not specified', count: 2 }]);
      expect(d.recent.map((r: any) => r.fullName)).toEqual(['Bob Acme', 'Alice Acme']); // newest first, own department only
    });
    it('filters the dashboard by location, never widening the caller\'s scope', async () => {
      const d = (await http().get('/api/dashboard').query({ guardRoomId: roomB }).set(as('admin'))).body;
      expect(d.onPremises.byGuardRoom.map((g: any) => g.id)).toEqual([roomB]);
      expect(d.recent.every((r: any) => r.guardRoom === `B-${tag}`)).toBe(true);
      const hrAdmin = (await http().get('/api/dashboard').query({ guardRoomId: roomB }).set(as('deptAdminHR'))).body;
      expect(hrAdmin.onPremises.total).toBe(0); // room B only has IT visits
      expect((await http().get('/api/dashboard').query({ guardRoomId: 'nope' }).set(as('admin'))).status).toBe(400);
    });
    it('gives a super admin the whole picture', async () => {
      const d = (await http().get('/api/dashboard').set(as('admin'))).body;
      expect(d.onPremises.total).toBeGreaterThanOrEqual(2);
      expect(d.onPremises.byGuardRoom.map((g: any) => g.id)).toEqual(expect.arrayContaining([roomA, roomB]));
      expect(d.today.walkIns).toBeGreaterThanOrEqual(1);
      expect(d.byPassCategory.find((p: any) => p.id === p1).count).toBe(2);
      expect(d.byDepartment.map((x: any) => x.id)).toEqual(expect.arrayContaining([hr, itD]));
    });
    it('supports week and month trends and rejects bad parameters', async () => {
      expect((await http().get('/api/dashboard').query({ granularity: 'week', period: '30d' }).set(as('admin'))).body.trend).toHaveLength(12);
      expect((await http().get('/api/dashboard').query({ granularity: 'month' }).set(as('admin'))).body.trend).toHaveLength(12);
      expect((await http().get('/api/dashboard').query({ period: 'forever' }).set(as('admin'))).status).toBe(400);
    });
    it('exports the summary to Excel and PDF', async () => {
      const x = await binary(http().get('/api/dashboard/export').query({ format: 'xlsx' }).set(as('admin')));
      expect(x.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.body as any);
      expect(wb.getWorksheet('Summary')).toBeTruthy();
      const p = await binary(http().get('/api/dashboard/export').query({ format: 'pdf' }).set(as('deptAdminHR')));
      expect((p.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });
});
