export type VisitEvent =
  | 'pre_registered'
  | 'pre_registration_updated'
  | 'pre_registration_cancelled'
  | 'walk_in'
  | 'checked_in'
  | 'checked_out'
  | 'overstay'
  | 'blacklist_hit';

export interface MessageCtx {
  referenceNo: string;
  visitorName: string;
  hostName?: string | null;
  guardRoomName: string;
  expectedAt?: Date | null;
}

const COLOMBO_OFFSET_MS = 5.5 * 3600_000;

/** "07 Nov 2026, 14:30" in Sri Lanka time. */
export function formatColombo(d: Date): string {
  const l = new Date(d.getTime() + COLOMBO_OFFSET_MS);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][l.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(l.getUTCDate())} ${mon} ${l.getUTCFullYear()}, ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
}

/** Strip control characters / newlines so user-entered names cannot forge SMS or e-mail header content. */
export const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100);

/** In-app text. No NIC or phone numbers: notifications are visible to more roles than the record. */
export function inAppText(event: VisitEvent, c: MessageCtx): { title: string; message: string } {
  const who = clean(c.visitorName);
  const room = clean(c.guardRoomName);
  switch (event) {
    case 'pre_registered':
      return { title: 'New visitor expected', message: `${who} (${c.referenceNo}) is expected at ${room}${c.expectedAt ? ' on ' + formatColombo(c.expectedAt) : ''}.` };
    case 'pre_registration_updated':
      return { title: 'Pre-registration changed', message: `${who} (${c.referenceNo}) was updated; now expected at ${room}${c.expectedAt ? ' on ' + formatColombo(c.expectedAt) : ''}.` };
    case 'pre_registration_cancelled':
      return { title: 'Pre-registration cancelled', message: `${who} (${c.referenceNo}) was cancelled.` };
    case 'walk_in':
      return { title: 'Walk-in visitor', message: `${who} (${c.referenceNo}) was registered at ${room}.` };
    case 'checked_in':
      return { title: 'Visitor arrived', message: `${who} (${c.referenceNo}) checked in at ${room}.` };
    case 'checked_out':
      return { title: 'Visitor left', message: `${who} (${c.referenceNo}) checked out from ${room}.` };
    case 'overstay':
      return { title: 'Visitor overstay', message: `${who} (${c.referenceNo}) has not checked out from ${room}.` };
    case 'blacklist_hit':
      return { title: 'Blacklisted visitor', message: `${who} (${c.referenceNo}) is on the watch list.` };
  }
}

/** SMS to the visitor (FR-18). */
export function visitorSms(event: 'pre_registered' | 'pre_registration_updated' | 'pre_registration_cancelled', c: MessageCtx): string {
  const host = c.hostName ? `, host ${clean(c.hostName)}` : '';
  if (event === 'pre_registration_cancelled') return `Your visit ${c.referenceNo} has been cancelled.`;
  const verb = event === 'pre_registered' ? 'Visit registered' : 'Visit updated';
  return `${verb}: ref ${c.referenceNo}${c.expectedAt ? ', ' + formatColombo(c.expectedAt) : ''}, report to ${clean(c.guardRoomName)}${host}.`;
}

/** SMS to the host (FR-21). */
export function hostSms(event: 'checked_in' | 'walk_in', c: MessageCtx): string {
  return event === 'checked_in'
    ? `${clean(c.visitorName)} has arrived at ${clean(c.guardRoomName)} (${c.referenceNo}).`
    : `Walk-in visitor ${clean(c.visitorName)} registered at ${clean(c.guardRoomName)} for you (${c.referenceNo}).`;
}

/** Sri Lankan local (07XXXXXXXX / 7XXXXXXXX) or international input -> E.164. Returns null if unusable. */
export function toE164LK(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[\s()-]/g, '');
  if (/^\+\d{9,15}$/.test(d)) return d;
  if (/^0\d{9}$/.test(d)) return `+94${d.slice(1)}`;
  if (/^94\d{9}$/.test(d)) return `+${d}`;
  if (/^[1-9]\d{8}$/.test(d)) return `+94${d}`;
  return null;
}

/** Most recent overstay cut-off instant at or before `now` ("HH:MM", Colombo time). */
export function latestCutoff(now: Date, hhmm: string): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid OVERSTAY_CUTOFF "${hhmm}", expected HH:MM`);
  const local = new Date(now.getTime() + COLOMBO_OFFSET_MS);
  const todayCut = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +m[1], +m[2]) - COLOMBO_OFFSET_MS;
  return new Date(todayCut <= now.getTime() ? todayCut : todayCut - 86_400_000);
}
