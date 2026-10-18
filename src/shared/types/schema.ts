import { z } from 'zod';
import { migrateWorkspace } from './legacy.js';

export const objectTypes = ['REQUIREMENT', 'DATA_DICTIONARY', 'ENTITY', 'ACTION'] as const;
export const objectTypeSchema = z.enum(objectTypes);
const key = z.string().min(1);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const token = z.string().regex(/^[\p{L}\p{N}_]*$/u, 'Prefixes may contain letters, numbers and underscores');
const name = z.string().trim().min(1);
const value = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const columnSchema = z.object({
  id: key, name, type: z.enum(['string', 'text', 'markdown', 'enum', 'number', 'boolean', 'date', 'reference']),
  required: z.boolean().optional(), system: z.boolean().optional(),
  options: z.array(key).optional(), default: value.optional(),
  referenceTypes: z.array(objectTypeSchema).min(1).optional(),
}).strict();
export const objectConfigSchema = z.object({
  name, prefix: token, enabled: z.boolean(), usePrefix: z.boolean(), columns: z.array(columnSchema),
}).strict();
export const projectConfigSchema = z.object({
  version: z.literal('1.0.0'), projectId: key, projectName: name,
  projectPrefix: token, idCasing: z.enum(['UPPER', 'LOWER', 'AS_IS']),
  objectTypes: z.object({ REQUIREMENT: objectConfigSchema, DATA_DICTIONARY: objectConfigSchema,
    ENTITY: objectConfigSchema, ACTION: objectConfigSchema }).strict(),
}).strict();
export const componentSchema = z.object({
  id: key, name, prefix: token, description: z.string(), parentId: key.nullable(),
}).strict();
export const itemSchema = z.object({
  id: key, seq: counter.refine(n => n > 0), created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(), values: z.record(value),
}).strict();
export const requirementSetSchema = z.object({
  // fn_ ids predate requirement sets and are kept so stored references stay valid.
  requirementSetId: key.regex(/^(?:rs|fn)_[a-zA-Z0-9_-]+$/), name, prefix: token.min(1),
  componentPath: z.array(name), parentComponentId: key, description: z.string(),
  watermarkCounter: counter, items: z.array(itemSchema),
}).strict();
const domainSchema = z.object({ components: z.array(componentSchema), requirementSets: z.array(requirementSetSchema) }).strict();
export const workspaceSchema = z.preprocess(migrateWorkspace, z.object({
  config: projectConfigSchema,
  domains: z.object({ REQUIREMENT: domainSchema, DATA_DICTIONARY: domainSchema,
    ENTITY: domainSchema, ACTION: domainSchema }).strict(),
  retiredIds: z.array(key),
}).strict());
