import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, addComponent, addRequirementSet } from '../../src/main/services/workspaceFactory.js';
import { authorRequirementSet } from '../../src/main/services/authoringService.js';
import { updateProjectConfig } from '../../src/main/config/projectConfig.js';
import { exportWorkspace } from '../../src/main/services/exportService.js';
import { validateWorkspace } from '../../src/main/services/validation.js';
import { WorkspaceIndex } from '../../src/main/db/sqliteClient.js';
function fixture() {
  let workspace = createWorkspace('Test', 'GS');
  for (const type of ['REQUIREMENT', 'DATA_DICTIONARY'] as const) {
    workspace = addComponent(workspace, type, 'Module', 'MOD');
    workspace = addRequirementSet(workspace, type, workspace.domains[type].components[0]!.id, 'Function', 'FN');
  }
  return workspace;
}
it('saves values and scope atomically, preserves gaps, timestamps edits, and rejects invalid rows', () => {
  let w = fixture(); const requirementSetId = w.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
  const command = { objectType: 'REQUIREMENT', requirementSetId, description: '# Scope', changes: [{ action: 'add', values: { col_desc: 'First' } }, { action: 'add', values: { col_desc: 'Second' } }] };
  const saved = authorRequirementSet(w, command);
  expect(w.domains.REQUIREMENT.requirementSets[0]!.items).toEqual([]);
  const first = saved.domains.REQUIREMENT.requirementSets[0]!.items[0]!;
  w = authorRequirementSet(saved, { objectType: 'REQUIREMENT', requirementSetId, changes: [{ action: 'edit', id: first.id, values: { ...first.values, col_desc: 'Changed' } }] });
  expect(w.domains.REQUIREMENT.requirementSets[0]!.items[0]!.id).toBe(first.id);
  expect(w.domains.REQUIREMENT.requirementSets[0]!.items[0]!.updated_at).toBeTruthy();
  w = authorRequirementSet(w, { objectType: 'REQUIREMENT', requirementSetId, changes: [{ action: 'delete', id: first.id }, { action: 'add', values: { col_desc: 'Third' } }] });
  expect(w.domains.REQUIREMENT.requirementSets[0]!.items.map(i => i.seq)).toEqual([2, 3]);
  expect(() => authorRequirementSet(w, { ...command, changes: [{ action: 'add', values: {} }] })).toThrow('Required');
  expect(() => authorRequirementSet(w, { ...command, requirementSetId: 'missing' })).toThrow('Requirement set not found');
  expect(() => authorRequirementSet(w, { ...command, changes: [{ action: 'edit', id: 'missing', values: {} }] })).toThrow('Item not found');
  w.config.objectTypes.REQUIREMENT.enabled = false; expect(() => authorRequirementSet(w, command)).toThrow('disabled');
});
it('migrates added/defaulted, reordered and removed columns without changing item IDs; rejects incompatible types', () => {
  let w = fixture(); const requirementSetId = w.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
  w = authorRequirementSet(w, { objectType: 'REQUIREMENT', requirementSetId, changes: [{ action: 'add', values: { col_desc: 'Existing' } }] });
  const config = structuredClone(w.config);
  config.objectTypes.REQUIREMENT.columns.push({ id: 'n', name: 'Number', type: 'number', required: true, default: 7 });
  let next = updateProjectConfig(w, config);
  expect(next.domains.REQUIREMENT.requirementSets[0]!.items[0]!.values.n).toBe(7);
  const changed = structuredClone(next.config); changed.objectTypes.REQUIREMENT.columns.find(c => c.id === 'n')!.type = 'boolean';
  expect(() => updateProjectConfig(next, changed)).toThrow('Invalid value');
  const removed = structuredClone(next.config); removed.objectTypes.REQUIREMENT.columns = removed.objectTypes.REQUIREMENT.columns.filter(c => c.id !== 'n').reverse();
  next = updateProjectConfig(next, removed);
  expect(next.domains.REQUIREMENT.requirementSets[0]!.items[0]!.values.n).toBeUndefined();
  expect(next.domains.REQUIREMENT.requirementSets[0]!.items[0]!.id).toBe(w.domains.REQUIREMENT.requirementSets[0]!.items[0]!.id);
});
it('resolves typed references and blocks dangling references and deletion of referenced targets', () => {
  let w = fixture(); const fn = w.domains.REQUIREMENT.requirementSets[0]!.requirementSetId; const di = w.domains.DATA_DICTIONARY.requirementSets[0]!.requirementSetId;
  w = authorRequirementSet(w, { objectType: 'DATA_DICTIONARY', requirementSetId: di, changes: [{ action: 'add', values: { col_name: 'Altitude' } }] });
  const target = w.domains.DATA_DICTIONARY.requirementSets[0]!.items[0]!.id;
  const config = structuredClone(w.config); config.objectTypes.REQUIREMENT.columns.push({ id: 'ref', name: 'Data item', type: 'reference', referenceTypes: ['DATA_DICTIONARY'] });
  w = updateProjectConfig(w, config);
  w = authorRequirementSet(w, { objectType: 'REQUIREMENT', requirementSetId: fn, changes: [{ action: 'add', values: { col_desc: 'Reads altitude', ref: target } }, { action: 'add', values: { col_desc: 'No reference', ref: '' } }] });
  expect(() => authorRequirementSet(w, { objectType: 'DATA_DICTIONARY', requirementSetId: di, changes: [{ action: 'delete', id: target }] })).toThrow('Unresolved reference');
  const bad = structuredClone(w); bad.config.objectTypes.REQUIREMENT.columns.at(-1)!.referenceTypes = ['ENTITY']; expect(() => validateWorkspace(bad)).toThrow('Unresolved reference');
  delete bad.config.objectTypes.REQUIREMENT.columns.at(-1)!.referenceTypes; expect(() => validateWorkspace(bad)).not.toThrow();
  bad.domains.REQUIREMENT.requirementSets[0]!.items[0]!.values.ref = 'missing'; expect(() => validateWorkspace(bad)).toThrow('Unresolved reference');
});
it('exports CSV with escaping and formula protection, and Markdown with safe tables', () => {
  let w = fixture(); const requirementSetId = w.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
  w = authorRequirementSet(w, { objectType: 'REQUIREMENT', requirementSetId, changes: [{ action: 'add', values: { col_desc: '=formula,"quoted"\n<script>|\\' } }] });
  const csv = exportWorkspace(w, { format: 'csv', objectType: 'REQUIREMENT', requirementSetId });
  expect(csv).toContain('"\'=formula,""quoted""'); expect(csv).toContain('\r\n');
  const md = exportWorkspace(w, { format: 'markdown' }); expect(md).toContain('&lt;script&gt;\\|\\\\'); expect(md).toContain('<br>');
  expect(() => exportWorkspace(w, { format: 'csv', requirementSetId: 'missing' })).toThrow();
  expect(() => exportWorkspace(w, { format: 'html' })).toThrow();
});
it('searches 10,000 indexed items in under 50ms with stable IDs and object destinations', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-search-')); let index: WorkspaceIndex | undefined;
  try {
    const w = fixture(); const fn = w.domains.REQUIREMENT.requirementSets[0]!;
    fn.items = Array.from({ length: 10000 }, (_, i) => ({ id: `REQ-GS-MOD-FN-${String(i + 1).padStart(3, '0')}`, seq: i + 1, created_at: '2026-09-25T00:00:00Z', values: { col_desc: `The controller shall verify telemetry sample${i}.`, col_status: 'Draft' } }));
    fn.watermarkCounter = 10000; index = WorkspaceIndex.rebuild(root, w);
    const start = performance.now(); const results = index.search('telemetry sample9999'); const duration = performance.now() - start;
    expect(results).toHaveLength(1); expect(results[0]!.objectType).toBe('REQUIREMENT'); expect(results[0]!.requirementSetName).toBe('Function'); expect(duration).toBeLessThan(50);
    console.log(`10,000-item search: ${duration.toFixed(2)}ms`);
  } finally { index?.close(); rmSync(root, { recursive: true, force: true }); }
});
