import type { z } from 'zod';
import type { moduleSchema, functionSchema, itemSchema, workspaceSchema } from './schema.js';
export type Module = z.infer<typeof moduleSchema>;
export type FunctionGroup = z.infer<typeof functionSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
