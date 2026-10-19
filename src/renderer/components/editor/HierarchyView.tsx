import React from 'react';
import type { RequirementSet, Workspace } from '../../../shared/types/workspace.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
import { nodeTerm, plural } from '../../../shared/terminology.js';
import { formatId } from '../../../shared/utils/idUtils.js';
import { NodeIcon, type GhostNode, type Person, type TreeAction } from '../tree/WorkspaceTree.js';
import { Icon, objectIcons } from '../ui/Icon.js';
import { AvatarStack, Button, ButtonGroup, Code, Empty, IconButton, Alert } from '../ui/primitives.js';
interface Props {
  workspace: Workspace; selected: HierarchySelection; busy: boolean; readOnly?: boolean; allowDelete?: boolean;
  onSelect: (selection: HierarchySelection, itemId?: string) => void; onAction: (action: TreeAction, selection: HierarchySelection) => void;
  /** Renders the editor for a requirement set; offline and room editors differ in how they save. */
  renderSet: (set: RequirementSet, nextId: string) => React.ReactNode;
  ghosts?: GhostNode[]; viewers?: Record<string, Person[]>;
}
export function nextItemId(workspace: Workspace, objectType: HierarchySelection['objectType'], set: RequirementSet): string {
  const domain = workspace.domains[objectType];
  const prefixes: string[] = [];
  let parent: string | null = set.parentComponentId;
  while (parent) { const c = domain.components.find(x => x.id === parent); if (!c) break; prefixes.unshift(c.prefix); parent = c.parentId; }
  const used = new Set([...workspace.retiredIds, ...Object.values(workspace.domains).flatMap(d => d.requirementSets.flatMap(s => s.items.map(i => i.id)))]);
  let seq = set.watermarkCounter + 1, id: string;
  do { id = formatId(workspace.config, objectType, prefixes, set.prefix, seq++); } while (used.has(id));
  return id;
}
export function HierarchyView({ workspace, selected, busy, readOnly = false, allowDelete = true, onSelect, onAction, renderSet, ghosts = [], viewers = {} }: Props) {
  const domain = workspace.domains[selected.objectType];
  const component = selected.kind === 'component' ? domain.components.find(c => c.id === selected.id) : undefined;
  const set = selected.kind === 'requirementSet' ? domain.requirementSets.find(s => s.requirementSetId === selected.id) : undefined;
  if (selected.kind !== 'root' && !component && !set) return <Empty icon="warning" title="This node no longer exists">Someone may have deleted it. Pick another node in the tree.</Empty>;
  const title = component?.name ?? set?.name ?? objectLabels[selected.objectType];
  const ancestors = [];
  let parent = set?.parentComponentId ?? component?.parentId;
  while (parent) { const ancestor = domain.components.find(c => c.id === parent); if (!ancestor) break; ancestors.unshift(ancestor); parent = ancestor.parentId; }
  const enabled = workspace.config.objectTypes[selected.objectType].enabled && !readOnly;
  const components = domain.components.filter(c => c.parentId === selected.id);
  const sets = selected.kind === 'component' ? domain.requirementSets.filter(s => s.parentComponentId === selected.id) : [];
  const childGhosts = ghosts.filter(g => g.objectType === selected.objectType && g.parentId === selected.id);
  const term = nodeTerm(selected.kind, component?.parentId);
  const nextId = set ? nextItemId(workspace, selected.objectType, set) : '';
  const prefix = (component ?? set)?.prefix;
  const descendants = (id: string | null): number => domain.components.filter(c => c.parentId === id).reduce((n, c) => n + 1 + descendants(c.id), 0);
  const itemsUnder = (id: string): number => domain.requirementSets.filter(s => s.parentComponentId === id).reduce((n, s) => n + s.items.length, 0) + domain.components.filter(c => c.parentId === id).reduce((n, c) => n + itemsUnder(c.id), 0);
  return <section className={`node-view type-${selected.objectType}`}>
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Icon name={objectIcons[selected.objectType]} size={14} />
      {selected.kind !== 'root' ? <button onClick={() => onSelect({ objectType: selected.objectType, kind: 'root', id: null })}>{objectLabels[selected.objectType]}</button> : <span aria-current="page">{objectLabels[selected.objectType]}</span>}
      {ancestors.map(ancestor => <React.Fragment key={ancestor.id}><Icon name="chevronRight" size={12} /><button onClick={() => onSelect({ objectType: selected.objectType, kind: 'component', id: ancestor.id })}>{ancestor.name}</button></React.Fragment>)}
      {selected.kind !== 'root' && <><Icon name="chevronRight" size={12} /><span aria-current="page">{title}</span></>}
    </nav>
    <header className="node-head">
      <div className="node-badge"><NodeIcon selection={selected} parentId={component?.parentId} size={30} /></div>
      <div className="node-titles">
        <div className="eyebrow">{term}</div>
        <h1>{title}</h1>
        <div className="meta-strip">
          {selected.kind !== 'root' && <span className="meta"><span>Prefix</span><Code>{prefix || '—'}</Code></span>}
          {set && <span className="meta"><span>Next ID</span><Code>{nextId}</Code></span>}
          {set && <span className="meta"><span>Items</span><strong>{set.items.length}</strong></span>}
          {!set && <span className="meta"><span>Contains</span><strong>{plural(components.length, selected.kind === 'root' ? 'component' : 'subcomponent')} · {plural(sets.length, 'set')}</strong></span>}
          <AvatarStack people={viewers[selected.id ?? selected.objectType] ?? []} max={4} />
        </div>
      </div>
      {enabled && <div className="node-actions">
        {selected.kind !== 'requirementSet' && <ButtonGroup label="Create">
          <Button icon={selected.kind === 'root' ? 'component' : 'subcomponent'} disabled={busy} onClick={() => onAction('addComponent', selected)}>{selected.kind === 'root' ? 'Component' : 'Subcomponent'}</Button>
          {selected.kind === 'component' && <Button icon="requirementSet" tone="primary" disabled={busy} onClick={() => onAction('addRequirementSet', selected)}>Requirement set</Button>}
        </ButtonGroup>}
        {selected.kind !== 'root' && <ButtonGroup label="Edit"><Button icon="edit" disabled={busy} onClick={() => onAction('edit', selected)}>Properties</Button></ButtonGroup>}
        {selected.kind !== 'root' && allowDelete && <ButtonGroup label="Danger"><IconButton icon="trash" tone="danger" label={`Delete ${term.toLowerCase()}`} disabled={busy} onClick={() => onAction('delete', selected)} /></ButtonGroup>}
      </div>}
    </header>
    {!workspace.config.objectTypes[selected.objectType].enabled && <Alert tone="info">This object type is disabled in project settings. Existing content stays readable.</Alert>}
    {set ? renderSet(set, nextId) : <>
      {component?.description && <p className="node-description">{component.description}</p>}
      <div className="contents-grid">
        {components.map(child => <button className="content-card" key={child.id} onClick={() => onSelect({ objectType: selected.objectType, kind: 'component', id: child.id })}>
          <span className="card-top"><NodeIcon selection={{ kind: 'component', objectType: selected.objectType }} parentId={child.parentId} size={22} /><AvatarStack people={viewers[child.id] ?? []} max={2} /></span>
          <strong>{child.name}</strong>
          <span className="card-meta"><Code>{child.prefix || 'no prefix'}</Code><span>{plural(descendants(child.id), 'subcomponent')} ·{plural(itemsUnder(child.id), 'item')}</span></span>
          <span className="card-kind">{nodeTerm('component', child.parentId)}</span>
        </button>)}
        {sets.map(child => <button className="content-card content-set" key={child.requirementSetId} onClick={() => onSelect({ objectType: selected.objectType, kind: 'requirementSet', id: child.requirementSetId })}>
          <span className="card-top"><NodeIcon selection={{ kind: 'requirementSet', objectType: selected.objectType }} size={22} /><AvatarStack people={viewers[child.requirementSetId] ?? []} max={2} /></span>
          <strong>{child.name}</strong>
          <span className="card-meta"><Code>{child.prefix}</Code><span>{plural(child.items.length, 'item')}</span></span>
          <span className="card-kind">Requirement set</span>
        </button>)}
        {childGhosts.map(ghost => <div key={ghost.id} className="content-card content-ghost" style={{ '--user': ghost.person.color } as React.CSSProperties} aria-label={`${ghost.person.name} is creating ${ghost.name || 'something'}`}>
          <span className="card-top"><Icon name={ghost.kind === 'requirementSet' ? 'requirementSet' : ghost.parentId ? 'subcomponent' : 'component'} size={22} /></span>
          <strong>{ghost.name.trim() || 'Untitled'}</strong>
          <span className="card-meta"><span>{ghost.person.name} is creating this…</span></span>
          <span className="card-kind">{ghost.kind === 'requirementSet' ? 'Requirement set' : nodeTerm('component', ghost.parentId)}</span>
        </div>)}
        {enabled && <div className="content-card content-add">
          <Button icon={selected.kind === 'root' ? 'component' : 'subcomponent'} disabled={busy} onClick={() => onAction('addComponent', selected)}>Add {selected.kind === 'root' ? 'component' : 'subcomponent'}</Button>
          {selected.kind === 'component' && <Button icon="requirementSet" disabled={busy} onClick={() => onAction('addRequirementSet', selected)}>Add requirement set</Button>}
        </div>}
      </div>
      {!components.length && !sets.length && !childGhosts.length && <p className="hint">{component ? 'Empty. Split it into subcomponents, or add a requirement set to start writing items.' : 'No components yet. Add the first one to start structuring this object type.'}</p>}
    </>}
  </section>;
}
