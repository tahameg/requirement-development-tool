import React, { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../shared/types/workspace.js';
import { hierarchyCommandSchema, objectLabels, type HierarchyCommand, type HierarchySelection } from '../../../shared/hierarchy.js';
import { nodeTerm, plural } from '../../../shared/terminology.js';
import { formatId } from '../../../shared/utils/idUtils.js';
import { Modal } from '../ui/Modal.js';
import { Alert, Button, Code, Field } from '../ui/primitives.js';
import { Icon } from '../ui/Icon.js';
import type { GhostNode, TreeAction } from './WorkspaceTree.js';
export interface HierarchyEditor { action: TreeAction; selection: HierarchySelection; }
export function HierarchyDialog({ workspace, editor, busy, onClose, onSave, onNameChange, peers = [] }: {
  /** Disables the form for outside reasons (offline busy, no permission). Saving is tracked here. */
  workspace: Workspace; editor: HierarchyEditor; busy: boolean; onClose: () => void; onSave: (command: HierarchyCommand) => Promise<void>;
  /** Called while a new node is being named, so collaborators can see it take shape. */
  onNameChange?: (name: string) => void; peers?: GhostNode[];
}) {
  const { action, selection } = editor;
  const domain = workspace.domains[selection.objectType];
  const component = domain.components.find(c => c.id === selection.id);
  const set = domain.requirementSets.find(s => s.requirementSetId === selection.id);
  const target = component ?? set;
  const editing = action === 'edit';
  const deleting = action === 'delete';
  const setMode = action === 'addRequirementSet' || (editing || deleting) && selection.kind === 'requirementSet';
  const [name, setName] = useState(editing ? target?.name ?? '' : '');
  const [prefix, setPrefix] = useState(editing ? target?.prefix ?? '' : '');
  const [description, setDescription] = useState(editing ? target?.description ?? '' : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const disabled = busy || saving;
  useEffect(() => { if (!editing && !deleting) onNameChange?.(name); }, [name]);
  // autoFocus is lost if the form mounts disabled; focus once it can take input.
  useEffect(() => { if (!disabled && !nameInput.current?.closest('dialog')?.contains(document.activeElement)) nameInput.current?.focus(); }, [disabled]);
  const parentId = editing || deleting ? component?.parentId ?? set?.parentComponentId ?? null : selection.id;
  const term = editing || deleting ? nodeTerm(selection.kind, parentId) : setMode ? 'Requirement set' : nodeTerm('component', parentId);
  const deletedComponents = new Set<string>();
  if (deleting && component) {
    deletedComponents.add(component.id);
    let size = -1;
    while (size !== deletedComponents.size) { size = deletedComponents.size; domain.components.forEach(c => { if (c.parentId && deletedComponents.has(c.parentId)) deletedComponents.add(c.id); }); }
  }
  const deletedSets = deleting ? domain.requirementSets.filter(s => deletedComponents.has(s.parentComponentId) || s.requirementSetId === set?.requirementSetId) : [];
  const itemCount = deletedSets.reduce((n, s) => n + s.items.length, 0);
  const parents = [];
  let cursor = parentId;
  while (cursor) { const parent = domain.components.find(c => c.id === cursor); if (!parent) break; parents.unshift(parent); cursor = parent.parentId; }
  const example = formatId(workspace.config, selection.objectType, [...parents.map(c => c.prefix), ...setMode ? [] : [prefix]], setMode ? prefix || 'SET' : 'SET', 1);
  const siblingNames = setMode ? domain.requirementSets.filter(s => s.parentComponentId === parentId && s.requirementSetId !== set?.requirementSetId).map(s => s.name) : [];
  const duplicate = setMode && siblingNames.some(n => n.trim().toLowerCase() === name.trim().toLowerCase());
  const racing = peers.filter(p => p.parentId === parentId && p.kind === (setMode ? 'requirementSet' : 'component') && p.name.trim());
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const command = deleting
      ? { action: setMode ? 'deleteRequirementSet' : 'deleteComponent', objectType: selection.objectType, id: selection.id }
      : editing
        ? { action: setMode ? 'editRequirementSet' : 'editComponent', objectType: selection.objectType, id: selection.id, name, prefix, description }
        : { action, objectType: selection.objectType, parentId: selection.id, name, prefix, description };
    const result = hierarchyCommandSchema.safeParse(command);
    if (!result.success) { setError(result.error.issues[0]?.message ?? 'Check the fields'); return; }
    setSaving(true);
    try { await onSave(result.data); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes'); }
    finally { setSaving(false); }
  }
  const title = deleting ? `Delete ${target?.name}?` : editing ? `${term} properties` : `New ${term.toLowerCase()}`;
  return <Modal title={title} eyebrow={<>{objectLabels[selection.objectType]}{parents.map(p => <span key={p.id}> / {p.name}</span>)}</>} icon={deleting ? 'trash' : setMode ? 'requirementSet' : parentId ? 'subcomponent' : 'component'}
    onClose={() => { if (!saving) onClose(); }} labelledBy="hierarchy-dialog-title" className={`hierarchy-dialog${deleting ? ' modal-danger' : ''}`}
    footer={<><Button disabled={saving} autoFocus={deleting} onClick={onClose}>Cancel</Button>
      <Button type="submit" form="hierarchy-form" tone={deleting ? 'danger' : 'primary'} icon={deleting ? 'trash' : editing ? 'save' : 'plus'} disabled={disabled || duplicate}>{saving ? 'Saving…' : deleting ? 'Delete permanently' : editing ? 'Save changes' : `Create ${term.toLowerCase()}`}</Button></>}>
    <form id="hierarchy-form" onSubmit={event => void submit(event)}>
      {error && <Alert>{error}</Alert>}
      {deleting ? <div className="delete-summary">
        <div className="delete-counts"><span><strong>{deletedComponents.size}</strong>{deletedComponents.size === 1 ? 'component' : 'components'}</span><span><strong>{deletedSets.length}</strong>{deletedSets.length === 1 ? 'requirement set' : 'requirement sets'}</span><span><strong>{itemCount}</strong>{itemCount === 1 ? 'item' : 'items'}</span></div>
        <p>This removes {plural(deletedComponents.size, 'component')}, {plural(deletedSets.length, 'requirement set')}, and {plural(itemCount, 'item')} from this workspace.</p>
        <Alert tone="info" icon="lock">Deleted item IDs stay retired forever. This cannot be undone.</Alert>
      </div>
      : <fieldset disabled={disabled}>
        <div className="form-row">
          <Field label="Name" className="grow" error={duplicate ? `Another requirement set here is already called “${name.trim()}”.` : undefined}><input ref={nameInput} name="name" required maxLength={200} autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={setMode ? 'e.g. tsCreateParser' : 'e.g. Compiler'} /></Field>
          <Field label={setMode ? 'Prefix' : 'Prefix (optional)'} className="prefix-field"><input name="prefix" className="mono" required={setMode} value={prefix} onChange={e => setPrefix(e.target.value)} placeholder={setMode ? 'TSCRTPRSR' : 'COMPL'} /></Field>
        </div>
        <p className="field-hint">Letters, numbers and underscores.{!setMode && ' Leave the prefix empty to keep this component out of item IDs.'}</p>
        <div className="id-preview"><span className="eyebrow"><Icon name="hash" size={12} />First item ID</span><Code big>{example}</Code>{editing && <small>Existing item IDs never change.</small>}</div>
        {racing.length > 0 && <Alert tone="accent" icon="users">{racing.map(p => `${p.person.name} is creating “${p.name.trim()}”`).join(' · ')} here right now.</Alert>}
        <Field label="Description"><textarea name="description" rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Scope, inputs, outputs, rationale" /></Field>
      </fieldset>}
    </form>
  </Modal>;
}
