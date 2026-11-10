/**
 * Demo / UAT data: sample users and ~30 days of visits so dashboards and reports have something to show.
 *   npm run seed:demo            create (safe to re-run: it clears its own previous demo data first)
 *   npm run seed:demo -- --clear remove all demo data
 * Everything it creates is recognisable: users end in @demo.vms.local, visitor NICs start with "99".
 * Demo accounts share a DOCUMENTED password (DEMO_PASSWORD, default below). NEVER run this in production.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../.env') });
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PiiCrypto } from '../src/common/pii-crypto';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create demo data in production');

const prisma = new PrismaClient();
const crypto = new PiiCrypto(process.env.DATA_ENCRYPTION_KEY!, process.env.NIC_HASH_KEY!);
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-pass-12345';
const DOMAIN = '@demo.vms.local';

// small deterministic PRNG so every run produces the same-looking data
let seed = 20261107;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const weighted = <T,>(a: [T, number][]) => { let r = rnd() * a.reduce((s, [, w]) => s + w, 0); for (const [v, w] of a) if ((r -= w) <= 0) return v; return a[0][0]; };

const FIRST = ['Nimal', 'Kamal', 'Sunil', 'Chamari', 'Dilini', 'Ruwan', 'Tharindu', 'Nadeesha', 'Pradeep', 'Ishara', 'Kasun', 'Malini', 'Sampath', 'Anjali', 'Rohan', 'Fathima', 'Mohamed', 'Priya', 'Arjun', 'Sanduni'];
const LAST = ['Perera', 'Fernando', 'Silva', 'Jayasinghe', 'Wickramasinghe', 'Gunasekara', 'Rajapaksa', 'Bandara', 'De Soysa', 'Kumar', 'Nazeer', 'Samarasinghe'];
const COMPANIES = ['Acme Lanka', 'Globex Ceylon', 'Initech Solutions', 'Hemas Logistics', 'Dialog Axiata', 'Sampath Bank', 'John Keells', 'MAS Holdings', 'Ceylon Tea Traders', 'Lanka Hospitals'];
const PURPOSES: [string, number][] = [['Meeting', 40], ['Interview', 25], ['Vendor', 15], ['Delivery', 12], ['Audit', 8]];
const AREAS = ['Reception', 'Level 2 – Finance', 'Level 3 – IT', 'Boardroom', 'Warehouse', 'HR Office'];
const D = 86_400_000;
const nicFor = (i: number) => `99${String(1000000000 + i).slice(-10)}`;

async function clear() {
  const users = await prisma.user.findMany({ where: { username: { startsWith: 'demo.' } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const demoSet = new Set(Array.from({ length: 400 }, (_, i) => crypto.hashNic(nicFor(i))));
  const visitors = await prisma.visitor.findMany({ select: { id: true, nicHash: true } });
  const demoVisitorIds = visitors.filter((v) => demoSet.has(v.nicHash)).map((v) => v.id);
  const visits = await prisma.visit.findMany({ where: { OR: [{ createdBy: { in: ids } }, { visitorId: { in: demoVisitorIds } }] }, select: { id: true } });
  await prisma.notification.deleteMany({ where: { visitId: { in: visits.map((v) => v.id) } } });
  await prisma.visit.deleteMany({ where: { id: { in: visits.map((v) => v.id) } } });
  await prisma.visitor.deleteMany({ where: { id: { in: demoVisitorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await clear();
  if (process.argv.includes('--clear')) { console.log('Demo data removed.'); return; }

  const [depts, rooms, passes] = await Promise.all([
    prisma.department.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }), prisma.guardRoom.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.passCategory.findMany({ where: { isActive: true } }),
  ]);
  if (!depts.length || !rooms.length || !passes.length) throw new Error('Run `npm run seed` first (departments, guard rooms, pass categories).');
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const hosts: { id: string; departmentId: string }[] = [];
  const names = ['Kasun Ranasinghe', 'Ayesha Perera', 'Ruwan Jayawardena', 'Nadeesha Silva', 'Imran Hussain', 'Dinusha Fernando'];
  for (const [i, nm] of names.entries()) {
    const dep = depts[i % depts.length];
    const u = await prisma.user.create({ data: { name: nm, username: `demo.host${i + 1}`, email: `host${i + 1}${DOMAIN}`, role: 'host', departmentId: dep.id, passwordHash, phone: `0771000${100 + i}` } });
    hosts.push({ id: u.id, departmentId: dep.id });
  }
  await prisma.user.create({ data: { name: 'Demo Dept Admin', username: 'demo.deptadmin', email: `deptadmin${DOMAIN}`, role: 'dept_admin', departmentId: depts[0].id, passwordHash } });
  const guards: { id: string; roomId: string }[] = [];
  for (const [i, r] of rooms.entries()) {
    const g = await prisma.user.create({ data: { name: `Guard ${r.name}`, username: `demo.guard${i + 1}`, email: `guard${i + 1}${DOMAIN}`, role: 'guard', guardRoomId: r.id, passwordHash } });
    guards.push({ id: g.id, roomId: r.id });
  }

  const now = Date.now();
  const colombo0 = (daysAgo: number) => { const l = new Date(now + 5.5 * 3600_000 - daysAgo * D); return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - 5.5 * 3600_000; };
  let n = 0, refSeq = 0;
  const visitorCache = new Map<number, { id: string; fullName: string; phone: string | null; company: string | null }>();

  const make = async (dayStart: number, hourF: number, status: 'checked_out' | 'on_premises' | 'expected', source: 'pre_registered' | 'walk_in') => {
    const idx = n++ % 380;
    let vis = visitorCache.get(idx);
    if (!vis) {
      const nic = nicFor(idx);
      const v = await prisma.visitor.create({ data: {
        fullName: `${pick(FIRST)} ${pick(LAST)}`, nicHash: crypto.hashNic(nic), nicOrLicence: crypto.encrypt(nic), company: pick(COMPANIES),
        phone: `07${Math.floor(10000000 + rnd() * 89999999)}`, address: 'Colombo',
      } });
      vis = v; visitorCache.set(idx, vis);
    }
    const guard = pick(guards); const host = pick(hosts);
    const at = new Date(dayStart + hourF * 3600_000);
    const stayH = 0.4 + rnd() * 3.2;
    await prisma.visit.create({ data: {
      referenceNo: `V-DEMO-${String(++refSeq).padStart(5, '0')}`, visitorId: vis.id, visitorName: vis.fullName, visitorPhone: vis.phone, visitorCompany: vis.company, hostUserId: host.id, departmentId: host.departmentId, guardRoomId: guard.roomId,
      passCategoryId: status === 'expected' ? null : pick(passes).id, purpose: weighted(PURPOSES), areaVisited: pick(AREAS), source, status,
      expectedAt: source === 'pre_registered' ? new Date(at.getTime() - 20 * 60_000) : null,
      timeIn: status === 'expected' ? null : at, timeOut: status === 'checked_out' ? new Date(at.getTime() + stayH * 3600_000) : null,
      createdBy: guard.id, checkedOutBy: status === 'checked_out' ? guard.id : null, createdAt: new Date(at.getTime() - 3600_000),
    } });
  };

  // history: weekday-heavy volumes over the last 30 days
  for (let d = 30; d >= 1; d--) {
    const dow = new Date(colombo0(d) + 5.5 * 3600_000).getUTCDay();
    const count = dow === 0 || dow === 6 ? 2 + Math.floor(rnd() * 4) : 8 + Math.floor(rnd() * 14);
    for (let i = 0; i < count; i++) await make(colombo0(d), 8 + rnd() * 9, 'checked_out', rnd() < 0.75 ? 'pre_registered' : 'walk_in');
  }
  // today: a morning peak and a lunchtime bump, up to the current Colombo hour
  const nowH = ((now + 5.5 * 3600_000) % D) / 3600_000;
  const today = colombo0(0);
  for (let h = 8; h < Math.min(nowH - 0.3, 18); h += 0.35) {
    const weight = h < 11 ? 0.95 : h < 13 ? 0.55 : 0.75;
    if (rnd() < weight) {
      const staying = nowH - h < 1.6 ? rnd() < 0.8 : rnd() < 0.15;
      await make(today, h + rnd() * 0.3, staying ? 'on_premises' : 'checked_out', rnd() < 0.7 ? 'pre_registered' : 'walk_in');
    }
  }
  for (let i = 0; i < 5; i++) await make(today, nowH + 0.5 + i * 0.7, 'expected', 'pre_registered'); // still to arrive

  console.log(`Demo data created. Sign in with demo.host1 / demo.guard1 / demo.deptadmin and password "${PASSWORD}".`);
}

main().finally(() => prisma.$disconnect());
