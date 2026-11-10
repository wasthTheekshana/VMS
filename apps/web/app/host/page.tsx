'use client';
import { FormEvent, useState } from 'react';
import { api, fmt, fromLocalInput, toLocalInput, useFetch, useSession } from '@/lib/api';
import { Avatar, Badge, Empty, ErrorBox, errText, Field, Modal, Shell, useLive, useToast } from '@/components/ui';

interface Visit {
  id: string; referenceNo: string; status: string; purpose: string | null; areaVisited: string | null; expectedAt: string | null; timeIn: string | null; timeOut: string | null;
  groupId: string | null; blacklisted?: boolean;
  visitor: { fullName: string; nic: string; phone: string | null; company: string | null };
  guardRoom: { id: string; name: string };
}
interface Room { id: string; name: string; location: string; isActive: boolean }
interface Person { fullName: string; nic: string; phone: string; company: string }
const blank = (): Person => ({ fullName: '', nic: '', phone: '', company: '' });
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '')) as Partial<T>;

function PreRegister({ rooms, onDone }: { rooms: Room[]; onDone: () => void }) {
  const toast = useToast();
  const [people, setPeople] = useState<Person[]>([blank()]);
  const [f, setF] = useState({ purpose: '', areaVisited: '', guardRoomId: '', expectedAt: toLocalInput() });
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const setP = (i: number, k: keyof Person, v: string) => setPeople(people.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ visits: Visit[] }>('/visits', {
        method: 'POST',
        body: { visitors: people.map((p) => clean({ ...p })), purpose: f.purpose, areaVisited: f.areaVisited, guardRoomId: f.guardRoomId, expectedAt: fromLocalInput(f.expectedAt) },
      });
      const flagged = r.visits.filter((v) => v.blacklisted).map((v) => v.visitor.fullName);
      toast(`Registered: ${r.visits.map((v) => v.referenceNo).join(', ')}. The visitor${r.visits.length > 1 ? 's are' : ' is'} being notified by SMS.`);
      if (flagged.length) { setWarn(flagged); setBusy(false); setPeople([blank()]); onDone(); return; }
      onDone();
    } catch (x) { setErr(errText(x)); setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2 style={{ marginBottom: 12 }}>Pre-register expected visitors</h2>
      <ErrorBox error={err} />
      {warn.length > 0 && <div className="alert warn" role="alert">⚠ On the watch list: {warn.join(', ')}. Administrators have been informed; the guard will need approval at the gate.</div>}
      {people.map((p, i) => (
        <fieldset key={i} style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 12 }}>
          <legend>Visitor {i + 1}</legend>
          <div className="grid">
            <Field label="Full name *"><input value={p.fullName} onChange={(e) => setP(i, 'fullName', e.target.value)} required /></Field>
            <Field label="NIC / licence no. *" hint="e.g. 199512345678, 951234567V, B1234567"><input value={p.nic} onChange={(e) => setP(i, 'nic', e.target.value)} required /></Field>
            <Field label="Mobile number" hint="For the SMS with the reference number"><input inputMode="tel" value={p.phone} onChange={(e) => setP(i, 'phone', e.target.value)} /></Field>
            <Field label="Company"><input value={p.company} onChange={(e) => setP(i, 'company', e.target.value)} /></Field>
          </div>
          {people.length > 1 && <button type="button" className="btn small danger" onClick={() => setPeople(people.filter((_, j) => j !== i))}>Remove</button>}
        </fieldset>
      ))}
      <button type="button" className="btn" onClick={() => setPeople([...people, blank()])} disabled={people.length >= 50}>+ Add another visitor (group)</button>
      <div className="grid" style={{ marginTop: 14 }}>
        <Field label="Expected date and time *"><input type="datetime-local" value={f.expectedAt} onChange={(e) => setF({ ...f, expectedAt: e.target.value })} required /></Field>
        <Field label="Guard room they will arrive at *">
          <select value={f.guardRoomId} onChange={(e) => setF({ ...f, guardRoomId: e.target.value })} required>
            <option value="">Select…</option>{rooms.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name} — {r.location}</option>)}
          </select>
        </Field>
        <Field label="Area to be visited *"><input value={f.areaVisited} onChange={(e) => setF({ ...f, areaVisited: e.target.value })} required /></Field>
      </div>
      <Field label="Purpose of visit *"><textarea value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} required /></Field>
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Pre-register'}</button>
    </form>
  );
}

function EditModal({ v, rooms, onClose, onDone }: { v: Visit; rooms: Room[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ purpose: v.purpose ?? '', areaVisited: v.areaVisited ?? '', guardRoomId: v.guardRoom.id, expectedAt: toLocalInput(v.expectedAt ? new Date(v.expectedAt) : new Date()) });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={`Edit ${v.referenceNo}`} onClose={onClose}>
      <ErrorBox error={err} />
      <form onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(`/visits/${v.id}`, { method: 'PATCH', body: { ...f, expectedAt: fromLocalInput(f.expectedAt) } });
          toast('Pre-registration updated'); onDone();
        } catch (x) { setErr(errText(x)); }
      }}>
        <Field label="Expected date and time"><input type="datetime-local" value={f.expectedAt} onChange={(e) => setF({ ...f, expectedAt: e.target.value })} required /></Field>
        <Field label="Guard room"><select value={f.guardRoomId} onChange={(e) => setF({ ...f, guardRoomId: e.target.value })}>{rooms.filter((r) => r.isActive || r.id === v.guardRoom.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Area to be visited"><input value={f.areaVisited} onChange={(e) => setF({ ...f, areaVisited: e.target.value })} required /></Field>
        <Field label="Purpose"><textarea value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} required /></Field>
        <button className="btn primary">Save changes</button>
      </form>
    </Modal>
  );
}

export default function HostPortal() {
  const me = useSession(['host', 'dept_admin']);
  const [tab, setTab] = useState<'mine' | 'new'>('mine');
  const mine = useFetch<Visit[]>(me ? '/visits/mine' : null);
  const rooms = useFetch<Room[]>(me ? '/guard-rooms' : null);
  const [edit, setEdit] = useState<Visit | null>(null);
  useLive('visits:changed', () => void mine.reload());
  useLive('connect', () => void mine.reload());

  const cancel = async (v: Visit) => {
    if (!window.confirm(`Cancel the visit for ${v.visitor.fullName}? The guard room and the visitor will be told.`)) return;
    try { await api(`/visits/${v.id}/cancel`, { method: 'POST' }); void mine.reload(); } catch (x) { window.alert(errText(x)); }
  };

  return (
    <Shell me={me} title="Host portal" active={tab} onNav={setTab} nav={[
      { id: 'mine', label: 'My visitors', icon: 'users', badge: mine.data?.filter((v) => v.status === 'on_premises').length },
      { id: 'new', label: 'Pre-register', icon: 'userPlus' },
    ]}>
      {tab === 'new' && <PreRegister rooms={rooms.data ?? []} onDone={() => { void mine.reload(); setTab('mine'); }} />}
      {tab === 'mine' && (
        <div className="panel">
          <ErrorBox error={mine.error} />
          {mine.data?.length === 0 && <Empty>No visitors yet. Use “Pre-register” to add one.</Empty>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Visitor</th><th>Company</th><th>Ref</th><th>Expected</th><th>Guard room</th><th>In</th><th>Out</th><th>Status</th><th /></tr></thead>
              <tbody>
                {mine.data?.map((v) => (
                  <tr key={v.id}>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><Avatar name={v.visitor.fullName} small /><div><strong>{v.visitor.fullName}</strong><div className="muted">{v.visitor.nic}</div></div></div></td>
                    <td>{v.visitor.company ?? '–'}</td><td>{v.referenceNo}</td><td>{fmt(v.expectedAt)}</td><td>{v.guardRoom.name}</td>
                    <td>{fmt(v.timeIn)}</td><td>{fmt(v.timeOut)}</td><td><Badge s={v.status} /></td>
                    <td>{v.status === 'expected' && <div className="row"><button className="btn small" onClick={() => setEdit(v)}>Edit</button><button className="btn small danger" onClick={() => cancel(v)}>Cancel</button></div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && <EditModal v={edit} rooms={rooms.data ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void mine.reload(); }} />}
    </Shell>
  );
}
