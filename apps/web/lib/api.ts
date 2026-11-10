'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Role = 'super_admin' | 'dept_admin' | 'host' | 'guard';
export interface Me { id: string; name?: string; username?: string; role: Role; departmentId: string | null; guardRoomId: string | null }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Query = Record<string, string | number | undefined | null>;
export const qs = (q: Query = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Same-origin call to the API; the session lives in an HttpOnly cookie that scripts never see. */
export async function api<T = unknown>(path: string, o: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(o.query)}`, {
      method: o.method ?? (o.body ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = (data as { message?: string | string[] }).message;
    throw new ApiError(res.status, Array.isArray(m) ? m.join('; ') : m ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Loads the signed-in user; sends anyone else back to the login page. Keeps the session alive while the user is active. */
export function useSession(allowed: Role[]) {
  const [me, setMe] = useState<Me | null>(null);
  const allowedKey = allowed.join(',');
  useEffect(() => {
    let alive = true;
    api<Me>('/auth/me').then(
      (m) => {
        if (!alive) return;
        if (!allowedKey.split(',').includes(m.role)) window.location.replace('/');
        else setMe(m);
      },
      () => { if (alive) window.location.replace('/'); },
    );
    return () => { alive = false; };
  }, [allowedKey]);

  useEffect(() => {
    let last = 0;
    const ping = () => {
      const now = Date.now();
      if (now - last < 5 * 60_000) return; // sliding idle timeout: refresh at most every 5 minutes of activity
      last = now;
      api('/auth/refresh', { method: 'POST' }).catch((e) => { if (e instanceof ApiError && e.status === 401) window.location.replace('/'); });
    };
    const ev = ['pointerdown', 'keydown'] as const;
    ev.forEach((e) => window.addEventListener(e, ping));
    return () => ev.forEach((e) => window.removeEventListener(e, ping));
  }, []);
  return me;
}

/** Fetch-on-mount helper with reload. Errors are surfaced, never swallowed. */
export function useFetch<T>(path: string | null, query?: Query) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = path ? path + qs(query) : null;
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path, { query });
      if (mine === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

const COLOMBO = 'Asia/Colombo';
export const fmt = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: COLOMBO, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
export const fmtTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: COLOMBO, hour: '2-digit', minute: '2-digit' }) : '–';

/** datetime-local value (Colombo wall time) <-> ISO instant. */
export const toLocalInput = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16);
export const fromLocalInput = (v: string) => new Date(`${v}:00+05:30`).toISOString();

export const beep = () => {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.35);
    o.onended = () => void ctx.close();
  } catch { /* audio may be blocked until the user interacts; the on-screen alert still shows */ }
};

export const ROLE_HOME: Record<Role, string> = { super_admin: '/admin', dept_admin: '/admin', host: '/host', guard: '/guard' };
