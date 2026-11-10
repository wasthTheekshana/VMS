import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../.env') });
/**
 * Idempotent seed: departments, pass categories, placeholder guard rooms (SRS 2.6) and
 * the first super admin. Guard room names are PLACEHOLDERS until the client supplies the real ones.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  for (const name of ['HR', 'IT', 'Security']) {
    await prisma.department.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const name of ['VIP Pass', 'Rest Pass', 'Loading Pass', 'Inter Pass', 'Contract Pass']) {
    await prisma.passCategory.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const n of [1, 2, 3]) {
    await prisma.guardRoom.upsert({
      where: { name: `Guard Room ${n}` },
      update: {},
      create: { name: `Guard Room ${n}`, location: 'TBC - supplied by client' },
    });
  }

  const username = (process.env.SEED_ADMIN_USERNAME ?? 'admin').toLowerCase();
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase() || undefined;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('Set SEED_ADMIN_PASSWORD (min 12 chars), and optionally SEED_ADMIN_USERNAME, to create the first super admin');
  }
  const exists = await prisma.user.findUnique({ where: { username } });
  if (!exists) {
    await prisma.user.create({
      data: { name: 'Super Administrator', username, email, role: 'super_admin', passwordHash: await bcrypt.hash(password, 12) },
    });
    console.log(`Created super admin ${username}`);
  }
}

main().finally(() => prisma.$disconnect());
