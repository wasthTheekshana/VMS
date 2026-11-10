'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, Me, ROLE_HOME } from '@/lib/api';
import { Icon } from '@/components/ui';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Me>('/auth/me').then((m) => window.location.replace(ROLE_HOME[m.role]), () => undefined); // already signed in
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const m = await api<Me>('/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      window.location.replace(ROLE_HOME[m.role]);
    } catch (x) {
      setError(x instanceof ApiError && x.status === 429 ? 'Too many attempts. Wait a minute and try again.' : (x as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-art" aria-hidden="true">
        <div><div className="brand-name" style={{ fontSize: '2.6rem' }}>VMS</div><div className="brand-sub">VISITOR</div></div>
        <div>
          <h2>Every visitor, recorded and welcomed.</h2>
          <ul>
            <li><Icon name="userPlus" />Pre-register guests before they arrive</li>
            <li><Icon name="login" />Fast check-in and check-out at the gate</li>
            <li><Icon name="bell" />Instant alerts to hosts, guards and administrators</li>
            <li><Icon name="chart" />Live dashboards and exportable reports</li>
          </ul>
        </div>
        <small style={{ opacity: .8 }}>DOK Solutions Lanka (Pvt) Ltd · A member of the ABANS Group</small>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <h1>Welcome back</h1>
          <p className="muted" style={{ marginTop: 0, marginBottom: 22 }}>Sign in to the Visitor Management System.</p>
          {error && <div className="alert bad" role="alert">{error}</div>}
          <label className="field"><span>Username</span><input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="btn primary big" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="muted" style={{ fontSize: '.85rem', marginTop: 18 }}>Accounts are created by an administrator.</p>
        </form>
      </section>
    </div>
  );
}
