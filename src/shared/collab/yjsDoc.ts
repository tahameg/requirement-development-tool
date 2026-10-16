import * as Y from 'yjs';
import { moduleChain } from '../../main/services/validation.js';
import type { Column, ObjectType, ProjectConfig } from '../types/config.js';
import { objectTypes } from '../types/schema.js';
import type { FunctionGroup, Item, Module, Workspace } from '../types/workspace.js';

export const TEXT_COLUMN_TYPES = ['string', 'text', 'markdown'] as const;
export const SCALAR_COLUMN_TYPES = ['enum', 'number', 'boolean', 'date', 'reference'] as const;
export const PENDING_ITEM_PREFIX = '__pending__:' as const;

export function isTextColumnType(type: Column['type'] | undefined): boolean {
  return type === 'string' || type === 'text' || type === 'markdown';
}

export function isPendingItemId(id: string): boolean {
  return id.startsWith(PENDING_ITEM_PREFIX);
}

export interface TextDiffDelta {
  start: number;
  deleteCount: number;
  insertText: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Computes the minimal single-span character diff between `current` and `next`,
 * preserving UTF-16 surrogate pairs so multi-byte characters are never split.
 */
export function computeTextDiff(current: string, next: string): TextDiffDelta {
  if (current === next) {
    return { start: 0, deleteCount: 0, insertText: '' };
  }

  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1;
  }

  if (
    start > 0 &&
    (isHighSurrogate(current.charCodeAt(start - 1)) ||
      (start < current.length && isLowSurrogate(current.charCodeAt(start))) ||
      (start < next.length && isLowSurrogate(next.charCodeAt(start))))
  ) {
    start -= 1;
  }

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  if (
    currentEnd < current.length &&
    (isHighSurrogate(current.charCodeAt(currentEnd - 1)) ||
      isLowSurrogate(current.charCodeAt(currentEnd)))
  ) {
    currentEnd += 1;
    nextEnd += 1;
  }

  return {
    start,
    deleteCount: currentEnd - start,
    insertText: next.slice(start, nextEnd),
  };
}

/**
 * Applies the minimal character-level diff (`delete` + `insert`) to a `Y.Text`
 * inside a single Yjs transaction. Returns `true` if `ytext` changed, `false` if no-op.
 */
export function applyTextChange(ytext: Y.Text, nextString: string): boolean {
  if (!ytext.doc) {
    throw new Error('Y.Text must be attached to a Y.Doc before calling applyTextChange');
  }

  const current = ytext.toString();
  if (current === nextString) {
    return false;
  }

  const { start, deleteCount, insertText } = computeTextDiff(current, nextString);
  ytext.doc.transact(() => {
    if (deleteCount > 0) {
      ytext.delete(start, deleteCount);
    }
    if (insertText.length > 0) {
      ytext.insert(start, insertText);
    }
  });
  return true;
}

function setMapIfChanged(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (map.get(key) !== value) {
    map.set(key, value);
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function syncYStringArray(yarr: Y.Array<string>, target: readonly string[]): void {
  const current = yarr.toArray();
  if (arraysEqual(current, target)) {
    return;
  }

  let isPrefix = current.length <= target.length;
  if (isPrefix) {
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] !== target[i]) {
        isPrefix = false;
        break;
      }
    }
  }

  if (isPrefix) {
    const tail = target.slice(current.length);
    if (tail.length > 0) {
      yarr.push(tail);
    }
    return;
  }

  if (current.length > 0) {
    yarr.delete(0, current.length);
  }
  if (target.length > 0) {
    yarr.insert(0, [...target]);
  }
}

function removeFromYStringArray(yarr: Y.Array<string>, valueToRemove: string): void {
  const current = yarr.toArray();
  for (let i = current.length - 1; i >= 0; i -= 1) {
    if (current[i] === valueToRemove) {
      yarr.delete(i, 1);
    }
  }
}

function appendUniqueToYStringArray(yarr: Y.Array<string>, value: string): void {
  if (!yarr.toArray().includes(value)) {
    yarr.push([value]);
  }
}

function ensureDomainMap(doc: Y.Doc, objectType: ObjectType): {
  domainMap: Y.Map<unknown>;
  moduleOrder: Y.Array<string>;
  modulesMap: Y.Map<Y.Map<unknown>>;
  functionOrder: Y.Array<string>;
  functionsMap: Y.Map<Y.Map<unknown>>;
} {
  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  let domainMap = domainsMap.get(objectType);
  if (!(domainMap instanceof Y.Map)) {
    domainMap = new Y.Map<unknown>();
    domainsMap.set(objectType, domainMap);
  }

  let moduleOrder = domainMap.get('moduleOrder') as Y.Array<string> | undefined;
  if (!(moduleOrder instanceof Y.Array)) {
    moduleOrder = new Y.Array<string>();
    domainMap.set('moduleOrder', moduleOrder);
  }

  let modulesMap = domainMap.get('modules') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(modulesMap instanceof Y.Map)) {
    modulesMap = new Y.Map<Y.Map<unknown>>();
    domainMap.set('modules', modulesMap);
  }

  let functionOrder = domainMap.get('functionOrder') as Y.Array<string> | undefined;
  if (!(functionOrder instanceof Y.Array)) {
    functionOrder = new Y.Array<string>();
    domainMap.set('functionOrder', functionOrder);
  }

  let functionsMap = domainMap.get('functions') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(functionsMap instanceof Y.Map)) {
    functionsMap = new Y.Map<Y.Map<unknown>>();
    domainMap.set('functions', functionsMap);
  }

  return { domainMap, moduleOrder, modulesMap, functionOrder, functionsMap };
}

function getColumnsById(doc: Y.Doc, objectType: ObjectType): Map<string, Column> {
  const configMap = doc.getMap<unknown>('config');
  const objectTypesMap = configMap.get('objectTypes') as Y.Map<Y.Map<unknown>> | undefined;
  const objMap = objectTypesMap?.get(objectType);
  const rawColumns = objMap?.get('columns');
  const map = new Map<string, Column>();
  if (Array.isArray(rawColumns)) {
    for (const col of rawColumns as Column[]) {
      if (col && typeof col.id === 'string') {
        map.set(col.id, col);
      }
    }
  }
  return map;
}

function ensureYTextProperty(map: Y.Map<unknown>, key: string, textValue: string): Y.Text {
  const existing = map.get(key);
  if (existing instanceof Y.Text) {
    applyTextChange(existing, textValue);
    return existing;
  }
  const ytext = new Y.Text();
  map.set(key, ytext);
  if (textValue.length > 0) {
    ytext.insert(0, textValue);
  }
  return ytext;
}

/**
 * Updates `ProjectConfig` inside `doc` and reconciles item column values
 * if columns were added (with defaults), removed, or changed between text and scalar types.
 */
export function updateYDocConfig(doc: Y.Doc, config: ProjectConfig): void {
  doc.transact(() => {
    const configMap = doc.getMap<unknown>('config');
    setMapIfChanged(configMap, 'version', config.version);
    setMapIfChanged(configMap, 'projectId', config.projectId);
    setMapIfChanged(configMap, 'projectName', config.projectName);
    setMapIfChanged(configMap, 'projectPrefix', config.projectPrefix);
    setMapIfChanged(configMap, 'idCasing', config.idCasing);

    let objectTypesMap = configMap.get('objectTypes') as Y.Map<Y.Map<unknown>> | undefined;
    if (!(objectTypesMap instanceof Y.Map)) {
      objectTypesMap = new Y.Map<Y.Map<unknown>>();
      configMap.set('objectTypes', objectTypesMap);
    }

    const domainsMap = doc.getMap<Y.Map<unknown>>('domains');

    for (const type of objectTypes) {
      const objConfig = config.objectTypes[type];
      let objMap = objectTypesMap.get(type);
      if (!(objMap instanceof Y.Map)) {
        objMap = new Y.Map<unknown>();
        objectTypesMap.set(type, objMap);
      }
      setMapIfChanged(objMap, 'name', objConfig.name);
      setMapIfChanged(objMap, 'prefix', objConfig.prefix);
      setMapIfChanged(objMap, 'enabled', objConfig.enabled);
      setMapIfChanged(objMap, 'usePrefix', objConfig.usePrefix);

      const currentCols = objMap.get('columns');
      if (JSON.stringify(currentCols) !== JSON.stringify(objConfig.columns)) {
        objMap.set('columns', structuredClone(objConfig.columns));
      }

      // Reconcile existing items in this domain if already present
      const domainMap = domainsMap.get(type);
      const functionsMap = domainMap?.get('functions') as Y.Map<Y.Map<unknown>> | undefined;
      if (functionsMap instanceof Y.Map) {
        const nextColumnsById = new Map(objConfig.columns.map(c => [c.id, c]));
        for (const fnMap of functionsMap.values()) {
          const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
          if (!(itemsMap instanceof Y.Map)) continue;
          for (const itemMap of itemsMap.values()) {
            const valuesMap = itemMap.get('values') as Y.Map<unknown> | undefined;
            if (!(valuesMap instanceof Y.Map)) continue;
            for (const existingKey of Array.from(valuesMap.keys())) {
              if (!nextColumnsById.has(existingKey)) {
                valuesMap.delete(existingKey);
              }
            }
            for (const col of objConfig.columns) {
              const currentVal = valuesMap.get(col.id);
              if (currentVal === undefined) {
                if (col.default !== undefined) {
                  if (isTextColumnType(col.type) && typeof col.default === 'string') {
                    ensureYTextProperty(valuesMap, col.id, col.default);
                  } else {
                    valuesMap.set(col.id, col.default);
                  }
                }
              } else if (isTextColumnType(col.type)) {
                if (typeof currentVal === 'string') {
                  ensureYTextProperty(valuesMap, col.id, currentVal);
                }
              } else if (currentVal instanceof Y.Text) {
                valuesMap.set(col.id, currentVal.toString());
              }
            }
          }
        }
      }
    }
  });
}

/**
 * Appends retired item IDs to `doc.getArray('retiredIds')`, avoiding duplicates.
 */
export function addYDocRetiredIds(doc: Y.Doc, ids: Iterable<string>): void {
  doc.transact(() => {
    const retiredArray = doc.getArray<string>('retiredIds');
    const existing = new Set(retiredArray.toArray());
    const toAppend: string[] = [];
    for (const id of ids) {
      if (id && !isPendingItemId(id) && !existing.has(id)) {
        existing.add(id);
        toAppend.push(id);
      }
    }
    if (toAppend.length > 0) {
      retiredArray.push(toAppend);
    }
  });
}

/**
 * Inserts or updates a `Module` in `doc`, preserving its `description` `Y.Text` instance.
 */
export function upsertYDocModule(doc: Y.Doc, objectType: ObjectType, module: Module): void {
  doc.transact(() => {
    const { moduleOrder, modulesMap } = ensureDomainMap(doc, objectType);
    let modMap = modulesMap.get(module.id);
    if (!(modMap instanceof Y.Map)) {
      modMap = new Y.Map<unknown>();
      modulesMap.set(module.id, modMap);
    }
    setMapIfChanged(modMap, 'id', module.id);
    setMapIfChanged(modMap, 'name', module.name);
    setMapIfChanged(modMap, 'prefix', module.prefix);
    setMapIfChanged(modMap, 'parentId', module.parentId);
    ensureYTextProperty(modMap, 'description', module.description);
    appendUniqueToYStringArray(moduleOrder, module.id);
  });
}

/**
 * Character-level update for a module's `description` `Y.Text`.
 */
export function updateYDocModuleDescription(
  doc: Y.Doc,
  objectType: ObjectType,
  moduleId: string,
  description: string,
): boolean {
  const ytext = getYDocModuleDescriptionText(doc, objectType, moduleId);
  if (!ytext) {
    throw new Error(`Module '${moduleId}' not found in ${objectType}`);
  }
  return applyTextChange(ytext, description);
}

/**
 * Deletes a module, all its descendant submodules, and all functions inside them,
 * retiring all permanent item IDs contained in those functions. Returns the retired item IDs.
 */
export function deleteYDocModule(doc: Y.Doc, objectType: ObjectType, moduleId: string): string[] {
  const retiredIds: string[] = [];
  doc.transact(() => {
    const { moduleOrder, modulesMap, functionOrder, functionsMap } = ensureDomainMap(
      doc,
      objectType,
    );
    if (!modulesMap.has(moduleId)) {
      throw new Error(`Module '${moduleId}' not found in ${objectType}`);
    }

    const toDeleteModules = new Set<string>([moduleId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, modMap] of modulesMap.entries()) {
        const parentId = modMap.get('parentId');
        if (typeof parentId === 'string' && toDeleteModules.has(parentId) && !toDeleteModules.has(id)) {
          toDeleteModules.add(id);
          grew = true;
        }
      }
    }

    for (const [fnId, fnMap] of Array.from(functionsMap.entries())) {
      const parentModuleId = fnMap.get('parentModuleId');
      if (typeof parentModuleId === 'string' && toDeleteModules.has(parentModuleId)) {
        const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
        if (itemsMap instanceof Y.Map) {
          for (const itemId of itemsMap.keys()) {
            if (!isPendingItemId(itemId)) {
              retiredIds.push(itemId);
            }
          }
        }
        functionsMap.delete(fnId);
        removeFromYStringArray(functionOrder, fnId);
      }
    }

    for (const modId of toDeleteModules) {
      modulesMap.delete(modId);
      removeFromYStringArray(moduleOrder, modId);
    }

    if (retiredIds.length > 0) {
      addYDocRetiredIds(doc, retiredIds);
    }
  });
  return retiredIds;
}

function writeItemToYMap(
  itemMap: Y.Map<unknown>,
  item: Item,
  columnsById: Map<string, Column>,
): void {
  setMapIfChanged(itemMap, 'id', item.id);
  setMapIfChanged(itemMap, 'seq', item.seq);
  setMapIfChanged(itemMap, 'created_at', item.created_at);
  if (item.updated_at !== undefined) {
    setMapIfChanged(itemMap, 'updated_at', item.updated_at);
  } else if (itemMap.has('updated_at')) {
    itemMap.delete('updated_at');
  }

  let valuesMap = itemMap.get('values') as Y.Map<unknown> | undefined;
  if (!(valuesMap instanceof Y.Map)) {
    valuesMap = new Y.Map<unknown>();
    itemMap.set('values', valuesMap);
  }

  const incomingKeys = new Set(Object.keys(item.values));
  for (const existingKey of Array.from(valuesMap.keys())) {
    if (!incomingKeys.has(existingKey)) {
      valuesMap.delete(existingKey);
    }
  }

  for (const [colId, val] of Object.entries(item.values)) {
    if (val === undefined) continue;
    const col = columnsById.get(colId);
    if (isTextColumnType(col?.type) && typeof val === 'string') {
      ensureYTextProperty(valuesMap, colId, val);
    } else {
      setMapIfChanged(valuesMap, colId, val);
    }
  }
}

/**
 * Inserts or updates a `FunctionGroup` in `doc`, preserving its `description` `Y.Text`
 * and optionally syncing its `items`.
 */
export function upsertYDocFunction(
  doc: Y.Doc,
  objectType: ObjectType,
  fn: Omit<FunctionGroup, 'modulePath' | 'items'> & { items?: Item[] },
): void {
  doc.transact(() => {
    const { functionOrder, functionsMap } = ensureDomainMap(doc, objectType);
    const columnsById = getColumnsById(doc, objectType);

    let fnMap = functionsMap.get(fn.functionId);
    if (!(fnMap instanceof Y.Map)) {
      fnMap = new Y.Map<unknown>();
      functionsMap.set(fn.functionId, fnMap);
    }

    setMapIfChanged(fnMap, 'functionId', fn.functionId);
    setMapIfChanged(fnMap, 'name', fn.name);
    setMapIfChanged(fnMap, 'prefix', fn.prefix);
    setMapIfChanged(fnMap, 'parentModuleId', fn.parentModuleId);
    ensureYTextProperty(fnMap, 'description', fn.description);

    const existingWatermark = fnMap.get('watermarkCounter');
    const nextWatermark =
      typeof existingWatermark === 'number'
        ? Math.max(existingWatermark, fn.watermarkCounter)
        : fn.watermarkCounter;
    setMapIfChanged(fnMap, 'watermarkCounter', nextWatermark);

    let itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
    if (!(itemOrder instanceof Y.Array)) {
      itemOrder = new Y.Array<string>();
      fnMap.set('itemOrder', itemOrder);
    }

    let itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    if (!(itemsMap instanceof Y.Map)) {
      itemsMap = new Y.Map<Y.Map<unknown>>();
      fnMap.set('items', itemsMap);
    }

    if (fn.items !== undefined) {
      for (const item of fn.items) {
        let itemMap = itemsMap.get(item.id);
        if (!(itemMap instanceof Y.Map)) {
          itemMap = new Y.Map<unknown>();
          itemsMap.set(item.id, itemMap);
        }
        writeItemToYMap(itemMap, item, columnsById);
        appendUniqueToYStringArray(itemOrder, item.id);
      }
    }

    appendUniqueToYStringArray(functionOrder, fn.functionId);
  });
}

/**
 * Character-level update for a function's `description` `Y.Text`.
 */
export function updateYDocFunctionDescription(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  description: string,
): boolean {
  const ytext = getYDocFunctionDescriptionText(doc, objectType, functionId);
  if (!ytext) {
    throw new Error(`Function '${functionId}' not found in ${objectType}`);
  }
  return applyTextChange(ytext, description);
}

/**
 * Monotonically updates a function's `watermarkCounter`.
 */
export function setYDocWatermark(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  watermarkCounter: number,
): void {
  doc.transact(() => {
    const { functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }
    const current = fnMap.get('watermarkCounter');
    const next = typeof current === 'number' ? Math.max(current, watermarkCounter) : watermarkCounter;
    setMapIfChanged(fnMap, 'watermarkCounter', next);
  });
}

/**
 * Deletes a function and retires all permanent item IDs inside it. Returns the retired item IDs.
 */
export function deleteYDocFunction(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
): string[] {
  const retiredIds: string[] = [];
  doc.transact(() => {
    const { functionOrder, functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }
    const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    if (itemsMap instanceof Y.Map) {
      for (const itemId of itemsMap.keys()) {
        if (!isPendingItemId(itemId)) {
          retiredIds.push(itemId);
        }
      }
    }
    functionsMap.delete(functionId);
    removeFromYStringArray(functionOrder, functionId);
    if (retiredIds.length > 0) {
      addYDocRetiredIds(doc, retiredIds);
    }
  });
  return retiredIds;
}

/**
 * Inserts or updates an `Item` inside a function in `doc`, updating `watermarkCounter` monotonically.
 */
export function upsertYDocItem(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  item: Item,
): void {
  doc.transact(() => {
    const { functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }

    const columnsById = getColumnsById(doc, objectType);
    let itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
    if (!(itemOrder instanceof Y.Array)) {
      itemOrder = new Y.Array<string>();
      fnMap.set('itemOrder', itemOrder);
    }

    let itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    if (!(itemsMap instanceof Y.Map)) {
      itemsMap = new Y.Map<Y.Map<unknown>>();
      fnMap.set('items', itemsMap);
    }

    let itemMap = itemsMap.get(item.id);
    if (!(itemMap instanceof Y.Map)) {
      itemMap = new Y.Map<unknown>();
      itemsMap.set(item.id, itemMap);
    }

    writeItemToYMap(itemMap, item, columnsById);
    appendUniqueToYStringArray(itemOrder, item.id);

    if (!isPendingItemId(item.id) && item.seq > 0) {
      const currentWatermark = fnMap.get('watermarkCounter');
      const nextWatermark =
        typeof currentWatermark === 'number' ? Math.max(currentWatermark, item.seq) : item.seq;
      setMapIfChanged(fnMap, 'watermarkCounter', nextWatermark);
    }
  });
}

/**
 * Updates a single field value on an item in `doc`.
 * Text/Markdown/String columns use character-level `Y.Text` diffing;
 * scalar columns (`enum`, `number`, `boolean`, `date`, `reference`) use last-writer-wins on `values` `Y.Map`.
 */
export function updateYDocItemField(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  itemId: string,
  columnId: string,
  value: string | number | boolean | null,
  updatedAt?: string,
): void {
  doc.transact(() => {
    const { functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }
    const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    const itemMap = itemsMap?.get(itemId);
    if (!(itemMap instanceof Y.Map)) {
      throw new Error(`Item '${itemId}' not found in function '${functionId}'`);
    }

    let valuesMap = itemMap.get('values') as Y.Map<unknown> | undefined;
    if (!(valuesMap instanceof Y.Map)) {
      valuesMap = new Y.Map<unknown>();
      itemMap.set('values', valuesMap);
    }

    const columnsById = getColumnsById(doc, objectType);
    const col = columnsById.get(columnId);

    if (isTextColumnType(col?.type) && typeof value === 'string') {
      ensureYTextProperty(valuesMap, columnId, value);
    } else {
      valuesMap.set(columnId, value);
    }

    setMapIfChanged(itemMap, 'updated_at', updatedAt ?? new Date().toISOString());
  });
}

/**
 * Deletes an item from a function in `doc`, appending its ID to `retiredIds`
 * (unless it is a temporary `__pending__:` item) while preserving `watermarkCounter`.
 */
export function deleteYDocItem(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  itemId: string,
): boolean {
  let deleted = false;
  doc.transact(() => {
    const { functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }
    const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    const itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
    if (!itemsMap?.has(itemId)) {
      return;
    }
    itemsMap.delete(itemId);
    if (itemOrder instanceof Y.Array) {
      removeFromYStringArray(itemOrder, itemId);
    }
    if (!isPendingItemId(itemId)) {
      addYDocRetiredIds(doc, [itemId]);
    }
    deleted = true;
  });
  return deleted;
}

export interface PendingYDocItem {
  tempId: string;
  objectType: ObjectType;
  functionId: string;
  created_at: string;
  updated_at?: string;
  values: Item['values'];
}

/**
 * Adds a temporary pending item (`__pending__:<uuid>`) to a function in `doc`
 * before the server assigns its authoritative permanent ID and sequence number.
 */
export function addYDocPendingItem(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  tempId: string,
  values: Item['values'],
  createdAt: string = new Date().toISOString(),
): Item {
  const normalizedTempId = isPendingItemId(tempId) ? tempId : `${PENDING_ITEM_PREFIX}${tempId}`;
  const pendingItem: Item = {
    id: normalizedTempId,
    seq: 0,
    created_at: createdAt,
    values: structuredClone(values),
  };
  upsertYDocItem(doc, objectType, functionId, pendingItem);
  return pendingItem;
}

/**
 * Atomically replaces a temporary pending item (`__pending__:...`) with its
 * server-allocated permanent `Item` and updates `watermarkCounter`.
 */
export function resolveYDocPendingItem(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  tempId: string,
  permanentItem: Item,
): void {
  const normalizedTempId = isPendingItemId(tempId) ? tempId : `${PENDING_ITEM_PREFIX}${tempId}`;
  doc.transact(() => {
    const { functionsMap } = ensureDomainMap(doc, objectType);
    const fnMap = functionsMap.get(functionId);
    if (!(fnMap instanceof Y.Map)) {
      throw new Error(`Function '${functionId}' not found in ${objectType}`);
    }

    const columnsById = getColumnsById(doc, objectType);
    let itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
    if (!(itemOrder instanceof Y.Array)) {
      itemOrder = new Y.Array<string>();
      fnMap.set('itemOrder', itemOrder);
    }

    let itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
    if (!(itemsMap instanceof Y.Map)) {
      itemsMap = new Y.Map<Y.Map<unknown>>();
      fnMap.set('items', itemsMap);
    }

    itemsMap.delete(normalizedTempId);
    if (tempId !== normalizedTempId) {
      itemsMap.delete(tempId);
    }

    let permMap = itemsMap.get(permanentItem.id);
    if (!(permMap instanceof Y.Map)) {
      permMap = new Y.Map<unknown>();
      itemsMap.set(permanentItem.id, permMap);
    }
    writeItemToYMap(permMap, permanentItem, columnsById);

    const orderSnapshot = itemOrder.toArray();
    const pendingIdx = orderSnapshot.findIndex(id => id === normalizedTempId || id === tempId);
    if (pendingIdx >= 0) {
      itemOrder.delete(pendingIdx, 1);
      if (!itemOrder.toArray().includes(permanentItem.id)) {
        itemOrder.insert(pendingIdx, [permanentItem.id]);
      }
    } else {
      appendUniqueToYStringArray(itemOrder, permanentItem.id);
    }

    const currentWatermark = fnMap.get('watermarkCounter');
    const nextWatermark =
      typeof currentWatermark === 'number'
        ? Math.max(currentWatermark, permanentItem.seq)
        : permanentItem.seq;
    setMapIfChanged(fnMap, 'watermarkCounter', nextWatermark);
  });
}

/**
 * Extracts all unresolved temporary pending items (`__pending__:...`) across all domains in `doc`.
 */
export function getPendingItemsInYDoc(doc: Y.Doc): PendingYDocItem[] {
  const result: PendingYDocItem[] = [];
  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  for (const type of objectTypes) {
    const domainMap = domainsMap.get(type);
    const functionsMap = domainMap?.get('functions') as Y.Map<Y.Map<unknown>> | undefined;
    const functionOrder = domainMap?.get('functionOrder') as Y.Array<string> | undefined;
    if (!(functionsMap instanceof Y.Map)) continue;

    const orderedFnIds = collectOrderedKeys(functionOrder, functionsMap);
    for (const fnId of orderedFnIds) {
      const fnMap = functionsMap.get(fnId);
      if (!(fnMap instanceof Y.Map)) continue;
      const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
      const itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
      if (!(itemsMap instanceof Y.Map)) continue;

      const orderedItemIds = collectOrderedKeys(itemOrder, itemsMap);
      for (const itemId of orderedItemIds) {
        if (!isPendingItemId(itemId)) continue;
        const itemMap = itemsMap.get(itemId);
        if (!(itemMap instanceof Y.Map)) continue;
        const item = readItemFromYMap(itemId, itemMap);
        const entry: PendingYDocItem = {
          tempId: item.id,
          objectType: type,
          functionId: fnId,
          created_at: item.created_at,
          values: item.values,
        };
        if (item.updated_at !== undefined) {
          entry.updated_at = item.updated_at;
        }
        result.push(entry);
      }
    }
  }
  return result;
}

/**
 * Returns the live `Y.Text` instance for a module's `description`, or `null` if not found.
 */
export function getYDocModuleDescriptionText(
  doc: Y.Doc,
  objectType: ObjectType,
  moduleId: string,
): Y.Text | null {
  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  const domainMap = domainsMap.get(objectType);
  const modulesMap = domainMap?.get('modules') as Y.Map<Y.Map<unknown>> | undefined;
  const modMap = modulesMap?.get(moduleId);
  const desc = modMap?.get('description');
  return desc instanceof Y.Text ? desc : null;
}

/**
 * Returns the live `Y.Text` instance for a function's `description`, or `null` if not found.
 */
export function getYDocFunctionDescriptionText(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
): Y.Text | null {
  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  const domainMap = domainsMap.get(objectType);
  const functionsMap = domainMap?.get('functions') as Y.Map<Y.Map<unknown>> | undefined;
  const fnMap = functionsMap?.get(functionId);
  const desc = fnMap?.get('description');
  return desc instanceof Y.Text ? desc : null;
}

/**
 * Returns the live `Y.Text` instance for a text/markdown/string item column, or `null` if not a `Y.Text`.
 */
export function getYDocItemFieldText(
  doc: Y.Doc,
  objectType: ObjectType,
  functionId: string,
  itemId: string,
  columnId: string,
): Y.Text | null {
  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  const domainMap = domainsMap.get(objectType);
  const functionsMap = domainMap?.get('functions') as Y.Map<Y.Map<unknown>> | undefined;
  const fnMap = functionsMap?.get(functionId);
  const itemsMap = fnMap?.get('items') as Y.Map<Y.Map<unknown>> | undefined;
  const itemMap = itemsMap?.get(itemId);
  const valuesMap = itemMap?.get('values') as Y.Map<unknown> | undefined;
  const field = valuesMap?.get(columnId);
  return field instanceof Y.Text ? field : null;
}

/**
 * Synchronizes `doc` in-place to match `nextWorkspace` inside a single Yjs transaction,
 * preserving existing `Y.Text` instances so character-level history is retained.
 */
export function syncWorkspaceToYDoc(doc: Y.Doc, nextWorkspace: Workspace): void {
  doc.transact(() => {
    updateYDocConfig(doc, nextWorkspace.config);

    const retiredArray = doc.getArray<string>('retiredIds');
    const dedupedRetired = Array.from(new Set(nextWorkspace.retiredIds));
    syncYStringArray(retiredArray, dedupedRetired);

    for (const type of objectTypes) {
      const nextDomain = nextWorkspace.domains[type];
      const { moduleOrder, modulesMap, functionOrder, functionsMap } = ensureDomainMap(doc, type);
      const columnsById = getColumnsById(doc, type);

      const nextModuleIds = new Set(nextDomain.modules.map(m => m.id));
      for (const existingModId of Array.from(modulesMap.keys())) {
        if (!nextModuleIds.has(existingModId)) {
          modulesMap.delete(existingModId);
        }
      }
      for (const mod of nextDomain.modules) {
        upsertYDocModule(doc, type, mod);
      }
      syncYStringArray(
        moduleOrder,
        nextDomain.modules.map(m => m.id),
      );

      const nextFunctionIds = new Set(nextDomain.functions.map(f => f.functionId));
      for (const existingFnId of Array.from(functionsMap.keys())) {
        if (!nextFunctionIds.has(existingFnId)) {
          functionsMap.delete(existingFnId);
        }
      }

      for (const fn of nextDomain.functions) {
        let fnMap = functionsMap.get(fn.functionId);
        if (!(fnMap instanceof Y.Map)) {
          fnMap = new Y.Map<unknown>();
          functionsMap.set(fn.functionId, fnMap);
        }
        setMapIfChanged(fnMap, 'functionId', fn.functionId);
        setMapIfChanged(fnMap, 'name', fn.name);
        setMapIfChanged(fnMap, 'prefix', fn.prefix);
        setMapIfChanged(fnMap, 'parentModuleId', fn.parentModuleId);
        ensureYTextProperty(fnMap, 'description', fn.description);
        setMapIfChanged(fnMap, 'watermarkCounter', fn.watermarkCounter);

        let itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
        if (!(itemOrder instanceof Y.Array)) {
          itemOrder = new Y.Array<string>();
          fnMap.set('itemOrder', itemOrder);
        }

        let itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
        if (!(itemsMap instanceof Y.Map)) {
          itemsMap = new Y.Map<Y.Map<unknown>>();
          fnMap.set('items', itemsMap);
        }

        const nextItemIds = new Set(fn.items.map(i => i.id));
        for (const existingItemId of Array.from(itemsMap.keys())) {
          if (!nextItemIds.has(existingItemId)) {
            itemsMap.delete(existingItemId);
          }
        }

        for (const item of fn.items) {
          let itemMap = itemsMap.get(item.id);
          if (!(itemMap instanceof Y.Map)) {
            itemMap = new Y.Map<unknown>();
            itemsMap.set(item.id, itemMap);
          }
          writeItemToYMap(itemMap, item, columnsById);
        }

        syncYStringArray(
          itemOrder,
          fn.items.map(i => i.id),
        );
      }

      syncYStringArray(
        functionOrder,
        nextDomain.functions.map(f => f.functionId),
      );
    }
  });
}

/**
 * Converts a `Workspace` into a `Y.Doc` (creating a new `Y.Doc` or populating `targetDoc`).
 */
export function workspaceToYDoc(workspace: Workspace, targetDoc?: Y.Doc): Y.Doc {
  const doc = targetDoc ?? new Y.Doc();
  syncWorkspaceToYDoc(doc, workspace);
  return doc;
}

function collectOrderedKeys(
  orderArray: Y.Array<string> | undefined,
  map: Y.Map<Y.Map<unknown>> | undefined,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  if (orderArray instanceof Y.Array) {
    for (const id of orderArray.toArray()) {
      if (typeof id === 'string' && !seen.has(id) && map?.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  if (map instanceof Y.Map) {
    for (const id of map.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

function readItemFromYMap(fallbackId: string, itemMap: Y.Map<unknown>): Item {
  const id = typeof itemMap.get('id') === 'string' ? (itemMap.get('id') as string) : fallbackId;
  const rawSeq = itemMap.get('seq');
  const seq = typeof rawSeq === 'number' && Number.isInteger(rawSeq) ? rawSeq : 0;
  const createdAt =
    typeof itemMap.get('created_at') === 'string'
      ? (itemMap.get('created_at') as string)
      : '1970-01-01T00:00:00.000Z';
  const updatedAt = itemMap.get('updated_at');

  const values: Item['values'] = {};
  const valuesMap = itemMap.get('values') as Y.Map<unknown> | undefined;
  if (valuesMap instanceof Y.Map) {
    for (const [colId, rawVal] of valuesMap.entries()) {
      if (rawVal instanceof Y.Text) {
        values[colId] = rawVal.toString();
      } else if (
        typeof rawVal === 'string' ||
        typeof rawVal === 'number' ||
        typeof rawVal === 'boolean' ||
        rawVal === null
      ) {
        values[colId] = rawVal;
      }
    }
  }

  const item: Item = {
    id,
    seq,
    created_at: createdAt,
    values,
  };
  if (typeof updatedAt === 'string') {
    item.updated_at = updatedAt;
  }
  return item;
}

export interface YDocToWorkspaceOptions {
  includePending?: boolean;
}

/**
 * Converts a `Y.Doc` deterministically back into a `Workspace`.
 * By default, temporary pending items (`__pending__:<uuid>`) are excluded so the returned
 * `Workspace` is ready for `validateWorkspace`. Pass `{ includePending: true }` to include them.
 */
export function yDocToWorkspace(doc: Y.Doc, options?: YDocToWorkspaceOptions): Workspace {
  const includePending = options?.includePending ?? false;
  const configMap = doc.getMap<unknown>('config');
  const objectTypesMap = configMap.get('objectTypes') as Y.Map<Y.Map<unknown>> | undefined;

  const parsedObjectTypes = {} as ProjectConfig['objectTypes'];
  for (const type of objectTypes) {
    const objMap = objectTypesMap?.get(type);
    const rawColumns = objMap?.get('columns');
    parsedObjectTypes[type] = {
      name: typeof objMap?.get('name') === 'string' ? (objMap.get('name') as string) : type,
      prefix: typeof objMap?.get('prefix') === 'string' ? (objMap.get('prefix') as string) : '',
      enabled: typeof objMap?.get('enabled') === 'boolean' ? (objMap.get('enabled') as boolean) : true,
      usePrefix:
        typeof objMap?.get('usePrefix') === 'boolean' ? (objMap.get('usePrefix') as boolean) : true,
      columns: Array.isArray(rawColumns) ? structuredClone(rawColumns as Column[]) : [],
    };
  }

  const rawCasing = configMap.get('idCasing');
  const idCasing: ProjectConfig['idCasing'] =
    rawCasing === 'UPPER' || rawCasing === 'LOWER' || rawCasing === 'AS_IS' ? rawCasing : 'UPPER';

  const config: ProjectConfig = {
    version: '1.0.0',
    projectId:
      typeof configMap.get('projectId') === 'string' ? (configMap.get('projectId') as string) : '',
    projectName:
      typeof configMap.get('projectName') === 'string'
        ? (configMap.get('projectName') as string)
        : '',
    projectPrefix:
      typeof configMap.get('projectPrefix') === 'string'
        ? (configMap.get('projectPrefix') as string)
        : '',
    idCasing,
    objectTypes: parsedObjectTypes,
  };

  const retiredArray = doc.getArray<string>('retiredIds');
  const retiredIds = Array.from(
    new Set(retiredArray.toArray().filter((id): id is string => typeof id === 'string')),
  );

  const domainsMap = doc.getMap<Y.Map<unknown>>('domains');
  const domains = {} as Workspace['domains'];

  for (const type of objectTypes) {
    const domainMap = domainsMap.get(type);
    const moduleOrder = domainMap?.get('moduleOrder') as Y.Array<string> | undefined;
    const modulesMap = domainMap?.get('modules') as Y.Map<Y.Map<unknown>> | undefined;
    const functionOrder = domainMap?.get('functionOrder') as Y.Array<string> | undefined;
    const functionsMap = domainMap?.get('functions') as Y.Map<Y.Map<unknown>> | undefined;

    const modules: Module[] = [];
    const orderedModIds = collectOrderedKeys(moduleOrder, modulesMap);
    for (const modId of orderedModIds) {
      const modMap = modulesMap?.get(modId);
      if (!(modMap instanceof Y.Map)) continue;
      const rawDesc = modMap.get('description');
      const description =
        rawDesc instanceof Y.Text
          ? rawDesc.toString()
          : typeof rawDesc === 'string'
            ? rawDesc
            : '';
      const rawParentId = modMap.get('parentId');
      modules.push({
        id: typeof modMap.get('id') === 'string' ? (modMap.get('id') as string) : modId,
        name: typeof modMap.get('name') === 'string' ? (modMap.get('name') as string) : '',
        prefix: typeof modMap.get('prefix') === 'string' ? (modMap.get('prefix') as string) : '',
        description,
        parentId: typeof rawParentId === 'string' ? rawParentId : null,
      });
    }

    const functions: FunctionGroup[] = [];
    const orderedFnIds = collectOrderedKeys(functionOrder, functionsMap);
    for (const fnId of orderedFnIds) {
      const fnMap = functionsMap?.get(fnId);
      if (!(fnMap instanceof Y.Map)) continue;
      const rawDesc = fnMap.get('description');
      const description =
        rawDesc instanceof Y.Text
          ? rawDesc.toString()
          : typeof rawDesc === 'string'
            ? rawDesc
            : '';
      const parentModuleId =
        typeof fnMap.get('parentModuleId') === 'string'
          ? (fnMap.get('parentModuleId') as string)
          : '';
      const rawWatermark = fnMap.get('watermarkCounter');
      const watermarkCounter =
        typeof rawWatermark === 'number' && Number.isInteger(rawWatermark) ? rawWatermark : 0;

      let modulePath: string[] = [];
      try {
        modulePath = moduleChain(modules, parentModuleId).map(m => m.name);
      } catch {
        modulePath = [];
      }

      const itemOrder = fnMap.get('itemOrder') as Y.Array<string> | undefined;
      const itemsMap = fnMap.get('items') as Y.Map<Y.Map<unknown>> | undefined;
      const orderedItemIds = collectOrderedKeys(itemOrder, itemsMap);
      const items: Item[] = [];

      for (const itemId of orderedItemIds) {
        if (!includePending && isPendingItemId(itemId)) {
          continue;
        }
        const itemMap = itemsMap?.get(itemId);
        if (!(itemMap instanceof Y.Map)) continue;
        items.push(readItemFromYMap(itemId, itemMap));
      }

      functions.push({
        functionId:
          typeof fnMap.get('functionId') === 'string'
            ? (fnMap.get('functionId') as string)
            : fnId,
        name: typeof fnMap.get('name') === 'string' ? (fnMap.get('name') as string) : '',
        prefix: typeof fnMap.get('prefix') === 'string' ? (fnMap.get('prefix') as string) : '',
        modulePath,
        parentModuleId,
        description,
        watermarkCounter,
        items,
      });
    }

    domains[type] = { modules, functions };
  }

  return {
    config,
    domains,
    retiredIds,
  };
}

/**
 * Creates an independent clone of `doc` with the exact same Yjs state vector and history.
 */
export function cloneYDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}
