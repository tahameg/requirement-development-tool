/**
 * Upgrades data written before the component terminology change (2026-10).
 * Legacy shape: domains[type].modules / .functions, functionId, parentModuleId, modulePath,
 * hierarchy actions addModule/addFunction/..., op kind 'function.description'.
 * Every function is idempotent and returns current-shape input unchanged.
 */
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
function renameKeys(input: Json, names: Record<string, string>): Json {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [names[key] ?? key, value]));
}
const setKeys = { functionId: 'requirementSetId', parentModuleId: 'parentComponentId', modulePath: 'componentPath' };
export function migrateRequirementSet(input: unknown): unknown {
  return isObject(input) && 'functionId' in input ? renameKeys(input, setKeys) : input;
}
export function migrateWorkspace(input: unknown): unknown {
  if (!isObject(input) || !isObject(input.domains)) return input;
  const domains = Object.fromEntries(Object.entries(input.domains).map(([type, domain]) => {
    if (!isObject(domain) || !('modules' in domain || 'functions' in domain)) return [type, domain];
    const { modules, functions, ...rest } = domain;
    return [type, { ...rest, components: modules, requirementSets: Array.isArray(functions) ? functions.map(migrateRequirementSet) : functions }];
  }));
  return { ...input, domains };
}
const actions: Record<string, string> = {
  addModule: 'addComponent', editModule: 'editComponent', deleteModule: 'deleteComponent',
  addFunction: 'addRequirementSet', editFunction: 'editRequirementSet', deleteFunction: 'deleteRequirementSet',
};
export function migrateHierarchyCommand(input: unknown): unknown {
  return isObject(input) && typeof input.action === 'string' && input.action in actions ? { ...input, action: actions[input.action] } : input;
}
/** Stored room_ops rows keep their original kind and payload, so replay must upgrade them. */
export function migrateOp(input: unknown): unknown {
  if (!isObject(input) || !isObject(input.payload)) return input;
  if (input.kind === 'hierarchy') return { ...input, payload: migrateHierarchyCommand(input.payload) };
  const kind = input.kind === 'function.description' ? 'requirementSet.description' : input.kind;
  return { ...input, kind, payload: 'functionId' in input.payload ? renameKeys(input.payload, setKeys) : input.payload };
}
export function migrateDraft(input: unknown): unknown {
  return isObject(input) && 'functionId' in input ? renameKeys(input, setKeys) : input;
}
