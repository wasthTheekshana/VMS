import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PiiCrypto } from '../src/common/pii-crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const PW = 'Test-pass-12345';
const tag = `v${Date.now()}`;
const email = (n: string) => `${n}.${tag}@test.local`.toLowerCase();
const base = Date.now() % 1e9;
const nic = (i: number) => `9${String(base).padStart(9, "0")}${String(i).padStart(2, "0")}`; // 12 digits, unique per run
const nowIso = () => new Date().toISOString();

describe('Visits: host portal + guard console (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: PiiCrypto;
  let hr: string, itDept: string, roomA: string, roomB: string, pass: string;
  const ck: Record<string, string[]> = {};
  const http = () => request(app.getHttpServer());
  const as = (n: string) => ({ Cookie: ck[n] });
  const hostBody = (extra: object = {}) => ({
    visitors: [{ fullName: 'Nimal Perera', nic: nic(1), phone: '0771234567', company: 'Acme' }],
    purpose: 'Meeting', expectedAt: nowIso(), areaVisited: 'Level 3', guardRoomId: roomA, ...extra,
  });
  const preReg = async (extra: object = {}, who = 'hostHR') => {
    const r = await http().post('/api/visits').set(as(who)).send(hostBody(extra));
    expect(r.status).toBe(201);
    return r.body.visits[0];
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.init();
    prisma = app.get(PrismaService);
    crypto = app.get(PiiCrypto);

    hr = (await prisma.department.create({ data: { name: `HR-${tag}` } })).id;
    itDept = (await prisma.department.create({ data: { name: `IT-${tag}` } })).id;
    roomA = (await prisma.guardRoom.create({ data: { name: `A-${tag}`, location: 'x' } })).id;
    roomB = (await prisma.guardRoom.create({ data: { name: `B-${tag}`, location: 'x' } })).id;
    pass = (await prisma.passCategory.create({ data: { name: `Pass-${tag}` } })).id;
    const passwordHash = await bcrypt.hash(PW, 4);
    const mk = (n: string, role: any, extra: object) =>
      prisma.user.create({ data: { name: n, username: email(n).toLowerCase(), email: email(n), role, passwordHash, ...extra } });
    await mk('hostHR', 'host', { departmentId: hr });
    await mk('hostIT', 'host', { departmentId: itDept });
    await mk('guardA', 'guard', { guardRoomId: roomA });
    await mk('guardB', 'guard', { guardRoomId: roomB });
    await mk('guardA2', 'guard', { guardRoomId: roomA });
    await mk('admin', 'super_admin', {});
    for (const n of ['hostHR', 'hostIT', 'guardA', 'guardB', 'guardA2', 'admin']) {
      const r = await http().post('/api/auth/login').send({ username: email(n), password: PW });
      ck[n] = r.headers['set-cookie'] as unknown as string[];
    }
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { endsWith: `.${tag}@test.local` } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const hashes = Array.from({ length: 12 }, (_, i) => crypto.hashNic(nic(i)));
    await prisma.notification.deleteMany({ where: { visit: { createdBy: { in: ids } } } });
    await prisma.visit.deleteMany({ where: { createdBy: { in: ids } } });
    await prisma.visitGroup.deleteMany({ where: { hostUserId: { in: ids } } });
    await prisma.blacklist.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.visitor.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.passCategory.delete({ where: { id: pass } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.deleteMany({ where: { id: { in: [hr, itDept] } } });
    await app.close();
  });

  describe('pre-registration (FR-7, FR-9)', () => {
    it('creates a visit with a reference number and leaks no NIC ciphertext, hash or full NIC in the response', async () => {
      const v = await preReg();
      expect(v.referenceNo).toMatch(/^V-\d{8}-[A-Z2-9]{6}$/);
      expect(v.status).toBe('expected');
      const raw = JSON.stringify(v);
      expect(raw).not.toContain(nic(1));
      expect(raw).not.toMatch(/nicHash|nicOrLicence/);
      expect(v.visitor.nic).toMatch(/\*/);
    });
    it('stores the NIC encrypted at rest', async () => {
      const row = await prisma.visitor.findUniqueOrThrow({ where: { nicHash: crypto.hashNic(nic(1)) } });
      expect(row.nicOrLicence).not.toContain(nic(1));
      expect(crypto.decrypt(row.nicOrLicence)).toBe(nic(1));
    });
    it('groups several visitors under one pre-registration and rejects duplicate NICs', async () => {
      const ok = await http().post('/api/visits').set(as('hostHR')).send(hostBody({
        visitors: [{ fullName: 'A One', nic: nic(2) }, { fullName: 'B Two', nic: nic(3) }],
      }));
      expect(ok.status).toBe(201);
      expect(ok.body.visits).toHaveLength(2);
      expect(ok.body.visits[0].groupId).toBeTruthy();
      expect(ok.body.visits[0].groupId).toBe(ok.body.visits[1].groupId);
      const dup = await http().post('/api/visits').set(as('hostHR')).send(hostBody({
        visitors: [{ fullName: 'A One', nic: nic(4) }, { fullName: 'A Again', nic: nic(4) }],
      }));
      expect(dup.status).toBe(400);
    });
    it('validates input', async () => {
      expect((await http().post('/api/visits').set(as('hostHR')).send(hostBody({ visitors: [{ fullName: 'X Y', nic: 'bad' }] }))).status).toBe(400);
      expect((await http().post('/api/visits').set(as('hostHR')).send(hostBody({ expectedAt: '2020-01-01T00:00:00Z' }))).status).toBe(400);
      expect((await http().post('/api/visits').set(as('hostHR')).send(hostBody({ guardRoomId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(400);
      expect((await http().post('/api/visits').set(as('hostHR')).send(hostBody({ departmentId: hr }))).status).toBe(400); // unknown field
    });
    it('only hosts pre-register; guards cannot', async () => {
      expect((await http().post('/api/visits').set(as('guardA')).send(hostBody())).status).toBe(403);
    });
  });

  describe('guard-room segregation (FR-17)', () => {
    let visitId: string, ref: string;
    beforeAll(async () => {
      const v = await preReg({ visitors: [{ fullName: 'Seg Test', nic: nic(5), phone: '0712223344' }] });
      [visitId, ref] = [v.id, v.referenceNo];
    });
    it("shows the visit only in its own guard room's Expected Today list", async () => {
      const a = await http().get('/api/guard/expected').set(as('guardA'));
      const b = await http().get('/api/guard/expected').set(as('guardB'));
      expect(a.body.map((v: any) => v.id)).toContain(visitId);
      expect(b.body.map((v: any) => v.id)).not.toContain(visitId);
    });
    it('hides it entirely from another guard room and another department (404, not 403)', async () => {
      expect((await http().get(`/api/guard/visits/${visitId}`).set(as('guardB'))).status).toBe(404);
      expect((await http().post(`/api/guard/visits/${visitId}/check-in`).set(as('guardB')).send({ passCategoryId: pass })).status).toBe(404);
      expect((await http().get(`/api/visits/${visitId}`).set(as('hostIT'))).status).toBe(404);
      expect((await http().patch(`/api/visits/${visitId}`).set(as('hostIT')).send({ purpose: 'hijack' })).status).toBe(404);
      expect((await http().post(`/api/visits/${visitId}/cancel`).set(as('hostIT'))).status).toBe(404);
    });
    it('finds by NIC, reference number and name', async () => {
      for (const q of [nic(5), ref, 'seg test']) {
        const r = await http().get('/api/guard/expected').query({ q }).set(as('guardA'));
        expect(r.body.map((v: any) => v.id)).toContain(visitId);
      }
      const miss = await http().get('/api/guard/expected').query({ q: nic(5) }).set(as('guardB'));
      expect(miss.body).toHaveLength(0);
    });
    it('masks NIC and phone in lists but shows them on the single-record view', async () => {
      const list = (await http().get('/api/guard/expected').set(as('guardA'))).body.find((v: any) => v.id === visitId);
      expect(list.visitor.nic).not.toBe(nic(5));
      expect(list.visitor.phone).not.toBe('0712223344');
      const one = (await http().get(`/api/guard/visits/${visitId}`).set(as('guardA'))).body;
      expect(one.visitor.nic).toBe(nic(5));
    });
    it('hosts cannot use guard endpoints; guards cannot use host endpoints', async () => {
      expect((await http().get('/api/guard/expected').set(as('hostHR'))).status).toBe(403);
      expect((await http().get('/api/visits/mine').set(as('guardA'))).status).toBe(403);
    });
  });

  describe('check-in / check-out lifecycle (FR-12, FR-14, FR-15)', () => {
    let id: string;
    beforeAll(async () => {
      id = (await preReg({ visitors: [{ fullName: 'Life Cycle', nic: nic(6) }] })).id;
    });
    it('requires a pass category', async () => {
      expect((await http().post(`/api/guard/visits/${id}/check-in`).set(as('guardA')).send({})).status).toBe(400);
    });
    it('lets the guard edit details and records server-side Time IN', async () => {
      const r = await http().post(`/api/guard/visits/${id}/check-in`).set(as('guardA'))
        .send({ passCategoryId: pass, address: '12 Galle Rd', phone: '0701112233', remarks: 'ID verified', timeIn: '2000-01-01' });
      expect(r.status).toBe(400); // client-supplied time is rejected, not ignored
      const ok = await http().post(`/api/guard/visits/${id}/check-in`).set(as('guardA'))
        .send({ passCategoryId: pass, address: '12 Galle Rd', phone: '0701112233', remarks: 'ID verified' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('on_premises');
      expect(new Date(ok.body.timeIn).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(ok.body.visitor.address).toBe('12 Galle Rd');
      expect(ok.body.passCategory.id).toBe(pass);
    });
    it('rejects a second check-in and any edit/cancel after arrival (409)', async () => {
      expect((await http().post(`/api/guard/visits/${id}/check-in`).set(as('guardA')).send({ passCategoryId: pass })).status).toBe(409);
      expect((await http().patch(`/api/visits/${id}`).set(as('hostHR')).send({ purpose: 'late edit' })).status).toBe(409);
      expect((await http().post(`/api/visits/${id}/cancel`).set(as('hostHR'))).status).toBe(409);
    });
    it('lists the visitor as on premises for the right guard room only', async () => {
      const a = await http().get('/api/guard/on-premises').set(as('guardA'));
      const b = await http().get('/api/guard/on-premises').set(as('guardB'));
      expect(a.body.map((v: any) => v.id)).toContain(id);
      expect(b.body.map((v: any) => v.id)).not.toContain(id);
    });
    it("a different guard room cannot check the visitor out", async () => {
      expect((await http().post(`/api/guard/visits/${id}/check-out`).set(as('guardB')).send({})).status).toBe(404);
    });
    it('checks out once, with duration; a repeat is 409', async () => {
      const r = await http().post(`/api/guard/visits/${id}/check-out`).set(as('guardA')).send({ remarks: 'left by car' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('checked_out');
      expect(r.body.durationMinutes).toBeGreaterThanOrEqual(0);
      expect(r.body.remarks).toContain('left by car');
      expect((await http().post(`/api/guard/visits/${id}/check-out`).set(as('guardA')).send({})).status).toBe(409);
    });
    it('concurrent check-ins: exactly one wins', async () => {
      const v = await preReg({ visitors: [{ fullName: 'Race Cond', nic: nic(7) }] });
      const res = await Promise.all([1, 2, 3].map(() =>
        http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass })));
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(2);
    });
  });

  describe('edit / cancel (FR-8)', () => {
    it('host edits then cancels; cancelled visits leave the guard list', async () => {
      const v = await preReg({ visitors: [{ fullName: 'Edit Cancel', nic: nic(8) }] });
      const edit = await http().patch(`/api/visits/${v.id}`).set(as('hostHR')).send({ purpose: 'Updated', guardRoomId: roomB });
      expect(edit.status).toBe(200);
      expect(edit.body.purpose).toBe('Updated');
      expect((await http().get('/api/guard/expected').set(as('guardB'))).body.map((x: any) => x.id)).toContain(v.id);
      expect((await http().get('/api/guard/expected').set(as('guardA'))).body.map((x: any) => x.id)).not.toContain(v.id);
      expect((await http().post(`/api/visits/${v.id}/cancel`).set(as('hostHR'))).body.status).toBe('cancelled');
      expect((await http().get('/api/guard/expected').set(as('guardB'))).body.map((x: any) => x.id)).not.toContain(v.id);
    });
    it('"my visitors" only returns the host\'s own visits', async () => {
      const mine = await http().get('/api/visits/mine').set(as('hostIT'));
      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(0);
    });
  });

  describe('walk-ins, returning visitors and blacklist (FR-13, FR-16, FR-29)', () => {
    it('registers a walk-in directly on premises in the guard\'s own room', async () => {
      const r = await http().post('/api/guard/walk-ins').set(as('guardB')).send({
        fullName: 'Walk In', nic: nic(9), phone: '0759998877', company: 'Walk Co', address: 'Kandy',
        hostDepartmentId: hr, passCategoryId: pass, areaVisited: 'Reception',
      });
      expect(r.status).toBe(201);
      expect(r.body.source).toBe('walk_in');
      expect(r.body.status).toBe('on_premises');
      expect(r.body.guardRoom.id).toBe(roomB);
      expect(r.body.timeIn).toBeTruthy();
    });
    it('auto-fills a returning visitor by NIC', async () => {
      const r = await http().get('/api/guard/lookup').query({ nic: nic(9) }).set(as('guardA'));
      expect(r.body).toMatchObject({ found: true, blacklisted: false, visitor: { fullName: 'Walk In', company: 'Walk Co' } });
      const none = await http().get('/api/guard/lookup').query({ nic: nic(10) }).set(as('guardA'));
      expect(none.body.found).toBe(false);
    });
    it('rejects a host from another department and an invalid department', async () => {
      const itHost = await prisma.user.findUniqueOrThrow({ where: { email: email('hostIT') } });
      const r = await http().post('/api/guard/walk-ins').set(as('guardA')).send({
        fullName: 'Bad Host', nic: nic(11), hostDepartmentId: hr, hostUserId: itHost.id, passCategoryId: pass,
      });
      expect(r.status).toBe(400);
    });
    it('warns on blacklisted NICs and blocks check-in / walk-in', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: email('admin') } });
      await prisma.blacklist.create({ data: { nicHash: crypto.hashNic(nic(0)), reason: 'test', addedBy: admin.id } });
      const reg = await http().post('/api/visits').set(as('hostHR')).send(hostBody({ visitors: [{ fullName: 'Black Listed', nic: nic(0) }] }));
      expect(reg.status).toBe(201);
      expect(reg.body.visits[0].blacklisted).toBe(true); // host is warned, not blocked (UC-2)
      expect((await http().get('/api/guard/lookup').query({ nic: nic(0) }).set(as('guardA'))).body.blacklisted).toBe(true);
      expect((await http().post(`/api/guard/visits/${reg.body.visits[0].id}/check-in`).set(as('guardA')).send({ passCategoryId: pass })).status).toBe(403);
      const walk = await http().post('/api/guard/walk-ins').set(as('guardA')).send({
        fullName: 'Black Listed', nic: nic(0), hostDepartmentId: hr, passCategoryId: pass,
      });
      expect(walk.status).toBe(403);
    });
  });

  describe('guard exit summary (my-exits)', () => {
    const walkAndOut = async (guard: string, n: number) => {
      const w = await http().post('/api/guard/walk-ins').set(as(guard)).send({ fullName: 'Exit Tester', nic: nic(n), hostDepartmentId: hr, passCategoryId: pass });
      expect(w.status).toBe(201);
      expect((await http().post(`/api/guard/visits/${w.body.id}/check-out`).set(as(guard)).send({})).status).toBe(200);
      return w.body.id as string;
    };
    it('shows each guard only the exits they recorded, even within the same guard room', async () => {
      const a = await walkAndOut('guardA', 10);
      const a2 = await walkAndOut('guardA2', 11);
      const mineA = await http().get('/api/guard/my-exits').set(as('guardA'));
      expect(mineA.status).toBe(200);
      const idsA = mineA.body.exits.map((e: { id: string }) => e.id);
      expect(idsA).toContain(a);
      expect(idsA).not.toContain(a2);
      expect(mineA.body.total).toBe(idsA.length);
      const mineA2 = await http().get('/api/guard/my-exits').set(as('guardA2'));
      expect(mineA2.body.exits.map((e: { id: string }) => e.id)).toEqual([a2]);
      expect(mineA2.body.exits[0].timeOut).toBeTruthy();
    });
    it('is guard-only and validates the date', async () => {
      expect((await http().get('/api/guard/my-exits').set(as('hostHR'))).status).toBe(403);
      expect((await http().get('/api/guard/my-exits?date=nope').set(as('guardA'))).status).toBe(400);
      expect((await http().get('/api/guard/my-exits?date=2020-01-01').set(as('guardA'))).body.total).toBe(0);
    });
  });

  describe('audit', () => {
    it('records visit actions without NIC data', async () => {
      const rows = await prisma.auditLog.findMany({ where: { entity: 'visit' }, orderBy: { createdAt: 'desc' }, take: 50 });
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['pre_register', 'check_in', 'check_out', 'walk_in']));
      expect(JSON.stringify(rows)).not.toContain(nic(5));
    });
  });
});
