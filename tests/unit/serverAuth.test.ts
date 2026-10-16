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
import { ServerDatabase } from '../../src/server/db.js';
import {
  computeCertFingerprint,
  ensureServerTlsCertificate,
  fingerprintsMatch,
  generateSelfSignedCertificate,
  normalizeFingerprint,
} from '../../src/server/tls.js';
import { serverPublicInfoSchema } from '../../src/shared/collab/protocol.js';

describe('T03: ServerDatabase, Self-Signed TLS, and AuthService', () => {
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

      // Verify PEM and DER produce identical SHA-256 fingerprints matching X509Certificate.fingerprint256
      expect(computeCertFingerprint(bundle.certPem)).toBe(`SHA256:${x509.fingerprint256}`);
      expect(computeCertFingerprint(bundle.certDer)).toBe(bundle.fingerprint);
      expect(computeCertFingerprint(new Uint8Array(bundle.certDer))).toBe(bundle.fingerprint);
    });

    it('supports GeneralizedTime for dates after 2049 and normalizes/matches fingerprints', () => {
      const futureBundle = generateSelfSignedCertificate({
        now: new Date('2051-01-01T00:00:00.000Z'),
        validDays: 30,
      });
      const x509 = new X509Certificate(futureBundle.certPem);
      expect(x509.verify(x509.publicKey)).toBe(true);

      const lowerRaw = futureBundle.fingerprint.replace('SHA256:', '').toLowerCase();
      expect(normalizeFingerprint(lowerRaw)).toBe(futureBundle.fingerprint);
      expect(fingerprintsMatch(lowerRaw, futureBundle.fingerprint)).toBe(true);
      expect(fingerprintsMatch(futureBundle.fingerprint, 'SHA256:' + '00:'.repeat(31) + '00')).toBe(
        false,
      );
      expect(fingerprintsMatch(futureBundle.fingerprint, 'invalid-fingerprint')).toBe(false);
      expect(() => normalizeFingerprint('not-a-valid-sha256')).toThrow(/Invalid SHA-256/);
    });

    it('persists and reuses TLS certificates on disk in <dataDir>/tls and regenerates if corrupted', () => {
      const dataDir = makeTempDir();
      const first = ensureServerTlsCertificate(dataDir, { commonName: 'Disk Cert Server' });
      expect(first.created).toBe(true);

      const second = ensureServerTlsCertificate(dataDir, { commonName: 'Disk Cert Server' });
      expect(second.created).toBe(false);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.certPem).toBe(first.certPem);

      // Corrupt cert.pem and ensure it regenerates cleanly
      writeFileSync(first.certPath, 'not-a-pem-cert', 'utf8');
      const regenerated = ensureServerTlsCertificate(dataDir, { commonName: 'Regenerated Server' });
      expect(regenerated.created).toBe(true);
      expect(regenerated.fingerprint).toMatch(/^SHA256:([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    });
  });

  describe('ServerDatabase (src/server/db.ts)', () => {
    it('initializes server.sqlite on disk and in memory with default settings and audit log', () => {
      const dataDir = makeTempDir();
      const db = ServerDatabase.open(dataDir, {
        serverName: 'Avionics Collab Server',
        registrationMode: 'approval',
        roomCreationMode: 'admins_only',
      });

      expect(db.isOpen()).toBe(true);
      expect(db.filename).toBe(path.join(dataDir, 'server.sqlite'));

      const settings = db.getSettings();
      expect(settings.serverId).toMatch(/^srv_/);
      expect(settings.name).toBe('Avionics Collab Server');
      expect(settings.registrationMode).toBe('approval');
      expect(settings.roomCreationMode).toBe('admins_only');

      const entry = db.appendAuditLog({
        actorId: null,
        actorName: 'System',
        action: 'server:boot',
        details: { port: 8443 },
      });
      expect(entry.id).toMatch(/^aud_/);
      expect(db.listAuditLog()).toHaveLength(1);
      expect(db.listAuditLog()[0]?.details).toEqual({ port: 8443 });

      db.close();
      expect(db.isOpen()).toBe(false);

      // Re-open existing sqlite file directly
      const reopened = ServerDatabase.open(path.join(dataDir, 'server.sqlite'));
      expect(reopened.getSettings().serverId).toBe(settings.serverId);
      expect(reopened.listAuditLog()).toHaveLength(1);
      reopened.close();
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

    it('consumes the one-time setup token to create SERVER_OWNER and rejects reuse or wrong token', () => {
      const db = ServerDatabase.open(':memory:');
      const auth = new AuthService(db, { initialSetupToken: 'setup-secret-token-123' });

      expect(auth.isSetupRequired()).toBe(true);
      expect(auth.getInitialSetupToken()).toBe('setup-secret-token-123');

      const publicInfoBefore = auth.getPublicInfo({
        fingerprint: 'SHA256:' + 'AA:'.repeat(31) + 'AA',
      });
      expect(serverPublicInfoSchema.safeParse(publicInfoBefore).success).toBe(true);
      expect(publicInfoBefore.setupRequired).toBe(true);

      // Invalid payload -> 400 BAD_REQUEST
      expect(() =>
        auth.claimSetupToken({
          setupToken: 'setup-secret-token-123',
          username: 'a', // too short
          displayName: 'Owner',
          password: 'password123',
        }),
      ).toThrowError(CollabServiceError);

      // Wrong setup token -> 403 FORBIDDEN
      expect(() =>
        auth.claimSetupToken({
          setupToken: 'wrong-token',
          username: 'owner',
          displayName: 'Server Owner',
          password: 'password123',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Valid setup token -> creates SERVER_OWNER and session
      const setupResult = auth.claimSetupToken({
        setupToken: 'setup-secret-token-123',
        username: 'owner',
        displayName: 'Server Owner',
        password: 'password123',
      });

      expect(setupResult.user.username).toBe('owner');
      expect(setupResult.user.serverRole).toBe('SERVER_OWNER');
      expect(setupResult.user.status).toBe('ACTIVE');
      expect(setupResult.token).toBeTruthy();

      expect(auth.isSetupRequired()).toBe(false);
      expect(auth.getInitialSetupToken()).toBeNull();
      expect(auth.getPublicInfo().setupRequired).toBe(false);

      // Reusing setup token after SERVER_OWNER exists -> 403 FORBIDDEN
      expect(() =>
        auth.claimSetupToken({
          setupToken: 'setup-secret-token-123',
          username: 'owner2',
          displayName: 'Second Owner',
          password: 'password123',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      db.close();
    });
  });

  describe('Registration Modes (open, approval, closed), Login/Logout, and Session Expiry', () => {
    it('handles open, approval, and closed registration modes and enforces approval/status on login', () => {
      let currentTime = new Date('2026-10-16T04:00:00.000Z');
      const db = ServerDatabase.open(':memory:', { now: () => currentTime });
      const auth = new AuthService(db, {
        initialSetupToken: 'init-token',
        sessionTtlMs: 60_000,
        now: () => currentTime,
      });

      const { user: owner } = auth.claimSetupToken({
        setupToken: 'init-token',
        username: 'owner',
        displayName: 'Owner',
        password: 'owner-password',
      });

      // 1. Default registrationMode is 'open'
      const openReg = auth.registerUser({
        username: 'alice',
        displayName: 'Alice Engineer',
        password: 'alice-password',
      });
      expect(openReg.status).toBe('ACTIVE');
      if (openReg.status === 'ACTIVE') {
        expect(openReg.user.serverRole).toBe('USER');
        expect(auth.authenticateToken(openReg.token).username).toBe('alice');
      }

      // Duplicate username (case-insensitive) -> 409 CONFLICT
      expect(() =>
        auth.registerUser({
          username: 'ALICE',
          displayName: 'Alice Clone',
          password: 'alice-password',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'CONFLICT',
          status: 409,
        }),
      );

      // 2. Switch registrationMode to 'approval'
      const updatedSettings = auth.updateServerSettings(owner, {
        registrationMode: 'approval',
        roomCreationMode: 'admins_only',
      });
      expect(updatedSettings.registrationMode).toBe('approval');
      expect(updatedSettings.roomCreationMode).toBe('admins_only');

      const pendingReg = auth.registerUser({
        username: 'bob',
        displayName: 'Bob Pending',
        password: 'bob-password',
      });
      expect(pendingReg.status).toBe('PENDING_APPROVAL');
      expect(pendingReg.user.status).toBe('PENDING_APPROVAL');
      expect('token' in pendingReg).toBe(false);

      // Bob cannot log in while PENDING_APPROVAL -> 403 FORBIDDEN
      expect(() =>
        auth.loginUser({
          username: 'bob',
          password: 'bob-password',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Approve Bob -> Bob can now log in
      const approvedBob = auth.approveUser(owner, pendingReg.user.id);
      expect(approvedBob.status).toBe('ACTIVE');

      const bobSession = auth.loginUser({
        username: 'bob',
        password: 'bob-password',
      });
      expect(bobSession.user.id).toBe(approvedBob.id);
      expect(auth.authenticateAuthorizationHeader(`Bearer ${bobSession.token}`).username).toBe('bob');

      // 3. Switch registrationMode to 'closed'
      auth.updateServerSettings(owner, { registrationMode: 'closed' });
      expect(() =>
        auth.registerUser({
          username: 'charlie',
          displayName: 'Charlie',
          password: 'charlie-password',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // 4. Wrong password -> 401 UNAUTHORIZED
      expect(() =>
        auth.loginUser({
          username: 'bob',
          password: 'wrong-password',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      // 5. Session expiration after TTL -> 401 UNAUTHORIZED
      currentTime = new Date(currentTime.getTime() + 61_000);
      expect(() => auth.authenticateToken(bobSession.token)).toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      // 6. Re-login and logout -> invalidates token immediately
      const bobSession2 = auth.loginUser({
        username: 'bob',
        password: 'bob-password',
      });
      expect(auth.logoutSession(bobSession2.token)).toEqual({ loggedOut: true });
      expect(() => auth.authenticateToken(bobSession2.token)).toThrowError(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );

      db.close();
    });
  });

  describe('Role Permission Matrix on User Management (SERVER_OWNER vs SERVER_ADMIN vs USER)', () => {
    it('enforces SERVER_OWNER, SERVER_ADMIN, and USER permissions across create, approve, disable, resetPassword, and changeServerRole', () => {
      const db = ServerDatabase.open(':memory:');
      const auth = new AuthService(db, { initialSetupToken: 'setup-token' });

      const { user: owner } = auth.claimSetupToken({
        setupToken: 'setup-token',
        username: 'owner',
        displayName: 'Server Owner',
        password: 'owner-password',
      });

      // Owner creates a SERVER_ADMIN and two regular USERs
      const admin1 = auth.createUser(owner, {
        username: 'admin1',
        displayName: 'Server Admin One',
        password: 'admin1-password',
        serverRole: 'SERVER_ADMIN',
      });
      expect(admin1.serverRole).toBe('SERVER_ADMIN');

      const user1 = auth.createUser(owner, {
        username: 'user1',
        displayName: 'Regular User One',
        password: 'user1-password',
      });
      expect(user1.serverRole).toBe('USER');

      // SERVER_ADMIN can create regular USER accounts
      const user2 = auth.createUser(admin1, {
        username: 'user2',
        displayName: 'Regular User Two',
        password: 'user2-password',
        serverRole: 'USER',
      });
      expect(user2.serverRole).toBe('USER');

      // SERVER_ADMIN CANNOT create another SERVER_ADMIN -> 403 FORBIDDEN
      expect(() =>
        auth.createUser(admin1, {
          username: 'admin2',
          displayName: 'Unauthorized Admin',
          password: 'admin2-password',
          serverRole: 'SERVER_ADMIN',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // Regular USER cannot create users, list admin users, approve users, or update server settings
      expect(() =>
        auth.createUser(user1, {
          username: 'user3',
          displayName: 'User Three',
          password: 'user3-password',
        }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
      expect(() => auth.listUsers(user1)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.approveUser(user1, user2.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.updateServerSettings(user1, { name: 'Hacked' })).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.updateServerSettings(admin1, { name: 'Admin Rename' })).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Regular USER CAN search the active user directory
      expect(auth.searchUserDirectory(user1, 'user')).toHaveLength(2);
      expect(auth.listUsers(admin1)).toHaveLength(4);

      // SERVER_ADMIN can disable/enable and reset password for a regular USER (and revokes their sessions)
      const user2Login = auth.loginUser({ username: 'user2', password: 'user2-password' });
      expect(auth.authenticateToken(user2Login.token).id).toBe(user2.id);

      const disabledUser2 = auth.disableUser(admin1, user2.id, true);
      expect(disabledUser2.status).toBe('DISABLED');
      // Active session is revoked immediately
      expect(() => auth.authenticateToken(user2Login.token)).toThrowError(
        expect.objectContaining({ code: 'UNAUTHORIZED', status: 401 }),
      );
      // Disabled user cannot log in
      expect(() => auth.loginUser({ username: 'user2', password: 'user2-password' })).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Re-enable user2 and reset their password
      const reenabledUser2 = auth.enableUser(admin1, user2.id);
      expect(reenabledUser2.status).toBe('ACTIVE');
      expect(auth.resetPassword(admin1, user2.id, 'new-user2-pass')).toEqual({ reset: true });
      expect(auth.loginUser({ username: 'user2', password: 'new-user2-pass' }).user.id).toBe(
        user2.id,
      );

      // SERVER_ADMIN CANNOT promote/demote roles or disable/reset password of another SERVER_ADMIN or SERVER_OWNER
      expect(() => auth.changeServerRole(admin1, user1.id, 'SERVER_ADMIN')).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.disableUser(admin1, owner.id, true)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.resetPassword(admin1, owner.id, 'new-owner-pass')).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      const admin2 = auth.changeServerRole(owner, user1.id, 'SERVER_ADMIN');
      expect(admin2.serverRole).toBe('SERVER_ADMIN');

      // SERVER_ADMIN (admin1) cannot disable or reset password of another SERVER_ADMIN (admin2)
      expect(() => auth.disableUser(admin1, admin2.id, true)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.resetPassword(admin1, admin2.id, 'hacked-admin2')).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // SERVER_OWNER CAN disable, reset password, and demote a SERVER_ADMIN
      expect(auth.resetPassword(owner, admin2.id, 'owner-reset-pass')).toEqual({ reset: true });
      const disabledAdmin2 = auth.disableUser(owner, admin2.id, true);
      expect(disabledAdmin2.status).toBe('DISABLED');
      const demotedUser1 = auth.changeServerRole(owner, admin2.id, 'USER');
      expect(demotedUser1.serverRole).toBe('USER');

      // SERVER_OWNER cannot disable or demote themselves
      expect(() => auth.disableUser(owner, owner.id, true)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => auth.changeServerRole(owner, owner.id, 'USER')).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Audit log records all administrative actions and is accessible to SERVER_ADMIN & SERVER_OWNER only
      expect(() => auth.listServerAuditLog(user2)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      const auditEntries = auth.listServerAuditLog(admin1);
      expect(auditEntries.length).toBeGreaterThanOrEqual(6);

      db.close();
    });
  });
});
