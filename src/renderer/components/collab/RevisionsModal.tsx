import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import type { RevisionMetadata } from '../../../shared/collab/types.js';
import { capabilities } from '../../../shared/collab/ui.js';
import { collab, request } from './api.js';
import { Icon } from '../ui/Icon.js';
import { Badge, Button, ButtonGroup, Code, Field, Panel } from '../ui/primitives.js';
import { useConfirm } from '../ui/Modal.js';
export function RevisionsModal({ state, run, close }: { state: CollabState; run: (fn: () => Promise<unknown>) => void; close: () => void }) {
  const [revisions, setRevisions] = useState<RevisionMetadata[]>([]); const [diff, setDiff] = useState<any>(); const [compareTo, setCompareTo] = useState('');
  const base = `/api/rooms/${state.roomId}/revisions`; const cap = capabilities(state.role, state.connection === 'connected');
  const confirm = useConfirm();
  const refresh = async () => setRevisions((await request('GET', base)).revisions);
  useEffect(() => { run(refresh); }, [state.notice]);
  return <section className="page-panels">
    <header className="page-head"><div><div className="eyebrow"><Icon name="history" size={12} />Room</div><h1>Revisions</h1><p>Edits save continuously. A revision is a named snapshot you can compare or restore.</p></div><Button icon="close" onClick={close}>Close</Button></header>
    {cap.admin && <Panel title="Save a revision" icon="save"><form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const message = new FormData(form).get('message'); run(async () => { await request('POST', base, { message }); form.reset(); await refresh(); }); }}><div className="form-row"><Field label="Revision message" className="grow"><input name="message" required maxLength={1000} placeholder="Reviewed baseline" /></Field><Button type="submit" tone="primary" icon="save">Save revision</Button></div></form></Panel>}
    <Panel title="History" icon="history" actions={<label className="inline-field"><span>Compare against</span><select value={compareTo} onChange={e => setCompareTo(e.target.value)}><option value="">Current workspace</option>{revisions.map(r => <option key={r.id} value={r.id}>{r.message}</option>)}</select></label>}>
      <ol className="timeline">{revisions.map(r => <li key={r.id}><span className="timeline-dot" /><div className="timeline-main"><strong>{r.message}</strong><small>{r.authorName} · {new Date(r.createdAt).toLocaleString()} · change {r.seq}</small></div>
        <ButtonGroup label="Inspect"><Button icon="eye" onClick={() => run(async () => setDiff(await request('GET', `${base}/${r.id}/diff${compareTo ? `?to=${encodeURIComponent(compareTo)}` : ''}`)))}>Compare</Button></ButtonGroup>
        {cap.admin && <ButtonGroup label="Restore"><Button tone="danger" icon="undo" onClick={() => run(async () => { if (await confirm({ title: `Restore “${r.message}”?`, tone: 'danger', confirmLabel: 'Restore', body: <p>This replaces the current project and releases every edit lock. A new revision records the restore, so nothing is lost.</p> })) { await request('POST', `${base}/${r.id}/restore`, {}); await refresh(); } })}>Restore</Button></ButtonGroup>}
      </li>)}</ol>
      {!revisions.length && <p className="hint">No revisions yet.</p>}
    </Panel>
    {diff && <Panel title="Changes since this revision" icon="list" actions={<Badge tone={diff.configChanged ? 'accent' : 'muted'}>Settings {diff.configChanged ? 'changed' : 'unchanged'}</Badge>}>
      <div className="diff-summary"><div className="change-add"><strong>{diff.added.length}</strong> added</div><div className="change-remove"><strong>{diff.removed.length}</strong> removed</div><div className="change-change"><strong>{diff.changed.length}</strong> changed</div></div>
      {diff.added.length > 0 && <p>Added: {diff.added.map((id: string) => <Code key={id}>{id}</Code>)}</p>}
      {diff.removed.length > 0 && <p>Removed: {diff.removed.map((id: string) => <Code key={id}>{id}</Code>)}</p>}
      {diff.changed.map((c: any) => <details key={c.id} className="diff-item"><summary><Code>{c.id}</Code> <small>{c.after.kind}</small></summary><div className="conflict-cols"><pre>{JSON.stringify(c.before.value, null, 2)}</pre><pre>{JSON.stringify(c.after.value, null, 2)}</pre></div></details>)}
    </Panel>}
    {cap.admin && <Panel title="Import" icon="upload"><div className="form-actions"><span className="hint">Replace the room project with a local workspace. The import is saved as a revision.</span><Button icon="upload" onClick={() => run(async () => { if (await confirm({ title: 'Import a local workspace?', tone: 'danger', confirmLabel: 'Choose folder', body: <p>The imported project replaces the room project and releases all edit locks.</p> })) { await collab({ action: 'import' }); await refresh(); } })}>Import local workspace</Button></div></Panel>}
  </section>;
}
