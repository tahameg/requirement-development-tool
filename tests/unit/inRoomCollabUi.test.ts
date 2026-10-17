import { expect, it } from 'vitest';
import { capabilities, changedValues, lockStatus, presenceByNode } from '../../src/shared/collab/ui.js';
import { collabCommandSchema } from '../../src/shared/collab/commands.js';
it('maps roles, connection and locks to edit capabilities', () => {
  expect(capabilities('VIEWER', true).edit).toBe(false); expect(capabilities('EDITOR', false).edit).toBe(false);
  expect(capabilities('EDITOR', true).admin).toBe(false); expect(capabilities('ROOM_ADMIN', true).admin).toBe(true);
  const holder = { userId: 'a', name: 'A', color: '#123456' };
  expect(lockStatus(undefined, 'a')).toBe('free'); expect(lockStatus(holder, 'a')).toBe('mine'); expect(lockStatus(holder, 'b')).toBe('others');
});
it('builds changed-column patches and groups view presence', () => {
  expect(changedValues({ a: 'same', b: 1 }, { a: 'same', b: 2 })).toEqual({ b: 2 });
  expect(Object.keys(presenceByNode([{ connectionId: 'c', user: { userId: 'a', name: 'A', color: '#123456' }, state: { view: { objectType: 'REQUIREMENT', nodeId: 'fn' }, focus: null, drafting: null } }]))).toEqual(['fn']);
});
it('validates IPC commands and rejects arbitrary URLs and credential-returning auth proxies', () => {
  expect(collabCommandSchema.safeParse({ action: 'request', method: 'GET', route: 'https://evil.test' }).success).toBe(false);
  expect(collabCommandSchema.safeParse({ action: 'request', method: 'POST', route: '/api/auth/login' }).success).toBe(false);
  expect(collabCommandSchema.safeParse({ action: 'request', method: 'GET', route: '/api/rooms' }).success).toBe(true);
  expect(collabCommandSchema.safeParse({ action: 'draft', draft: { objectType: 'REQUIREMENT', functionId: 'f', itemId: null, values: {}, baseValues: {} } }).success).toBe(true);
});
