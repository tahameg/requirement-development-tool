import { z } from 'zod';
import { objectTypeSchema } from './types/schema.js';
export const objectLabels = { REQUIREMENT: 'Requirements', DATA_DICTIONARY: 'Data Dictionary', ENTITY: 'Entity', ACTION: 'Action' } as const;
const name = z.string().trim().min(1, 'Enter a name').max(200);
const prefix = z.string().regex(/^[\p{L}\p{N}_]*$/u, 'Prefixes may contain letters, numbers and underscores');
const common = { objectType: objectTypeSchema };
const properties = { name, prefix, description: z.string() };
export const hierarchyCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('addComponent'), parentId: z.string().min(1).nullable(), ...properties }).strict(),
  z.object({ ...common, action: z.literal('addRequirementSet'), parentId: z.string().min(1), ...properties, prefix: prefix.min(1, 'Enter a requirement set prefix') }).strict(),
  z.object({ ...common, action: z.literal('editComponent'), id: z.string().min(1), ...properties }).strict(),
  z.object({ ...common, action: z.literal('editRequirementSet'), id: z.string().min(1), ...properties, prefix: prefix.min(1, 'Enter a requirement set prefix') }).strict(),
  z.object({ ...common, action: z.literal('deleteComponent'), id: z.string().min(1) }).strict(),
  z.object({ ...common, action: z.literal('deleteRequirementSet'), id: z.string().min(1) }).strict(),
]);
export type HierarchyCommand = z.infer<typeof hierarchyCommandSchema>;
export type HierarchySelection = { objectType: z.infer<typeof objectTypeSchema>; kind: 'root' | 'component' | 'requirementSet'; id: string | null };
