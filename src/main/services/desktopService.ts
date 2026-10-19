import { z } from 'zod';
import { authorRequirementSet } from './authoringService.js';
import { exportWorkspace } from './exportService.js';
import { mkdir, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../config/appConfig.js';
import { updateProjectConfig } from '../config/projectConfig.js';
import { WorkspaceIndex } from '../db/sqliteClient.js';
import { changeHierarchy } from './hierarchyService.js';
import { createWorkspace } from './workspaceFactory.js';
import { loadWorkspace, saveWorkspace } from './workspaceService.js';
import { appSettingsSchema } from '../../shared/appSettings.js';
import type { AppState, WorkspaceView } from '../../shared/api.js';
import type { Workspace } from '../../shared/types/workspace.js';
export class DesktopService {
  private current: WorkspaceView | null = null;
  private index: WorkspaceIndex | null = null;
  constructor(readonly config: AppConfig) {}
  state(): AppState { return structuredClone({ settings: this.config.get(), configPath: this.config.filename, current: this.current }); }
  private activate(root: string, workspace: Workspace): void {
    this.index?.close(); this.index = null;
    let status: WorkspaceView['index'];
    try { this.index = WorkspaceIndex.rebuild(root, workspace); status = { status: 'ready', count: this.index.count() }; }
    catch (error) { status = { status: 'unavailable', count: 0, error: error instanceof Error ? error.message : 'Index unavailable' }; }
    this.current = { root, workspace, index: status };
    this.config.remember(root);
  }
  async create(root: string, name: string, prefix: string): Promise<void> {
    const workspace = createWorkspace(name, prefix);
    // The chosen destination must be new. Never overwrite an existing directory.
    await mkdir(root, { recursive: false });
    try { await saveWorkspace(root, workspace); }
    catch (error) { if ((await readdir(root)).length === 0) await rmdir(root); throw error; }
    this.activate(path.resolve(root), workspace);
  }
  async open(root: string): Promise<void> {
    const workspace = await loadWorkspace(root);
    this.activate(path.resolve(root), workspace);
  }
  async save(): Promise<void> {
    if (!this.current) throw new Error('Open a project first');
    await saveWorkspace(this.current.root, this.current.workspace);
    this.activate(this.current.root, this.current.workspace);
  }
  async updateProject(input: unknown): Promise<void> {
    if (!this.current) throw new Error('Open a project first');
    const workspace = updateProjectConfig(this.current.workspace, input);
    await saveWorkspace(this.current.root, workspace);
    this.activate(this.current.root, workspace);
  }
  async changeHierarchy(input: unknown): Promise<void> {
    if (!this.current) throw new Error('Open a project first');
    const workspace = changeHierarchy(this.current.workspace, input);
    await saveWorkspace(this.current.root, workspace);
    this.activate(this.current.root, workspace);
  }
  async authorRequirementSet(input: unknown): Promise<void> {
    if (!this.current) throw new Error('Open a project first');
    const workspace = authorRequirementSet(this.current.workspace, input);
    await saveWorkspace(this.current.root, workspace);
    this.activate(this.current.root, workspace);
  }
  search(input: unknown) {
    const query = z.string().max(500).parse(input);
    if (!this.index) throw new Error('Open a project with an available search index first');
    return this.index.search(query);
  }
  export(input: unknown): string {
    if (!this.current) throw new Error('Open a project first');
    return exportWorkspace(this.current.workspace, input);
  }
  saveSettings(input: unknown): void {
    const general = appSettingsSchema.shape.general.parse(input);
    this.config.save({ ...this.config.get(), general });
  }
  close(): void { this.index?.close(); this.index = null; }
}
