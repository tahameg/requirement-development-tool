import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { updateProjectConfig } from '../../src/main/config/projectConfig.js';
import { editFunction } from '../../src/main/services/authoringService.js';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { validateWorkspace } from '../../src/main/services/validation.js';
import {
  addFunction,
  addModule,
  createWorkspace,
} from '../../src/main/services/workspaceFactory.js';
import { validateYDocDiffPermissions } from '../../src/shared/collab/permissions.js';
import {
  addYDocPendingItem,
  addYDocRetiredIds,
  applyTextChange,
  cloneYDoc,
  computeTextDiff,
  deleteYDocFunction,
  deleteYDocItem,
  deleteYDocModule,
  getPendingItemsInYDoc,
  getYDocFunctionDescriptionText,
  getYDocItemFieldText,
  getYDocModuleDescriptionText,
  isPendingItemId,
  isTextColumnType,
  resolveYDocPendingItem,
  setYDocWatermark,
  syncWorkspaceToYDoc,
  updateYDocConfig,
  updateYDocFunctionDescription,
  updateYDocItemField,
  updateYDocModuleDescription,
  upsertYDocFunction,
  upsertYDocItem,
  upsertYDocModule,
  workspaceToYDoc,
  yDocToWorkspace,
} from '../../src/shared/collab/yjsDoc.js';
import { objectTypes } from '../../src/shared/types/schema.js';
import type { Workspace } from '../../src/shared/types/workspace.js';

function buildRichWorkspace(): Workspace {
  let ws = createWorkspace('Avionics Flight Control', 'AFC');

  // Extend REQUIREMENT columns to include all scalar and text types
  const nextConfig = structuredClone(ws.config);
  nextConfig.objectTypes.REQUIREMENT.columns = [
    { id: 'col_desc', name: 'Description', type: 'markdown', required: true, system: true },
    {
      id: 'col_status',
      name: 'Status',
      type: 'enum',
      options: ['Draft', 'Reviewed', 'Approved', 'Obsolete'],
      default: 'Draft',
    },
    { id: 'col_rationale', name: 'Rationale', type: 'text' },
    { id: 'col_title', name: 'Short Title', type: 'string' },
    { id: 'col_priority', name: 'Priority', type: 'number', default: 1 },
    { id: 'col_safety', name: 'Safety Critical', type: 'boolean', default: false },
    { id: 'col_due', name: 'Target Date', type: 'date' },
    {
      id: 'col_ref',
      name: 'Related Data',
      type: 'reference',
      referenceTypes: ['DATA_DICTIONARY', 'ENTITY', 'ACTION'],
    },
  ];
  ws = updateProjectConfig(ws, nextConfig);

  // Populate all 4 object types with modules, submodules, functions, and items
  for (const type of objectTypes) {
    ws = addModule(ws, type, `${type} Root Module`, 'ROOT', null);
    const rootMod = ws.domains[type].modules[0]!;
    rootMod.description = `Root module description for ${type}`;

    ws = addModule(ws, type, `${type} Submodule`, 'SUB', rootMod.id);
    const subMod = ws.domains[type].modules[1]!;
    subMod.description = `Submodule description for ${type}`;

    ws = addFunction(ws, type, subMod.id, `${type} Primary Function`, 'FN');
    const fn = ws.domains[type].functions[0]!;
    fn.description = `# ${type} Scope\nInitial function scope.`;

    if (type !== 'REQUIREMENT') {
      ws = addItem(ws, type, fn.functionId, {
        col_name: `${type} Item One`,
        col_desc: `Detailed text for ${type} 1`,
      });
      ws = addItem(ws, type, fn.functionId, {
        col_name: `${type} Item Two`,
        col_desc: `Detailed text for ${type} 2`,
      });
    }
  }

  // Reference target from DATA_DICTIONARY
  const ddTargetId = ws.domains.DATA_DICTIONARY.functions[0]!.items[0]!.id;
  const reqFnId = ws.domains.REQUIREMENT.functions[0]!.functionId;

  ws = addItem(ws, 'REQUIREMENT', reqFnId, {
    col_desc: 'The FCC shall sample barometric altitude at 100 Hz.',
    col_status: 'Approved',
    col_rationale: 'Required for inner loop stability.',
    col_title: 'Altitude Sampling',
    col_priority: 10,
    col_safety: true,
    col_due: '2026-12-01',
    col_ref: ddTargetId,
  });

  ws = addItem(ws, 'REQUIREMENT', reqFnId, {
    col_desc: 'The FCC shall log sensor faults.',
    col_status: 'Draft',
    col_rationale: 'Maintenance diagnostics.',
    col_title: 'Fault Logging',
    col_priority: 2,
    col_safety: false,
    col_due: null,
    col_ref: null,
  });

  // Edit first requirement so updated_at is populated, and delete second to populate retiredIds
  const firstReq = ws.domains.REQUIREMENT.functions[0]!.items[0]!;
  const secondReq = ws.domains.REQUIREMENT.functions[0]!.items[1]!;
  ws = editFunction(ws, {
    objectType: 'REQUIREMENT',
    functionId: reqFnId,
    changes: [
      {
        action: 'edit',
        id: firstReq.id,
        values: { ...firstReq.values, col_title: 'Barometric Altitude Sampling' },
      },
    ],
  });
  ws = deleteItem(ws, 'REQUIREMENT', reqFnId, secondReq.id);

  // Add a third requirement so seq jumps to 3 while seq 2 stays retired
  ws = addItem(ws, 'REQUIREMENT', reqFnId, {
    col_desc: 'The FCC shall report health status over ARINC 429.',
    col_status: 'Reviewed',
    col_rationale: 'Cockpit display integration.',
    col_title: 'Health Reporting',
    col_priority: 5,
    col_safety: true,
    col_due: '2026-11-15',
    col_ref: ddTargetId,
  });

  return validateWorkspace(ws);
}

describe('yjsDoc conversion and collaborative helpers', () => {
  it('performs lossless Workspace -> Y.Doc -> Workspace round-trips across all 4 object types', () => {
    const original = buildRichWorkspace();
    const doc = workspaceToYDoc(original);
    const roundTripped = yDocToWorkspace(doc);

    expect(roundTripped).toEqual(original);
    expect(() => validateWorkspace(roundTripped)).not.toThrow();

    // Also verify round-tripping through binary state encoding into a fresh Y.Doc
    const syncedDoc = cloneYDoc(doc);
    const syncedWorkspace = yDocToWorkspace(syncedDoc);
    expect(syncedWorkspace).toEqual(original);
    expect(syncedWorkspace.retiredIds).toEqual(original.retiredIds);
    for (const type of objectTypes) {
      expect(syncedWorkspace.domains[type].functions[0]!.watermarkCounter).toBe(
        original.domains[type].functions[0]!.watermarkCounter,
      );
    }
  });

  it('computes minimal character-level diffs and preserves UTF-16 surrogate pairs', () => {
    expect(computeTextDiff('same text', 'same text')).toEqual({
      start: 0,
      deleteCount: 0,
      insertText: '',
    });

    expect(computeTextDiff('The system shall work.', 'The flight system shall work.')).toEqual({
      start: 4,
      deleteCount: 0,
      insertText: 'flight ',
    });

    expect(computeTextDiff('The flight system shall work.', 'The system shall work.')).toEqual({
      start: 4,
      deleteCount: 7,
      insertText: '',
    });

    // Emoji surrogate pair replacement (😀 \uD83D\uDE00 vs 😁 \uD83D\uDE01 share high surrogate \uD83D)
    const emojiDiff = computeTextDiff('Status 😀 ok', 'Status 😁 ok');
    expect(emojiDiff.insertText).toBe('😁');
    expect(emojiDiff.deleteCount).toBe(2);

    // Emoji surrogate pair at the end of the diff span
    const trailingEmojiDiff = computeTextDiff('😀 alpha', '😁 beta');
    expect(trailingEmojiDiff.start).toBe(0);

    const unattached = new Y.Text();
    expect(() => applyTextChange(unattached, 'Hello world')).toThrow(
      'Y.Text must be attached to a Y.Doc',
    );

    const tempDoc = new Y.Doc();
    const attached = tempDoc.getText('sample');
    attached.insert(0, 'Hello world');
    expect(applyTextChange(attached, 'Hello world')).toBe(false);
    expect(applyTextChange(attached, 'Hello brave new world')).toBe(true);
    expect(attached.toString()).toBe('Hello brave new world');
    expect(applyTextChange(attached, 'Hello world')).toBe(true);
    expect(attached.toString()).toBe('Hello world');

    expect(isTextColumnType('string')).toBe(true);
    expect(isTextColumnType('text')).toBe(true);
    expect(isTextColumnType('markdown')).toBe(true);
    expect(isTextColumnType('enum')).toBe(false);
    expect(isTextColumnType('number')).toBe(false);
    expect(isTextColumnType(undefined)).toBe(false);
  });

  it('merges concurrent character-level Y.Text edits on module descriptions, function descriptions, and text/Markdown item columns without overwriting', () => {
    const ws = buildRichWorkspace();
    const reqModId = ws.domains.REQUIREMENT.modules[0]!.id;
    const reqFnId = ws.domains.REQUIREMENT.functions[0]!.functionId;
    const reqItemId = ws.domains.REQUIREMENT.functions[0]!.items[0]!.id;

    const docA = workspaceToYDoc(ws);
    const docB = cloneYDoc(docA);

    // 1. Concurrent edits on Function description
    // Initial: "# REQUIREMENT Scope\nInitial function scope."
    updateYDocFunctionDescription(
      docA,
      'REQUIREMENT',
      reqFnId,
      '# Primary REQUIREMENT Scope\nInitial function scope.',
    );
    updateYDocFunctionDescription(
      docB,
      'REQUIREMENT',
      reqFnId,
      '# REQUIREMENT Scope\nInitial function scope with safety notes.',
    );

    // 2. Concurrent edits on Module description
    // Initial: "Root module description for REQUIREMENT"
    updateYDocModuleDescription(
      docA,
      'REQUIREMENT',
      reqModId,
      '[Verified] Root module description for REQUIREMENT',
    );
    updateYDocModuleDescription(
      docB,
      'REQUIREMENT',
      reqModId,
      'Root module description for REQUIREMENT (v2)',
    );

    // 3. Concurrent edits on item Markdown column (col_desc) and text column (col_rationale)
    // Initial col_desc: "The FCC shall sample barometric altitude at 100 Hz."
    updateYDocItemField(
      docA,
      'REQUIREMENT',
      reqFnId,
      reqItemId,
      'col_desc',
      'The primary FCC shall sample barometric altitude at 100 Hz.',
      '2026-10-16T01:00:00.000Z',
    );
    updateYDocItemField(
      docB,
      'REQUIREMENT',
      reqFnId,
      reqItemId,
      'col_desc',
      'The FCC shall sample barometric altitude at 100 Hz with +/- 1 ft accuracy.',
      '2026-10-16T01:00:01.000Z',
    );

    // Exchange binary updates between docA and docB
    const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
    const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
    Y.applyUpdate(docA, updateFromB);
    Y.applyUpdate(docB, updateFromA);

    const mergedA = yDocToWorkspace(docA);
    const mergedB = yDocToWorkspace(docB);
    expect(mergedA).toEqual(mergedB);

    const mergedMod = mergedA.domains.REQUIREMENT.modules[0]!;
    expect(mergedMod.description).toBe(
      '[Verified] Root module description for REQUIREMENT (v2)',
    );

    const mergedFn = mergedA.domains.REQUIREMENT.functions[0]!;
    expect(mergedFn.description).toBe(
      '# Primary REQUIREMENT Scope\nInitial function scope with safety notes.',
    );

    const mergedItem = mergedFn.items[0]!;
    expect(mergedItem.values.col_desc).toBe(
      'The primary FCC shall sample barometric altitude at 100 Hz with +/- 1 ft accuracy.',
    );
  });

  it('applies last-writer-wins on scalar columns (enum, number, boolean, date, reference)', () => {
    const ws = buildRichWorkspace();
    const reqFnId = ws.domains.REQUIREMENT.functions[0]!.functionId;
    const reqItemId = ws.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    const ddSecondItemId = ws.domains.DATA_DICTIONARY.functions[0]!.items[1]!.id;

    const docA = workspaceToYDoc(ws);
    // Ensure deterministic clientID ordering so docB wins concurrent LWW ties
    const docB = new Y.Doc();
    docA.clientID = 10;
    docB.clientID = 20;
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Verify scalar columns are stored as primitive values, not Y.Text
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_desc')).toBeInstanceOf(
      Y.Text,
    );
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_status')).toBeNull();
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_priority')).toBeNull();
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_safety')).toBeNull();
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_due')).toBeNull();
    expect(getYDocItemFieldText(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_ref')).toBeNull();

    // Concurrent edits to all 5 scalar column types on docA vs docB
    updateYDocItemField(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_status', 'Reviewed');
    updateYDocItemField(docB, 'REQUIREMENT', reqFnId, reqItemId, 'col_status', 'Obsolete');

    updateYDocItemField(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_priority', 50);
    updateYDocItemField(docB, 'REQUIREMENT', reqFnId, reqItemId, 'col_priority', 99);

    updateYDocItemField(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_safety', false);
    updateYDocItemField(docB, 'REQUIREMENT', reqFnId, reqItemId, 'col_safety', true);

    updateYDocItemField(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_due', '2027-01-15');
    updateYDocItemField(docB, 'REQUIREMENT', reqFnId, reqItemId, 'col_due', '2027-06-30');

    updateYDocItemField(docA, 'REQUIREMENT', reqFnId, reqItemId, 'col_ref', null);
    updateYDocItemField(docB, 'REQUIREMENT', reqFnId, reqItemId, 'col_ref', ddSecondItemId);

    const uA = Y.encodeStateAsUpdate(docA);
    const uB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(docA, uB);
    Y.applyUpdate(docB, uA);

    const finalA = yDocToWorkspace(docA);
    const finalB = yDocToWorkspace(docB);
    expect(finalA).toEqual(finalB);

    const item = finalA.domains.REQUIREMENT.functions[0]!.items[0]!;
    expect(item.values.col_status).toBe('Obsolete');
    expect(item.values.col_priority).toBe(99);
    expect(item.values.col_safety).toBe(true);
    expect(item.values.col_due).toBe('2027-06-30');
    expect(item.values.col_ref).toBe(ddSecondItemId);
    expect(() => validateWorkspace(finalA)).not.toThrow();
  });

  it('preserves watermarkCounter and appends retiredIds across item, function, and module deletions', () => {
    const ws = buildRichWorkspace();
    const doc = workspaceToYDoc(ws);
    const reqFn = ws.domains.REQUIREMENT.functions[0]!;
    const initialRetired = [...ws.retiredIds];

    // Raise watermark explicitly and ensure lower values are ignored
    setYDocWatermark(doc, 'REQUIREMENT', reqFn.functionId, 15);
    setYDocWatermark(doc, 'REQUIREMENT', reqFn.functionId, 4);
    expect(yDocToWorkspace(doc).domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(15);

    // Delete first item in REQUIREMENT
    const itemToDelete = reqFn.items[0]!.id;
    expect(deleteYDocItem(doc, 'REQUIREMENT', reqFn.functionId, itemToDelete)).toBe(true);
    expect(deleteYDocItem(doc, 'REQUIREMENT', reqFn.functionId, 'non-existent')).toBe(false);

    let state = yDocToWorkspace(doc);
    expect(state.retiredIds).toContain(itemToDelete);
    expect(state.domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(15);

    // Delete ENTITY function and verify its items are retired
    const entityFn = ws.domains.ENTITY.functions[0]!;
    const entityItemIds = entityFn.items.map(i => i.id);
    const retiredFromFn = deleteYDocFunction(doc, 'ENTITY', entityFn.functionId);
    expect(retiredFromFn).toEqual(entityItemIds);

    state = yDocToWorkspace(doc);
    expect(state.domains.ENTITY.functions).toHaveLength(0);
    for (const id of entityItemIds) {
      expect(state.retiredIds).toContain(id);
    }

    // Delete ACTION root module (cascading to submodule, function, and items)
    const actionRootModId = ws.domains.ACTION.modules[0]!.id;
    const actionItemIds = ws.domains.ACTION.functions[0]!.items.map(i => i.id);
    const retiredFromMod = deleteYDocModule(doc, 'ACTION', actionRootModId);
    expect(retiredFromMod).toEqual(actionItemIds);

    state = yDocToWorkspace(doc);
    expect(state.domains.ACTION.modules).toHaveLength(0);
    expect(state.domains.ACTION.functions).toHaveLength(0);
    for (const id of [...initialRetired, itemToDelete, ...entityItemIds, ...actionItemIds]) {
      expect(state.retiredIds).toContain(id);
    }
  });

  it('tracks temporary pending items separately and resolves them to permanent server-allocated items', () => {
    const ws = buildRichWorkspace();
    const doc = workspaceToYDoc(ws);
    const reqFnId = ws.domains.REQUIREMENT.functions[0]!.functionId;

    const pending = addYDocPendingItem(
      doc,
      'REQUIREMENT',
      reqFnId,
      'temp-123',
      {
        col_desc: 'Draft pending requirement',
        col_status: 'Draft',
      },
      '2026-10-16T02:00:00.000Z',
    );
    expect(isPendingItemId(pending.id)).toBe(true);
    expect(pending.id).toBe('__pending__:temp-123');

    // Excluded by default so validateWorkspace succeeds
    const cleanWs = yDocToWorkspace(doc);
    expect(cleanWs.domains.REQUIREMENT.functions[0]!.items.some(i => i.id === pending.id)).toBe(
      false,
    );
    expect(() => validateWorkspace(cleanWs)).not.toThrow();

    // Included when includePending is true
    const withPendingWs = yDocToWorkspace(doc, { includePending: true });
    expect(
      withPendingWs.domains.REQUIREMENT.functions[0]!.items.some(i => i.id === pending.id),
    ).toBe(true);

    // Extracted via getPendingItemsInYDoc
    const pendingList = getPendingItemsInYDoc(doc);
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]!.tempId).toBe('__pending__:temp-123');
    expect(pendingList[0]!.values.col_desc).toBe('Draft pending requirement');

    // Resolve pending item to a server-allocated permanent item via addItem
    const afterAllocWs = addItem(cleanWs, 'REQUIREMENT', reqFnId, pendingList[0]!.values);
    const permanentItem = afterAllocWs.domains.REQUIREMENT.functions[0]!.items.at(-1)!;
    resolveYDocPendingItem(doc, 'REQUIREMENT', reqFnId, 'temp-123', permanentItem);

    expect(getPendingItemsInYDoc(doc)).toHaveLength(0);
    const resolvedWs = yDocToWorkspace(doc);
    expect(resolvedWs.domains.REQUIREMENT.functions[0]!.items.at(-1)).toEqual(permanentItem);
    expect(resolvedWs.domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(permanentItem.seq);

    // Deleting a pending item must not add it to retiredIds
    const secondPending = addYDocPendingItem(doc, 'REQUIREMENT', reqFnId, '__pending__:temp-456', {
      col_desc: 'To be cancelled',
    });
    deleteYDocItem(doc, 'REQUIREMENT', reqFnId, secondPending.id);
    expect(yDocToWorkspace(doc).retiredIds).not.toContain(secondPending.id);
  });

  it('supports in-place config migrations, upserts, syncWorkspaceToYDoc, and conflict detection', () => {
    const ws = buildRichWorkspace();
    const doc = workspaceToYDoc(ws);
    const reqFnId = ws.domains.REQUIREMENT.functions[0]!.functionId;
    const reqItemId = ws.domains.REQUIREMENT.functions[0]!.items[0]!.id;

    // Keep reference to Y.Text before syncWorkspaceToYDoc
    const descYTextBefore = getYDocItemFieldText(doc, 'REQUIREMENT', reqFnId, reqItemId, 'col_desc');
    expect(descYTextBefore).toBeInstanceOf(Y.Text);

    // Modify workspace and sync into existing doc
    const modifiedWs = structuredClone(ws);
    modifiedWs.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc =
      'The FCC shall sample barometric altitude at 200 Hz.';
    modifiedWs.domains.REQUIREMENT.functions[0]!.items.reverse();
    syncWorkspaceToYDoc(doc, modifiedWs);

    const descYTextAfter = getYDocItemFieldText(doc, 'REQUIREMENT', reqFnId, reqItemId, 'col_desc');
    expect(descYTextAfter).toBe(descYTextBefore);
    expect(yDocToWorkspace(doc)).toEqual(modifiedWs);

    // Upsert new module, function, and item directly
    upsertYDocModule(doc, 'ENTITY', {
      id: 'mod_extra',
      name: 'Extra Module',
      prefix: 'EXT',
      description: 'Extra module desc',
      parentId: null,
    });
    expect(getYDocModuleDescriptionText(doc, 'ENTITY', 'mod_extra')?.toString()).toBe(
      'Extra module desc',
    );

    upsertYDocFunction(doc, 'ENTITY', {
      functionId: 'fn_extra',
      name: 'Extra Function',
      prefix: 'EFN',
      parentModuleId: 'mod_extra',
      description: 'Extra fn desc',
      watermarkCounter: 1,
      items: [
        {
          id: 'ENTT-AFC-EXT-EFN-001',
          seq: 1,
          created_at: '2026-10-16T00:00:00.000Z',
          values: { col_name: 'Sensor', col_desc: 'Optical sensor' },
        },
      ],
    });
    expect(getYDocFunctionDescriptionText(doc, 'ENTITY', 'fn_extra')?.toString()).toBe(
      'Extra fn desc',
    );

    upsertYDocItem(doc, 'ENTITY', 'fn_extra', {
      id: 'ENTT-AFC-EXT-EFN-002',
      seq: 2,
      created_at: '2026-10-16T00:00:00.000Z',
      values: { col_name: 'Actuator', col_desc: 'Hydraulic actuator' },
    });

    // Update config: add a text column with a default and remove col_title
    const nextConfig = structuredClone(yDocToWorkspace(doc).config);
    nextConfig.objectTypes.REQUIREMENT.columns = nextConfig.objectTypes.REQUIREMENT.columns
      .filter(c => c.id !== 'col_title')
      .concat([{ id: 'col_notes', name: 'Notes', type: 'text', default: 'Default note' }]);
    updateYDocConfig(doc, nextConfig);

    const afterConfigWs = yDocToWorkspace(doc);
    expect(
      afterConfigWs.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_title,
    ).toBeUndefined();
    expect(afterConfigWs.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_notes).toBe(
      'Default note',
    );

    // Verify error handling for missing targets
    expect(() => updateYDocModuleDescription(doc, 'REQUIREMENT', 'missing', 'x')).toThrow(
      "Module 'missing' not found",
    );
    expect(() => deleteYDocModule(doc, 'REQUIREMENT', 'missing')).toThrow(
      "Module 'missing' not found",
    );
    expect(() => updateYDocFunctionDescription(doc, 'REQUIREMENT', 'missing', 'x')).toThrow(
      "Function 'missing' not found",
    );
    expect(() => setYDocWatermark(doc, 'REQUIREMENT', 'missing', 5)).toThrow(
      "Function 'missing' not found",
    );
    expect(() => deleteYDocFunction(doc, 'REQUIREMENT', 'missing')).toThrow(
      "Function 'missing' not found",
    );
    expect(() =>
      upsertYDocItem(doc, 'REQUIREMENT', 'missing', {
        id: 'REQ-1',
        seq: 1,
        created_at: '2026-10-16T00:00:00.000Z',
        values: {},
      }),
    ).toThrow("Function 'missing' not found");
    expect(() =>
      updateYDocItemField(doc, 'REQUIREMENT', 'missing', reqItemId, 'col_desc', 'x'),
    ).toThrow("Function 'missing' not found");
    expect(() =>
      updateYDocItemField(doc, 'REQUIREMENT', reqFnId, 'missing', 'col_desc', 'x'),
    ).toThrow("Item 'missing' not found");
    expect(() => deleteYDocItem(doc, 'REQUIREMENT', 'missing', reqItemId)).toThrow(
      "Function 'missing' not found",
    );
    expect(() =>
      resolveYDocPendingItem(doc, 'REQUIREMENT', 'missing', 'temp', {
        id: 'REQ-1',
        seq: 1,
        created_at: '2026-10-16T00:00:00.000Z',
        values: {},
      }),
    ).toThrow("Function 'missing' not found");

    // Simulate structural conflict where an editor adds a function under a module concurrently deleted by an admin
    const adminDoc = workspaceToYDoc(ws);
    const editorDoc = cloneYDoc(adminDoc);
    const targetSubModId = ws.domains.ENTITY.modules[1]!.id;

    deleteYDocModule(adminDoc, 'ENTITY', targetSubModId);
    upsertYDocFunction(editorDoc, 'ENTITY', {
      functionId: 'fn_orphaned',
      name: 'Orphaned Function',
      prefix: 'ORPH',
      parentModuleId: targetSubModId,
      description: 'Created concurrently',
      watermarkCounter: 0,
    });

    const prevAdminWs = yDocToWorkspace(adminDoc);
    Y.applyUpdate(adminDoc, Y.encodeStateAsUpdate(editorDoc));
    const conflictedWs = yDocToWorkspace(adminDoc);
    const validation = validateYDocDiffPermissions('EDITOR', prevAdminWs, conflictedWs);
    expect(validation).toEqual({
      ok: false,
      code: 'CONFLICT',
      targetId: targetSubModId,
      message: 'The module or function you were editing was deleted by an administrator.',
    });

    // Duplicate retiredIds are deduplicated
    addYDocRetiredIds(adminDoc, ['DUP-001', 'DUP-001']);
    expect(yDocToWorkspace(adminDoc).retiredIds.filter(id => id === 'DUP-001')).toHaveLength(1);
  });
});
