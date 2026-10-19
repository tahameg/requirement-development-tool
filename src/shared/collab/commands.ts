import { z } from 'zod';
import { collabOpSchema, presenceStateSchema } from './protocol.js';
import { objectTypeSchema } from '../types/schema.js';
const values = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export const roomDraftSchema = z.object({ kind: z.enum(['item', 'description']).optional(), opId: z.string().uuid().optional(), objectType: objectTypeSchema, requirementSetId: z.string().min(1), itemId: z.string().nullable(), values, baseValues: values, conflict: z.string().optional() }).strict();
export const collabCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('discover') }).strict(),
  z.object({ action: z.literal('disconnect') }).strict(),
  z.object({ action: z.literal('leave') }).strict(),
  z.object({ action: z.literal('export') }).strict(),
  z.object({ action: z.literal('import') }).strict(),
  z.object({ action: z.literal('clear-draft') }).strict(),
  z.object({ action: z.literal('ack-settings-change') }).strict(),

  z.object({ action: z.literal('create-from-local'), name: z.string().trim().min(1).max(200), visibility: z.enum(['private', 'listed']) }).strict(),
  z.object({ action: z.literal('probe'), address: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('connect'), address: z.string().min(1).max(2048), fingerprint: z.string().nullable(), allowHttp: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('auth'), method: z.enum(['login', 'register', 'setup']), username: z.string().max(100), password: z.string().max(1000), displayName: z.string().max(200).optional(), setupToken: z.string().max(1000).optional() }).strict(),
  z.object({ action: z.literal('request'), method: z.enum(['GET','POST','PATCH','DELETE']), route: z.string().regex(/^\/api\/(?:rooms|invites|admin|users)(?:[/?][A-Za-z0-9/_?=&.%+-]*)?$/).refine(route => !decodeURIComponent(route).split(/[/?]/).includes('..'), 'Invalid route'), body: z.unknown().optional() }).strict(),
  z.object({ action: z.literal('join'), roomId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('op'), op: collabOpSchema }).strict(),
  z.object({ action: z.literal('lock'), kind: z.enum(['acquire', 'release', 'force-release']), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('presence'), ...presenceStateSchema.shape }).strict(),
  z.object({ action: z.literal('draft'), draft: roomDraftSchema }).strict(),
]);
