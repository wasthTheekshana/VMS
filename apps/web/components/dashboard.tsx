'use client';
import { useId, useState } from 'react';
import { fmtTime, qs, useFetch } from '@/lib/api';
import { Avatar, Empty, ErrorBox, Icon, IconName, useLive } from '@/components/ui';

interface Dash {
  kpis: {
    visitors: { value: number; previous: number }; checkedIn: number;
    checkedOut: { value: number; previous: number }; preRegistrations: { value: number; previous: number };
  };
  byPurpose: { label: string; count: number }[];
  recent: { id: string; fullName: string; status: string; timeIn: string | null; guardRoom: string; pass: string | null }[];
  onPremises: { total: number };
  today: { expected: number; arrived: number; walkIns: number };
  checkInsByGuardRoom: { id: string; name: string; count: number }[];
  byPassCategory: { name: string; count: number }[]; byDepartment: { name: string; count: number }[]; topCompanies: { company: string; count: number }[];
  hourly: { hour: number; count: number }[]; trend: { bucket: string; count: number }[];
  generatedAt: string;
}
type View = 'today' | '7d' | '30d' | '12w' | '12m';
const VIEWS: { id: View; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, { id: '12w', label: 'Last 12 weeks' }, { id: '12m', label: 'Last 12 months' },
];
const COLORS = ['#d6204d', '#f08a24', '#8a3fb8', '#4c5fd5'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) return <span className="delta flat">– no change</span>;
  if (prev === 0) return <span className="delta up">▲ new</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  return <span className={`delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}`}>{pct > 0 ? '▲' : pct < 0 ? '▼' : '–'} {Math.abs(pct)}%</span>;
}

function Kpi({ icon, color, label, value, prev }: { icon: IconName; color: string; label: string; value: number; prev?: number }) {
  return (
    <div className="kpi">
      <span className="kpi-icon" style={{ background: color }}><Icon name={icon} /></span>
      <div><small>{label}</small><b>{value}</b>{prev !== undefined && <Delta now={value} prev={prev} />}</div>
    </div>
  );
}

/** Axis maximum as 4 equal steps of 1, 2, 5, 10… so the gridline labels are always even whole numbers. */
const niceMax = (v: number) => {
  const raw = Math.max(v, 4) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p * 4;
};

/** Smooth area chart (no chart library): cubic segments through each point, gradient fill, last point highlighted. */
function AreaChart({ values, labels }: { values: number[]; labels: string[] }) {
  const gid = useId().replace(/:/g, '');
  const W = 640, H = 310, L = 38, R = 14, T = 14, B = 30;
  const max = niceMax(Math.max(0, ...values));
  const x = (i: number) => L + (values.length <= 1 ? 0 : (i / (values.length - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const pts = values.map((v, i) => [x(i), y(v)] as const);
  const line = pts.map(([px, py], i) => {
    if (i === 0) return `M${px},${py}`;
    const [qx] = pts[i - 1];
    const mx = (qx + px) / 2;
    return `C${mx},${pts[i - 1][1]} ${mx},${py} ${px},${py}`;
  }).join(' ');
  const base = y(0);
  const area = `${line} L${pts.at(-1)![0]},${base} L${pts[0][0]},${base} Z`;
  const narrow = typeof window !== 'undefined' && window.innerWidth < 700;
  const step = Math.max(1, Math.ceil(labels.length / (narrow ? 4 : 8)));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Visitor trend">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d6204d" stopOpacity=".28" /><stop offset="100%" stopColor="#d6204d" stopOpacity="0" /></linearGradient></defs>
      {ticks.map((t) => (<g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#eceef4" /><text x={L - 8} y={y(t) + 4} textAnchor="end">{t}</text></g>))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="#d6204d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {labels.map((l, i) => (i % step === 0 ? <text key={i} x={x(i)} y={H - 8} textAnchor="middle">{l}</text> : null))}
      {pts.length > 0 && <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r="5" fill="#fff" stroke="#d6204d" strokeWidth="2.5" />}
      {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="9" fill="transparent"><title>{`${labels[i]}: ${v}`}</title></circle>)}
    </svg>
  );
}

function Donut({ data }: { data: { label: string; count: number }[] }) {
  const total = data.reduce((a, d) => a + d.count, 0);
  if (!total) return <Empty>No visits in this period</Empty>;
  const r = 70, C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="donut-wrap">
      <svg width="190" height="190" viewBox="0 0 190 190" role="img" aria-label="Visitors by purpose">
        <g transform="rotate(-90 95 95)">
          {data.map((d, i) => {
            const len = (d.count / total) * C;
            const el = <circle key={d.label} cx="95" cy="95" r={r} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="26" strokeDasharray={`${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}`} strokeDashoffset={-acc} />;
            acc += len;
            return el;
          })}
        </g>
        <text x="95" y="102" textAnchor="middle" style={{ fontSize: 34, fontWeight: 800, fill: '#1d2433' }}>{total}</text>
      </svg>
      <div className="legend">{data.map((d, i) => <div key={d.label}><i style={{ background: COLORS[i % COLORS.length] }} />{d.label}<b>{Math.round((d.count / total) * 100)}%</b></div>)}</div>
    </div>
  );
}

function Bars({ rows, colors }: { rows: { label: string; count: number }[]; colors?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <Empty>No data</Empty>;
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div className="bar" key={r.label}><span title={r.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div className="track"><i style={{ width: `${(r.count / max) * 100}%`, background: colors ? COLORS[i % COLORS.length] : COLORS[0] }} /></div><b>{r.count}</b></div>
      ))}
    </div>
  );
}

export function Dashboard({ rooms, onViewAll }: { rooms: { id: string; name: string }[]; onViewAll: () => void }) {
  const [view, setView] = useState<View>('today');
  const [room, setRoom] = useState('');
  const period = view === 'today' ? 'today' : view === '7d' ? '7d' : '30d';
  const granularity = view === '12w' ? 'week' : view === '12m' ? 'month' : 'day';
  const query = { period, granularity, guardRoomId: room || undefined };
  const { data, error, reload } = useFetch<Dash>('/dashboard', query);
  useLive('visits:changed', () => void reload()); // NFR-2: the screen updates as events arrive
  useLive('connect', () => void reload());
  const exp = (f: string) => `/api/dashboard/export${qs({ ...query, format: f })}`;

  const series = (() => {
    if (!data) return { values: [] as number[], labels: [] as string[] };
    if (view === 'today') return { values: data.hourly.map((h) => h.count), labels: data.hourly.map((h) => (h.hour === 0 ? '12 AM' : h.hour < 12 ? `${h.hour} AM` : h.hour === 12 ? '12 PM' : `${h.hour - 12} PM`)) };
    const t = view === '7d' ? data.trend.slice(-7) : data.trend;
    const label = (b: string) => (view === '12m' ? MONTHS[Number(b.slice(5, 7)) - 1] : `${b.slice(8, 10)} ${MONTHS[Number(b.slice(5, 7)) - 1]}`);
    return { values: t.map((p) => p.count), labels: t.map((p) => label(p.bucket)) };
  })();

  return (
    <>
      <div className="row spread dash-toolbar" style={{ marginBottom: 18 }}>
        <div className="row filters">
          <select className="pill" value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Location"><option value="">All locations</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <select className="pill" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Period">{VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select>
        </div>
        <div className="row exports"><a className="btn" href={exp('xlsx')}><Icon name="download" />Excel</a><a className="btn" href={exp('pdf')}><Icon name="download" />PDF</a></div>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="kpis">
            <Kpi icon="users" color="#d6204d" label="Today's visitors" value={data.kpis.visitors.value} prev={data.kpis.visitors.previous} />
            <Kpi icon="check" color="#f08a24" label="Checked in (now)" value={data.kpis.checkedIn} />
            <Kpi icon="logout" color="#4c5fd5" label="Checked out" value={data.kpis.checkedOut.value} prev={data.kpis.checkedOut.previous} />
            <Kpi icon="clipboard" color="#8a3fb8" label="Pre-registrations" value={data.kpis.preRegistrations.value} prev={data.kpis.preRegistrations.previous} />
          </div>

          <div className="dash-grid" style={{ marginBottom: 20 }}>
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="card-head"><h3>Visitor trend</h3><span className="muted">{VIEWS.find((v) => v.id === view)?.label}</span></div>
              {series.values.some((v) => v > 0) ? <AreaChart values={series.values} labels={series.labels} /> : <Empty>No visits in this period yet</Empty>}
            </div>
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="card-head"><h3>Recent visitors</h3><button className="link" onClick={onViewAll}>View all</button></div>
              {!data.recent.length && <Empty>No visitors yet</Empty>}
              <div className="recent">
                {data.recent.map((r) => (
                  <div className="recent-row" key={r.id}>
                    <Avatar name={r.fullName} small />
                    <div className="who"><b>{r.fullName}</b><small>{r.guardRoom}{r.pass ? ` · ${r.pass}` : ''}</small></div>
                    <span className={`pill-text ${r.status === 'on_premises' ? 'in' : 'out'}`}>{r.status === 'on_premises' ? 'Check-in' : 'Check-out'}</span><time>{fmtTime(r.timeIn)}</time>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="dash-grid even" style={{ marginBottom: 20 }}>
            <div className="card" style={{ marginBottom: 0 }}><div className="card-head"><h3>Visitors by purpose</h3></div><Donut data={data.byPurpose} /></div>
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="card-head"><h3>Location overview</h3><span className="muted">Check-ins today</span></div>
              <Bars colors rows={data.checkInsByGuardRoom.map((g) => ({ label: g.name, count: g.count })).sort((a, b) => b.count - a.count)} />
            </div>
          </div>

          <div className="dash-grid three">
            <div className="card"><div className="card-head"><h3>By pass category</h3></div><Bars rows={data.byPassCategory.map((g) => ({ label: g.name, count: g.count }))} /></div>
            <div className="card"><div className="card-head"><h3>By department</h3></div><Bars rows={data.byDepartment.map((g) => ({ label: g.name, count: g.count }))} /></div>
            <div className="card"><div className="card-head"><h3>Top companies</h3></div><Bars rows={data.topCompanies.map((g) => ({ label: g.company, count: g.count }))} /></div>
          </div>
        </>
      )}
    </>
  );
}
