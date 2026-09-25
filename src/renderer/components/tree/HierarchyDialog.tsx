import React, { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../shared/types/workspace.js';
import { hierarchyCommandSchema, objectLabels, type HierarchyCommand, type HierarchySelection } from '../../../shared/hierarchy.js';
import { formatId } from '../../../shared/utils/idUtils.js';
import type { TreeAction } from './WorkspaceTree.js';
export interface HierarchyEditor { action: TreeAction; selection: HierarchySelection; }
export function HierarchyDialog({ workspace, editor, busy, onClose, onSave }: {
  workspace: Workspace; editor: HierarchyEditor; busy: boolean; onClose: () => void; onSave: (command: HierarchyCommand) => Promise<void>;
}) {
  const { action, selection } = editor;
  const domain = workspace.domains[selection.objectType];
  const module = domain.modules.find(m => m.id === selection.id);
  const fn = domain.functions.find(f => f.functionId === selection.id);
  const target = module ?? fn;
  const editing = action === 'edit';
  const deleting = action === 'delete';
  const functionMode = action === 'addFunction' || (editing || deleting) && selection.kind === 'function';
  const [name, setName] = useState(editing ? target?.name ?? '' : '');
  const [prefix, setPrefix] = useState(editing ? target?.prefix ?? '' : '');
  const [description, setDescription] = useState(editing ? target?.description ?? '' : '');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const deletedModules = new Set<string>();
  if (deleting && module) {
    deletedModules.add(module.id);
    let size = -1;
    while (size !== deletedModules.size) { size = deletedModules.size; domain.modules.forEach(m => { if (m.parentId && deletedModules.has(m.parentId)) deletedModules.add(m.id); }); }
  }
  const deletedFunctions = deleting ? domain.functions.filter(f => deletedModules.has(f.parentModuleId) || f.functionId === fn?.functionId) : [];
  const itemCount = deletedFunctions.reduce((n, f) => n + f.items.length, 0);
  const parents = [];
  let parentId = editing ? module?.parentId ?? fn?.parentModuleId : selection.id;
  while (parentId) { const parent = domain.modules.find(m => m.id === parentId); if (!parent) break; parents.unshift(parent); parentId = parent.parentId; }
  const example = formatId(workspace.config, selection.objectType, [...parents.map(m => m.prefix), ...functionMode ? [] : [prefix]], functionMode ? prefix || 'FUNCTION' : 'FUNCTION', 1);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const command = deleting
      ? { action: functionMode ? 'deleteFunction' : 'deleteModule', objectType: selection.objectType, id: selection.id }
      : editing
        ? { action: functionMode ? 'editFunction' : 'editModule', objectType: selection.objectType, id: selection.id, name, prefix, description }
        : { action, objectType: selection.objectType, parentId: selection.id, name, prefix, description };
    const result = hierarchyCommandSchema.safeParse(command);
    if (!result.success) { setError(result.error.issues[0]?.message ?? 'Check the fields'); return; }
    try { await onSave(result.data); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes'); }
  }
  return <dialog ref={dialog} className="hierarchy-dialog" aria-labelledby="hierarchy-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => void submit(event)}><div className="eyebrow">{objectLabels[selection.objectType]}</div><h2 id="hierarchy-dialog-title">{deleting ? `Delete ${target?.name}?` : editing ? `${functionMode ? 'Function' : 'Module'} properties` : action === 'addFunction' ? 'Add function' : selection.kind === 'root' ? 'Add module' : 'Add submodule'}</h2>
    {error && <p className="error" role="alert">{error}</p>}
    {deleting ? <><p>This removes {deletedModules.size} module{deletedModules.size === 1 ? '' : 's'}, {deletedFunctions.length} function{deletedFunctions.length === 1 ? '' : 's'}, and {itemCount} item{itemCount === 1 ? '' : 's'} from this workspace.</p><p>Deleted item IDs stay retired. This cannot be undone.</p></>
      : <fieldset disabled={busy}><label>Name<input name="name" required maxLength={200} autoFocus value={name} onChange={e => setName(e.target.value)} /></label><label>{functionMode ? 'Function prefix' : 'Module prefix (optional)'}<input name="prefix" required={functionMode} value={prefix} onChange={e => setPrefix(e.target.value)} /></label><p className="hint">Letters, numbers and underscores.{!functionMode && ' Leave empty to omit this module from item IDs.'}</p><div className="id-preview"><span>ID format example</span><code>{example}</code></div>{editing && <p className="hint">Existing item IDs remain unchanged.</p>}<label>Description<textarea name="description" rows={4} value={description} onChange={e => setDescription(e.target.value)} /></label></fieldset>}
    <div className="actions"><button type="button" disabled={busy} autoFocus={deleting} onClick={onClose}>Cancel</button><button className={deleting ? 'danger' : 'primary'} disabled={busy}>{busy ? 'Saving…' : deleting ? 'Delete permanently' : editing ? 'Save changes' : functionMode ? 'Create function' : 'Create module'}</button></div></form>
  </dialog>;
}
