import type { LockHolder, LockInfo } from '../shared/collab/types.js';
export const LOCK_TTL_MS = 30_000;
export class LockManager {
  private leases = new Map<string, LockInfo & { sessionId: string }>();
  constructor(private changed: (key: string, holder: LockHolder | null) => void, private now = () => Date.now()) {}
  reap() { for (const [key, lease] of this.leases) if (lease.expiresAt <= this.now()) this.forceRelease(key); }
  state() { this.reap(); return Object.fromEntries([...this.leases].map(([k, v]) => [k, v.holder])); }
  authorizationState(sessionId: string) { this.reap(); return Object.fromEntries([...this.leases].map(([key, lease]) => [key, { ...lease.holder, userId: lease.sessionId === sessionId ? lease.holder.userId : `other-session:${lease.sessionId}` }])); }
  get(key: string) { this.reap(); return this.leases.get(key); }
  owns(key: string, sessionId: string) { return this.get(key)?.sessionId === sessionId; }
  acquire(key: string, sessionId: string, holder: LockHolder) {
    const lease = this.get(key);
    if (lease && lease.sessionId !== sessionId) return { ok: false as const, holder: lease.holder, expiresAt: lease.expiresAt };
    const expiresAt = this.now() + LOCK_TTL_MS;
    this.leases.set(key, { holder, sessionId, expiresAt });
    this.changed(key, holder);
    return { ok: true as const, holder, expiresAt };
  }
  heartbeat(key: string, sessionId: string) {
    const lease = this.get(key);
    if (!lease || lease.sessionId !== sessionId) return false;
    lease.expiresAt = this.now() + LOCK_TTL_MS; return true;
  }
  release(key: string, sessionId: string) { return this.owns(key, sessionId) && this.forceRelease(key); }
  disconnect(sessionId: string) { this.reap(); for (const lease of this.leases.values()) if (lease.sessionId === sessionId) lease.expiresAt = this.now() + LOCK_TTL_MS; }
  releaseUser(userId: string) { for (const [key, lease] of this.leases) if (lease.holder.userId === userId) this.forceRelease(key); }
  forceRelease(key: string) { if (!this.leases.delete(key)) return false; this.changed(key, null); return true; }
  retain(valid: (key: string) => boolean) { for (const key of this.leases.keys()) if (!valid(key)) this.forceRelease(key); }
  clear() { for (const key of this.leases.keys()) this.forceRelease(key); }
}
export class PresenceThrottle {
  private last = new Map<string, number>();
  constructor(private now = () => Date.now()) {}
  accept(id: string) { const now = this.now(); if (now - (this.last.get(id) ?? -Infinity) < 100) return false; this.last.set(id, now); return true; }
  remove(id: string) { this.last.delete(id); }
}
