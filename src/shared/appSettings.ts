import { z } from 'zod';
export const appSettingsSchema = z.object({
  general: z.object({ theme: z.enum(['dark', 'light', 'high-contrast']), language: z.literal('en'), auto_save_interval_sec: z.number().int().min(0).max(86400) }).strict(),
  window: z.object({ width: z.number().int().min(800).max(7680), height: z.number().int().min(600).max(4320), maximized: z.boolean() }).strict(),
  recentProjects: z.array(z.string().min(1)).max(10),
}).strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;
export const defaultAppSettings: AppSettings = {
  general: { theme: 'dark', language: 'en', auto_save_interval_sec: 300 },
  window: { width: 1440, height: 900, maximized: false }, recentProjects: [],
};
