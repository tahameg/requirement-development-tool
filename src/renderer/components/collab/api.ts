import type { CollabCommand } from '../../../shared/collab/client.js';
export async function collab(command: CollabCommand): Promise<any> { const result = await window.hlr.collab(command); if (!result.ok) throw new Error(result.error); return result.value; }
export const request = (method: 'GET'|'POST'|'PATCH'|'DELETE', route: string, body?: unknown) => collab({ action: 'request', method, route, body });
