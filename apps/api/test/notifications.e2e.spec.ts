import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PiiCrypto } from '../src/common/pii-crypto';
import { OverstayScheduler } from '../src/notifications/notifications.module';
import { MailProvider, SmsProvider } from '../src/notifications/providers';
import { PrismaService } from '../src/prisma/prisma.service';

process.env.NOTIFY_BACKOFF_MS = '30'; // fast retries for the test

const PW = 'Test-pass-12345';
const tag = `n${Date.now()}`;
const email = (n: string) => `${n}.${tag}@test.local`.toLowerCase();
const base = Date.now() % 1e9;
const nic = (i: number) => `9${String(base).padStart(9, '0')}${String(i).padStart(2, '0')}`;
const phone = (i: number) => `07${String(base % 1e7).padStart(7, '0')}${i}`; // 10 digits
const e164 = (p: string) => `+94${p.slice(1)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

class FakeSms extends SmsProvider {
  sent: { to: string; text: string }[] = [];
  failing = false;
  attempts = 0;
  async send(to: string, text: string) {
    this.attempts++;
    if (this.failing) throw new Error('gateway down');
    this.sent.push({ to, text });
  }
}
class FakeMail extends MailProvider {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
}

describe('Notifications: real-time, SMS/email queue, overstay (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: PiiCrypto;
  let url: string;
  let hr: string, itDept: string, roomA: string, roomB: string, pass: string;
  const sms = new FakeSms();
  const mail = new FakeMail();
  const ck: Record<string, string[]> = {};
  const sockets: Record<string, Socket> = {};
  const got: Record<string, any[]> = {};
  const changed: Record<string, any[]> = {};
  const http = () => request(app.getHttpServer());
  const as = (n: string) => ({ Cookie: ck[n] });

  const connect = async (n: string) => {
    got[n] = []; changed[n] = [];
    const s = io(url, { path: '/ws', transports: ['websocket'], extraHeaders: { cookie: ck[n].map((c) => c.split(';')[0]).join('; ') }, reconnection: false });
    s.on('notification', (m) => got[n].push(m));
    s.on('visits:changed', (m) => changed[n].push(m));
    await new Promise<void>((res, rej) => { s.on('connect', () => res()); s.on('connect_error', rej); });
    sockets[n] = s;
  };
  const preReg = async (i: number, extra: object = {}) => {
    const r = await http().post('/api/visits').set(as('hostHR')).send({
      visitors: [{ fullName: `Visitor ${i}`, nic: nic(i), phone: phone(i) }], purpose: 'Meeting',
      expectedAt: new Date().toISOString(), areaVisited: 'Level 3', guardRoomId: roomA, ...extra,
    });
    expect(r.status).toBe(201);
    return r.body.visits[0];
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsProvider).useValue(sms)
      .overrideProvider(MailProvider).useValue(mail)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, 'http://localhost:3000');
    await app.listen(0);
    url = await app.getUrl();
    url = url.replace('[::1]', 'localhost');
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
    await mk('hostHR', 'host', { departmentId: hr, phone: phone(0) });
    await mk('hostIT', 'host', { departmentId: itDept });
    await mk('guardA', 'guard', { guardRoomId: roomA });
    await mk('guardB', 'guard', { guardRoomId: roomB });
    await mk('admin', 'super_admin', {});
    for (const n of ['hostHR', 'hostIT', 'guardA', 'guardB', 'admin']) {
      const r = await http().post('/api/auth/login').send({ username: email(n), password: PW });
      ck[n] = r.headers['set-cookie'] as unknown as string[];
      await connect(n);
    }
  });

  afterAll(async () => {
    Object.values(sockets).forEach((s) => s.close());
    const ids = (await prisma.user.findMany({ where: { email: { endsWith: `.${tag}@test.local` } }, select: { id: true } })).map((u) => u.id);
    const hashes = Array.from({ length: 20 }, (_, i) => crypto.hashNic(nic(i)));
    await prisma.notification.deleteMany({ where: { visit: { createdBy: { in: ids } } } });
    await prisma.visit.deleteMany({ where: { createdBy: { in: ids } } });
    await prisma.blacklist.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.visitor.deleteMany({ where: { nicHash: { in: hashes } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.passCategory.delete({ where: { id: pass } });
    await prisma.guardRoom.deleteMany({ where: { id: { in: [roomA, roomB] } } });
    await prisma.department.deleteMany({ where: { id: { in: [hr, itDept] } } });
    await app.close();
  });

  it('refuses a WebSocket connection without a valid session', async () => {
    const s = io(url, { path: '/ws', transports: ['websocket'], reconnection: false });
    await new Promise<void>((res) => s.on('disconnect', () => res()));
    expect(s.connected).toBe(false);
  });

  describe('pre-registration alerts (FR-18, FR-19, FR-20)', () => {
    let visit: any;
    beforeAll(async () => { visit = await preReg(1); });

    it('alerts the assigned guard room with sound, and the admin, in real time', async () => {
      const a = await waitFor(() => got.guardA.find((m) => m.visitId === visit.id));
      expect(a).toMatchObject({ event: 'pre_registered', sound: true, title: 'New visitor expected' });
      const adm = await waitFor(() => got.admin.find((m) => m.visitId === visit.id));
      expect(adm.sound).toBe(false);
    });
    it('never delivers it to another guard room or another department (FR-17)', async () => {
      await waitFor(() => changed.guardA.find((m) => m.visitId === visit.id));
      await sleep(300);
      for (const n of ['guardB', 'hostIT']) {
        expect(got[n].filter((m) => m.visitId === visit.id)).toHaveLength(0);
        expect(changed[n].filter((m) => m.visitId === visit.id)).toHaveLength(0);
      }
    });
    it('sends the visitor an SMS with reference, guard room and host, to an E.164 number', async () => {
      const m = await waitFor(() => sms.sent.find((x) => x.text.includes(visit.referenceNo)));
      expect(m.to).toBe(e164(phone(1)));
      expect(m.text).toContain(`A-${tag}`);
      expect(m.text).toContain('hostHR');
      expect(m.text).not.toContain(nic(1)); // no NIC in SMS
      const row = await waitFor(() => prisma.notification.findFirst({ where: { visitId: visit.id, channel: 'sms', status: 'sent' } }));
      expect(row.sentAt).toBeTruthy();
    });
    it('refreshes the host\'s own screens', async () => {
      await waitFor(() => changed.hostHR.find((m) => m.visitId === visit.id));
    });
  });

  describe('arrival alerts (FR-21)', () => {
    it('tells the host in-app and by SMS when the visitor checks in, and in-app when they leave', async () => {
      const v = await preReg(2);
      const r = await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass });
      expect(r.status).toBe(200);
      const inApp = await waitFor(() => got.hostHR.find((m) => m.visitId === v.id && m.event === 'checked_in'));
      expect(inApp.message).toContain('checked in');
      const text = await waitFor(() => sms.sent.find((x) => x.to === e164(phone(0)) && x.text.includes(v.referenceNo)));
      expect(text.text).toContain('arrived');
      await waitFor(() => changed.admin.find((m) => m.visitId === v.id && m.event === 'checked_in')); // dashboard signal
      await http().post(`/api/guard/visits/${v.id}/check-out`).set(as('guardA')).send({}).expect(200);
      await waitFor(() => got.hostHR.find((m) => m.visitId === v.id && m.event === 'checked_out'));
    });
  });

  describe('edit and cancel (FR-8, FR-19)', () => {
    it('moving the visit alerts both guard rooms and SMSes the visitor; cancelling alerts the new room', async () => {
      const v = await preReg(3);
      await http().patch(`/api/visits/${v.id}`).set(as('hostHR')).send({ guardRoomId: roomB }).expect(200);
      await waitFor(() => got.guardB.find((m) => m.visitId === v.id && m.event === 'pre_registration_updated'));
      await waitFor(() => got.guardA.find((m) => m.visitId === v.id && m.event === 'pre_registration_updated')); // old room told it left
      await waitFor(() => sms.sent.find((x) => x.text.startsWith('Visit updated') && x.text.includes(v.referenceNo)));
      await http().post(`/api/visits/${v.id}/cancel`).set(as('hostHR')).expect(200);
      await waitFor(() => got.guardB.find((m) => m.visitId === v.id && m.event === 'pre_registration_cancelled'));
    });
    it('a purpose-only edit does not SMS the visitor', async () => {
      const v = await preReg(4);
      await waitFor(() => sms.sent.find((x) => x.text.includes(v.referenceNo)));
      const before = sms.sent.length;
      await http().patch(`/api/visits/${v.id}`).set(as('hostHR')).send({ purpose: 'New purpose' }).expect(200);
      await waitFor(() => got.guardA.find((m) => m.visitId === v.id && m.event === 'pre_registration_updated'));
      await sleep(200);
      expect(sms.sent.length).toBe(before);
    });
  });

  describe('delivery failures (plan: retry 3x then mark failed)', () => {
    it('retries 3 times, marks the row failed, shows it to admins, and never blocks the guard', async () => {
      sms.failing = true;
      sms.attempts = 0;
      const v = await preReg(5);
      await waitFor(() => prisma.notification.findFirst({ where: { visitId: v.id, channel: 'sms', status: 'failed' } }));
      const row = await prisma.notification.findFirstOrThrow({ where: { visitId: v.id, channel: 'sms' } });
      expect(row.attempts).toBe(3);
      expect(row.lastError).toContain('gateway down');
      // the guard console keeps working while the gateway is down
      const ci = await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass });
      expect(ci.status).toBe(200);
      const failed = await http().get('/api/notifications/failed').set(as('admin'));
      expect(failed.body.map((r: any) => r.id)).toContain(row.id);
      expect((await http().get('/api/notifications/failed').set(as('guardA'))).status).toBe(403);
      // admin retries once the gateway is back
      sms.failing = false;
      expect((await http().post(`/api/notifications/${row.id}/retry`).set(as('admin'))).body.requeued).toBe(true);
      await waitFor(() => prisma.notification.findFirst({ where: { id: row.id, status: 'sent' } }));
    });
    it('rejects a malformed phone number up front, so it never reaches the queue', async () => {
      const r = await http().post('/api/visits').set(as('hostHR')).send({
        visitors: [{ fullName: 'No Phone', nic: nic(6), phone: '+12' }], purpose: 'x', expectedAt: new Date().toISOString(), areaVisited: 'y', guardRoomId: roomA,
      });
      expect(r.status).toBe(400); // rejected at validation: bad numbers never reach the queue
    });
  });

  describe('inbox', () => {
    it('lists only the caller\'s own notifications and only lets them mark their own as read', async () => {
      const mine = await http().get('/api/notifications').set(as('guardA'));
      expect(mine.status).toBe(200);
      expect(mine.body.length).toBeGreaterThan(0);
      expect(mine.body.every((n: any) => n.payload && !('recipientUserId' in n))).toBe(true);
      const theirs = (await http().get('/api/notifications').set(as('guardB'))).body[0];
      const res = await http().post(`/api/notifications/${theirs.id}/read`).set(as('guardA'));
      expect(res.body.updated).toBe(0); // someone else's notification
      expect((await http().post(`/api/notifications/${mine.body[0].id}/read`).set(as('guardA'))).body.updated).toBe(1);
      expect((await http().post('/api/notifications/read-all').set(as('guardA'))).status).toBe(200);
      expect((await http().get('/api/notifications').set(as('guardA'))).body.every((n: any) => n.readAt)).toBe(true);
    });
  });

  describe('overstay (FR-22)', () => {
    it('flags a visitor still on premises after the cut-off exactly once, alerting the guard room and admin', async () => {
      const v = await preReg(7);
      await http().post(`/api/guard/visits/${v.id}/check-in`).set(as('guardA')).send({ passCategoryId: pass }).expect(200);
      const scheduler = app.get(OverstayScheduler);
      const tomorrow = new Date(Date.now() + 36 * 3600_000);
      expect(await scheduler.check(tomorrow)).toBeGreaterThanOrEqual(1);
      const a = await waitFor(() => got.guardA.find((m) => m.visitId === v.id && m.event === 'overstay'));
      expect(a.sound).toBe(true);
      await waitFor(() => got.admin.find((m) => m.visitId === v.id && m.event === 'overstay'));
      await scheduler.check(tomorrow);
      const perUser = await prisma.notification.groupBy({ by: ['recipientUserId'], where: { visitId: v.id, event: 'overstay' }, _count: true });
      expect(perUser.every((g) => g._count === 1)).toBe(true); // no duplicates on the second run
    });
  });

  describe('blacklist warning (FR-29)', () => {
    it('tells admins in-app and by e-mail when a blacklisted NIC is pre-registered', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: email('admin') } });
      await prisma.blacklist.create({ data: { nicHash: crypto.hashNic(nic(8)), reason: 'test', addedBy: admin.id } });
      const v = await preReg(8);
      await waitFor(() => got.admin.find((m) => m.visitId === v.id && m.event === 'blacklist_hit'));
      const m = await waitFor(() => mail.sent.find((x) => x.to === email('admin')));
      expect(m.subject).toContain('Blacklisted');
      expect(m.text).not.toContain(nic(8));
    });
  });
});
