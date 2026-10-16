import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthService,
  CollabServiceError,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../../src/server/auth.js';
import {
  computeCertFingerprint,
  ensureServerTlsCertificate,
  fingerprintsMatch,
  generateSelfSignedCertificate,
  normalizeFingerprint,
} from '../../src/server/tls.js';
import { serverPublicInfoSchema } from '../../src/shared/collab/protocol.js';
import { createTestStore } from './testDbHelper.js';

describe('T03 / R02: PostgreSQL ServerStore, Self-Signed TLS, and AuthService', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-server-auth-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('Self-signed X.509 TLS Certificate & SHA-256 Fingerprint (src/server/tls.ts)', () => {
    it('generates a valid self-signed X.509 v3 certificate verifiable by node:crypto X509Certificate', () => {
      const bundle = generateSelfSignedCertificate({
        commonName: 'Test HLR Collab Server',
        organization: 'HLR Test Org',
        validDays: 365,
        hostnames: ['localhost', 'hlr.local'],
        ipAddresses: ['127.0.0.1', '192.168.1.50'],
      });

      expect(bundle.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(bundle.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(bundle.fingerprint).toMatch(/^SHA256:([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

      const x509 = new X509Certificate(bundle.certPem);
      expect(x509.verify(x509.publicKey)).toBe(true);
      expect(x509.subject).toContain('CN=Test HLR Collab Server');
      expect(x509.subjectAltName).toContain('DNS:localhost');
      expect(x509.subjectAltName).toContain('DNS:hlr.local');
      expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
      expect(x509.subjectAltName).toContain('IP Address:192.168.1.50');

      // Valid date range check
      const validFrom = new Date(x509.validFrom).getTime();
      const validTo = new Date(x509.validTo).getTime();
      const now = Date.now();
      expect(validFrom).toBeLessThanOrEqual(now);
      expect(validTo).toBeGreaterThan(now + 360 * 24 * 60 * 60 * 1000);
    });

    it('computes, normalizes, and compares certificate fingerprints reliably', () => {
      const bundle = generateSelfSignedCertificate();
      const fp = computeCertFingerprint(bundle.certPem);
      expect(fp).toBe(bundle.fingerprint);

      // Normalization handles case and punctuation differences
      const rawHex = fp.replace(/^SHA256:/, '').replace(/:/g, '').toLowerCase();
      expect(normalizeFingerprint(rawHex)).toBe(fp);
      expect(fingerprintsMatch(fp, rawHex)).toBe(true);
      expect(fingerprintsMatch(fp, fp.toLowerCase())).toBe(true);
      expect(fingerprintsMatch(fp, 'SHA256:' + '00:'.repeat(31) + '00')).toBe(false);
      expect(fingerprintsMatch('invalid', fp)).toBe(false);
    });

    it('persists and reuses TLS certificate on disk, regenerating if invalid or corrupt', () => {
      const certDir = makeTempDir();
      const first = ensureServerTlsCertificate(certDir, { commonName: 'Persistence Test' });
      expect(first.fingerprint).toMatch(/^SHA256:/);

      // Second load should reuse the existing certificate
      const second = ensureServerTlsCertificate(certDir, { commonName: 'Persistence Test' });
      expect(second.certPem).toBe(first.certPem);
      expect(second.fingerprint).toBe(first.fingerprint);

      // Corrupt the certificate on disk -> should detect and generate fresh certificate
      writeFileSync(first.certPath, 'CORRUPT_CERT_CONTENT\n', 'utf8');
      const regenerated = ensureServerTlsCertificate(certDir, { commonName: 'Persistence Test' });
      expect(regenerated.certPem).not.toBe(first.certPem);
      expect(regenerated.fingerprint).not.toBe(first.fingerprint);
      const x509 = new X509Certificate(regenerated.certPem);
      expect(x509.verify(x509.publicKey)).toBe(true);
    });
  });

  describe('PostgreSQL ServerStore & Migrations (src/server/store/*)', () => {
    it('initializes server settings and appends/lists audit logs in PostgreSQL', async () => {
      const fixture = await createTestStore({ schemaPrefix: 'auth_db' });
      const { store } = fixture;

      const settings = await store.serverSettings.ensure({
        serverName: 'Audit Test Server',
        registrationMode: 'open',
      });
      expect(settings.server_id).toMatch(/^srv_/);
      expect(settings.server_name).toBe('Audit Test Server');

      const entry = await store.audit.append({
        actorId: null,
        actorName: 'System',
        action: 'server:boot',
        details: { port: 8443 },
      });
      expect(entry.id).toMatch(/^aud_/);

      const auditList = await store.audit.list();
      expect(auditList).toHaveLength(1);
      expect(auditList[0]?.details_json).toEqual({ port: 8443 });

      await fixture.cleanup();
    });
  });

  describe('Password Hashing & One-Time Setup Token Flow (src/server/auth.ts)', () => {
    it('hashes and verifies passwords with scrypt and rejects malformed or wrong hashes', () => {
      const hash = hashPassword('CorrectHorseBatteryStaple!');
      expect(hash.startsWith('scrypt$')).toBe(true);
      expect(verifyPassword('CorrectHorseBatteryStaple!', hash)).toBe(true);
      expect(verifyPassword('WrongPassword', hash)).toBe(false);
      expect(verifyPassword('any', 'invalid-hash')).toBe(false);
      expect(verifyPassword('any', 'scrypt$zz$ff')).toBe(false);
      expect(hashToken('token-1')).toHaveLength(64);
    });

    it('consumes the one-time setup token to create SERVER_OWNER and rejects reuse or wrong token', async () => {
      const fixture = await createTestStore({ schemaPrefix: 'auth_setup' });
      const auth = new AuthService(fixture.store, { initialSetupToken: 'setup-secret-token-123' });

      expect(await auth.isSetupRequired()).toBe(true);
      expect(await auth.getInitialSetupToken()).toBe('setup-secret-token-123');

      const publicInfoBefore = await auth.getPublicInfo({
        fingerprint: 'SHA256:' + 'AA:'.repeat(31) + 'AA',
      });
      expect(serverPublicInfoSchema.safeParse(publicInfoBefore).success).toBe(true);
      expect(publicInfoBefore.setupRequired).toBe(true);

      // Invalid payload -> 400 BAD_REQUEST
      await expect(
        auth.claimSetupToken({
          setupToken: 'setup-secret-token-123',
          username: 'a', // too short
          displayName: 'Owner',
          password: 'password123',
        }),
      ).rejects.toThrowError(CollabServiceError);

      // Wrong setup token -> 403 FORBIDDEN
      await expect(
        auth.claimSetupToken({
          setupToken: 'wrong-token',
          username: 'owner',
          displayName: 'Server Owner',
          password: 'password123',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Valid setup token -> creates SERVER_OWNER and session
      const setupResult = await auth.claimSetupToken({
        setupToken: 'setup-secret-token-123',
        username: 'owner',
        displayName: 'Server Owner',
        password: 'password123',
      });

      expect(setupResult.user.username).toBe('owner');
      expect(setupResult.user.serverRole).toBe('SERVER_OWNER');
      expect(setupResult.user.status).toBe('ACTIVE');
      expect(setupResult.token).toBeTruthy();

      expect(await auth.isSetupRequired()).toBe(false);
      expect(await auth.getInitialSetupToken()).toBeNull();
      const publicInfoAfter = await auth.getPublicInfo();
      expect(publicInfoAfter.setupRequired).toBe(false);

      // Reusing setup token after SERVER_OWNER exists -> 403 FORBIDDEN
      await expect(
        auth.claimSetupToken({
          setupToken: 'setup-secret-token-123',
          username: 'owner2',
          displayName: 'Second Owner',
          password: 'password123',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      await fixture.cleanup();
    });
  });

  describe('Registration Modes (open, approval, closed), Login/Logout, and Session Expiry', () => {
    it('handles open, approval, and closed registration modes and enforces approval/status on login', async () => {
      let currentTime = new Date('2026-10-16T04:00:00.000Z');
      const fixture = await createTestStore({ schemaPrefix: 'auth_reg' });
      const auth = new AuthService(fixture.store, {
        initialSetupToken: 'init-token',
        sessionTtlMs: 60_000,
        now: () => currentTime,
      });

      const { user: owner } = await auth.claimSetupToken({
        setupToken: 'init-token',
        username: 'owner',
        displayName: 'Owner',
        password: 'owner-password',
      });

      // 1. Default registrationMode is 'open'
      const openReg = await auth.registerUser({
        username: 'alice',
        displayName: 'Alice Engineer',
        password: 'alice-password',
      });
      expect(openReg.status).toBe('ACTIVE');
      if (openReg.status === 'ACTIVE') {
        expect(openReg.user.serverRole).toBe('USER');
        const authUser = await auth.authenticateToken(openReg.token);
        expect(authUser.username).toBe('alice');
      }

      // Duplicate username (case-insensitive) -> 409 CONFLICT
      await expect(
        auth.registerUser({
          username: 'ALICE',
          displayName: 'Alice Clone',
          password: 'alice-password',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'CONFLICT',
          status: 409,
        }),
      );

      // 2. Switch registrationMode to 'approval'
      const updatedSettings = await auth.updateServerSettings(owner, {
        registrationMode: 'approval',
        roomCreationMode: 'admins_only',
      });
      expect(updatedSettings.registrationMode).toBe('approval');
      expect(updatedSettings.roomCreationMode).toBe('admins_only');

      const pendingReg = await auth.registerUser({
        username: 'bob',
        displayName: 'Bob Pending',
        password: 'bob-password',
      });
      expect(pendingReg.status).toBe('PENDING_APPROVAL');
      expect(pendingReg.user.status).toBe('PENDING_APPROVAL');
      expect('token' in pendingReg).toBe(false);

      // Bob cannot log in while PENDING_APPROVAL -> 403 FORBIDDEN
      await expect(
        auth.loginUser({
          username: 'bob',
          password: 'bob-password',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Approve Bob -> Bob can now log in
      const approvedBob = await auth.approveUser(owner, pendingReg.user.id);
      expect(approvedBob.status).toBe('ACTIVE');

      const bobSession = await auth.loginUser({
        username: 'bob',
        password: 'bob-password',
      });
      expect(bobSession.user.id).toBe(approvedBob.id);
      const authBob = await auth.authenticateAuthorizationHeader(`Bearer ${bobSession.token}`);
      expect(authBob.username).toBe('bob');

      // 3. Switch registrationMode to 'closed'
      await auth.updateServerSettings(owner, { registrationMode: 'closed' });
      await expect(
        auth.registerUser({
          username: 'charlie',
          displayName: 'Charlie',
          password: 'charlie-password',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // 4. Wrong password -> 401 UNAUTHORIZED
      await expect(
        auth.loginUser({
          username: 'bob',
          password: 'wrong-password',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      // 5. Session expiration after TTL -> 401 UNAUTHORIZED
      currentTime = new Date(currentTime.getTime() + 61_000);
      await expect(auth.authenticateToken(bobSession.token)).rejects.toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      // 6. Re-login and logout -> invalidates token immediately
      const bobSession2 = await auth.loginUser({
        username: 'bob',
        password: 'bob-password',
      });
      expect(await auth.logoutSession(bobSession2.token)).toEqual({ loggedOut: true });
      await expect(auth.authenticateToken(bobSession2.token)).rejects.toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      await fixture.cleanup();
    });
  });

  describe('Role Permission Matrix on User Management (SERVER_OWNER vs SERVER_ADMIN vs USER)', () => {
    it('enforces SERVER_OWNER, SERVER_ADMIN, and USER permissions across create, approve, disable, resetPassword, and changeServerRole', async () => {
      const fixture = await createTestStore({ schemaPrefix: 'auth_matrix' });
      const auth = new AuthService(fixture.store, { initialSetupToken: 'setup-token' });

      const { user: owner } = await auth.claimSetupToken({
        setupToken: 'setup-token',
        username: 'owner',
        displayName: 'Server Owner',
        password: 'owner-password',
      });

      // Owner creates a SERVER_ADMIN and two regular USERs
      const admin1 = await auth.createUser(owner, {
        username: 'admin1',
        displayName: 'Server Admin One',
        password: 'admin1-password',
        serverRole: 'SERVER_ADMIN',
      });
      expect(admin1.serverRole).toBe('SERVER_ADMIN');

      const user1 = await auth.createUser(owner, {
        username: 'user1',
        displayName: 'Regular User One',
        password: 'user1-password',
      });
      expect(user1.serverRole).toBe('USER');

      // SERVER_ADMIN can create regular USER accounts
      const user2 = await auth.createUser(admin1, {
        username: 'user2',
        displayName: 'Regular User Two',
        password: 'user2-password',
        serverRole: 'USER',
      });
      expect(user2.serverRole).toBe('USER');

      // SERVER_ADMIN CANNOT create another SERVER_ADMIN -> 403 FORBIDDEN
      await expect(
        auth.createUser(admin1, {
          username: 'admin2',
          displayName: 'Unauthorized Admin',
          password: 'admin2-password',
          serverRole: 'SERVER_ADMIN',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Regular USER cannot create users, list admin users, approve users, or update server settings
      await expect(
        auth.createUser(user1, {
          username: 'user3',
          displayName: 'User Three',
          password: 'user3-password',
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
      await expect(auth.listUsers(user1)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.approveUser(user1, user2.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.updateServerSettings(user1, { name: 'Hacked' })).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.updateServerSettings(admin1, { name: 'Admin Rename' })).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Regular USER CAN search the active user directory
      expect(await auth.searchUserDirectory(user1, 'user')).toHaveLength(2);
      expect(await auth.listUsers(admin1)).toHaveLength(4);

      // SERVER_ADMIN can disable/enable and reset password for a regular USER (and revokes their sessions)
      const user2Login = await auth.loginUser({ username: 'user2', password: 'user2-password' });
      expect((await auth.authenticateToken(user2Login.token)).id).toBe(user2.id);

      const disabledUser2 = await auth.disableUser(admin1, user2.id, true);
      expect(disabledUser2.status).toBe('DISABLED');
      // Active session is revoked immediately
      await expect(auth.authenticateToken(user2Login.token)).rejects.toThrowError(
        expect.objectContaining({ code: 'UNAUTHORIZED', status: 401 }),
      );
      // Disabled user cannot log in
      await expect(auth.loginUser({ username: 'user2', password: 'user2-password' })).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Re-enable user2 and reset their password
      const reenabledUser2 = await auth.enableUser(admin1, user2.id);
      expect(reenabledUser2.status).toBe('ACTIVE');
      expect(await auth.resetPassword(admin1, user2.id, 'new-user2-pass')).toEqual({ reset: true });
      expect((await auth.loginUser({ username: 'user2', password: 'new-user2-pass' })).user.id).toBe(
        user2.id,
      );

      // SERVER_ADMIN CANNOT promote/demote roles or disable/reset password of another SERVER_ADMIN or SERVER_OWNER
      await expect(auth.changeServerRole(admin1, user1.id, 'SERVER_ADMIN')).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.disableUser(admin1, owner.id, true)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.resetPassword(admin1, owner.id, 'new-owner-pass')).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      const admin2 = await auth.changeServerRole(owner, user1.id, 'SERVER_ADMIN');
      expect(admin2.serverRole).toBe('SERVER_ADMIN');

      // SERVER_ADMIN (admin1) cannot disable or reset password of another SERVER_ADMIN (admin2)
      await expect(auth.disableUser(admin1, admin2.id, true)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.resetPassword(admin1, admin2.id, 'hacked-admin2')).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // SERVER_OWNER CAN disable, reset password, and demote a SERVER_ADMIN
      expect(await auth.resetPassword(owner, admin2.id, 'owner-reset-pass')).toEqual({ reset: true });
      const disabledAdmin2 = await auth.disableUser(owner, admin2.id, true);
      expect(disabledAdmin2.status).toBe('DISABLED');
      const demotedUser1 = await auth.changeServerRole(owner, admin2.id, 'USER');
      expect(demotedUser1.serverRole).toBe('USER');

      // SERVER_OWNER cannot disable or demote themselves
      await expect(auth.disableUser(owner, owner.id, true)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(auth.changeServerRole(owner, owner.id, 'USER')).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Audit log records all administrative actions and is accessible to SERVER_ADMIN & SERVER_OWNER only
      await expect(auth.listServerAuditLog(user2)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      const auditEntries = await auth.listServerAuditLog(admin1);
      expect(auditEntries.length).toBeGreaterThanOrEqual(6);

      await fixture.cleanup();
    });
  });
});
