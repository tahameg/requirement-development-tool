import type { CollabCommand, CollabState } from './collab/client.js';
import type { FunctionEdit, ExportRequest, SearchHit } from './authoring.js';
import type { HierarchyCommand } from './hierarchy.js';
import type { AppSettings } from './appSettings.js';
import type { Workspace } from './types/workspace.js';
import type { ProjectConfig } from './types/config.js';
export interface WorkspaceView { root: string; workspace: Workspace; index: { status: 'ready' | 'unavailable'; count: number; error?: string }; }
export interface AppState { settings: AppSettings; configPath: string; current: WorkspaceView | null; }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  collab(command: CollabCommand): Promise<Result<any>>;
  onCollabState(listener: (state: CollabState) => void): () => void;
  editFunction(command: FunctionEdit): Promise<Result<AppState>>;
  search(query: string): Promise<Result<SearchHit[]>>;
  exportWorkspace(request: ExportRequest): Promise<Result<string | null>>;
  changeHierarchy(command: HierarchyCommand): Promise<Result<AppState>>;
  state(): Promise<Result<AppState>>;
  createProject(name: string, prefix: string): Promise<Result<AppState>>;
  openProject(): Promise<Result<AppState>>;
  openRecent(index: number): Promise<Result<AppState>>;
  saveProject(): Promise<Result<AppState>>;
  updateProject(config: ProjectConfig): Promise<Result<AppState>>;
  saveSettings(general: AppSettings['general']): Promise<Result<AppState>>;
}
export const channels = { editFunction: 'hlr:edit-function', search: 'hlr:search', exportWorkspace: 'hlr:export', changeHierarchy: 'hlr:hierarchy', state: 'hlr:state', createProject: 'hlr:create', openProject: 'hlr:open', openRecent: 'hlr:recent', saveProject: 'hlr:save', updateProject: 'hlr:project-settings', saveSettings: 'hlr:app-settings' } as const;
