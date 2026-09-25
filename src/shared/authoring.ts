import { z } from 'zod';
import { objectTypeSchema } from './types/schema.js';
const values = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export const editFunctionSchema = z.object({
  objectType: objectTypeSchema, functionId: z.string().min(1), description: z.string().optional(),
  changes: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('add'), values }).strict(),
    z.object({ action: z.literal('edit'), id: z.string().min(1), values }).strict(),
    z.object({ action: z.literal('delete'), id: z.string().min(1) }).strict(),
  ])).max(100),
}).strict();
export type FunctionEdit = z.infer<typeof editFunctionSchema>;
export const exportSchema = z.object({ format: z.enum(['csv', 'markdown']), objectType: objectTypeSchema.optional(), functionId: z.string().min(1).optional() }).strict();
export type ExportRequest = z.infer<typeof exportSchema>;
export interface SearchHit { id: string; functionId: string; functionName: string; objectType: z.infer<typeof objectTypeSchema>; description: string; }
