import { describe, it, expect, vi, afterEach } from 'vitest';
import { LockManager, PresenceThrottle } from '../../src/server/locks.js';
afterEach(() => vi.useRealTimers());
describe('session lease locks', () => {
  it('denies competing sessions, heartbeats, expires and cannot revive an expired lease', () => {
    vi.useFakeTimers(); const changed = vi.fn(); const locks = new LockManager(changed);
    const holder = { userId: 'alice', name: 'Alice', color: '#123456' };
    expect(locks.acquire('item:1', 'session-a', holder).ok).toBe(true);
    expect(locks.acquire('item:1', 'session-b', holder).ok).toBe(false);
    vi.advanceTimersByTime(20000); expect(locks.heartbeat('item:1', 'session-a')).toBe(true);
    vi.advanceTimersByTime(20000); expect(locks.owns('item:1', 'session-a')).toBe(true);
    vi.advanceTimersByTime(10001); expect(locks.heartbeat('item:1', 'session-a')).toBe(false);
    expect(changed).toHaveBeenLastCalledWith('item:1', null);
  });
  it('grants disconnect grace, reclaims only with the same session and supports forced release', () => {
    vi.useFakeTimers(); const locks = new LockManager(() => {});
    const holder = { userId: 'alice', name: 'Alice', color: '#123456' };
    locks.acquire('config', 'a', holder); vi.advanceTimersByTime(29000); locks.disconnect('a');
    vi.advanceTimersByTime(20000); expect(locks.acquire('config', 'b', holder).ok).toBe(false);
    expect(locks.acquire('config', 'a', holder).ok).toBe(true);
    expect(locks.release('config', 'b')).toBe(false);
    expect(locks.forceRelease('config')).toBe(true);
    expect(locks.acquire('config', 'b', holder).ok).toBe(true);
    locks.releaseUser('alice'); expect(locks.state()).toEqual({});
  });
  it('throttles presence independently to 10 updates per second', () => {
    vi.useFakeTimers(); const throttle = new PresenceThrottle();
    expect(throttle.accept('a')).toBe(true); expect(throttle.accept('a')).toBe(false);
    expect(throttle.accept('b')).toBe(true); vi.advanceTimersByTime(100); expect(throttle.accept('a')).toBe(true);
    throttle.remove('a'); expect(throttle.accept('a')).toBe(true);
  });
});
