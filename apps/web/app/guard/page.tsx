'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, fmt, fmtTime, useFetch, useSession } from '@/lib/api';
import { Avatar, Badge, Empty, ErrorBox, errText, Field, Icon, Modal, Shell, useLive, useToast } from '@/components/ui';

interface Visit {
  id: string; referenceNo: string; status: string; source: string; purpose: string | null; areaVisited: string | null; remarks: string | null;
  expectedAt: string | null; timeIn: string | null; timeOut: string | null;
  visitor: { fullName: string; nic: string; phone: string | null; company: string | null; address: string | null };
  passCategory: { id: string; name: string } | null; department: { id: string; name: string } | null; host: { id: string; name: string } | null;
}
interface Named { id: string; name: string; isActive: boolean }
interface Override { id: string; status: 'pending' | 'approved' | 'rejected' | 'used'; decisionNote: string | null }

/** Drop empty strings so optional fields are simply "not sent". */
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
const isBlacklistError = (e: unknown) => e instanceof ApiError && e.status === 403 && /blacklist/i.test(e.message);

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** UC-4: a blacklisted visitor needs a single-use administrator approval before the guard can proceed. */
function OverrideBox({ nic, visitId, onApproved }: { nic: string; visitId?: string; onApproved: (id: string) => void }) {
  const [remark, setRemark] = useState('');
  const [req, setReq] = useState<Override | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = async (id: string) => {
    const r = await api<Override>(`/guard/overrides/${id}`);
    setReq(r);
    if (r.status === 'approved') onApproved(r.id);
  };
  useLive('overrides:changed', () => req && void check(req.id).catch(() => undefined));
  useEffect(() => {
    if (!req || req.status !== 'pending') return;
    const t = setInterval(() => void check(req.id).catch(() => undefined), 8000); // fallback if the socket is down
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.id, req?.status]);

  return (
    <div className="alert warn" role="alert">
      <strong>⚠ This visitor is on the watch list. Administrator approval is required.</strong>
      <ErrorBox error={err} />
      {!req && (
        <form onSubmit={async (e) => {
          e.preventDefault();
          try { setReq(await api<Override>('/guard/overrides', { method: 'POST', body: clean({ nic, remark, visitId }) })); } catch (x) { setErr(errText(x)); }
        }}>
          <Field label="Reason for requesting approval"><textarea value={remark} onChange={(e) => setRemark(e.target.value)} required minLength={3} /></Field>
          <button className="btn primary">Request approval</button>
        </form>
      )}
      {req?.status === 'pending' && <p>⏳ Waiting for an administrator to decide… (updates automatically)</p>}
      {req?.status === 'approved' && <p>✅ Approved. Continue with the check-in below.</p>}
      {req?.status === 'rejected' && <p>⛔ Rejected{req.decisionNote ? `: ${req.decisionNote}` : ''}. Do not admit this visitor.</p>}
    </div>
  );
}

function SlipModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useFetch<{ referenceNo: string; visitorName: string; company: string | null; passCategory: string | null; host: string | null; department: string | null; areaVisited: string | null; guardRoom: string; timeIn: string }>(`/guard/visits/${id}/slip`);
  return (
    <Modal title="Visitor pass" onClose={onClose}>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="slip">
            <h3>VISITOR PASS</h3>
            <dl>
              <dt>Ref</dt><dd><strong>{data.referenceNo}</strong></dd><dt>Name</dt><dd>{data.visitorName}</dd>
              {data.company && <><dt>Company</dt><dd>{data.company}</dd></>}
              <dt>Pass</dt><dd>{data.passCategory ?? '–'}</dd><dt>Host</dt><dd>{data.host ?? data.department ?? '–'}</dd>
              <dt>Area</dt><dd>{data.areaVisited ?? '–'}</dd><dt>Gate</dt><dd>{data.guardRoom}</dd><dt>Time in</dt><dd>{fmt(data.timeIn)}</dd>
            </dl>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary big" onClick={() => window.print()}>🖨 Print pass</button><button className="btn" onClick={onClose}>Done</button></div>
        </>
      )}
    </Modal>
  );
}

function CheckInModal({ visit, passes, onClose, onDone }: { visit: Visit; passes: Named[]; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const { data: full, error: loadErr } = useFetch<Visit>(`/guard/visits/${visit.id}`); // the full NIC is only on the single-record view
  const [f, setF] = useState({ fullName: '', nic: '', address: '', phone: '', company: '', passCategoryId: '', areaVisited: '', remarks: '' });
  const [blocked, setBlocked] = useState(false);
  const [overrideId, setOverrideId] = useState<string>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (full) setF((p) => ({ ...p, fullName: full.visitor.fullName, nic: full.visitor.nic, address: full.visitor.address ?? '', phone: full.visitor.phone ?? '', company: full.visitor.company ?? '', areaVisited: full.areaVisited ?? '', remarks: full.remarks ?? '', passCategoryId: full.passCategory?.id ?? '' }));
  }, [full]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return; // guard against double taps
    setBusy(true); setErr(null);
    try {
      await api(`/guard/visits/${visit.id}/check-in`, { method: 'POST', body: clean({ ...f, overrideId }) });
      toast(`${f.fullName} checked in`);
      onDone(visit.id);
    } catch (x) {
      if (isBlacklistError(x)) setBlocked(true); else setErr(errText(x));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Check in · ${visit.referenceNo}`} onClose={onClose} wide>
      <ErrorBox error={loadErr ?? err} />
      {blocked && !overrideId && <OverrideBox nic={f.nic} visitId={visit.id} onApproved={setOverrideId} />}
      {full && (
        <form onSubmit={submit}>
          <p className="muted">Verify the visitor's ID document, then correct anything that differs.</p>
          <div className="grid">
            <Field label="Full name"><input value={f.fullName} onChange={set('fullName')} required /></Field>
            <Field label="NIC / licence no."><input value={f.nic} onChange={set('nic')} required /></Field>
            <Field label="Contact number"><input inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
            <Field label="Company"><input value={f.company} onChange={set('company')} /></Field>
            <Field label="Address"><input value={f.address} onChange={set('address')} /></Field>
            <Field label="Area to visit"><input value={f.areaVisited} onChange={set('areaVisited')} /></Field>
            <Field label="Pass category *">
              <select value={f.passCategoryId} onChange={set('passCategoryId')} required>
                <option value="">Select…</option>{passes.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Remarks"><textarea value={f.remarks} onChange={set('remarks')} /></Field>
          <p className="muted">Host: {full.host?.name ?? full.department?.name ?? '–'} · Purpose: {full.purpose ?? '–'}</p>
          <button className="btn primary big" disabled={busy || (blocked && !overrideId)}>{busy ? 'Checking in…' : '✔ Confirm check-in'}</button>
        </form>
      )}
    </Modal>
  );
}

function WalkIn({ passes, onDone }: { passes: Named[]; onDone: (id: string) => void }) {
  const toast = useToast();
  const { data: depts } = useFetch<Named[]>('/departments');
  const [f, setF] = useState({ nic: '', fullName: '', address: '', phone: '', company: '', hostDepartmentId: '', hostUserId: '', passCategoryId: '', areaVisited: '', purpose: '', remarks: '' });
  const { data: hosts } = useFetch<{ id: string; name: string }[]>(f.hostDepartmentId ? '/guard/hosts' : null, { departmentId: f.hostDepartmentId });
  const [listed, setListed] = useState(false);
  const [known, setKnown] = useState(false);
  const [overrideId, setOverrideId] = useState<string>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const lookup = async () => {
    if (!f.nic.trim()) return;
    try {
      const r = await api<{ found: boolean; blacklisted: boolean; visitor: { fullName: string; address: string | null; phone: string | null; company: string | null } | null }>('/guard/lookup', { query: { nic: f.nic } });
      setListed(r.blacklisted); setKnown(r.found); setErr(null);
      if (r.visitor) setF((p) => ({ ...p, fullName: r.visitor!.fullName, address: r.visitor!.address ?? '', phone: r.visitor!.phone ?? '', company: r.visitor!.company ?? '' }));
    } catch (x) { setErr(errText(x)); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const v = await api<Visit>('/guard/walk-ins', { method: 'POST', body: clean({ ...f, overrideId }) });
      toast(`${v.visitor.fullName} registered (${v.referenceNo})`);
      onDone(v.id);
    } catch (x) {
      if (isBlacklistError(x)) setListed(true); else setErr(errText(x));
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2 style={{ marginBottom: 12 }}>Walk-in visitor</h2>
      <ErrorBox error={err} />
      {listed && !overrideId && <OverrideBox nic={f.nic} onApproved={setOverrideId} />}
      <div className="grid">
        <Field label="NIC / licence no. *" hint={known ? 'Returning visitor: details filled in, please verify' : 'Press Tab to look up'}><input value={f.nic} onChange={set('nic')} onBlur={lookup} required /></Field>
        <Field label="Full name *"><input value={f.fullName} onChange={set('fullName')} required /></Field>
        <Field label="Contact number"><input inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Company"><input value={f.company} onChange={set('company')} /></Field>
        <Field label="Address"><input value={f.address} onChange={set('address')} /></Field>
        <Field label="Host department *">
          <select value={f.hostDepartmentId} onChange={(e) => setF({ ...f, hostDepartmentId: e.target.value, hostUserId: '' })} required>
            <option value="">Select…</option>{depts?.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Host person" hint="Leave blank if unknown">
          <select value={f.hostUserId} onChange={set('hostUserId')} disabled={!f.hostDepartmentId}>
            <option value="">Not known</option>{hosts?.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
        <Field label="Pass category *">
          <select value={f.passCategoryId} onChange={set('passCategoryId')} required>
            <option value="">Select…</option>{passes.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Area to visit"><input value={f.areaVisited} onChange={set('areaVisited')} /></Field>
        <Field label="Purpose"><input value={f.purpose} onChange={set('purpose')} /></Field>
      </div>
      <Field label="Remarks"><textarea value={f.remarks} onChange={set('remarks')} /></Field>
      <button className="btn primary big" disabled={busy || (listed && !overrideId)}>{busy ? 'Registering…' : '✔ Register and check in'}</button>
    </form>
  );
}

export default function GuardConsole() {
  const me = useSession(['guard']);
  const [tab, setTab] = useState<'expected' | 'premises' | 'walkin' | 'exits'>('expected');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const expected = useFetch<Visit[]>(me ? '/guard/expected' : null, { q: dq });
  const premises = useFetch<Visit[]>(me ? '/guard/on-premises' : null, { q: dq });
  const { data: passes } = useFetch<Named[]>(me ? '/pass-categories' : null);
  const [checkIn, setCheckIn] = useState<Visit | null>(null);
  const [checkOut, setCheckOut] = useState<Visit | null>(null);
  const [slip, setSlip] = useState<string | null>(null);

  const refresh = () => { void expected.reload(); void premises.reload(); };
  useLive('visits:changed', refresh);
  useLive('connect', refresh);

  const done = (id: string) => { setCheckIn(null); setSlip(id); setTab('premises'); refresh(); };

  return (
    <Shell me={me} title="Guard console" active={tab} onNav={setTab} nav={[
      { id: 'expected', label: 'Expected today', icon: 'clipboard', badge: expected.data?.length },
      { id: 'premises', label: 'On premises', icon: 'users', badge: premises.data?.length },
      { id: 'walkin', label: 'Walk-in', icon: 'userPlus' },
      { id: 'exits', label: 'My check-outs', icon: 'logout' },
    ]}>
      {(tab === 'expected' || tab === 'premises') && (
        <div className="searchbar">
          <Icon name="search" />
          <input placeholder="Search NIC, name, phone or reference…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search visitors" />
          <button className="btn primary" onClick={refresh} aria-label="Refresh lists">Refresh</button>
        </div>
      )}
      {tab === 'expected' && (
        <>
          <ErrorBox error={expected.error} />
          {expected.data?.length === 0 && <Empty>{dq ? 'No expected visitor matches.' : 'No visitors expected today.'}</Empty>}
          <div className="cards">
            {expected.data?.map((v) => (
              <button key={v.id} className="vcard" onClick={() => setCheckIn(v)}>
                <div className="top"><Avatar name={v.visitor.fullName} /><h3>{v.visitor.fullName}</h3><Badge s={v.status} /></div>
                <div>{v.visitor.company ?? 'No company'}</div>
                <div className="meta">{v.visitor.nic} · {v.referenceNo}</div>
                <div className="meta">Expected {fmtTime(v.expectedAt)} · Host {v.host?.name ?? '–'} ({v.department?.name ?? '–'})</div>
                {v.areaVisited && <div className="meta">→ {v.areaVisited}</div>}
              </button>
            ))}
          </div>
          {dq && !expected.data?.length && <p className="muted">Not on the list? Use <button className="link" onClick={() => setTab('walkin')}>+ Walk-in</button>.</p>}
        </>
      )}
      {tab === 'premises' && (
        <>
          <ErrorBox error={premises.error} />
          {premises.data?.length === 0 && <Empty>Nobody is on premises at this gate.</Empty>}
          <div className="cards">
            {premises.data?.map((v) => (
              <div key={v.id} className="vcard" style={{ cursor: 'default' }}>
                <div className="top"><Avatar name={v.visitor.fullName} /><h3>{v.visitor.fullName}</h3><Badge s="on_premises" /></div>
                <div>{v.visitor.company ?? 'No company'} · {v.passCategory?.name ?? 'No pass'}</div>
                <div className="meta">In {fmtTime(v.timeIn)} · {v.referenceNo}</div>
                <div className="meta">Host {v.host?.name ?? v.department?.name ?? '–'}</div>
                <div className="row"><button className="btn primary" onClick={() => setCheckOut(v)}><Icon name="logout" />Check out</button><button className="btn" onClick={() => setSlip(v.id)}><Icon name="doc" />Pass slip</button></div>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'exits' && <MyExits />}
      {tab === 'walkin' && <WalkIn passes={passes ?? []} onDone={done} />}

      {checkIn && <CheckInModal visit={checkIn} passes={passes ?? []} onClose={() => setCheckIn(null)} onDone={done} />}
      {checkOut && <CheckOutModal visit={checkOut} onClose={() => setCheckOut(null)} onDone={() => { setCheckOut(null); refresh(); }} />}
      {slip && <SlipModal id={slip} onClose={() => setSlip(null)} />}
    </Shell>
  );
}

function CheckOutModal({ visit, onClose, onDone }: { visit: Visit; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Check out · ${visit.visitor.fullName}`} onClose={onClose}>
      <ErrorBox error={err} />
      <p className="muted">In since {fmt(visit.timeIn)}</p>
      <Field label="Remarks (optional)"><textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
      <button className="btn primary big" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ durationMinutes: number }>(`/guard/visits/${visit.id}/check-out`, { method: 'POST', body: clean({ remarks }) });
          toast(`${visit.visitor.fullName} checked out (${r.durationMinutes} min)`);
          onDone();
        } catch (x) { setErr(errText(x)); setBusy(false); }
      }}>Confirm check-out</button>
    </Modal>
  );
}

interface ExitSummary {
  date: string; total: number; avgMinutes: number; firstExit: string | null; lastExit: string | null;
  exits: (Visit & { durationMinutes: number })[];
}
const colomboToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** The signed-in guard's own exits for a day: who they checked out and when. Other guards' exits never appear. */
function MyExits() {
  const [date, setDate] = useState(colomboToday());
  const { data, error, reload } = useFetch<ExitSummary>('/guard/my-exits', { date });
  useLive('visits:changed', () => void reload());
  return (
    <>
      <div className="searchbar">
        <label className="muted" htmlFor="exit-date">Date</label>
        <input id="exit-date" type="date" value={date} max={colomboToday()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn primary" onClick={() => void reload()}>Refresh</button>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="kpis">
            <div className="kpi"><div><small>Checked out by me</small><b>{data.total}</b></div></div>
            <div className="kpi"><div><small>Average stay</small><b>{data.avgMinutes} min</b></div></div>
            <div className="kpi"><div><small>First exit</small><b>{data.firstExit ? fmtTime(data.firstExit) : '–'}</b></div></div>
            <div className="kpi"><div><small>Last exit</small><b>{data.lastExit ? fmtTime(data.lastExit) : '–'}</b></div></div>
          </div>
          {data.exits.length === 0 ? <Empty>You have not checked anyone out on this day.</Empty> : (
            <div className="panel"><div className="table-wrap"><table>
              <thead><tr><th>Time out</th><th>Visitor</th><th>Company</th><th>Time in</th><th>Stay</th><th>Ref</th></tr></thead>
              <tbody>{data.exits.map((v) => (
                <tr key={v.id}><td>{fmtTime(v.timeOut)}</td><td>{v.visitor.fullName}</td><td>{v.visitor.company ?? '–'}</td><td>{fmtTime(v.timeIn)}</td><td>{v.durationMinutes} min</td><td>{v.referenceNo}</td></tr>
              ))}</tbody></table></div></div>
          )}
        </>
      )}
    </>
  );
}
