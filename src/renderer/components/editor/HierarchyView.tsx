import { FunctionEditor, type DraftListener } from './FunctionEditor.js';
import type { FunctionEdit, ExportRequest } from '../../../shared/authoring.js';
import React from 'react';
import type { Workspace } from '../../../shared/types/workspace.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
import { formatId } from '../../../shared/utils/idUtils.js';
import { NodeIcon, type TreeAction } from '../tree/WorkspaceTree.js';
interface Props {
  workspace?: Workspace; selected: HierarchySelection; busy: boolean;
  onSelect: (selection: HierarchySelection, itemId?: string) => void; onAction: (action: TreeAction, selection: HierarchySelection) => void;
  onCreate: () => void; onOpen: () => void;
  onSave: (command: FunctionEdit) => Promise<void>; onDraft: DraftListener; autosave: number;
  onExport: (request: ExportRequest) => void; focusedItem?: string | null;
}
export function HierarchyView({ workspace, selected, busy, onSelect, onAction, onCreate, onOpen, onSave, onDraft, autosave, onExport, focusedItem }: Props) {
  const domain = workspace?.domains[selected.objectType];
  const module = selected.kind === 'module' ? domain?.modules.find(m => m.id === selected.id) : undefined;
  const fn = selected.kind === 'function' ? domain?.functions.find(f => f.functionId === selected.id) : undefined;
  const title = module?.name ?? fn?.name ?? objectLabels[selected.objectType];
  const ancestors = [];
  let parent = fn?.parentModuleId ?? module?.parentId;
  while (parent) { const ancestor = domain?.modules.find(m => m.id === parent); if (!ancestor) break; ancestors.unshift(ancestor); parent = ancestor.parentId; }
  const enabled = workspace?.config.objectTypes[selected.objectType].enabled;
  const modules = domain?.modules.filter(m => m.parentId === selected.id) ?? [];
  const functions = selected.kind === 'module' ? domain?.functions.filter(f => f.parentModuleId === selected.id) ?? [] : [];
  let preview = '';
  if (workspace && fn) {
    let seq = fn.watermarkCounter + 1;
    const used = new Set([...workspace.retiredIds, ...Object.values(workspace.domains).flatMap(d => d.functions.flatMap(f => f.items.map(i => i.id)))]);
    do { preview = formatId(workspace.config, selected.objectType, ancestors.map(m => m.prefix), fn.prefix, seq++); } while (used.has(preview));
  }
  return <section className="hierarchy-view">
    <nav className="breadcrumbs" aria-label="Breadcrumb">{selected.kind !== 'root' ? <button onClick={() => onSelect({ objectType: selected.objectType, kind: 'root', id: null })}>{objectLabels[selected.objectType]}</button> : <span>{objectLabels[selected.objectType]}</span>}{ancestors.map(ancestor => <React.Fragment key={ancestor.id}><span aria-hidden="true">/</span><button onClick={() => onSelect({ objectType: selected.objectType, kind: 'module', id: ancestor.id })}>{ancestor.name}</button></React.Fragment>)}{selected.kind !== 'root' && <><span aria-hidden="true">/</span><span aria-current="page">{title}</span></>}</nav>
    <div className="page-heading"><div><div className="eyebrow">{selected.kind === 'function' ? 'FUNCTION GROUP' : selected.kind === 'module' ? 'MODULE' : 'OBJECT TYPE'}</div><h1><NodeIcon kind={selected.kind} /> {title}</h1><p>{fn ? 'Function scope and permanent item identifiers.' : module ? 'Organize submodules and function groups within this module.' : 'Organize your workspace into modules and function groups.'}</p></div>{enabled && selected.kind !== 'root' && <div className="heading-actions"><button onClick={() => onAction('edit', selected)} disabled={busy}>Properties</button><button className="danger-text" onClick={() => onAction('delete', selected)} disabled={busy}>Delete</button></div>}</div>
    {!workspace ? <div className="empty"><h2>Open a project to view {objectLabels[selected.objectType].toLowerCase()}</h2><p>Create a workspace or choose a project folder on this computer.</p><div className="actions centered"><button onClick={onOpen} disabled={busy}>Open project</button><button className="primary" onClick={onCreate}>Create project</button></div></div>
      : <>{!enabled && <p className="notice">This object type is disabled in project settings. Existing content is available to view.</p>}
        {module && <section className="scope-card"><div className="section-heading"><h2>Scope</h2><span className="prefix-badge">Prefix: {(module ?? fn)!.prefix || 'None'}</span></div><p className="description-text">{(module ?? fn)!.description || 'No description yet. Add a scope description in Properties.'}</p>{fn && <div className="id-preview"><span>Next item ID</span><code>{preview}</code></div>}</section>}
        {fn ? <FunctionEditor key={fn.functionId} workspace={workspace} fn={fn} objectType={selected.objectType} busy={busy} preview={preview} autosave={autosave} onSave={onSave} onDraft={onDraft} onSelect={onSelect} onExport={onExport} focusedItem={focusedItem} />
        : <section className="workspace-card"><div className="section-heading"><h2>Contents <span className="count">{modules.length + functions.length}</span></h2>{enabled && <div className="heading-actions"><button disabled={busy} onClick={() => onAction('addModule', selected)}>{module ? 'Add submodule' : 'Add module'}</button>{module && <button className="primary" disabled={busy} onClick={() => onAction('addFunction', selected)}>Add function</button>}</div>}</div><div className="contents-list">{modules.map(child => <button className="content-row" key={child.id} onClick={() => onSelect({ objectType: selected.objectType, kind: 'module', id: child.id })}><NodeIcon kind="module" /><span><strong>{child.name}</strong><small>Module{child.prefix ? ` · ${child.prefix}` : ' · No prefix'}</small></span><span aria-hidden="true">→</span></button>)}{functions.map(child => <button className="content-row" key={child.functionId} onClick={() => onSelect({ objectType: selected.objectType, kind: 'function', id: child.functionId })}><NodeIcon kind="function" /><span><strong>{child.name}</strong><small>Function · {child.prefix} · {child.items.length} items</small></span><span aria-hidden="true">→</span></button>)}</div>{!modules.length && !functions.length && <div className="empty"><h3>{module ? 'This module is empty' : 'No modules yet'}</h3><p>{module ? 'Add a submodule to organize further, or a function to group items.' : 'Add your first module to begin organizing this section.'}</p></div>}</section>}
      </>}
  </section>;
}
