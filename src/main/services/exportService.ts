import { exportSchema } from '../../shared/authoring.js';
import type { Workspace } from '../../shared/types/workspace.js';
import { objectTypes } from '../../shared/types/schema.js';
export function exportWorkspace(workspace: Workspace, raw: unknown): string {
  const request = exportSchema.parse(raw);
  const types = request.objectType ? [request.objectType] : [...objectTypes];
  if (request.functionId && !types.some(type => workspace.domains[type].functions.some(fn => fn.functionId === request.functionId))) throw new Error('Function not found');
  const columns = new Map<string, string>();
  for (const type of types) for (const column of workspace.config.objectTypes[type].columns) columns.set(`${type}:${column.id}`, `${workspace.config.objectTypes[type].name}: ${column.name}`);
  const keys = [...columns.keys()];
  const rows: string[][] = [['Object type', 'Function', 'ID', ...columns.values()]];
  for (const type of types) for (const fn of workspace.domains[type].functions) {
    if (request.functionId && request.functionId !== fn.functionId) continue;
    for (const item of fn.items) rows.push([type, fn.name, item.id, ...keys.map(key => key.startsWith(`${type}:`) ? String(item.values[key.slice(type.length + 1)] ?? '') : '')]);
  }
  if (request.format === 'csv') return rows.map(row => row.map(cell => {
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(cell) ? `'${cell}` : cell;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
  const escape = (cell: string) => cell.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
  const line = (row: string[]) => `| ${row.map(escape).join(' | ')} |`;
  return [line(rows[0]!), line(rows[0]!.map(() => '---')), ...rows.slice(1).map(line)].join('\n') + '\n';
}
