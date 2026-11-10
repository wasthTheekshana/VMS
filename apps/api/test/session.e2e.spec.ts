import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

const PW = 'Test-pass-12345';
const tag = `s${Date.now()}`;
const uname = (n: string) => `${n}.${tag}`.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

describe('Session revocation and live connections (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let url: string;
  let hr: string, roomA: string, roomB: string;
  const ids: Record<string, string> = {};
  const sockets: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const maxHours = loadEnv().sessionMaxHours;

  const cookieOf = (r: request.Response) =>
    (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vms_session='))!.split(';')[0];
  const login = async (n: string, pw = PW) => cookieOf(await http().post('/api/auth/login').send({ username: uname(n), password: pw }).expect(200));
  const me = (cookie: string) => http().get('/api/auth/me').set('Cookie', cookie);
  const claims = (cookie: string) => jwt.decode(cookie.split('=')[1]) as { sub: string; tv: number; at: number };
  const connect = async (cookie: string) => {
    const s = io(url, { path: '/ws', transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.on('connect', () => res()); s.on('connect_error', rej); });
    return s;
  };
  const mk = async (n: string, role: any, extra: object = {}) => {
    ids[n] = (await prisma.user.create({ data: { name: n, username: uname(n), role, passwordHash: await bcrypt.hash(PW, 4), ...extra } })).id;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    hr = (await prisma.department.create({ data: { name: `HR-${tag}` } })).id;
    roomA = (await prisma.guardRoom.create({ data: { name: `A-${tag}`, location: 'x' } })).id;
    roomB = (await prisma.guardRoom.create({ data: { name: `B-${tag}`, location: 'x' } })).id;
    await mk('admin', 'super_admin');
    for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank']) await mk(n, 'host', { departmentId: hr });
    await mk('guardx', 'guard', { guardRoomId: roomA });
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.delete({ where: { id: hr } });
    await app.close();
  });

  describe('logout', () => {
    it('ends the session for real: a copied cookie stops working', async () => {
      const c = await login('alice');
      expect((await me(c)).status).toBe(200);
      await http().post('/api/auth/logout').set('Cookie', c).expect(204);
      expect((await me(c)).status).toBe(401);
    });
    it('is harmless without a session', async () => {
      await http().post('/api/auth/logout').expect(204);
      await http().post('/api/auth/logout').set('Cookie', 'vms_session=garbage').expect(204);
    });
    it('does not let a refresh revive a revoked session', async () => {
      const c = await login('hank');
      await http().post('/api/auth/logout').set('Cookie', c).expect(204);
      expect((await http().post('/api/auth/refresh').set('Cookie', c)).status).toBe(401);
    });
  });

  describe('password change and reset', () => {
    it('a password change ends every OTHER session but keeps this browser signed in', async () => {
      const a = await login('bob');
      const b = await login('bob');
      const changed = await http().post('/api/auth/change-password').set('Cookie', a).send({ currentPassword: PW, newPassword: 'New-pass-67890' });
      expect(changed.status).toBe(204);
      const fresh = cookieOf(changed);
      expect((await me(a)).status).toBe(401); // the cookie that made the change is replaced
      expect((await me(b)).status).toBe(401); // another device is signed out
      expect((await me(fresh)).status).toBe(200); // this browser got a new token
      expect((await http().post('/api/auth/login').send({ username: uname('bob'), password: PW })).status).toBe(401);
      expect((await http().post('/api/auth/login').send({ username: uname('bob'), password: 'New-pass-67890' })).status).toBe(200);
    });
    it("an administrator reset ends the user's sessions", async () => {
      const carol = await login('carol');
      const admin = await login('admin');
      expect((await me(carol)).status).toBe(200);
      await http().patch(`/api/users/${ids.carol}`).set('Cookie', admin).send({ password: 'Reset-pass-12345' }).expect(200);
      expect((await me(carol)).status).toBe(401);
      expect((await me(admin)).status).toBe(200); // the admin is unaffected
    });
  });

  describe('absolute session lifetime', () => {
    it('refuses a sign-in older than the limit even though the token itself has not expired', async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: ids.dave } });
      const now = Math.floor(Date.now() / 1000);
      const fresh = await jwt.signAsync({ sub: u.id, tv: u.tokenVersion, at: now });
      const old = await jwt.signAsync({ sub: u.id, tv: u.tokenVersion, at: now - maxHours * 3600 - 120 });
      expect((await me(`vms_session=${fresh}`)).status).toBe(200);
      expect((await me(`vms_session=${old}`)).status).toBe(401);
      expect((await http().post('/api/auth/refresh').set('Cookie', `vms_session=${old}`)).status).toBe(401);
    });
    it('rejects tokens that predate the new claims (no version, no sign-in time)', async () => {
      const legacy = await jwt.signAsync({ sub: ids.dave });
      expect((await me(`vms_session=${legacy}`)).status).toBe(401);
    });
    it('refresh slides the idle window but keeps the ORIGINAL sign-in time', async () => {
      const c = await login('erin');
      const before = claims(c);
      await sleep(1100); // make sure a new token would carry a later time
      const r = await http().post('/api/auth/refresh').set('Cookie', c);
      expect(r.status).toBe(204);
      const after = claims(cookieOf(r));
      expect(after.at).toBe(before.at); // the absolute limit cannot be extended by activity
      expect(after.tv).toBe(before.tv);
      expect((await me(cookieOf(r))).status).toBe(200);
    });
  });

  describe('live connections follow the session and the user record', () => {
    it("logout disconnects the user's open sockets immediately", async () => {
      const c = await login('frank');
      const s = await connect(c);
      expect(s.connected).toBe(true);
      await http().post('/api/auth/logout').set('Cookie', c).expect(204);
      await waitFor(() => !s.connected);
    });
    it('a revoked token cannot open a socket at all', async () => {
      const c = await login('gina');
      await http().post('/api/auth/logout').set('Cookie', c).expect(204);
      const s = io(url, { path: '/ws', transports: ['websocket'], extraHeaders: { cookie: c }, reconnection: false });
      sockets.push(s);
      await sleep(1200);
      expect(s.connected).toBe(false);
    });
    it('moving a guard to another guard room drops their socket, so old-room alerts stop', async () => {
      const guard = await login('guardx');
      const admin = await login('admin');
      const s = await connect(guard);
      expect(s.connected).toBe(true);
      await http().patch(`/api/users/${ids.guardx}`).set('Cookie', admin).send({ guardRoomId: roomB }).expect(200);
      await waitFor(() => !s.connected);
    });
  });
});
