import { expect, it } from 'vitest';
import { restoreWorkspace, diffWorkspaces } from '../../src/server/revisions.js';
import { addItem } from '../../src/main/services/idGenerator.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
it('restores without reusing IDs issued in newer history and preserves function watermarks', () => {
  let base = addModule(createWorkspace('Project', 'P'), 'REQUIREMENT', 'Module', 'M'); base = addFunction(base, 'REQUIREMENT', base.domains.REQUIREMENT.modules[0]!.id, 'Function', 'F');
  const fn = base.domains.REQUIREMENT.functions[0]!.functionId;
  base = addItem(base, 'REQUIREMENT', fn, { col_desc: 'Baseline' });
  const current = addItem(base, 'REQUIREMENT', fn, { col_desc: 'Later' });
  const later = current.domains.REQUIREMENT.functions[0]!.items[1]!.id;
  const restored = restoreWorkspace(current, base);
  expect(restored.retiredIds).toContain(later); expect(restored.domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(2);
  expect(addItem(restored, 'REQUIREMENT', fn, { col_desc: 'After restore' }).domains.REQUIREMENT.functions[0]!.items[1]!.seq).toBe(3);
  expect(diffWorkspaces(base, current).added).toContain(later);
  expect(() => restoreWorkspace(current, createWorkspace('Other'))).toThrow('identity');
});
