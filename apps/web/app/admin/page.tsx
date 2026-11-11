'use client';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { api, fmt, qs, useFetch, useSession } from '@/lib/api';
import { Badge, Empty, ErrorBox, errText, Field, Icon, Modal, NavItem, Shell, useLive, useToast } from '@/components/ui';
import { Dashboard } from '@/components/dashboard';

interface Named { id: string; name: string; isActive: boolean; location?: string }
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;

/* ============================== Records (FR-23, FR-24, FR-26) ============================== */
interface Rec {
  id: string; referenceNo: string; status: string; source: string; purpose: string | null; areaVisited: string | null; remarks: string | null;
  expectedAt: string | null; timeIn: string | null; timeOut: string | null;
  visitor: { fullName: string; nic: string; phone: string | null; company: string | null; address: string | null };
  guardRoom: { name: string }; passCategory: { name: string } | null; department: { name: string } | null; host: { name: string } | null;
}
function Records() {
  const empty = { from: '', to: '', guardRoomId: '', passCategoryId: '', departmentId: '', status: '', company: '', q: '' };
  const [draft, setDraft] = useState(empty);
  const [applied, setApplied] = useState(empty);
  const [sort, setSort] = useState<{ by: string; order: 'asc' | 'desc' }>({ by: 'timeIn', order: 'desc' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const rooms = useFetch<Named[]>('/guard-rooms'); const passes = useFetch<Named[]>('/pass-categories'); const depts = useFetch<Named[]>('/departments');
  const query = { ...clean(applied), sortBy: sort.by, order: sort.order, page, pageSize: 25 };
  const { data, error, loading, reload } = useFetch<{ items: Rec[]; total: number }>('/records', query);
  useLive('visits:changed', () => void reload());
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 25));
  const th = (key: string, label: string) => (
    <th className="sortable" onClick={() => { setSort({ by: key, order: sort.by === key && sort.order === 'desc' ? 'asc' : 'desc' }); setPage(1); }} aria-sort={sort.by === key ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.by === key ? (sort.order === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const exp = (f: string) => `/api/records/export${qs({ ...clean(applied), sortBy: sort.by, order: sort.order, format: f })}`;
  const sel = (k: keyof typeof empty, label: string, list?: Named[]) => (
    <Field label={label}><select value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}><option value="">All</option>{list?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
  );
  return (
    <>
      <form className="panel" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setPage(1); }}>
        <div className="grid">
          <Field label="From"><input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
          {sel('guardRoomId', 'Guard room', rooms.data ?? undefined)}{sel('passCategoryId', 'Pass type', passes.data ?? undefined)}{sel('departmentId', 'Department', depts.data ?? undefined)}
          <Field label="Status"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}><option value="">All</option>{['expected', 'on_premises', 'checked_out', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></Field>
          <Field label="Company"><input value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} /></Field>
          <Field label="NIC, name or reference"><input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} /></Field>
        </div>
        <div className="row spread filter-actions">
          <div className="row"><button className="btn primary">Search</button><button type="button" className="btn" onClick={() => { setDraft(empty); setApplied(empty); setPage(1); }}>Clear</button></div>
          <div className="row"><a className="btn" href={exp('xlsx')}>⬇ Excel</a><a className="btn" href={exp('pdf')}>⬇ PDF</a></div>
        </div>
      </form>
      <ErrorBox error={error} />
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr>{th('referenceNo', 'Ref')}{th('visitor', 'Visitor')}{th('company', 'Company')}<th>NIC</th>{th('department', 'Department')}{th('guardRoom', 'Guard room')}{th('passCategory', 'Pass')}{th('timeIn', 'Time in')}<th>Time out</th>{th('status', 'Status')}</tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                  <td>{r.referenceNo}</td><td>{r.visitor.fullName}</td><td>{r.visitor.company ?? '–'}</td><td>{r.visitor.nic}</td><td>{r.department?.name ?? '–'}</td>
                  <td>{r.guardRoom.name}</td><td>{r.passCategory?.name ?? '–'}</td><td>{fmt(r.timeIn ?? r.expectedAt)}</td><td>{fmt(r.timeOut)}</td><td><Badge s={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.items.length === 0 && <Empty>No records match these filters.</Empty>}
        <div className="row spread pager" style={{ marginTop: 10 }}>
          <span className="muted">{loading ? 'Loading…' : `${data?.total ?? 0} records`}</span>
          <div className="row"><button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button><span>Page {page} / {pages}</span><button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button></div>
        </div>
      </div>
      {open && <RecordDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
function RecordDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useFetch<Rec>(`/records/${id}`);
  return (
    <Modal title="Visit details" onClose={onClose}>
      <ErrorBox error={error} />
      {data && (
        <div className="slip" style={{ border: 'none', padding: 0 }}>
          <dl>
            <dt>Reference</dt><dd>{data.referenceNo} <Badge s={data.status} /></dd><dt>Visitor</dt><dd>{data.visitor.fullName}</dd>
            <dt>NIC / licence</dt><dd>{data.visitor.nic}</dd><dt>Phone</dt><dd>{data.visitor.phone ?? '–'}</dd><dt>Address</dt><dd>{data.visitor.address ?? '–'}</dd>
            <dt>Company</dt><dd>{data.visitor.company ?? '–'}</dd><dt>Host</dt><dd>{data.host?.name ?? '–'} ({data.department?.name ?? '–'})</dd>
            <dt>Guard room</dt><dd>{data.guardRoom.name}</dd><dt>Pass</dt><dd>{data.passCategory?.name ?? '–'}</dd><dt>Source</dt><dd>{data.source.replace('_', ' ')}</dd>
            <dt>Expected</dt><dd>{fmt(data.expectedAt)}</dd><dt>Time in</dt><dd>{fmt(data.timeIn)}</dd><dt>Time out</dt><dd>{fmt(data.timeOut)}</dd>
            <dt>Area</dt><dd>{data.areaVisited ?? '–'}</dd><dt>Purpose</dt><dd>{data.purpose ?? '–'}</dd><dt>Remarks</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{data.remarks ?? '–'}</dd>
          </dl>
        </div>
      )}
    </Modal>
  );
}

/* ============================== Users (FR-3, FR-5) ============================== */
interface UserRow { id: string; name: string; username: string; email: string | null; phone: string | null; role: string; departmentId: string | null; guardRoomId: string | null; isActive: boolean }
function Users({ isSuper, deptId }: { isSuper: boolean; deptId: string | null }) {
  const toast = useToast();
  const { data, error, reload } = useFetch<UserRow[]>('/users');
  const depts = useFetch<Named[]>('/departments'); const rooms = useFetch<Named[]>('/guard-rooms');
  const [creating, setCreating] = useState(false);
  const [reset, setReset] = useState<UserRow | null>(null);
  const dName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name ?? '–';
  const rName = (id: string | null) => rooms.data?.find((d) => d.id === id)?.name ?? '–';
  return (
    <div className="panel">
      <div className="row spread" style={{ marginBottom: 10 }}><h2>{isSuper ? 'Users' : 'Hosts in my department'}</h2><button className="btn primary" onClick={() => setCreating(true)}>+ Add user</button></div>
      <ErrorBox error={error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Department / Guard room</th><th>Status</th><th /></tr></thead>
        <tbody>{data?.map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.username}</td><td>{u.role.replace('_', ' ')}</td><td>{u.role === 'guard' ? rName(u.guardRoomId) : dName(u.departmentId)}</td>
            <td><Badge s={u.isActive ? 'sent' : 'cancelled'} /></td>
            <td><div className="row">
              <button className="btn small" onClick={async () => { try { await api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } }); void reload(); } catch (x) { toast(errText(x), 'error'); } }}>{u.isActive ? 'Deactivate' : 'Activate'}</button>
              <button className="btn small" onClick={() => setReset(u)}>Reset password</button></div></td></tr>
        ))}</tbody></table></div>
      {creating && <UserForm isSuper={isSuper} deptId={deptId} depts={depts.data ?? []} rooms={rooms.data ?? []} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void reload(); }} />}
      {reset && (
        <Modal title={`Reset password · ${reset.name}`} onClose={() => setReset(null)}>
          <PasswordForm onSubmit={async (pw) => { await api(`/users/${reset.id}`, { method: 'PATCH', body: { password: pw } }); toast('Password reset'); setReset(null); }} />
        </Modal>
      )}
    </div>
  );
}
function PasswordForm({ onSubmit }: { onSubmit: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState<string | null>(null);
  return (
    <form onSubmit={async (e) => { e.preventDefault(); try { await onSubmit(pw); } catch (x) { setErr(errText(x)); } }}>
      <ErrorBox error={err} />
      <Field label="New password" hint="At least 10 characters, with a letter and a digit. Share it with the user securely."><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} /></Field>
      <button className="btn primary">Set password</button>
    </form>
  );
}
function UserForm({ isSuper, deptId, depts, rooms, onClose, onDone }: { isSuper: boolean; deptId: string | null; depts: Named[]; rooms: Named[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', username: '', email: '', phone: '', role: isSuper ? 'host' : 'host', departmentId: deptId ?? '', guardRoomId: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: clean({ ...f, departmentId: f.role === 'guard' || f.role === 'super_admin' ? '' : f.departmentId, guardRoomId: f.role === 'guard' ? f.guardRoomId : '' }) });
      toast('User created'); onDone();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <Modal title="Add user" onClose={onClose}>
      <ErrorBox error={err} />
      <form onSubmit={submit}>
        <Field label="Full name"><input value={f.name} onChange={set('name')} required /></Field>
        <Field label="Username (login)" hint="3-32 characters: letters, digits, dot, dash or underscore"><input value={f.username} onChange={set('username')} required minLength={3} maxLength={32} autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" /></Field>
        <Field label="Email (optional)" hint="Only used for email alerts"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile (for SMS alerts)"><input inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        {isSuper && <Field label="Role"><select value={f.role} onChange={set('role')}><option value="host">Host (department user)</option><option value="dept_admin">Department administrator</option><option value="guard">Security guard</option><option value="super_admin">Super administrator</option></select></Field>}
        {(f.role === 'host' || f.role === 'dept_admin') && <Field label="Department"><select value={f.departmentId} onChange={set('departmentId')} required disabled={!isSuper}><option value="">Select…</option>{depts.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        {f.role === 'guard' && <Field label="Guard room"><select value={f.guardRoomId} onChange={set('guardRoomId')} required><option value="">Select…</option>{rooms.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
        <Field label="Initial password" hint="At least 10 characters, with a letter and a digit"><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={10} /></Field>
        <button className="btn primary">Create user</button>
      </form>
    </Modal>
  );
}

/* ============================== Master data (FR-2, FR-4, FR-6) ============================== */
function Master({ path, title, withLocation }: { path: string; title: string; withLocation?: boolean }) {
  const toast = useToast();
  const { data, error, reload } = useFetch<Named[]>(path);
  const [edit, setEdit] = useState<Partial<Named> | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = clean({ name: edit!.name, location: withLocation ? edit!.location : undefined });
      if (edit!.id) await api(`${path}/${edit!.id}`, { method: 'PATCH', body }); else await api(path, { method: 'POST', body });
      setEdit(null); void reload();
    } catch (x) { toast(errText(x), 'error'); }
  };
  return (
    <div className="panel">
      <div className="row spread" style={{ marginBottom: 10 }}><h2>{title}</h2><button className="btn primary" onClick={() => setEdit({ name: '', location: '' })}>+ Add</button></div>
      <ErrorBox error={error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th>{withLocation && <th>Location</th>}<th>Status</th><th /></tr></thead>
        <tbody>{data?.map((x) => (
          <tr key={x.id}><td>{x.name}</td>{withLocation && <td>{x.location}</td>}<td><Badge s={x.isActive ? 'sent' : 'cancelled'} /></td>
            <td><div className="row"><button className="btn small" onClick={() => setEdit(x)}>Edit</button>
              <button className="btn small" onClick={async () => { try { await api(`${path}/${x.id}`, { method: 'PATCH', body: { isActive: !x.isActive } }); void reload(); } catch (e) { toast(errText(e), 'error'); } }}>{x.isActive ? 'Deactivate' : 'Activate'}</button></div></td></tr>
        ))}</tbody></table></div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : `Add to ${title}`} onClose={() => setEdit(null)}>
          <form onSubmit={save}>
            <Field label="Name"><input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required minLength={2} /></Field>
            {withLocation && <Field label="Location"><input value={edit.location ?? ''} onChange={(e) => setEdit({ ...edit, location: e.target.value })} required minLength={2} /></Field>}
            <button className="btn primary">Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

/* ============================== Blacklist + approvals (FR-29) ============================== */
interface Req { id: string; guardRoomId: string; remark: string; status: string; createdAt: string; decisionNote: string | null }
function Blacklist({ onPending }: { onPending: (n: number) => void }) {
  const toast = useToast();
  const list = useFetch<{ id: string; nicMasked: string; reason: string; createdAt: string }[]>('/blacklist');
  const reqs = useFetch<Req[]>('/blacklist/overrides/requests');
  const rooms = useFetch<Named[]>('/guard-rooms');
  const [f, setF] = useState({ nic: '', reason: '' });
  const [decide, setDecide] = useState<Req | null>(null);
  const [note, setNote] = useState('');
  useLive('overrides:changed', () => void reqs.reload());
  useLive('connect', () => void reqs.reload());
  const pending = reqs.data?.filter((r) => r.status === 'pending') ?? [];
  useEffect(() => onPending(pending.length), [pending.length, onPending]);
  const act = async (approve: boolean) => {
    try { await api(`/blacklist/overrides/${decide!.id}/decision`, { method: 'POST', body: clean({ approve, note }) }); setDecide(null); setNote(''); void reqs.reload(); } catch (x) { toast(errText(x), 'error'); }
  };
  return (
    <>
      <div className="panel">
        <h2 style={{ marginBottom: 10 }}>Approval requests {pending.length > 0 && <b className="count">{pending.length}</b>}</h2>
        <ErrorBox error={reqs.error} />
        {!reqs.data?.length && <Empty>No requests.</Empty>}
        <div className="table-wrap"><table><tbody>{reqs.data?.slice(0, 30).map((r) => (
          <tr key={r.id}><td>{fmt(r.createdAt)}</td><td>{rooms.data?.find((x) => x.id === r.guardRoomId)?.name}</td><td>{r.remark}</td><td><Badge s={r.status} />{r.decisionNote && <div className="muted">{r.decisionNote}</div>}</td>
            <td>{r.status === 'pending' && <button className="btn small primary" onClick={() => setDecide(r)}>Review</button>}</td></tr>))}</tbody></table></div>
      </div>
      <div className="panel">
        <h2 style={{ marginBottom: 10 }}>Watch list</h2>
        <form className="grid" onSubmit={async (e) => { e.preventDefault(); try { await api('/blacklist', { method: 'POST', body: f }); setF({ nic: '', reason: '' }); void list.reload(); } catch (x) { toast(errText(x), 'error'); } }}>
          <Field label="NIC / licence no."><input value={f.nic} onChange={(e) => setF({ ...f, nic: e.target.value })} required /></Field>
          <Field label="Reason"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} /></Field>
          <div className="form-action"><button className="btn primary">Add to watch list</button></div>
        </form>
        <ErrorBox error={list.error} />
        <div className="table-wrap"><table><thead><tr><th>NIC (masked)</th><th>Reason</th><th>Added</th><th /></tr></thead><tbody>{list.data?.map((b) => (
          <tr key={b.id}><td>{b.nicMasked || '–'}</td><td>{b.reason}</td><td>{fmt(b.createdAt)}</td>
            <td><button className="btn small danger" onClick={async () => { if (window.confirm('Remove from the watch list?')) { await api(`/blacklist/${b.id}`, { method: 'DELETE' }); void list.reload(); } }}>Remove</button></td></tr>))}</tbody></table></div>
      </div>
      {decide && (
        <Modal title="Approve entry for a watch-listed visitor?" onClose={() => setDecide(null)}>
          <p><strong>Guard's reason:</strong> {decide.remark}</p>
          <p className="muted">Approval is single-use and only valid at the requesting guard room.</p>
          <Field label="Note to the guard (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row"><button className="btn primary" onClick={() => act(true)}>Approve once</button><button className="btn danger" onClick={() => act(false)}>Reject</button></div>
        </Modal>
      )}
    </>
  );
}

/* ============================== Failed notifications, audit ============================== */
function Failed() {
  const toast = useToast();
  const { data, error, reload } = useFetch<{ id: string; channel: string; event: string; attempts: number; lastError: string | null; createdAt: string }[]>('/notifications/failed');
  return (
    <div className="panel"><h2 style={{ marginBottom: 10 }}>Failed SMS / e-mail</h2>
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty>No failed deliveries 🎉</Empty>}
      <div className="table-wrap"><table><tbody>{data?.map((n) => (
        <tr key={n.id}><td>{fmt(n.createdAt)}</td><td>{n.channel}</td><td>{n.event.replace(/_/g, ' ')}</td><td>{n.attempts} attempts</td><td className="muted">{n.lastError}</td>
          <td><button className="btn small" onClick={async () => { try { await api(`/notifications/${n.id}/retry`, { method: 'POST' }); toast('Queued for retry'); void reload(); } catch (x) { toast(errText(x), 'error'); } }}>Retry</button></td></tr>))}</tbody></table></div>
    </div>
  );
}
function Audit() {
  const [f, setF] = useState({ entity: '', action: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const { data, error } = useFetch<{ total: number; items: { id: string; action: string; entity: string; entityId: string | null; userName: string | null; createdAt: string; afterJson: unknown }[] }>('/audit', { ...clean(applied), page, pageSize: 50 });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 50));
  return (
    <div className="panel"><h2 style={{ marginBottom: 10 }}>Audit trail</h2>
      <form className="grid" onSubmit={(e) => { e.preventDefault(); setApplied(f); setPage(1); }}>
        <Field label="Entity"><input value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} placeholder="visit, user, blacklist…" /></Field>
        <Field label="Action"><input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="check_in, create…" /></Field>
        <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <div className="form-action"><button className="btn primary">Filter</button></div>
      </form>
      <ErrorBox error={error} />
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
        <tbody>{data?.items.map((a) => (
          <tr key={a.id}><td>{fmt(a.createdAt)}</td><td>{a.userName ?? '–'}</td><td>{a.action}</td><td>{a.entity}</td>
            <td className="muted" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.afterJson ? JSON.stringify(a.afterJson).slice(0, 160) : ''}</td></tr>))}</tbody></table></div>
      <div className="row spread pager" style={{ marginTop: 10 }}><span className="muted">{data?.total ?? 0} entries</span>
        <div className="row"><button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button><span>Page {page} / {pages}</span><button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button></div></div>
    </div>
  );
}

/* ============================== Page ============================== */
type TabId = 'dash' | 'records' | 'users' | 'depts' | 'rooms' | 'passes' | 'blacklist' | 'failed' | 'audit';
export default function AdminPortal() {
  const me = useSession(['super_admin', 'dept_admin']);
  const isSuper = me?.role === 'super_admin';
  const [tab, setTab] = useState<TabId>('dash');
  const [pending, setPending] = useState(0);
  const rooms = useFetch<Named[]>(me ? '/guard-rooms' : null);
  const { data: pend, reload } = useFetch<Req[]>(isSuper ? '/blacklist/overrides/requests' : null, { status: 'pending' });
  useLive('overrides:changed', () => void reload());
  useEffect(() => { if (pend) setPending(pend.length); }, [pend]);
  const nav: NavItem<TabId>[] = [
    { id: 'dash', label: 'Dashboard', icon: 'home' },
    { id: 'records', label: 'Visitor records', icon: 'users' },
    { id: 'users', label: isSuper ? 'Users' : 'My hosts', icon: 'userPlus' },
    ...(isSuper ? ([
      { id: 'depts', label: 'Departments', icon: 'building' },
      { id: 'rooms', label: 'Guard rooms', icon: 'pin' },
      { id: 'passes', label: 'Pass categories', icon: 'tag' },
      { id: 'blacklist', label: 'Watch list', icon: 'shield', badge: pending },
      { id: 'failed', label: 'Failed alerts', icon: 'alert' },
      { id: 'audit', label: 'Audit trail', icon: 'list' },
    ] as NavItem<TabId>[]) : []),
  ];
  const body: Record<TabId, ReactNode> = {
    dash: <Dashboard rooms={(rooms.data ?? []).filter((r) => r.isActive)} onViewAll={() => setTab('records')} />,
    records: <Records />, users: <Users isSuper={!!isSuper} deptId={me?.departmentId ?? null} />,
    depts: <Master path="/departments" title="Departments" />, rooms: <Master path="/guard-rooms" title="Guard rooms" withLocation />, passes: <Master path="/pass-categories" title="Pass categories" />,
    blacklist: <Blacklist onPending={setPending} />, failed: <Failed />, audit: <Audit />,
  };
  return (
    <Shell me={me} title={isSuper ? 'Administration' : 'Department administration'} nav={nav} active={tab} onNav={setTab}>
      {body[tab]}
    </Shell>
  );
}
