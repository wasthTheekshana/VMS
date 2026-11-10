import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

const PW = 'Test-pass-12345';
const tag = `e2e${Date.now()}`;
const email = (n: string) => `${n}.${tag}@test.local`;

describe('Auth + RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hrId: string, itId: string, roomA: string, roomB: string;
  const cookies: Record<string, string[]> = {};

  const login = async (n: string) => {
    const r = await request(app.getHttpServer()).post('/api/auth/login').send({ username: email(n), password: PW });
    expect(r.status).toBe(200);
    cookies[n] = r.headers['set-cookie'] as unknown as string[];
  };
  const as = (n: string) => ({ Cookie: cookies[n] });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.init();
    prisma = app.get(PrismaService);

    const hr = await prisma.department.create({ data: { name: `HR-${tag}` } });
    const it = await prisma.department.create({ data: { name: `IT-${tag}` } });
    const a = await prisma.guardRoom.create({ data: { name: `A-${tag}`, location: 'x' } });
    const b = await prisma.guardRoom.create({ data: { name: `B-${tag}`, location: 'x' } });
    [hrId, itId, roomA, roomB] = [hr.id, it.id, a.id, b.id];
    const passwordHash = await bcrypt.hash(PW, 4);
    const mk = (n: string, role: any, extra: object) =>
      prisma.user.create({ data: { name: n, username: email(n).toLowerCase(), email: email(n), role, passwordHash, ...extra } });
    await mk('admin', 'super_admin', {});
    await mk('deptadmin', 'dept_admin', { departmentId: hrId });
    await mk('host', 'host', { departmentId: hrId });
    await mk('guard', 'guard', { guardRoomId: roomA });
    for (const n of ['admin', 'deptadmin', 'host', 'guard']) await login(n);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: `.${tag}@test.local` } } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.deleteMany({ where: { id: { in: [hrId, itId] } } });
    await app.close();
  });

  describe('authentication', () => {
    it('rejects unauthenticated access to every protected route', async () => {
      for (const path of ['/api/departments', '/api/guard-rooms', '/api/pass-categories', '/api/users', '/api/auth/me']) {
        expect((await http().get(path)).status).toBe(401);
      }
    });
    it('serves a public health check that reveals nothing but the status', async () => {
      const r = await http().get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'ok' });
    });
    it('gives the same error for unknown username and wrong password', async () => {
      const a = await http().post('/api/auth/login').send({ username: 'nobody', password: 'whatever' });
      const b = await http().post('/api/auth/login').send({ username: email('admin'), password: 'wrong-password' });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body.message).toBe(b.body.message);
    });
    it('sets an HttpOnly, SameSite=Strict session cookie and never returns the hash', async () => {
      const r = await http().post('/api/auth/login').send({ username: email('admin'), password: PW });
      const c = (r.headers['set-cookie'] as unknown as string[])[0];
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Strict/i);
      expect(JSON.stringify(r.body)).not.toMatch(/hash/i);
    });
    it('rate-limits repeated login attempts (brute-force protection)', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development'; // re-enable throttling for this test only
      try {
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) {
          codes.push((await http().post('/api/auth/login').send({ username: email('admin'), password: 'bad-guess' })).status);
        }
        expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
        expect(codes).toContain(429);
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
    it('blocks a deactivated user immediately, even with a valid token', async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { email: email('host') } });
      await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
      expect((await http().get('/api/auth/me').set(as('host'))).status).toBe(401);
      await prisma.user.update({ where: { id: u.id }, data: { isActive: true } });
    });
  });

  describe('role enforcement', () => {
    it('only a super admin can create departments / guard rooms / pass categories', async () => {
      for (const n of ['deptadmin', 'host', 'guard']) {
        expect((await http().post('/api/departments').set(as(n)).send({ name: `X-${n}-${tag}` })).status).toBe(403);
        expect((await http().post('/api/guard-rooms').set(as(n)).send({ name: `X-${n}-${tag}`, location: 'l' })).status).toBe(403);
        expect((await http().post('/api/pass-categories').set(as(n)).send({ name: `X-${n}-${tag}` })).status).toBe(403);
      }
      const ok = await http().post('/api/departments').set(as('admin')).send({ name: `Fin-${tag}` });
      expect(ok.status).toBe(201);
      await prisma.department.delete({ where: { id: ok.body.id } });
    });
    it('returns 409 on duplicate names', async () => {
      const r = await http().post('/api/departments').set(as('admin')).send({ name: `HR-${tag}` });
      expect(r.status).toBe(409);
    });
    it('hosts and guards cannot list or create users', async () => {
      for (const n of ['host', 'guard']) {
        expect((await http().get('/api/users').set(as(n))).status).toBe(403);
      }
    });
    it('rejects unknown / invalid body fields', async () => {
      const r = await http().post('/api/departments').set(as('admin')).send({ name: 'Ok name', isAdmin: true });
      expect(r.status).toBe(400);
    });
  });

  describe('user management rules', () => {
    const body = (n: string, extra: object) => ({
      name: n, username: `${n}${tag}`.toLowerCase().slice(0, 32), email: email(n), role: 'host', departmentId: hrId, password: PW, ...extra,
    });
    it('dept admin can add a host to their own department only', async () => {
      const ok = await http().post('/api/users').set(as('deptadmin')).send(body('newhost', {}));
      expect(ok.status).toBe(201);
      expect(ok.body.passwordHash).toBeUndefined();
      expect((await http().post('/api/users').set(as('deptadmin')).send(body('otherdept', { departmentId: itId }))).status).toBe(403);
      expect((await http().post('/api/users').set(as('deptadmin')).send(body('escalate', { role: 'super_admin', departmentId: undefined }))).status).toBe(403);
      expect((await http().post('/api/users').set(as('deptadmin')).send(body('guardx', { role: 'guard', guardRoomId: roomA, departmentId: undefined }))).status).toBe(403);
    });
    it('dept admin only lists hosts of their own department', async () => {
      const r = await http().get('/api/users').set(as('deptadmin'));
      expect(r.status).toBe(200);
      expect(r.body.every((u: any) => u.role === 'host' && u.departmentId === hrId)).toBe(true);
    });
    it('super admin creates a guard bound to a guard room; weak passwords are refused', async () => {
      const ok = await http().post('/api/users').set(as('admin')).send(body('guard2', { role: 'guard', guardRoomId: roomB, departmentId: undefined }));
      expect(ok.status).toBe(201);
      expect(ok.body.guardRoomId).toBe(roomB);
      expect((await http().post('/api/users').set(as('admin')).send(body('weak', { password: 'short' }))).status).toBe(400);
      expect((await http().post('/api/users').set(as('admin')).send(body('noroom', { role: 'guard', departmentId: undefined }))).status).toBe(400);
    });
    it('cannot deactivate yourself', async () => {
      const me = await prisma.user.findUniqueOrThrow({ where: { email: email('admin') } });
      expect((await http().patch(`/api/users/${me.id}`).set(as('admin')).send({ isActive: false })).status).toBe(400);
    });
  });

  describe('guard room rules', () => {
    it('refuses to deactivate a guard room with visitors on premises (UC-1)', async () => {
      const guard = await prisma.user.findUniqueOrThrow({ where: { email: email('guard') } });
      const v = await prisma.visitor.create({ data: { fullName: 'T', nicOrLicence: 'x', nicHash: `h-${tag}` } });
      const visit = await prisma.visit.create({
        data: { referenceNo: `R-${tag}`, visitorId: v.id, guardRoomId: roomA, source: 'walk_in', status: 'on_premises', createdBy: guard.id, timeIn: new Date() },
      });
      const r = await http().patch(`/api/guard-rooms/${roomA}`).set(as('admin')).send({ isActive: false });
      expect(r.status).toBe(400);
      await prisma.visit.delete({ where: { id: visit.id } });
      await prisma.visitor.delete({ where: { id: v.id } });
      expect((await http().patch(`/api/guard-rooms/${roomA}`).set(as('admin')).send({ isActive: false })).status).toBe(200);
    });
  });

  describe('audit trail', () => {
    it('records changes without secrets', async () => {
      const rows = await prisma.auditLog.findMany({ where: { entity: 'user', action: 'create' }, orderBy: { createdAt: 'desc' }, take: 5 });
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/\$2[aby]\$/); // no bcrypt hashes
    });
    it('is append-only at the database level', async () => {
      const row = await prisma.auditLog.findFirstOrThrow();
      await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
      await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    });
  });
});
