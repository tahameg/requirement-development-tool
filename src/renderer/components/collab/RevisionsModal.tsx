import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import type { RevisionMetadata } from '../../../shared/collab/types.js';
import { capabilities } from '../../../shared/collab/ui.js';
import { collab, request } from './api.js';
export function RevisionsModal({ state, run, close }: { state: CollabState; run: (fn: () => Promise<unknown>) => void; close: () => void }) {
  const [revisions, setRevisions] = useState<RevisionMetadata[]>([]); const [diff, setDiff] = useState<any>(); const [compareTo, setCompareTo] = useState('');
  const base = `/api/rooms/${state.roomId}/revisions`; const cap = capabilities(state.role, state.connection === 'connected');
  const refresh = async () => setRevisions((await request('GET', base)).revisions);
  useEffect(() => { run(refresh); }, [state.notice]);
  return <section className="workspace-card"><div className="section-heading"><h2>Revision history</h2><button onClick={close}>Close</button></div><p>Edits autosave continuously. A revision is a named snapshot of the project.</p>
    {cap.admin && <form onSubmit={e => { e.preventDefault(); const message = new FormData(e.currentTarget).get('message'); run(async () => { await request('POST', base, { message }); await refresh(); }); }}><label>Revision message<input name="message" required maxLength={1000} /></label><button className="primary">Save revision</button></form>}
    <label>Compare revisions against<select value={compareTo} onChange={e => setCompareTo(e.target.value)}><option value="">Current workspace</option>{revisions.map(r => <option key={r.id} value={r.id}>{r.message}</option>)}</select></label>
    {revisions.map(r => <div className="collab-row" key={r.id}><div><strong>{r.message}</strong><small>{r.authorName} · {new Date(r.createdAt).toLocaleString()} · change {r.seq}</small></div><button onClick={() => run(async () => setDiff(await request('GET', `${base}/${r.id}/diff${compareTo ? `?to=${encodeURIComponent(compareTo)}` : ''}`)))}>Compare</button>{cap.admin && <button onClick={() => run(async () => { if (window.confirm(`Restore “${r.message}”? This replaces the current project and releases active edit locks. A new revision preserves the restore.`)) { await request('POST', `${base}/${r.id}/restore`, {}); await refresh(); } })}>Restore</button>}</div>)}
    {diff && <div><h3>Changes since this revision</h3><p>Project settings: {diff.configChanged ? 'changed' : 'unchanged'}</p><p>Added: {diff.added.join(', ') || 'None'}</p><p>Removed: {diff.removed.join(', ') || 'None'}</p>{diff.changed.map((c: any) => <details key={c.id}><summary>{c.id}</summary><div className="collab-columns"><pre>{JSON.stringify(c.before.value, null, 2)}</pre><pre>{JSON.stringify(c.after.value, null, 2)}</pre></div></details>)}</div>}
    {cap.admin && <button onClick={() => run(async () => { if (window.confirm('Import a local copy of this project? The imported revision will replace the room project and release edit locks.')) { await collab({ action: 'import' }); await refresh(); } })}>Import local workspace</button>}
  </section>;
}
