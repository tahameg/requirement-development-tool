import { Collaboration } from './components/collab/Collaboration.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Result } from '../shared/api.js';
import type { AppSettings } from '../shared/appSettings.js';
import type { HierarchyCommand, HierarchySelection } from '../shared/hierarchy.js';
import { WorkspaceTree, type TreeAction } from './components/tree/WorkspaceTree.js';
import { HierarchyDialog, type HierarchyEditor } from './components/tree/HierarchyDialog.js';
import type { RequirementSetEdit, ExportRequest } from '../shared/authoring.js';
import type { ProjectConfig } from '../shared/types/config.js';
import { ProjectSettings } from './components/settings/ProjectSettings.js';
import { SearchDialog } from './components/search/SearchDialog.js';
import { HierarchyView } from './components/editor/HierarchyView.js';
import { RequirementSetEditor } from './components/editor/RequirementSetEditor.js';
import { AppSettingsView } from './components/settings/AppSettingsView.js';
import { Brand, StatusBar } from './components/layout/Shell.js';
import { Icon } from './components/ui/Icon.js';
import { Alert, Button, ButtonGroup, Code, Empty, Eyebrow, IconButton } from './components/ui/primitives.js';
import { useConfirm, useToast } from './components/ui/Modal.js';
import { plural } from '../shared/terminology.js';

type Panel = 'home' | 'new' | 'app' | 'project' | 'hierarchy';
export function App() {
  const [collaboration, setCollaboration] = useState(false);
  const [state, setState] = useState<AppState>();
  const [dirty, setDirty] = useState(false);
  const saveDraft = useRef<(() => Promise<void>) | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [panel, setPanel] = useState<Panel>('home');
  const [selected, setSelected] = useState<HierarchySelection | null>(null);
  const [editor, setEditor] = useState<HierarchyEditor | null>(null);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('GS');
  const confirm = useConfirm();
  const notify = useToast();
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
  async function mayLeave() {
    if (busy) return false;
    if (!dirty) return true;
    const ok = await confirm({ title: panel === 'project' ? 'Leave project settings?' : 'Leave with unsaved edits?', tone: 'danger', icon: 'warning', confirmLabel: 'Discard and leave', cancelLabel: 'Keep editing',
      body: <p>{panel === 'project' ? 'Your unsaved settings changes will be discarded.' : 'Your unsaved edits will be discarded.'} Save first (Ctrl S) to keep them.</p> });
    if (ok) { setDirty(false); saveDraft.current = null; }
    return ok;
  }
  async function navigate(next: Panel) { if (next === panel || await mayLeave()) setPanel(next); }
  async function select(selection: HierarchySelection, itemId?: string) {
    if ((panel !== 'hierarchy' || selected?.id !== selection.id || selected?.objectType !== selection.objectType) && !await mayLeave()) return;
    setSelected(selection); setPanel('hierarchy'); setFocusedItem(itemId ?? null); setError('');
  }
  async function editItems(command: RequirementSetEdit) {
    setBusy(true);
    try { const result = await window.hlr.authorRequirementSet(command); if (!result.ok) throw new Error(result.error); setState(result.value); }
    finally { setBusy(false); }
  }
  async function updateConfig(config: ProjectConfig) {
    setBusy(true);
    try { const result = await window.hlr.updateProject(config); if (!result.ok) throw new Error(result.error); setState(result.value); setDirty(false); saveDraft.current = null; setPanel('home'); notify({ tone: 'ok', title: 'Project settings saved' }); }
    finally { setBusy(false); }
  }
  function hierarchyAction(action: TreeAction, selection: HierarchySelection) {
    if (dirty) { setError('Save or discard your current edits before changing the hierarchy.'); return; }
    setEditor({ action, selection });
  }
  async function exportFile(request: ExportRequest) {
    setBusy(true); setError('');
    try { const result = await window.hlr.exportWorkspace(request); if (!result.ok) throw new Error(result.error); if (result.value) notify({ tone: 'ok', title: 'Export written', body: result.value, icon: 'download' }); }
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
      if (command.action === 'addComponent') next = { objectType: command.objectType, kind: 'component', id: domain.components.at(-1)!.id };
      else if (command.action === 'addRequirementSet') next = { objectType: command.objectType, kind: 'requirementSet', id: domain.requirementSets.at(-1)!.requirementSetId };
      else if (command.action === 'deleteComponent' || command.action === 'deleteRequirementSet') {
        const previous = current!.workspace.domains[command.objectType];
        const parent = command.action === 'deleteComponent' ? previous.components.find(c => c.id === command.id)?.parentId : previous.requirementSets.find(s => s.requirementSetId === command.id)?.parentComponentId;
        next = { objectType: command.objectType, kind: parent ? 'component' : 'root', id: parent ?? null };
      } else next = { objectType: command.objectType, kind: command.action === 'editComponent' ? 'component' : 'requirementSet', id: command.id };
      setState(result.value); setSelected(next); setPanel('hierarchy'); setEditor(null);
    } finally { setBusy(false); }
  }
  async function goOnline() { if (await mayLeave()) setCollaboration(true); }
  if (collaboration) return <Collaboration onOffline={() => setCollaboration(false)} />;
  const totals = current ? Object.values(current.workspace.domains).reduce((t, d) => ({ components: t.components + d.components.length, sets: t.sets + d.requirementSets.length, items: t.items + d.requirementSets.reduce((n, s) => n + s.items.length, 0) }), { components: 0, sets: 0, items: 0 }) : null;
  return <div className="app">
    <header className="topbar">
      <Brand mode="Local" />
      <div className="topbar-project">{current ? <><strong>{current.workspace.config.projectName}</strong><Code>{current.workspace.config.projectPrefix || 'no prefix'}</Code></> : <span className="muted">No project open</span>}</div>
      <ButtonGroup label="Find"><Button icon="search" disabled={busy || !current} onClick={() => setSearchOpen(true)} kbd="Ctrl P">Search</Button></ButtonGroup>
      <ButtonGroup label="Project">
        <Button icon="save" disabled={busy || !current} onClick={() => { if (saveDraft.current) void saveDraft.current(); else void run(() => window.hlr.saveProject(), false); }} kbd="Ctrl S">Save</Button>
        <IconButton icon="database" label="Project settings" disabled={busy || !current} onClick={() => void navigate('project')} className={panel === 'project' ? 'on' : ''} />
      </ButtonGroup>
      <ButtonGroup label="Application">
        <Button icon="users" disabled={busy} onClick={() => void goOnline()}>Team server</Button>
        <IconButton icon="settings" label="Application settings" disabled={busy} onClick={() => void navigate('app')} className={panel === 'app' ? 'on' : ''} />
      </ButtonGroup>
    </header>
    <div className="body">
      <aside className="sidebar">
        <nav className="side-nav"><button className={panel === 'home' ? 'on' : ''} onClick={() => void navigate('home')}><Icon name="home" />Overview</button>
          {current && <button className={panel === 'project' ? 'on' : ''} onClick={() => void navigate('project')}><Icon name="database" />Data definition</button>}</nav>
        <div className="side-label">Workspace</div>
        <WorkspaceTree key={current?.root ?? 'unopened'} workspace={current?.workspace} readOnly={!current} selected={panel === 'hierarchy' ? selected : null} busy={busy} onSelect={s => void select(s)} onAction={hierarchyAction} />
        <div className="side-foot"><Icon name="offline" /><div><strong>Local workspace</strong><small>Files stay on this computer</small></div></div>
      </aside>
      <main aria-busy={busy}>
        {error && <Alert onDismiss={() => setError('')}>{error}</Alert>}
        {panel === 'hierarchy' && selected && current ? <HierarchyView workspace={current.workspace} selected={selected} busy={busy} onSelect={(s, item) => void select(s, item)} onAction={hierarchyAction}
          renderSet={(set, nextId) => <RequirementSetEditor key={set.requirementSetId} workspace={current.workspace} set={set} objectType={selected.objectType} busy={busy} preview={nextId} autosave={state?.settings.general.auto_save_interval_sec ?? 0} onSave={editItems} onDraft={onDraft} onSelect={(s, item) => void select(s, item)} onExport={request => void exportFile(request)} focusedItem={focusedItem} />} />
        : panel === 'new' ? <section className="form-page"><Eyebrow icon="filePlus">New workspace</Eyebrow><h1>Create a project</h1><p>Choose a name and the prefix every ID starts with. You pick a new folder next.</p>
          <form className="panel form-panel" onSubmit={e => { e.preventDefault(); void run(() => window.hlr.createProject(name, prefix)); }}>
            <label className="field"><span className="field-label">Project name</span><input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="Guidance System" autoFocus /></label>
            <label className="field"><span className="field-label">Project prefix</span><input className="mono" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="GS" pattern="[\p{L}\p{N}_]*" /><span className="field-hint">Optional. Letters, numbers and underscores. IDs look like <Code>REQ-{(prefix || 'GS').toUpperCase()}-COMPL-001</Code></span></label>
            <div className="form-actions"><Button onClick={() => void navigate('home')}>Cancel</Button><Button type="submit" tone="primary" icon="folderOpen" disabled={busy || !name.trim()}>Choose workspace folder</Button></div>
          </form></section>
        : panel === 'app' && state ? <AppSettingsView settings={state.settings} path={state.configPath} busy={busy} onCancel={() => setPanel('home')} onSave={general => void run(() => window.hlr.saveSettings(general))} />
        : panel === 'project' && current ? <ProjectSettings current={current.workspace.config} workspace={current.workspace} busy={busy} onCancel={() => void navigate('home')} onSave={updateConfig} onDraft={onDraft} />
        : <section className="home">
          <div className="hero"><Eyebrow icon="requirement">Requirements engineering</Eyebrow><h1>{current ? current.workspace.config.projectName : 'Write requirements that last.'}</h1><p>{current ? 'Components, requirement sets and permanent IDs, saved as readable files.' : 'Structure systems into components, group requirements into sets, keep IDs immutable.'}</p></div>
          <div className="launch">
            <button className="launch-tile" disabled={busy} onClick={() => { setName(''); setPanel('new'); }}><Icon name="filePlus" size={28} /><strong>Create project</strong><span>New workspace with your own naming rules</span></button>
            <button className="launch-tile" disabled={busy} onClick={() => void run(() => window.hlr.openProject())}><Icon name="folderOpen" size={28} /><strong>Open project</strong><span>Continue a workspace on this computer</span></button>
            <button className="launch-tile launch-team" disabled={busy} onClick={() => void goOnline()}><Icon name="users" size={28} /><strong>Join a team</strong><span>Connect to a collaboration server</span></button>
          </div>
          {current && totals ? <section className="panel overview">
            <header className="panel-head"><h2><Icon name="grid" />Project overview</h2><div className="panel-actions">
              <ButtonGroup label="Export"><Button icon="download" disabled={busy} onClick={() => void exportFile({ format: 'csv' })}>CSV</Button><Button icon="download" disabled={busy} onClick={() => void exportFile({ format: 'markdown' })}>Markdown</Button></ButtonGroup>
              <ButtonGroup label="Configure"><Button icon="database" disabled={busy} onClick={() => void navigate('project')}>Data definition</Button></ButtonGroup>
            </div></header>
            <div className="stats"><div><strong>{totals.items}</strong><span>Items</span></div><div><strong>{totals.sets}</strong><span>Requirement sets</span></div><div><strong>{totals.components}</strong><span>Components</span></div><div><strong className="mono">{current.workspace.config.projectPrefix || '—'}</strong><span>Project prefix</span></div></div>
            <div className="filepath"><Icon name="folderOpen" size={14} />{current.root}</div>
            {current.index.status === 'unavailable' && <Alert>Search index unavailable: {current.index.error}. Your JSON workspace is still available.</Alert>}
          </section>
          : <section className="panel recent"><header className="panel-head"><h2><Icon name="history" />Recent projects</h2></header>
            {state?.settings.recentProjects.length ? state.settings.recentProjects.map((root, i) => <button className="recent-row" key={root} disabled={busy} onClick={() => void run(() => window.hlr.openRecent(i))}><Icon name="folderOpen" /><span><strong>{root.split(/[\\/]/).pop()}</strong><small>{root}</small></span><Icon name="arrowRight" /></button>)
              : <Empty icon="folderOpen" title="Nothing here yet">Projects you create or open show up here.</Empty>}
          </section>}
        </section>}
      </main>
    </div>
    {searchOpen && current && <SearchDialog onClose={() => setSearchOpen(false)} onOpen={hit => void (async () => { if (panel === 'hierarchy' && selected?.id === hit.requirementSetId || await mayLeave()) { setSelected({ objectType: hit.objectType, kind: 'requirementSet', id: hit.requirementSetId }); setFocusedItem(hit.id); setPanel('hierarchy'); setSearchOpen(false); } })()} />}
    {editor && current && <HierarchyDialog workspace={current.workspace} editor={editor} busy={busy} onClose={() => setEditor(null)} onSave={changeHierarchy} />}
    <StatusBar items={[
      { icon: busy ? 'refresh' : dirty ? 'edit' : 'check', text: busy ? 'Working…' : dirty ? 'Unsaved edits' : 'Saved', tone: dirty ? 'accent' : undefined },
      { icon: 'database', text: current ? `SQLite index ${current.index.status === 'ready' ? 'OK' : 'unavailable'}` : 'No workspace open' },
      ...totals ? [{ icon: 'list' as const, text: plural(totals.items, 'item') }] : [],
    ]} />
  </div>;
}
