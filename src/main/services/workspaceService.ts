import { mkdir, readFile, open, rename, readdir, unlink, lstat, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../../shared/types/workspace.js';
import { objectTypes } from '../../shared/types/schema.js';
import { validateWorkspace } from './validation.js';
const directories = { REQUIREMENT: 'requirements', DATA_DICTIONARY: 'data-dictionary', ENTITY: 'entities', ACTION: 'actions' };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

// Serialize saves/loads per workspace in this process. Multi-process editing is not supported.
const queues = new Map<string, Promise<unknown>>();
async function exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
async function safeDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Workspace directories cannot be symbolic links');
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } finally { await unlink(temp).catch(() => undefined); }
}
async function materialize(root: string, workspace: Workspace): Promise<void> {
  for (const type of objectTypes) {
    const directory = path.join(root, directories[type]);
    await safeDirectory(directory);
    const sets = path.join(directory, 'requirement-sets');
    await safeDirectory(sets);
    await atomicJson(path.join(directory, 'components.json'), workspace.domains[type].components);
    const expected = new Set<string>();
    for (const set of workspace.domains[type].requirementSets) {
      const filename = `rs-${set.requirementSetId}.json`;
      expected.add(filename);
      await atomicJson(path.join(sets, filename), set);
    }
    for (const filename of await readdir(sets)) {
      if (/^rs-.*\.json$/.test(filename) && !expected.has(filename)) await unlink(path.join(sets, filename));
    }
    await removeLegacyLayout(directory);
  }
  await atomicJson(path.join(root, 'project.config.json'), workspace.config);
  await atomicJson(path.join(root, 'retired-ids.json'), workspace.retiredIds);
}
/** Pre-component workspaces stored modules.json and functions/fn-*.json; the new files replace them. */
async function removeLegacyLayout(directory: string): Promise<void> {
  await unlink(path.join(directory, 'modules.json')).catch(ignoreMissing);
  const legacy = path.join(directory, 'functions');
  let files: string[];
  try { files = await readdir(legacy); } catch (error) { ignoreMissing(error); return; }
  for (const filename of files) if (/^fn-.*\.json$/.test(filename)) await unlink(path.join(legacy, filename));
  if (!(await readdir(legacy)).length) await rmdir(legacy);
}
function ignoreMissing(error: unknown): void { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { ignoreMissing(error); return false; }
}
async function recover(root: string): Promise<void> {
  let pending: unknown;
  try { pending = await readJson(path.join(root, '.hlr', 'pending-save.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await materialize(root, validateWorkspace(pending));
  await unlink(path.join(root, '.hlr', 'pending-save.json'));
}
export async function saveWorkspace(root: string, input: Workspace): Promise<void> {
  const workspace = validateWorkspace(input);
  await exclusive(root, async () => {
    await safeDirectory(root);
    await safeDirectory(path.join(root, '.hlr'));
    await recover(root);
    // A saved intent allows an interrupted multi-file write to be replayed on open.
    await atomicJson(path.join(root, '.hlr', 'pending-save.json'), workspace);
    await materialize(root, workspace);
    await unlink(path.join(root, '.hlr', 'pending-save.json'));
  });
}
export async function loadWorkspace(root: string): Promise<Workspace> {
  return exclusive(root, async () => {
    await recover(root);
    const config = await readJson(path.join(root, 'project.config.json'));
    const domains: Record<string, unknown> = {};
    for (const type of objectTypes) {
      const directory = path.join(root, directories[type]);
      const legacy = !(await exists(path.join(directory, 'components.json')));
      const [index, folder, pattern] = legacy ? ['modules.json', 'functions', /^fn-.*\.json$/] : ['components.json', 'requirement-sets', /^rs-.*\.json$/];
      const files = (await readdir(path.join(directory, folder))).filter(f => pattern.test(f)).sort();
      // validateWorkspace upgrades the legacy modules/functions shape.
      domains[type] = { [legacy ? 'modules' : 'components']: await readJson(path.join(directory, index)), [legacy ? 'functions' : 'requirementSets']: await Promise.all(files.map(f => readJson(path.join(directory, folder, f)))) };
    }
    let retiredIds: unknown = [];
    try { retiredIds = await readJson(path.join(root, 'retired-ids.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return validateWorkspace({ config, domains, retiredIds });
  });
}
