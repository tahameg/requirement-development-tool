import React, { useEffect, useState } from 'react';
import { objectTypes } from '../../../shared/types/schema.js';
import type { Workspace } from '../../../shared/types/workspace.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
export type TreeAction = 'addModule' | 'addFunction' | 'edit' | 'delete';
interface Props {
  readOnly?: boolean; allowDelete?: boolean; presence?: Record<string, string>;
  workspace?: Workspace; selected: HierarchySelection | null; busy: boolean;
  onSelect: (selection: HierarchySelection) => void;
  onAction: (action: TreeAction, selection: HierarchySelection) => void;
}
export function NodeIcon({ kind }: { kind: HierarchySelection['kind'] }) {
  return kind === 'function' ? <span className="function-icon" aria-hidden="true">ƒx</span> : kind === 'module'
    ? <svg className="folder-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9H2Z" stroke="currentColor" strokeWidth="1.4" /></svg>
    : <span className="root-icon" aria-hidden="true">≡</span>;
}
const selectionKey = (s: HierarchySelection) => s.id ?? s.objectType;
export function WorkspaceTree({ workspace, selected, busy, onSelect, onAction, readOnly = false, allowDelete = true, presence = {} }: Props) {
  const [query, setQuery] = useState('');
  const [focusedKey, setFocusedKey] = useState<string>(objectTypes[0]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(objectTypes));
  const [menu, setMenu] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...text: string[]) => text.some(value => value.toLocaleLowerCase().includes(needle));
  useEffect(() => {
    if (!selected || !workspace) return;
    const domain = workspace.domains[selected.objectType];
    let id = selected.kind === 'function' ? domain.functions.find(fn => fn.functionId === selected.id)?.parentModuleId : selected.id;
    const parents = [selected.objectType as string];
    while (id) { parents.push(id); id = domain.modules.find(m => m.id === id)?.parentId; }
    setExpanded(previous => new Set([...previous, ...parents]));
    setMenu(null);
    setFocusedKey(selectionKey(selected));
  }, [selected, workspace]);
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  function renderNode(selection: HierarchySelection, label: string, prefix: string, level: number, ancestorMatches = false): React.ReactNode {
    const key = selectionKey(selection);
    const domain = workspace?.domains[selection.objectType];
    const functions = selection.kind === 'module' ? domain?.functions.filter(fn => fn.parentModuleId === selection.id) ?? [] : [];
    const modules = selection.kind !== 'function' ? domain?.modules.filter(m => m.parentId === selection.id) ?? [] : [];
    const fn = selection.kind === 'function' ? domain?.functions.find(f => f.functionId === selection.id) : undefined;
    const ownMatch = ancestorMatches || matches(label, prefix, key, ...fn?.items.map(item => item.id) ?? []);
    const children = [
      ...modules.map(m => renderNode({ objectType: selection.objectType, kind: 'module', id: m.id }, m.name, m.prefix, level + 1, ownMatch)),
      ...functions.map(f => renderNode({ objectType: selection.objectType, kind: 'function', id: f.functionId }, f.name, f.prefix, level + 1, ownMatch)),
    ].filter(Boolean);
    if (needle && !ownMatch && !children.length) return null;
    const isExpanded = !!needle || expanded.has(key);
    const canExpand = children.length > 0;
    const active = !!selected && selectionKey(selected) === key;
    const enabled = !readOnly && !!workspace?.config.objectTypes[selection.objectType].enabled;
    return <li key={key} role="treeitem" aria-label={label} aria-level={level} aria-selected={active} aria-expanded={canExpand ? isExpanded : undefined} tabIndex={key === focusedKey || !!needle && level === 1 ? 0 : -1}
      onFocus={event => { if ((event.target as HTMLElement).closest('[role=treeitem]') === event.currentTarget) setFocusedKey(key); }}
      data-node-key={key} onKeyDown={event => {
        if ((event.target as HTMLElement).closest('[role=treeitem]') !== event.currentTarget || (event.target as HTMLElement).closest('[role=menu]')) return;
        const item = event.currentTarget;
        const tree = item.closest('[role=tree]')!;
        const visible = [...tree.querySelectorAll<HTMLElement>('[role=treeitem]')];
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
      }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy) { setMenu(key); } }}>
      <div className={`tree-row${active ? ' active' : ''}`}>
        {canExpand ? <button className="tree-toggle" tabIndex={-1} aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`} disabled={!!needle} onClick={() => toggle(key)}>{isExpanded ? '⌄' : '›'}</button> : <span className="tree-toggle" />}
        <button className="tree-select" disabled={busy} tabIndex={-1} onClick={() => onSelect(selection)} title={prefix ? `${label} [${prefix}]` : label}><NodeIcon kind={selection.kind} /><span className="node-name">{label}{presence[key] && <small title={presence[key]}> ● {presence[key]}</small>}</span>{prefix && <span className="node-prefix">{prefix}</span>}</button>
        {enabled && <button className="tree-more" tabIndex={-1} aria-label={`Actions for ${label}`} aria-expanded={menu === key} onClick={() => setMenu(menu === key ? null : key)}>⋯</button>}
      </div>
      {menu === key && enabled && <div className="tree-menu" role="menu" aria-label={`${label} actions`}>
        {selection.kind !== 'function' && <button role="menuitem" onClick={() => { setMenu(null); onAction('addModule', selection); }}>{selection.kind === 'root' ? 'Add module' : 'Add submodule'}</button>}
        {selection.kind === 'module' && <button role="menuitem" onClick={() => { setMenu(null); onAction('addFunction', selection); }}>Add function</button>}
        {selection.kind !== 'root' && <><button role="menuitem" onClick={() => { setMenu(null); onAction('edit', selection); }}>Rename / Properties</button><button hidden={!allowDelete} role="menuitem" className="danger-text" onClick={() => { setMenu(null); onAction('delete', selection); }}>Delete</button></>}
        <button role="menuitem" onClick={() => setMenu(null)}>Close menu</button>
      </div>}
      {canExpand && isExpanded && <ul role="group">{children}</ul>}
    </li>;
  }
  const roots = objectTypes.map(type => renderNode({ objectType: type, kind: 'root', id: null }, objectLabels[type], '', 1)).filter(Boolean);
  return <div className="workspace-tree"><label className="tree-search-label"><span className="sr-only">Search workspace tree</span><input type="search" placeholder="Search names, prefixes, IDs…" value={query} onChange={e => setQuery(e.target.value)} /></label><ul role="tree" aria-label="Workspace hierarchy">{roots}</ul>{!roots.length && <p className="hint tree-empty">No matching objects.</p>}</div>;
}
