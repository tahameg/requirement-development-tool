import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfig, appConfigPath } from '../../src/main/config/appConfig.js';
import { updateProjectConfig } from '../../src/main/config/projectConfig.js';
import { createWorkspace, addComponent, addRequirementSet } from '../../src/main/services/workspaceFactory.js';
import { addItem } from '../../src/main/services/idGenerator.js';

describe('application INI configuration', () => {
  it('uses platform-specific config locations and environment overrides', () => {
    expect(appConfigPath('linux', {}, '/home/user')).toBe('/home/user/.config/hlr-writing-tool/config.ini');
    expect(appConfigPath('linux', { XDG_CONFIG_HOME: '/settings' }, '/home/user')).toBe('/settings/hlr-writing-tool/config.ini');
    expect(appConfigPath('win32', { APPDATA: '/roaming' }, '/home/user')).toBe('/roaming/hlr-writing-tool/config.ini');
    expect(appConfigPath('win32', {}, '/home/user')).toBe('/home/user/AppData/Roaming/hlr-writing-tool/config.ini');
  });
  it('persists preferences, booleans, window dimensions, and bounded deduplicated recent paths', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-config-'));
    try {
      const filename = path.join(root, 'config.ini');
      const config = new AppConfig(filename);
      expect(readFileSync(filename, 'utf8')).toContain('[general]');
      const settings = config.get();
      settings.general.theme = 'light'; settings.general.auto_save_interval_sec = 0; settings.window.maximized = true;
      config.save(settings);
      for (let i = 0; i < 12; i++) config.remember(`/project ${i};=ü.hlr`);
      config.remember('/project 8;=ü.hlr');
      const reloaded = new AppConfig(filename).get();
      expect(reloaded.general.theme).toBe('light'); expect(reloaded.window.maximized).toBe(true);
      expect(reloaded.general.auto_save_interval_sec).toBe(0);
      expect(reloaded.recentProjects).toHaveLength(10);
      expect(reloaded.recentProjects[0]).toBe('/project 8;=ü.hlr');
      expect(config.get().general.theme).toBe('light');
      expect(() => config.save({ ...settings, window: { ...settings.window, width: 1 } })).toThrow();
      expect(new AppConfig(filename).get()).toEqual(reloaded);
      writeFileSync(filename, '[general]\ntheme=invalid\n');
      expect(() => new AppConfig(filename)).toThrow();
      expect(readFileSync(filename, 'utf8')).toContain('invalid');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
it('project configuration updates preserve item IDs and reject incompatible columns', () => {
  let workspace = addComponent(createWorkspace('Test', 'GS'), 'REQUIREMENT', 'Module', 'MOD');
  workspace = addRequirementSet(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.components[0]!.id, 'Function', 'FN');
  workspace = addItem(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.requirementSets[0]!.requirementSetId, { col_desc: 'Requirement' });
  const updated = updateProjectConfig(workspace, { ...workspace.config, projectPrefix: 'NEW', idCasing: 'LOWER' });
  expect(updated.domains.REQUIREMENT.requirementSets[0]!.items).toEqual(workspace.domains.REQUIREMENT.requirementSets[0]!.items);
  expect(workspace.config.projectPrefix).toBe('GS');
  expect(() => updateProjectConfig(workspace, { ...workspace.config, projectId: 'other' })).toThrow('identity');
  const invalid = structuredClone(workspace.config); invalid.objectTypes.REQUIREMENT.columns = [];
  expect(() => updateProjectConfig(workspace, invalid)).toThrow('system column');
});
