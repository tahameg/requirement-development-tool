import type { z } from 'zod';
import type { columnSchema, projectConfigSchema, objectTypeSchema } from './schema.js';
export type Column = z.infer<typeof columnSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ObjectType = z.infer<typeof objectTypeSchema>;
