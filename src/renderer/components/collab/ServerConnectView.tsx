import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import { collab } from './api.js';
import { Icon } from '../ui/Icon.js';
import { Alert, Button, ButtonGroup, Code, Eyebrow, Field } from '../ui/primitives.js';
export function ServerConnectView({ state, run }: { state: CollabState; run: (fn: () => Promise<unknown>) => void }) {
  const [address, setAddress] = useState('');
  const [probe, setProbe] = useState<{ address: string; fingerprint: string | null; previous: string | null } | null>(null);
  const [method, setMethod] = useState<'login'|'register'|'setup'>('login');
  useEffect(() => { void collab({ action: 'discover' }).catch(() => {}); }, []);
  // Depend on primitives: state is re-published (new object identity) on every discovery broadcast.
  const setupRequired = !!state.server?.setupRequired;
  useEffect(() => { setMethod(setupRequired ? 'setup' : 'login'); }, [state.address, setupRequired]);
  const servers = [...state.discovered.map(s => ({ key: s.serverId, label: s.name, detail: `${s.host}:${s.port}`, address: `${s.tls ? 'https' : 'http'}://${s.host}:${s.port}`, found: true })), ...state.remembered.map(s => ({ key: s, label: s, detail: 'Trusted before', address: s, found: false }))];
  return <section className="form-page connect">
    <Eyebrow icon="server">Collaboration</Eyebrow><h1>Connect to your team</h1><p>Pick a server on your network or type its address. Your account lives on that server.</p>
    {!state.server ? <>
      {servers.length > 0 && <div className="server-list">{servers.map(s => <button key={s.key} className={`server-tile${address === s.address ? ' on' : ''}`} onClick={() => setAddress(s.address)}><Icon name={s.found ? 'server' : 'history'} size={20} /><span><strong>{s.label}</strong><small>{s.detail}</small></span></button>)}</div>}
      <form className="panel form-panel" onSubmit={e => { e.preventDefault(); run(async () => setProbe(await collab({ action: 'probe', address }))); }}>
        <Field label="Server address"><input required className="mono" value={address} placeholder="https://192.168.1.20:8443" onChange={e => setAddress(e.target.value)} /></Field>
        <div className="form-actions"><Button type="submit" tone="primary" icon="plug">Connect</Button></div>
      </form>
      {probe && <div className={`panel trust-card${probe.previous && probe.previous !== probe.fingerprint ? ' panel-danger' : ''}`} role="alert">
        <header className="panel-head"><h2><Icon name={probe.fingerprint ? 'shield' : 'warning'} />{probe.previous && probe.previous !== probe.fingerprint ? 'Server certificate changed' : probe.fingerprint ? 'Trust this server?' : 'Unencrypted test server'}</h2></header>
        <div className="panel-body"><p>{probe.fingerprint ? 'Compare this fingerprint with your server administrator before continuing.' : 'Plain HTTP sends your password and project data unencrypted. Use it only on a trusted test network.'}</p>
          {probe.previous && <p>Previously trusted: <Code>{probe.previous}</Code></p>}<Code big>{probe.fingerprint ?? probe.address}</Code>
          <div className="form-actions"><Button onClick={() => setProbe(null)}>Cancel</Button><Button tone={probe.fingerprint ? 'primary' : 'danger'} icon="check" onClick={() => run(async () => { await collab({ action: 'connect', address: probe.address, fingerprint: probe.fingerprint, allowHttp: !probe.fingerprint }); setProbe(null); })}>Trust and continue</Button></div></div>
      </div>}
    </> : <>
      <div className="panel server-card"><Icon name="server" size={28} /><div><strong>{state.server.name}</strong><Code>{state.address}</Code></div><Button icon="refresh" onClick={() => run(() => collab({ action: 'disconnect' }))}>Change server</Button></div>
      <div className="tabs" role="tablist" aria-label="Account">
        <button role="tab" aria-selected={method === 'login'} className={method === 'login' ? 'on' : ''} onClick={() => setMethod('login')}><Icon name="user" />Sign in</button>
        {state.server.registrationMode !== 'closed' && <button role="tab" aria-selected={method === 'register'} className={method === 'register' ? 'on' : ''} onClick={() => setMethod('register')}><Icon name="plus" />Register</button>}
        {state.server.setupRequired && <button role="tab" aria-selected={method === 'setup'} className={method === 'setup' ? 'on' : ''} onClick={() => setMethod('setup')}><Icon name="crown" />Claim server</button>}
      </div>
      {state.notice && <Alert tone="info">{state.notice}</Alert>}
      <form key={method} className="panel form-panel" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); run(() => collab({ action: 'auth', method, username: String(data.get('username')), password: String(data.get('password')), ...(method !== 'login' ? { displayName: String(data.get('displayName')) } : {}), ...(method === 'setup' ? { setupToken: String(data.get('setupToken')) } : {}) })); }}>
        <Field label="Username"><input name="username" autoComplete="username" required autoFocus /></Field>
        {method !== 'login' && <Field label="Display name" hint="Teammates see this next to your edits."><input name="displayName" required /></Field>}
        <Field label="Password"><input name="password" type="password" minLength={8} autoComplete={method === 'login' ? 'current-password' : 'new-password'} required /></Field>
        {method === 'setup' && <Field label="One-time setup token" hint="Printed by the server on first start."><input name="setupToken" type="password" required /></Field>}
        <div className="form-actions"><ButtonGroup label="Submit"><Button type="submit" tone="primary" icon={method === 'login' ? 'arrowRight' : method === 'register' ? 'plus' : 'crown'}>{method === 'login' ? 'Sign in' : method === 'register' ? 'Create account' : 'Set up server'}</Button></ButtonGroup></div>
      </form>
    </>}
  </section>;
}
