import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import ini from 'ini';
import { appSettingsSchema, defaultAppSettings, type AppSettings } from '../../shared/appSettings.js';
export function appConfigPath(platform = process.platform, env = process.env, home = os.homedir()): string {
  const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'hlr-writing-tool', 'config.ini');
}
export class AppConfig {
  private settings: AppSettings;
  constructor(readonly filename = appConfigPath()) {
    this.settings = structuredClone(defaultAppSettings);
    if (existsSync(filename)) {
      const parsed = ini.parse(readFileSync(filename, 'utf8'));
      this.settings = appSettingsSchema.parse({
        general: { ...this.settings.general, ...parsed.general, auto_save_interval_sec: Number(parsed.general?.auto_save_interval_sec ?? 300) },
        window: { ...this.settings.window, ...parsed.window, width: Number(parsed.window?.width ?? 1440), height: Number(parsed.window?.height ?? 900) },
        recentProjects: Object.values(parsed.recent_projects ?? {}),
      });
    } else this.save(this.settings);
  }
  get(): AppSettings { return structuredClone(this.settings); }
  save(input: AppSettings): AppSettings {
    const next = appSettingsSchema.parse(input);
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temp, ini.stringify({ general: next.general, window: next.window, recent_projects: Object.fromEntries(next.recentProjects.map((p, i) => [i + 1, p])) }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, this.filename);
    this.settings = next;
    return this.get();
  }
  remember(root: string): void {
    this.save({ ...this.settings, recentProjects: [root, ...this.settings.recentProjects.filter(p => p !== root)].slice(0, 10) });
  }
}
