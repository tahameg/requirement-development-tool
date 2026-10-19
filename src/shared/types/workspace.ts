import type { z } from 'zod';
import type { componentSchema, requirementSetSchema, itemSchema, workspaceSchema } from './schema.js';
export type Component = z.infer<typeof componentSchema>;
export type RequirementSet = z.infer<typeof requirementSetSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
