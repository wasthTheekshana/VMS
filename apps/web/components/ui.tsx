'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { api, ApiError, beep, fmt, Me, useFetch } from '@/lib/api';

/* ---------- icons (inline, stroke-based, no extra dependency) ---------- */
const PATHS = {
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M20 8v6 M23 11h-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M10 17l5-5-5-5 M15 12H3',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  chart: 'M12 20V10 M18 20V4 M6 20v-4',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  building: 'M3 21h18 M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16 M19 21V11h-4 M9 7h2 M9 11h2 M9 15h2',
  pin: 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z M7 7h.01',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M4.9 4.9l14.2 14.2',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  alert: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  check: 'M20 6L9 17l-5-5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z M15.5 7.5l3 3L22 7l-3-3',
  plus: 'M12 5v14 M5 12h14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8',
} as const;
export type IconName = keyof typeof PATHS;
export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{PATHS[name].split(' M').map((d, i) => <path key={i} d={(i ? 'M' : '') + d} />)}</svg>;
}
export const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
export const Avatar = ({ name, small, dark }: { name?: string; small?: boolean; dark?: boolean }) => <span className={`avatar${small ? ' sm' : ''}${dark ? ' on-dark' : ''}`} aria-hidden="true">{initials(name)}</span>;

/* ---------- live events (one socket per page, shared through context) ---------- */
type Handler = (payload: any) => void;
interface Live { connected: boolean; on: (event: string, fn: Handler) => () => void }
const LiveCtx = createContext<Live>({ connected: true, on: () => () => undefined });

/** Subscribe to a socket event for the lifetime of the component. `connect` also fires after every reconnect. */
export function useLive(event: string, fn: Handler) {
  const { on } = useContext(LiveCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(event, (p) => ref.current(p)), [event, on]);
}

/* ---------- toasts ---------- */
interface Toast { id: number; text: string; kind: 'info' | 'error' | 'alert' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function errText(e: unknown) {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong';
}

/* ---------- small widgets ---------- */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

const STATUS: Record<string, string> = { expected: 'info', on_premises: 'ok', checked_out: 'muted', cancelled: 'bad', pending: 'warn', approved: 'ok', rejected: 'bad', used: 'muted', failed: 'bad', sent: 'ok' };
export const Badge = ({ s }: { s: string }) => <span className={`badge ${STATUS[s] ?? 'muted'}`}>{s.replace('_', ' ')}</span>;

export const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="alert bad" role="alert">{error}</div> : null);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Segment<T extends string>({ items, value, onChange }: { items: { id: T; label: string; badge?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segment" role="tablist">
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}{!!t.badge && <b className="count">{t.badge}</b>}
        </button>
      ))}
    </div>
  );
}

/* ---------- change password ---------- */
function ChangePassword({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Change password" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
          toast('Password changed'); onClose();
        } catch (x) { setErr(errText(x)); }
      }}>
        <ErrorBox error={err} />
        <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
        <Field label="New password" hint="At least 10 characters, with a letter and a digit"><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} /></Field>
        <button className="btn primary">Change password</button>
      </form>
    </Modal>
  );
}

/* ---------- notification bell ---------- */
interface Note { id: string; event: string; visitId: string; payload: { title: string; message: string }; readAt: string | null; createdAt: string }

function Bell() {
  const { data, reload } = useFetch<Note[]>('/notifications');
  const [open, setOpen] = useState(false);
  useLive('notification', () => void reload());
  useLive('connect', () => void reload());
  const unread = data?.filter((n) => !n.readAt).length ?? 0;
  return (
    <div className="bell">
      <button className="icon-btn" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen(!open)}><Icon name="bell" />{unread > 0 && <b className="count">{unread}</b>}</button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-head"><strong>Notifications</strong>
            <button className="link" onClick={async () => { await api('/notifications/read-all', { method: 'POST' }); void reload(); }}>Mark all read</button></div>
          {!data?.length && <Empty>No notifications</Empty>}
          {data?.map((n) => (
            <div key={n.id} className={`note${n.readAt ? '' : ' unread'}`}>
              <strong>{n.payload.title}</strong><div>{n.payload.message}</div><small>{fmt(n.createdAt)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- page shell: crimson sidebar + top bar ---------- */
export interface NavItem<T extends string = string> { id: T; label: string; icon: IconName; badge?: number }

export function Shell<T extends string>({ me, title, nav, active, onNav, tools, children }: {
  me: Me | null; title: string; nav: NavItem<T>[]; active: T; onNav: (id: T) => void; tools?: ReactNode; children: ReactNode;
}) {
  const [connected, setConnected] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pw, setPw] = useState(false);
  const handlers = useRef(new Map<string, Set<Handler>>());
  const socket = useRef<Socket | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
  }, []);

  const on = useCallback((event: string, fn: Handler) => {
    const set = handlers.current.get(event) ?? new Set();
    set.add(fn);
    handlers.current.set(event, set);
    return () => { set.delete(fn); };
  }, []);

  useEffect(() => {
    if (!me) return;
    const s = io(process.env.NEXT_PUBLIC_WS_URL ?? window.location.origin, { path: '/ws', withCredentials: true, transports: ['websocket'] });
    socket.current = s;
    const fire = (event: string, p?: unknown) => handlers.current.get(event)?.forEach((f) => f(p));
    s.on('connect', () => { setConnected(true); fire('connect'); }); // re-fetch after any reconnect: nothing is missed
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    for (const ev of ['notification', 'visits:changed', 'overrides:changed']) s.on(ev, (p) => fire(ev, p));
    s.on('notification', (n: { title: string; message: string; sound: boolean }) => {
      toast(`${n.title}: ${n.message}`, 'alert');
      if (n.sound) beep();
    });
    return () => { s.close(); };
  }, [me, toast]);

  const live = useMemo(() => ({ connected, on }), [connected, on]);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); window.location.replace('/'); };
  const current = nav.find((n) => n.id === active)?.label ?? title;

  return (
    <LiveCtx.Provider value={live}>
      <ToastCtx.Provider value={toast}>
        <div className="app">
          <aside className="sidebar">
            <div className="brand-block"><div className="brand-name">VMS</div><div className="brand-sub">VISITOR</div></div>
            <nav className="nav" aria-label={title}>
              {nav.map((n) => (
                <button key={n.id} className={`nav-item${n.id === active ? ' active' : ''}`} aria-current={n.id === active ? 'page' : undefined} onClick={() => onNav(n.id)}>
                  <Icon name={n.icon} /><span>{n.label}</span>{!!n.badge && <b className="count">{n.badge}</b>}
                </button>
              ))}
            </nav>
            <div className="side-user">
              <div className="row"><Avatar name={me?.name} dark /><div className="who"><b>{me?.name ?? ''}</b><span style={{ opacity: .8, textTransform: 'capitalize' }}>{me?.role.replace('_', ' ')}</span></div></div>
              <div className="side-actions">
                <button onClick={() => setPw(true)} aria-label="Change password"><Icon name="key" /><span>Password</span></button>
                <button onClick={logout} aria-label="Sign out"><Icon name="logout" /><span>Sign out</span></button>
              </div>
            </div>
          </aside>
          <div className="content">
            <div className="topbar">
              <h1>{current}</h1>
              <div className="tools">{tools}<Bell /></div>
            </div>
            {!connected && <div className="offline" role="status">Live updates disconnected. Reconnecting… (lists refresh automatically when it returns)</div>}
            <main>{me ? children : <Empty>Loading…</Empty>}</main>
          </div>
        </div>
        <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
        {pw && <ChangePassword onClose={() => setPw(false)} />}
      </ToastCtx.Provider>
    </LiveCtx.Provider>
  );
}
