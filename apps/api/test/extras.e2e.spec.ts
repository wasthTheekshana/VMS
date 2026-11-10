import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RetentionService } from '../src/common/retention.service';
import { PiiCrypto } from '../src/common/pii-crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const PW = 'Test-pass-12345';
const tag = `x${Date.now()}`;
const email = (n: string) => `${n}.${tag}@test.local`.toLowerCase();
const base = Date.now() % 1e9;
const nic = (i: number) => `9${String(base).padStart(9, '0')}${String(i).padStart(2, '0')}`;

describe('Blacklist approval, pass slip, audit viewer, password, retention (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: PiiCrypto;
  let hr: string, roomA: string, roomB: string, pass: string;
  const ck: Record<string, string[]> = {};
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (n: string) => ({ Cookie: ck[n] });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.init();
    prisma = app.get(PrismaService);
    crypto = app.get(PiiCrypto);
    hr = (await prisma.department.create({ data: { name: `HR-${tag}` } })).id;
    roomA = (await prisma.guardRoom.create({ data: { name: `A-${tag}`, location: 'x' } })).id;
    roomB = (await prisma.guardRoom.create({ data: { name: `B-${tag}`, location: 'x' } })).id;
    pass = (await prisma.passCategory.create({ data: { name: `P-${tag}` } })).id;
    const passwordHash = await bcrypt.hash(PW, 4);
    const mk = async (n: string, role: any, extra: object = {}) => {
      ids[n] = (await prisma.user.create({ data: { name: n, username: email(n).toLowerCase(), email: email(n), role, passwordHash, ...extra } })).id;
    };
    await mk('admin', 'super_admin');
    await mk('hostHR', 'host', { departmentId: hr });
    await mk('guardA', 'guard', { guardRoomId: roomA });
    await mk('guardB', 'guard', { guardRoomId: roomB });
    for (const n of ['admin', 'hostHR', 'guardA', 'guardB']) {
      const r = await http().post('/api/auth/login').send({ username: email(n), password: PW });
      ck[n] = r.headers['set-cookie'] as unknown as string[];
    }
  });

  afterAll(async () => {
    const uids = Object.values(ids);
    const hashes = Array.from({ length: 12 }, (_, i) => crypto.hashNic(nic(i)));
    await prisma.notification.deleteMany({ where: { visit: { createdBy: { in: uids } } } });
    await prisma.visit.deleteMany({ where: { createdBy: { in: uids } } });
    await prisma.blacklistOverride.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.blacklist.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.visitor.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
    await prisma.passCategory.delete({ where: { id: pass } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.delete({ where: { id: hr } });
    await app.close();
  });

  const preReg = async (i: number) => {
    const r = await http().post('/api/visits').set(as('hostHR')).send({
      visitors: [{ fullName: `Visitor ${i}`, nic: nic(i) }], purpose: 'x', expectedAt: new Date().toISOString(), areaVisited: 'y', guardRoomId: roomA,
    });
    expect(r.status).toBe(201);
    return r.body.visits[0];
  };
  const walk = (who: string, extra: object) =>
    http().post('/api/guard/walk-ins').set(as(who)).send({ fullName: 'Banned Person', nic: nic(2), hostDepartmentId: hr, passCategoryId: pass, ...extra });

  describe('blacklist management (FR-29)', () => {
    let entryId: string;
    it('only a super admin manages it; the NIC is stored masked', async () => {
      expect((await http().post('/api/blacklist').set(as('guardA')).send({ nic: nic(1), reason: 'test' })).status).toBe(403);
      const r = await http().post('/api/blacklist').set(as('admin')).send({ nic: nic(1), reason: 'Theft on site' });
      expect(r.status).toBe(201);
      entryId = r.body.id;
      expect(r.body.nicMasked).toMatch(/\*/);
      expect(JSON.stringify(r.body)).not.toContain(nic(1));
      expect((await http().post('/api/blacklist').set(as('admin')).send({ nic: nic(1), reason: 'dup' })).status).toBe(409);
      expect((await http().get('/api/blacklist').set(as('admin'))).body.map((x: any) => x.id)).toContain(entryId);
    });
    it('removing an entry lifts the block and is audited', async () => {
      expect((await http().delete(`/api/blacklist/${entryId}`).set(as('admin'))).status).toBe(204);
      expect((await http().get('/api/guard/lookup').query({ nic: nic(1) }).set(as('guardA'))).body.blacklisted).toBe(false);
      expect(await prisma.auditLog.count({ where: { entity: 'blacklist', action: 'delete', entityId: entryId } })).toBe(1);
    });
  });

  describe('administrator approval for a blacklisted visitor (UC-4)', () => {
    beforeAll(async () => {
      await http().post('/api/blacklist').set(as('admin')).send({ nic: nic(2), reason: 'Banned' }).expect(201);
    });
    it('blocks check-in without approval, and a guard cannot self-approve', async () => {
      const v = await preReg(2);
      expect((await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass })).status).toBe(403);
      const req = await http().post('/api/guard/overrides').set(as('guardA')).send({ nic: nic(2), remark: 'Visitor insists, has appointment', visitId: v.id });
      expect(req.status).toBe(201);
      expect(req.body.status).toBe('pending');
      expect((await http().post(`/api/blacklist/overrides/${req.body.id}/decision`).set(as('guardA')).send({ approve: true })).status).toBe(403);
      expect((await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass, overrideId: req.body.id })).status).toBe(403); // still pending
    });
    it('lets the guard in after approval, exactly once, and only in the requesting guard room', async () => {
      const v = await preReg(2);
      const req = (await http().post('/api/guard/overrides').set(as('guardA')).send({ nic: nic(2), remark: 'Approved by phone', visitId: v.id })).body;
      expect((await http().get('/api/blacklist/overrides/requests').query({ status: 'pending' }).set(as('admin'))).body.map((r: any) => r.id)).toContain(req.id);
      expect((await http().post(`/api/blacklist/overrides/${req.id}/decision`).set(as('admin')).send({ approve: true, note: 'OK once' })).body.status).toBe('approved');
      expect((await http().post(`/api/blacklist/overrides/${req.id}/decision`).set(as('admin')).send({ approve: false })).status).toBe(409); // already decided
      expect((await http().get(`/api/guard/overrides/${req.id}`).set(as('guardB'))).status).toBe(404); // other room cannot even see it
      expect((await walk('guardB', { overrideId: req.id })).status).toBe(403);
      const ok = await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass, overrideId: req.id });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('on_premises');
      expect((await walk('guardA', { overrideId: req.id })).status).toBe(403); // approval was single-use
    });
    it('supports an approved walk-in, and rejects an override for someone not blacklisted', async () => {
      const req = (await http().post('/api/guard/overrides').set(as('guardA')).send({ nic: nic(2), remark: 'Walk-in, manager agrees' })).body;
      await http().post(`/api/blacklist/overrides/${req.id}/decision`).set(as('admin')).send({ approve: true }).expect(200);
      expect((await walk('guardA', { overrideId: req.id })).status).toBe(201);
      expect((await http().post('/api/guard/overrides').set(as('guardA')).send({ nic: nic(3), remark: 'not listed' })).status).toBe(400);
    });
    it('a rejected request cannot be used', async () => {
      const req = (await http().post('/api/guard/overrides').set(as('guardA')).send({ nic: nic(2), remark: 'try again' })).body;
      await http().post(`/api/blacklist/overrides/${req.id}/decision`).set(as('admin')).send({ approve: false, note: 'No' }).expect(200);
      expect((await walk('guardA', { overrideId: req.id })).status).toBe(403);
    });
  });

  describe('pass slip (FR-27)', () => {
    it('contains what a pass needs and no NIC or phone; unavailable before check-in; scoped to the guard room', async () => {
      const v = await preReg(4);
      expect((await http().get(`/api/guard/visits/${v.id}/slip`).set(as('guardA'))).status).toBe(409);
      await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass }).expect(200);
      const s = await http().get(`/api/guard/visits/${v.id}/slip`).set(as('guardA'));
      expect(s.status).toBe(200);
      expect(s.body).toMatchObject({ referenceNo: v.referenceNo, visitorName: 'Visitor 4', host: 'hostHR', guardRoom: `A-${tag}` });
      expect(JSON.stringify(s.body)).not.toContain(nic(4));
      expect((await http().get(`/api/guard/visits/${v.id}/slip`).set(as('guardB'))).status).toBe(404);
    });
  });

  describe('walk-in host list', () => {
    it('gives guards host names only (no email/phone), and nobody else', async () => {
      const r = await http().get('/api/guard/hosts').query({ departmentId: hr }).set(as('guardA'));
      expect(r.status).toBe(200);
      expect(r.body.map((h: any) => h.name)).toContain('hostHR');
      expect(Object.keys(r.body[0]).sort()).toEqual(['id', 'name']);
      expect((await http().get('/api/guard/hosts').query({ departmentId: hr }).set(as('hostHR'))).status).toBe(403);
      expect((await http().get('/api/guard/hosts').query({ departmentId: 'nope' }).set(as('guardA'))).status).toBe(400);
    });
    it('exposes the signed-in name to the UI via /auth/me', async () => {
      expect((await http().get('/api/auth/me').set(as('guardA'))).body.name).toBe('guardA');
    });
  });

  describe('audit viewer (FR-28)', () => {
    it('is super-admin only, filterable, read-only, and carries user names', async () => {
      expect((await http().get('/api/audit').set(as('guardA'))).status).toBe(403);
      const r = await http().get('/api/audit').query({ entity: 'blacklist_override', action: 'override_approve' }).set(as('admin'));
      expect(r.status).toBe(200);
      expect(r.body.total).toBeGreaterThan(0);
      expect(r.body.items[0]).toMatchObject({ action: 'override_approve', userName: 'admin' });
      expect((await http().get('/api/audit').query({ pageSize: 1000 }).set(as('admin'))).status).toBe(400);
      expect((await http().delete('/api/audit').set(as('admin'))).status).toBe(404); // no write endpoints exist
    });
  });

  describe('change password', () => {
    it('requires the current password, enforces the policy, then works', async () => {
      expect((await http().post('/api/auth/change-password').set(as('hostHR')).send({ currentPassword: 'wrong-password1', newPassword: 'New-secret-12345' })).status).toBe(401);
      expect((await http().post('/api/auth/change-password').set(as('hostHR')).send({ currentPassword: PW, newPassword: 'short' })).status).toBe(400);
      expect((await http().post('/api/auth/change-password').set(as('hostHR')).send({ currentPassword: PW, newPassword: 'New-secret-12345' })).status).toBe(204);
      expect((await http().post('/api/auth/login').send({ username: email('hostHR'), password: PW })).status).toBe(401);
      expect((await http().post('/api/auth/login').send({ username: email('hostHR'), password: 'New-secret-12345' })).status).toBe(200);
    });
  });

  describe('retention (NFR-9)', () => {
    it('purges only finished visits older than the retention period, and keeps open ones', async () => {
      const v = await prisma.visitor.create({ data: { fullName: 'Old', nicHash: crypto.hashNic(nic(9)), nicOrLicence: crypto.encrypt(nic(9)) } });
      const old = new Date(Date.now() - 4 * 365 * 86_400_000);
      const mk = (ref: string, status: any) => prisma.visit.create({
        data: { referenceNo: `${ref}-${tag}`, visitorId: v.id, guardRoomId: roomA, source: 'walk_in', status, createdBy: ids.admin, createdAt: old },
      });
      const done = await mk('OLD1', 'checked_out');
      const open = await mk('OLD2', 'on_premises');
      await app.get(RetentionService).purge(new Date(), 1095);
      expect(await prisma.visit.findUnique({ where: { id: done.id } })).toBeNull();
      expect(await prisma.visit.findUnique({ where: { id: open.id } })).not.toBeNull();
      expect(await prisma.visitor.findUnique({ where: { id: v.id } })).not.toBeNull(); // still referenced by the open visit
      expect(() => RetentionService.retentionDays({ RETENTION_DAYS: '5' } as any)).toThrow();
    });
  });
});
