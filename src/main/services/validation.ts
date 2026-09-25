import { validateReferences } from '../../shared/references.js';
import type { Column } from '../../shared/types/config.js';
import type { Workspace, Module } from '../../shared/types/workspace.js';
import { objectTypes, workspaceSchema } from '../../shared/types/schema.js';

export function validateValue(column: Column, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    if (column.required) throw new Error(`Required field: ${column.name}`);
    return;
  }
  const valid = column.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : column.type === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'string' && (column.type !== 'enum' || !!column.options?.includes(value))
      && (column.type !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  if (!valid) throw new Error(`Invalid value: ${column.name}`);
}
export function moduleChain(modules: Module[], id: string): Module[] {
  const chain: Module[] = [];
  const seen = new Set<string>();
  let next: string | null = id;
  while (next !== null) {
    if (seen.has(next)) throw new Error('Module cycle');
    seen.add(next);
    const module = modules.find(m => m.id === next);
    if (!module) throw new Error('Missing parent module');
    chain.unshift(module);
    next = module.parentId;
  }
  return chain;
}
export function validateWorkspace(input: unknown): Workspace {
  const workspace = workspaceSchema.parse(input);
  const ids = new Set<string>();
  const reserve = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate ID: ${id}`);
    ids.add(id);
  };
  workspace.retiredIds.forEach(reserve);
  for (const type of objectTypes) {
    const config = workspace.config.objectTypes[type];
    const columns = new Set<string>();
    for (const column of config.columns) {
      if (columns.has(column.id)) throw new Error('Duplicate column');
      columns.add(column.id);
      if (column.type === 'enum' && (!column.options?.length || new Set(column.options).size !== column.options.length)) throw new Error('Invalid enum options');
      if (column.default !== undefined) validateValue(column, column.default);
    }
    const domain = workspace.domains[type];
    for (const module of domain.modules) { reserve(module.id); moduleChain(domain.modules, module.id); }
    const names = new Set<string>();
    for (const fn of domain.functions) {
      reserve(fn.functionId);
      const signature = JSON.stringify([fn.parentModuleId, fn.name]);
      if (names.has(signature)) throw new Error('Function name must be unique within its module');
      names.add(signature);
      fn.modulePath = moduleChain(domain.modules, fn.parentModuleId).map(m => m.name);
      const sequences = new Set<number>();
      for (const item of fn.items) {
        reserve(item.id);
        if (sequences.has(item.seq)) throw new Error('Duplicate sequence');
        sequences.add(item.seq);
        const suffix = Number(item.id.split('-').at(-1));
        if (suffix !== item.seq) throw new Error('ID sequence mismatch');
        fn.watermarkCounter = Math.max(fn.watermarkCounter, item.seq);
        if (Object.keys(item.values).some(k => !columns.has(k))) throw new Error('Unknown column');
        for (const column of config.columns) validateValue(column, item.values[column.id]);
      }
    }
  }
  validateReferences(workspace);
  return workspace;
}
