import { describe, it, expect } from 'vitest';
import { createWorkspace, addModule, addFunction } from '../../src/main/services/workspaceFactory.js';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { validateWorkspace, validateValue } from '../../src/main/services/validation.js';
import { formatId } from '../../src/shared/utils/idUtils.js';
import type { Workspace } from '../../src/shared/types/workspace.js';
import type { Column } from '../../src/shared/types/config.js';
export function fixture() {
  let w = addModule(createWorkspace('Guidance', 'GS'), 'REQUIREMENT', 'Compiler', 'COMPL');
  const parent = w.domains.REQUIREMENT.modules[0]!.id;
  w = addModule(w, 'REQUIREMENT', 'Parser', 'PARSER', parent);
  return addFunction(w, 'REQUIREMENT', w.domains.REQUIREMENT.modules[1]!.id, 'tsCreateParser', 'TSCRTPRSR');
}
const fnId = (w: Workspace) => w.domains.REQUIREMENT.functions[0]!.functionId;
const add = (w: Workspace) => addItem(w, 'REQUIREMENT', fnId(w), { col_desc: 'The parser shall initialize.' });
describe('immutable IDs', () => {
  it('cascades prefixes, preserves gaps, applies defaults and never mutates input', () => {
    const initial = fixture(); let w = add(add(add(initial)));
    const id = w.domains.REQUIREMENT.functions[0]!.items[1]!.id;
    w = add(deleteItem(w, 'REQUIREMENT', fnId(w), id));
    expect(w.domains.REQUIREMENT.functions[0]!.items.map(i => i.seq)).toEqual([1, 3, 4]);
    expect(w.domains.REQUIREMENT.functions[0]!.items[0]!.id).toBe('REQ-GS-COMPL-PARSER-TSCRTPRSR-001');
    expect(w.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_status).toBe('Draft');
    expect(initial.domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(0);
  });
  it('supports casing, omitted prefixes and large counters', () => {
    const c = fixture().config;
    expect(formatId(c, 'REQUIREMENT', [''], 'MiXeD', 1000)).toBe('REQ-GS-MIXED-1000');
    c.idCasing = 'LOWER'; expect(formatId(c, 'REQUIREMENT', [], 'MiX', 1)).toBe('req-gs-mix-001');
    c.idCasing = 'AS_IS'; c.projectPrefix = ''; c.objectTypes.REQUIREMENT.usePrefix = false;
    expect(formatId(c, 'REQUIREMENT', ['', 'a'], 'MiX', 1)).toBe('a-MiX-001');
    for (const n of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => formatId(c, 'REQUIREMENT', [], 'X', n)).toThrow();
  });
  it('recovers stale watermarks and skips live and retired collisions', () => {
    let w = add(fixture()); const fn = w.domains.REQUIREMENT.functions[0]!;
    fn.watermarkCounter = 0; expect(add(w).domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(2);
    w = deleteItem(w, 'REQUIREMENT', fn.functionId, fn.items[0]!.id);
    w.domains.REQUIREMENT.functions[0]!.watermarkCounter = 0;
    expect(add(w).domains.REQUIREMENT.functions[0]!.items[0]!.seq).toBe(2);
    w = add(fixture()); const other = structuredClone(w.domains.REQUIREMENT.functions[0]!);
    other.functionId = 'fn_other'; other.name = 'Other'; other.items = []; other.watermarkCounter = 0;
    w.domains.REQUIREMENT.functions.push(other);
    expect(addItem(w, 'REQUIREMENT', other.functionId, { col_desc: 'Other' }).domains.REQUIREMENT.functions[1]!.items[0]!.seq).toBe(2);
  });
  it('rejects unavailable targets and invalid additions without consuming IDs', () => {
    const w = fixture();
    expect(() => addItem(w, 'REQUIREMENT', 'missing')).toThrow('Function not found');
    expect(() => deleteItem(w, 'REQUIREMENT', 'missing', 'x')).toThrow('Function not found');
    expect(() => deleteItem(w, 'REQUIREMENT', fnId(w), 'x')).toThrow('Item not found');
    expect(() => addItem(w, 'REQUIREMENT', fnId(w))).toThrow('Required');
    w.config.objectTypes.REQUIREMENT.enabled = false; expect(() => add(w)).toThrow('disabled');
  });
});
describe('schema and relational validation', () => {
  it('rejects malformed shapes, unknown keys, unsafe paths and counters', () => {
    expect(() => validateWorkspace({})).toThrow();
    const mutations = [
      (w: any) => w.extra = true,
      (w: any) => w.config.version = '2',
      (w: any) => w.config.projectPrefix = '../bad',
      (w: any) => w.domains.REQUIREMENT.functions[0].functionId = '../bad',
      (w: any) => w.domains.REQUIREMENT.functions[0].watermarkCounter = -1,
      (w: any) => w.domains.REQUIREMENT.functions[0].items[0].seq = 0,
      (w: any) => w.domains.REQUIREMENT.functions[0].items[0].created_at = 'yesterday',
    ];
    for (const mutate of mutations) { const w = add(fixture()); mutate(w); expect(() => validateWorkspace(w)).toThrow(); }
  });
  it('rejects structural conflicts', () => {
    const cases: [(w: Workspace) => void, string][] = [
      [w => w.retiredIds.push(w.domains.REQUIREMENT.modules[0]!.id), 'Duplicate ID'],
      [w => w.domains.REQUIREMENT.modules[0]!.parentId = w.domains.REQUIREMENT.modules[1]!.id, 'cycle'],
      [w => w.domains.REQUIREMENT.modules[0]!.parentId = 'missing', 'Missing parent'],
      [w => w.domains.REQUIREMENT.functions.push({ ...w.domains.REQUIREMENT.functions[0]!, functionId: 'fn_other' }), 'unique'],
      [w => w.config.objectTypes.REQUIREMENT.columns.push(w.config.objectTypes.REQUIREMENT.columns[0]!), 'Duplicate column'],
      [w => w.domains.REQUIREMENT.functions[0]!.items.push({ ...w.domains.REQUIREMENT.functions[0]!.items[0]!, id: 'OTHER-001' }), 'Duplicate sequence'],
      [w => w.domains.REQUIREMENT.functions[0]!.items[0]!.id = 'WRONG-002', 'mismatch'],
      [w => w.domains.REQUIREMENT.functions[0]!.items[0]!.values.unknown = 'x', 'Unknown column'],
    ];
    for (const [mutate, message] of cases) { const w = add(fixture()); mutate(w); expect(() => validateWorkspace(w)).toThrow(message); }
    for (const options of [undefined, [], ['a', 'a']]) { const w = fixture(); w.config.objectTypes.REQUIREMENT.columns[1]!.options = options; expect(() => validateWorkspace(w)).toThrow('enum options'); }
  });
  it('validates all custom field kinds and defaults', () => {
    for (const v of [undefined, null, '']) {
      expect(() => validateValue({ id: 'x', name: 'X', type: 'text' }, v)).not.toThrow();
      expect(() => validateValue({ id: 'x', name: 'X', type: 'text', required: true }, v)).toThrow('Required');
    }
    const cases: [Column['type'], unknown[], unknown[]][] = [
      ['number', [0, 1.5], ['1', Infinity]], ['boolean', [true, false], ['true']],
      ['text', ['abc'], [42]], ['enum', ['A'], ['B']],
      ['date', ['2024-02-29'], ['2023-02-29', 'bad', '2024-99-99']],
    ];
    for (const [type, good, bad] of cases) {
      const c: Column = { id: 'x', name: 'X', type, options: ['A'] };
      for (const v of good) expect(() => validateValue(c, v)).not.toThrow();
      for (const v of bad) expect(() => validateValue(c, v)).toThrow();
    }
    expect(() => validateValue({ id: 'x', name: 'X', type: 'enum' }, 'A')).toThrow();
    const w = fixture(); w.config.objectTypes.REQUIREMENT.columns[1]!.default = 'Invalid';
    expect(() => validateWorkspace(w)).toThrow('Invalid value');
  });
});
