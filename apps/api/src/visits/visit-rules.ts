import { randomBytes } from 'crypto';
import { PiiCrypto } from '../common/pii-crypto';

/** Sri Lankan NIC (old 9 digits + V/X, new 12 digits) or driving licence (letter + 7 digits). Input is normalised first. */
export const NIC_PATTERN = /^(\d{9}[VX]|\d{12}|[A-Z]\d{7})$/;

export const isValidNic = (raw: string) => NIC_PATTERN.test(PiiCrypto.normaliseNic(raw));

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: readable over the phone

/** e.g. V-20261107-K7H3QW. Random suffix so references cannot be enumerated. */
export function newReferenceNo(now = new Date()): string {
  const ymd = colomboParts(now).ymd;
  const bytes = randomBytes(6);
  const suffix = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `V-${ymd}-${suffix}`;
}

const COLOMBO_OFFSET_MS = 5.5 * 3600_000; // Asia/Colombo is UTC+05:30 with no DST

function colomboParts(now: Date) {
  const local = new Date(now.getTime() + COLOMBO_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return { y, m, d, ymd: `${y}${m}${d}` };
}

/** [start, end) of the current day in Sri Lanka time, as UTC instants ("Expected Today", FR-10). */
export function colomboDayBounds(now = new Date()): { start: Date; end: Date } {
  const { y, m, d } = colomboParts(now);
  const start = new Date(Date.parse(`${y}-${m}-${d}T00:00:00.000Z`) - COLOMBO_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function maskPhone(p?: string | null): string | null {
  if (!p) return null;
  return p.length <= 4 ? '*'.repeat(p.length) : `${'*'.repeat(p.length - 3)}${p.slice(-3)}`;
}

export interface VisitRecord {
  id: string; referenceNo: string; status: string; source: string; groupId: string | null;
  purpose: string | null; areaVisited: string | null; remarks: string | null;
  expectedAt: Date | null; timeIn: Date | null; timeOut: Date | null;
  visitor: { id: string; fullName: string; nicOrLicence: string; phone: string | null; company: string | null; address: string | null };
  guardRoom: { id: string; name: string };
  passCategory: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  host: { id: string; name: string } | null;
}

/**
 * Shape a visit for the API. List views are masked; `full` (single-record view) reveals the
 * decrypted NIC / phone to roles already scoped to the record (NFR-4). The ciphertext never leaves the server.
 */
export function toView(v: VisitRecord, crypto: PiiCrypto, full: boolean) {
  const nic = crypto.decrypt(v.visitor.nicOrLicence);
  const { nicOrLicence: _omit, ...visitor } = v.visitor;
  return {
    ...v,
    visitor: { ...visitor, nic: full ? nic : PiiCrypto.mask(nic), phone: full ? v.visitor.phone : maskPhone(v.visitor.phone) },
  };
}
