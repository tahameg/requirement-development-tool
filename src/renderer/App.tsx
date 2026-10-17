import { Collaboration } from './components/collab/Collaboration.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Result } from '../shared/api.js';
import type { AppSettings } from '../shared/appSettings.js';
import type { HierarchyCommand, HierarchySelection } from '../shared/hierarchy.js';
import { WorkspaceTree } from './components/tree/WorkspaceTree.js';
import { HierarchyDialog, type HierarchyEditor } from './components/tree/HierarchyDialog.js';
import type { FunctionEdit, ExportRequest } from '../shared/authoring.js';
import type { ProjectConfig } from '../shared/types/config.js';
import { ProjectSettings } from './components/settings/ProjectSettings.js';
import { SearchDialog } from './components/search/SearchDialog.js';
import { HierarchyView } from './components/editor/HierarchyView.js';

export function App() {
  const [collaboration, setCollaboration] = useState(false);
  const [state, setState] = useState<AppState>();
  const [dirty, setDirty] = useState(false);
  const saveDraft = useRef<(() => Promise<void>) | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [panel, setPanel] = useState<'home' | 'new' | 'app' | 'project' | 'hierarchy'>('home');
  const [selected, setSelected] = useState<HierarchySelection | null>(null);
  const [editor, setEditor] = useState<HierarchyEditor | null>(null);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('GS');
  async function run(action: () => Promise<Result<AppState>>, close = true) {
    setBusy(true); setError('');
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error);
      setState(result.value);
      if (close) setPanel('home');
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void run(() => window.hlr.state()); }, []);
  useEffect(() => { document.documentElement.dataset.theme = state?.settings.general.theme ?? 'dark'; }, [state?.settings.general.theme]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && ['p', 'f'].includes(event.key.toLowerCase()) && state?.current) { event.preventDefault(); setSearchOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy && state?.current) { if (saveDraft.current) void saveDraft.current(); else void run(() => window.hlr.saveProject(), false); } }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [busy, state?.current]);
  const current = state?.current;
  useEffect(() => { setSelected(null); setEditor(null); }, [current?.root]);
  const onDraft = useCallback((hasDraft: boolean, save: (() => Promise<void>) | null) => { setDirty(hasDraft); saveDraft.current = save; }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  function mayLeave() { if (busy) return false; return !dirty || window.confirm('Discard unsaved edits? Save changes first to keep them.'); }
  function navigate(next: typeof panel) { if (mayLeave()) { setPanel(next); setDirty(false); saveDraft.current = null; } }
  function select(selection: HierarchySelection, itemId?: string) {
    if ((panel !== 'hierarchy' || selected?.id !== selection.id || selected?.objectType !== selection.objectType) && !mayLeave()) return;
    setSelected(selection); setPanel('hierarchy'); setFocusedItem(itemId ?? null); setError('');
  }
  async function editItems(command: FunctionEdit) {
    setBusy(true);
    try { const result = await window.hlr.editFunction(command); if (!result.ok) throw new Error(result.error); setState(result.value); }
    finally { setBusy(false); }
  }
  async function updateConfig(config: ProjectConfig) {
    setBusy(true);
    try { const result = await window.hlr.updateProject(config); if (!result.ok) throw new Error(result.error); setState(result.value); setPanel('home'); }
    finally { setBusy(false); }
  }
  function hierarchyAction(action: HierarchyEditor['action'], selection: HierarchySelection) {
    if (dirty) { setError('Save or cancel your current edits before changing the hierarchy.'); return; }
    setEditor({ action, selection });
  }
  async function exportFile(request: ExportRequest) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await window.hlr.exportWorkspace(request); if (!result.ok) throw new Error(result.error); if (result.value) setNotice(`Exported to ${result.value}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); }
    finally { setBusy(false); }
  }
  async function changeHierarchy(command: HierarchyCommand) {
    setBusy(true);
    try {
      const result = await window.hlr.changeHierarchy(command);
      if (!result.ok) throw new Error(result.error);
      const domain = result.value.current!.workspace.domains[command.objectType];
      let next: HierarchySelection;
      if (command.action === 'addModule') next = { objectType: command.objectType, kind: 'module', id: domain.modules.at(-1)!.id };
      else if (command.action === 'addFunction') next = { objectType: command.objectType, kind: 'function', id: domain.functions.at(-1)!.functionId };
      else if (command.action === 'deleteModule' || command.action === 'deleteFunction') {
        const previous = current!.workspace.domains[command.objectType];
        const parent = command.action === 'deleteModule' ? previous.modules.find(m => m.id === command.id)?.parentId : previous.functions.find(f => f.functionId === command.id)?.parentModuleId;
        next = { objectType: command.objectType, kind: parent ? 'module' : 'root', id: parent ?? null };
      } else next = { objectType: command.objectType, kind: command.action === 'editModule' ? 'module' : 'function', id: command.id };
      setState(result.value); select(next); setEditor(null);
    } finally { setBusy(false); }
  }
  if (collaboration) return <Collaboration onOffline={() => setCollaboration(false)} />;
  return <div className="app">
    <header><div className="brand"><span className="brand-mark">H</span><strong>HLR <span>Writing Tool</span></strong></div><span className="project-title">{current?.workspace.config.projectName ?? 'Workspace overview'}</span><button disabled={busy || !current} onClick={() => setSearchOpen(true)}>Search <kbd>Ctrl P</kbd></button><button disabled={busy} onClick={() => { if (mayLeave()) setCollaboration(true); }}>Connect to server</button><button disabled={busy} onClick={() => navigate('app')}>Application settings</button></header>
    <div className="body"><aside><div className="eyebrow">WORKSPACE</div><button className={panel === 'home' ? 'nav selected' : 'nav'} onClick={() => navigate('home')}>▦ &nbsp; Overview</button><div className="rule" /><div className="eyebrow">OBJECT TYPES</div><WorkspaceTree key={current?.root ?? 'unopened'} workspace={current?.workspace} selected={panel === 'hierarchy' ? selected : null} busy={busy} onSelect={select} onAction={hierarchyAction} /><div className="sidebar-bottom"><span className="dot" /> Local workspace<br /><small>Your files stay on this computer.</small></div></aside>
    <main aria-busy={busy}>{notice && <p className="notice" role="status">{notice}</p>}{error && <div role="alert" className="error">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {panel === 'hierarchy' && selected ? <HierarchyView workspace={current?.workspace} selected={selected} busy={busy} onSelect={select} onAction={hierarchyAction} onCreate={() => { setName(''); setPanel('new'); }} onOpen={() => void run(() => window.hlr.openProject())} onSave={editItems} onDraft={onDraft} autosave={state?.settings.general.auto_save_interval_sec ?? 0} onExport={request => void exportFile(request)} focusedItem={focusedItem} />
    : panel === 'new' ? <section className="form-card"><div className="eyebrow">NEW WORKSPACE</div><h1>Create a project</h1><p>Give your requirements a home. Choose a new workspace folder when you continue.</p><form onSubmit={e => { e.preventDefault(); void run(() => window.hlr.createProject(name, prefix)); }}><label>Project name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="Guidance System" autoFocus /></label><label>Project prefix<input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="GS" pattern="[\p{L}\p{N}_]*" /></label><p className="hint">Letters, numbers and underscores. The prefix is optional.</p><div className="actions"><button type="button" onClick={() => navigate('home')}>Cancel</button><button className="primary" disabled={busy || !name.trim()}>Choose workspace folder</button></div></form></section>
    : panel === 'app' && state ? <Settings settings={state.settings} path={state.configPath} busy={busy} onCancel={() => setPanel('home')} onSave={general => void run(() => window.hlr.saveSettings(general))} />
    : panel === 'project' && current ? <ProjectSettings current={current.workspace.config} busy={busy} onCancel={() => setPanel('home')} onSave={updateConfig} onDraft={onDraft} />
    : <><div className="page-heading"><div><div className="eyebrow">REQUIREMENTS ENGINEERING</div><h1>{current ? current.workspace.config.projectName : 'A clear starting point.'}</h1><p>{current ? 'Workspace files and project configuration, together in one place.' : 'Create, organize and preserve your engineering requirements.'}</p></div><span className="badge">OFFLINE FIRST</span></div>
    <div className="cards"><button className="launch-card" disabled={busy} onClick={() => { setName(''); setPanel('new'); }}><span className="card-icon">＋</span><h2>Create project</h2><p>Start a workspace with your own naming rules.</p><span className="card-link">New workspace →</span></button><button className="launch-card" disabled={busy} onClick={() => void run(() => window.hlr.openProject())}><span className="card-icon">▱</span><h2>Open project</h2><p>Continue from a workspace saved on this computer.</p><span className="card-link">Browse folders →</span></button></div>
    {current ? <section className="workspace-card"><div className="section-heading"><h2>Project overview</h2><button disabled={busy} onClick={() => void exportFile({ format: 'csv' })}>Export all CSV</button><button disabled={busy} onClick={() => void exportFile({ format: 'markdown' })}>Export all Markdown</button><button disabled={busy} onClick={() => navigate('project')}>Project settings</button></div><div className="stats"><div><strong>{Object.values(current.workspace.domains).reduce((sum, d) => sum + d.functions.reduce((n, f) => n + f.items.length, 0), 0)}</strong><span>Engineering items</span></div><div><strong>{Object.values(current.workspace.domains).reduce((sum, d) => sum + d.modules.length, 0)}</strong><span>Modules</span></div><div><strong>{current.workspace.config.projectPrefix || '—'}</strong><span>Project prefix</span></div></div><div className="filepath">{current.root}</div>{current.index.status === 'unavailable' && <p role="alert" className="error">Search index unavailable: {current.index.error}. Your JSON workspace is still available.</p>}<div className="actions"><span className="hint">Workspace ready. Naming rules are available in project settings.</span><button disabled={busy} onClick={() => void run(() => window.hlr.saveProject())}>Save workspace <kbd>Ctrl S</kbd></button></div></section> : <section className="recent"><h2>Recent projects</h2>{state?.settings.recentProjects.length ? state.settings.recentProjects.map((root, i) => <button className="recent-row" key={root} disabled={busy} onClick={() => void run(() => window.hlr.openRecent(i))}><span>▱</span><div><strong>{root.split(/[\\/]/).pop()}</strong><small>{root}</small></div><span>→</span></button>) : <div className="empty"><span>▱</span><h3>Your next specification starts here</h3><p>Projects you create or open will appear in this list.</p></div>}</section>}
    <div className="foundation-note"><span>◈</span><div><strong>Built for lasting requirements</strong><p>Readable project files. Permanent IDs. No server required.</p></div></div></>}
    </main></div>{searchOpen && current && <SearchDialog onClose={() => setSearchOpen(false)} onOpen={hit => { if (panel === 'hierarchy' && selected?.id === hit.functionId || mayLeave()) { setSelected({ objectType: hit.objectType, kind: 'function', id: hit.functionId }); setFocusedItem(hit.id); setPanel('hierarchy'); setSearchOpen(false); } }} />}{editor && current && <HierarchyDialog workspace={current.workspace} editor={editor} busy={busy} onClose={() => setEditor(null)} onSave={changeHierarchy} />}<footer><span><i className="dot" />{busy ? 'Working…' : dirty ? 'Unsaved edits' : 'Saved'}</span><span>{current ? `SQLite index: ${current.index.status === 'ready' ? 'OK' : 'unavailable'}` : 'No workspace open'}</span><span>HLR Writing Tool · 0.6.0</span></footer>
  </div>;
}
function Settings({ settings, path, busy, onSave, onCancel }: { settings: AppSettings; path: string; busy: boolean; onSave: (general: AppSettings['general']) => void; onCancel: () => void }) {
  const [general, setGeneral] = useState(settings.general);
  return <section className="form-card"><div className="eyebrow">PREFERENCES</div><h1>Application settings</h1><p>Saved on this computer and shared across your projects.</p><form onSubmit={e => { e.preventDefault(); onSave(general); }}><label>Appearance<select value={general.theme} onChange={e => setGeneral({ ...general, theme: e.target.value as AppSettings['general']['theme'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="high-contrast">High contrast</option></select></label><p className="hint">Project settings are saved when you confirm them.</p><label>Autosave interval (seconds, 0 disables)<input type="number" min={0} max={86400} value={general.auto_save_interval_sec} onChange={e => setGeneral({ ...general, auto_save_interval_sec: Number(e.target.value) })} /></label><div className="filepath">{path}</div><div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>Save preferences</button></div></form></section>;
}
