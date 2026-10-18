import React, { useEffect, useState } from 'react';
import { objectTypes } from '../../../shared/types/schema.js';
import type { Workspace } from '../../../shared/types/workspace.js';
import type { ObjectType } from '../../../shared/types/config.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
import { nodeTerm } from '../../../shared/terminology.js';
import { Icon, objectIcons, type IconName } from '../ui/Icon.js';
import { AvatarStack } from '../ui/primitives.js';
export type TreeAction = 'addComponent' | 'addRequirementSet' | 'edit' | 'delete';
export interface Person { id: string; name: string; color: string }
/** A node a peer is naming in the create dialog. */
export interface GhostNode { id: string; objectType: ObjectType; kind: 'component' | 'requirementSet'; parentId: string | null; name: string; person: Person }
export interface NodeLock { name: string; color: string; mine: boolean }
interface Props {
  readOnly?: boolean; allowDelete?: boolean;
  viewers?: Record<string, Person[]>; ghosts?: GhostNode[]; locks?: Record<string, NodeLock>;
  workspace?: Workspace; selected: HierarchySelection | null; busy: boolean;
  onSelect: (selection: HierarchySelection) => void;
  onAction: (action: TreeAction, selection: HierarchySelection) => void;
}
export function nodeIcon(selection: Pick<HierarchySelection, 'kind' | 'objectType'>, parentId?: string | null): IconName {
  if (selection.kind === 'root') return objectIcons[selection.objectType];
  if (selection.kind === 'requirementSet') return 'requirementSet';
  return parentId ? 'subcomponent' : 'component';
}
export function NodeIcon({ selection, parentId, size }: { selection: Pick<HierarchySelection, 'kind' | 'objectType'>; parentId?: string | null; size?: number }) {
  return <span className={`node-icon node-icon-${selection.kind}`}><Icon name={nodeIcon(selection, parentId)} size={size} /></span>;
}
const selectionKey = (s: HierarchySelection) => s.id ?? s.objectType;
export function WorkspaceTree({ workspace, selected, busy, onSelect, onAction, readOnly = false, allowDelete = true, viewers = {}, ghosts = [], locks = {} }: Props) {
  const [query, setQuery] = useState('');
  const [focusedKey, setFocusedKey] = useState<string>(objectTypes[0]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(objectTypes));
  const [menu, setMenu] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...text: string[]) => text.some(value => value.toLocaleLowerCase().includes(needle));
  useEffect(() => {
    if (!selected || !workspace) return;
    const domain = workspace.domains[selected.objectType];
    let id = selected.kind === 'requirementSet' ? domain.requirementSets.find(set => set.requirementSetId === selected.id)?.parentComponentId : selected.id;
    const parents = [selected.objectType as string];
    while (id) { parents.push(id); id = domain.components.find(c => c.id === id)?.parentId; }
    setExpanded(previous => parents.every(p => previous.has(p)) ? previous : new Set([...previous, ...parents]));
    setFocusedKey(selectionKey(selected));
  }, [selected, workspace]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.tree-menu, .tree-more')) setMenu(null); };
    window.addEventListener('mousedown', close); return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  function act(action: TreeAction, selection: HierarchySelection) { setMenu(null); onAction(action, selection); }
  function renderGhost(ghost: GhostNode, level: number) {
    return <li key={`ghost:${ghost.id}`} className="tree-ghost" role="none" style={{ '--user': ghost.person.color } as React.CSSProperties} aria-label={`${ghost.person.name} is creating ${ghost.kind === 'component' ? 'a component' : 'a requirement set'}`}>
      <div className="tree-row" style={{ '--level': level } as React.CSSProperties}>
        <span className="tree-toggle" />
        <span className="tree-select"><Icon name={ghost.kind === 'requirementSet' ? 'requirementSet' : ghost.parentId ? 'subcomponent' : 'component'} />
          <span className="node-name">{ghost.name.trim() || 'Untitled'}</span>
          <span className="ghost-tag">{ghost.person.name.split(' ')[0]} is creating…</span>
        </span>
      </div>
    </li>;
  }
  function renderNode(selection: HierarchySelection, label: string, prefix: string, level: number, parentId: string | null, ancestorMatches = false): React.ReactNode {
    const key = selectionKey(selection);
    const domain = workspace?.domains[selection.objectType];
    const sets = selection.kind === 'component' ? domain?.requirementSets.filter(set => set.parentComponentId === selection.id) ?? [] : [];
    const components = selection.kind !== 'requirementSet' ? domain?.components.filter(c => c.parentId === selection.id) ?? [] : [];
    const set = selection.kind === 'requirementSet' ? domain?.requirementSets.find(s => s.requirementSetId === selection.id) : undefined;
    const ownMatch = ancestorMatches || matches(label, prefix, key, ...set?.items.map(item => item.id) ?? []);
    const childGhosts = selection.kind === 'requirementSet' || needle ? [] : ghosts.filter(g => g.objectType === selection.objectType && g.parentId === selection.id);
    const children = [
      ...components.map(c => renderNode({ objectType: selection.objectType, kind: 'component', id: c.id }, c.name, c.prefix, level + 1, c.parentId, ownMatch)),
      ...sets.map(s => renderNode({ objectType: selection.objectType, kind: 'requirementSet', id: s.requirementSetId }, s.name, s.prefix, level + 1, s.parentComponentId, ownMatch)),
    ].filter(Boolean);
    if (needle && !ownMatch && !children.length) return null;
    const canExpand = children.length > 0;
    const isExpanded = !!needle || expanded.has(key) || childGhosts.length > 0;
    const active = !!selected && selectionKey(selected) === key;
    const enabled = !readOnly && !!workspace?.config.objectTypes[selection.objectType].enabled;
    const lock = locks[key];
    const watching = viewers[key] ?? [];
    const term = nodeTerm(selection.kind, parentId);
    return <li key={key} role="treeitem" aria-label={label} aria-level={level} aria-selected={active} aria-expanded={canExpand ? isExpanded : undefined} tabIndex={key === focusedKey || !!needle && level === 1 ? 0 : -1}
      className={`tree-item tree-${selection.kind}${selection.kind === 'root' ? ` root-${selection.objectType}` : ''}`}
      onFocus={event => { if ((event.target as HTMLElement).closest('[role=treeitem]') === event.currentTarget) setFocusedKey(key); }}
      data-node-key={key} onKeyDown={event => {
        if ((event.target as HTMLElement).closest('[role=treeitem]') !== event.currentTarget || (event.target as HTMLElement).closest('[role=menu]')) return;
        const item = event.currentTarget;
        const visible = [...item.closest('[role=tree]')!.querySelectorAll<HTMLElement>('[role=treeitem]')];
        const index = visible.indexOf(item);
        if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
        if (event.key === 'ArrowDown') visible[index + 1]?.focus();
        if (event.key === 'ArrowUp') visible[index - 1]?.focus();
        if (event.key === 'Home') visible[0]?.focus();
        if (event.key === 'End') visible.at(-1)?.focus();
        if (event.key === 'ArrowRight') { if (canExpand && !isExpanded) toggle(key); else item.querySelector<HTMLElement>('[role=group] [role=treeitem]')?.focus(); }
        if (event.key === 'ArrowLeft') { if (canExpand && isExpanded && !needle) toggle(key); else item.parentElement?.closest<HTMLElement>('[role=treeitem]')?.focus(); }
        if ((event.key === 'Enter' || event.key === ' ') && !busy) onSelect(selection);
        if ((event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && enabled && !busy) { event.preventDefault(); setMenu(key); }
        if (event.key === 'Escape') setMenu(null);
      }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy && enabled) setMenu(key); }}>
      <div className={`tree-row${active ? ' active' : ''}${lock && !lock.mine ? ' locked' : ''}`} style={{ '--level': level, ...lock && !lock.mine ? { '--user': lock.color } : {} } as React.CSSProperties}>
        {canExpand ? <button className="tree-toggle" tabIndex={-1} aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`} disabled={!!needle} onClick={() => toggle(key)}><Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={14} /></button> : <span className="tree-toggle" />}
        <button className="tree-select" disabled={busy} tabIndex={-1} onClick={() => onSelect(selection)} title={`${term}: ${label}${prefix ? ` [${prefix}]` : ''}`}>
          <NodeIcon selection={selection} parentId={parentId} /><span className="node-name">{label}</span>
          {prefix && <span className="node-prefix">{prefix}</span>}
          {selection.kind === 'requirementSet' && set && <span className="node-count">{set.items.length}</span>}
        </button>
        {lock && !lock.mine && <span className="tree-lock" title={`${lock.name} is editing these properties`}><Icon name="lock" size={12} /></span>}
        <AvatarStack people={watching} max={2} />
        {enabled && <button className="tree-more" tabIndex={-1} aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={menu === key} onClick={() => setMenu(menu === key ? null : key)}><Icon name="more" size={14} /></button>}
      </div>
      {menu === key && enabled && <div className="tree-menu" role="menu" aria-label={`${label} actions`}>
        {selection.kind !== 'requirementSet' && <div className="menu-section" role="group" aria-label="Create">
          <span className="menu-title">Create</span>
          <button role="menuitem" onClick={() => act('addComponent', selection)}><Icon name={selection.kind === 'root' ? 'component' : 'subcomponent'} />{selection.kind === 'root' ? 'Component' : 'Subcomponent'}</button>
          {selection.kind === 'component' && <button role="menuitem" onClick={() => act('addRequirementSet', selection)}><Icon name="requirementSet" />Requirement set</button>}
        </div>}
        {selection.kind !== 'root' && <div className="menu-section" role="group" aria-label="Edit">
          <span className="menu-title">Edit</span>
          <button role="menuitem" disabled={!!lock && !lock.mine} onClick={() => act('edit', selection)}><Icon name="edit" />Rename / properties{lock && !lock.mine && <small> · {lock.name}</small>}</button>
        </div>}
        {selection.kind !== 'root' && allowDelete && <div className="menu-section menu-danger" role="group" aria-label="Danger">
          <button role="menuitem" className="danger-text" onClick={() => act('delete', selection)}><Icon name="trash" />Delete {term.toLowerCase()}</button>
        </div>}
      </div>}
      {(canExpand || childGhosts.length > 0) && isExpanded && <ul role="group">{children}{childGhosts.map(g => renderGhost(g, level + 1))}</ul>}
    </li>;
  }
  const roots = objectTypes.map(type => renderNode({ objectType: type, kind: 'root', id: null }, objectLabels[type], '', 1, null)).filter(Boolean);
  return <div className="workspace-tree">
    <label className="tree-search"><Icon name="search" size={14} /><span className="sr-only">Search workspace tree</span><input type="search" placeholder="Filter names, prefixes, IDs" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <ul role="tree" aria-label="Workspace hierarchy">{roots}</ul>
    {!roots.length && <p className="hint tree-empty">No matching objects.</p>}
  </div>;
}
