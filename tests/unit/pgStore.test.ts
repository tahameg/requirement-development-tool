import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { runMigrations } from '../../src/server/store/migrator.js';
import { PgServerStore } from '../../src/server/store/pgStore.js';
import { createTestStore, ensureSharedTestDatabase, type TestStoreFixture } from './testDbHelper.js';

describe('R02: PostgreSQL Server Store and Migrations', () => {
  let mainFixture: TestStoreFixture;

  beforeAll(async () => {
    mainFixture = await createTestStore({ schemaPrefix: 'store_test' });
  });

  afterAll(async () => {
    if (mainFixture) {
      await mainFixture.cleanup();
    }
  });

  describe('Migrations and Advisory Locking', () => {
    it('applies migrations on an empty schema and is a no-op on the second run', async () => {
      const dbUrl = await ensureSharedTestDatabase();
      const testSchema = `mig_test_${randomUUID().replace(/-/g, '_')}`;
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();

      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`SET search_path TO "${testSchema}", public`);

        // First run: should apply 0001_init.sql
        const firstRun = await runMigrations(client);
        expect(firstRun.applied).toContain('0001_init.sql');

        // Second run: should be a no-op
        const secondRun = await runMigrations(client);
        expect(secondRun.applied).toEqual([]);
        expect(secondRun.all).toContain('0001_init.sql');
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        await client.end();
      }
    });

    it('ensures two concurrent migration runners do not double-apply via advisory lock', async () => {
      const dbUrl = await ensureSharedTestDatabase();
      const testSchema = `mig_concurrent_${randomUUID().replace(/-/g, '_')}`;
      const client1 = new pg.Client({ connectionString: dbUrl });
      const client2 = new pg.Client({ connectionString: dbUrl });
      await client1.connect();
      await client2.connect();

      try {
        await client1.query(`CREATE SCHEMA "${testSchema}"`);
        await client1.query(`SET search_path TO "${testSchema}", public`);
        await client2.query(`SET search_path TO "${testSchema}", public`);

        // Run migrations concurrently on both clients
        const [res1, res2] = await Promise.all([
          runMigrations(client1),
          runMigrations(client2),
        ]);

        const totalApplied = [...res1.applied, ...res2.applied];
        expect(totalApplied).toEqual(['0001_init.sql', '0002_revision_sequences.sql']);
      } finally {
        await client1.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        await client1.end();
        await client2.end();
      }
    });
  });

  describe('Repository Unit Tests', () => {
    it('exercises UserRepository (create, getById, getByUsername, update, list, search, count)', async () => {
      const { users } = mainFixture.store;
      const initialCount = await users.count();

      const user1 = await users.create({
        id: `usr_${randomUUID()}`,
        username: 'alice_smith',
        displayName: 'Alice Smith',
        passwordHash: 'hash_alice',
        serverRole: 'USER',
        status: 'ACTIVE',
      });

      expect(user1.username).toBe('alice_smith');
      expect(await users.count()).toBe(initialCount + 1);

      // getById
      const fetched = await users.getById(user1.id);
      expect(fetched?.id).toBe(user1.id);
      expect(fetched?.display_name).toBe('Alice Smith');

      // getByUsername case-insensitive
      const fetchedByUsername = await users.getByUsername('ALICE_SMITH');
      expect(fetchedByUsername?.id).toBe(user1.id);

      // update
      const updated = await users.update(user1.id, {
        displayName: 'Alice Cooper',
        serverRole: 'SERVER_ADMIN',
      });
      expect(updated.display_name).toBe('Alice Cooper');
      expect(updated.server_role).toBe('SERVER_ADMIN');

      // search
      const searched = await users.search('cooper');
      expect(searched.some(u => u.id === user1.id)).toBe(true);

      // list
      const list = await users.list({ status: 'ACTIVE' });
      expect(list.some(u => u.id === user1.id)).toBe(true);
    });

    it('exercises SessionRepository (create, getByTokenHash, deleteByTokenHash, deleteByUserId, deleteExpired)', async () => {
      const { users, sessions } = mainFixture.store;
      const user = await users.create({
        id: `usr_${randomUUID()}`,
        username: `sess_user_${Date.now()}`,
        displayName: 'Session User',
        passwordHash: 'hash',
      });

      const tokenHash1 = `th1_${randomUUID()}`;
      const tokenHash2 = `th2_${randomUUID()}`;
      const future = new Date(Date.now() + 60000).toISOString();
      const past = new Date(Date.now() - 60000).toISOString();

      await sessions.create({ tokenHash: tokenHash1, userId: user.id, expiresAt: future });
      await sessions.create({ tokenHash: tokenHash2, userId: user.id, expiresAt: past });

      const s1 = await sessions.getByTokenHash(tokenHash1);
      expect(s1?.user_id).toBe(user.id);

      // deleteExpired
      const expiredCount = await sessions.deleteExpired(new Date().toISOString());
      expect(expiredCount).toBeGreaterThanOrEqual(1);
      expect(await sessions.getByTokenHash(tokenHash2)).toBeNull();

      // deleteByTokenHash
      expect(await sessions.deleteByTokenHash(tokenHash1)).toBe(true);
      expect(await sessions.getByTokenHash(tokenHash1)).toBeNull();

      // deleteByUserId
      const tokenHash3 = `th3_${randomUUID()}`;
      await sessions.create({ tokenHash: tokenHash3, userId: user.id, expiresAt: future });
      const deletedUserSessions = await sessions.deleteByUserId(user.id);
      expect(deletedUserSessions).toBe(1);
    });

    it('exercises ServerSettingsRepository (get, ensure, update)', async () => {
      const { serverSettings } = mainFixture.store;
      const settings = await serverSettings.ensure({
        serverName: 'Custom HLR Test Server',
        registrationMode: 'approval',
      });
      expect(settings.server_name).toBe('Custom HLR Test Server');
      expect(settings.registration_mode).toBe('approval');

      const updated = await serverSettings.update({
        serverName: 'Updated HLR Server',
        registrationMode: 'closed',
      });
      expect(updated.server_name).toBe('Updated HLR Server');
      expect(updated.registration_mode).toBe('closed');

      const fetched = await serverSettings.get();
      expect(fetched?.server_name).toBe('Updated HLR Server');
    });

    it('exercises RoomRepository and RoomMemberRepository', async () => {
      const { users, rooms, memberships } = mainFixture.store;
      const owner = await users.create({
        id: `usr_${randomUUID()}`,
        username: `owner_${Date.now()}`,
        displayName: 'Room Owner',
        passwordHash: 'hash',
      });

      const member = await users.create({
        id: `usr_${randomUUID()}`,
        username: `member_${Date.now()}`,
        displayName: 'Room Member',
        passwordHash: 'hash',
      });

      const roomId = `room_${randomUUID()}`;
      const room = await rooms.create({
        id: roomId,
        name: 'Avionics Project',
        visibility: 'listed',
        ownerId: owner.id,
        projectId: 'proj_1',
        projectName: 'Avionics',
      });
      expect(room.name).toBe('Avionics Project');

      // Memberships
      await memberships.add({ roomId, userId: owner.id, role: 'ROOM_OWNER' });
      await memberships.add({ roomId, userId: member.id, role: 'EDITOR' });

      const m = await memberships.get(roomId, member.id);
      expect(m?.role).toBe('EDITOR');

      const roomMembers = await memberships.listByRoom(roomId);
      expect(roomMembers.length).toBe(2);

      const userMemberships = await memberships.listByUser(member.id);
      expect(userMemberships.length).toBe(1);

      await memberships.updateRole(roomId, member.id, 'ROOM_ADMIN');
      expect((await memberships.get(roomId, member.id))?.role).toBe('ROOM_ADMIN');

      // Room queries
      const forUser = await rooms.listForUser(member.id);
      expect(forUser.some(r => r.id === roomId)).toBe(true);

      const listed = await rooms.list({ visibility: 'listed' });
      expect(listed.some(r => r.id === roomId)).toBe(true);

      const allAdmin = await rooms.listAllAdmin();
      expect(allAdmin.some(r => r.id === roomId)).toBe(true);

      // Update room
      const updatedRoom = await rooms.update(roomId, {
        name: 'Updated Avionics Project',
        headSeq: 10,
      });
      expect(updatedRoom.name).toBe('Updated Avionics Project');
      expect(updatedRoom.head_seq).toBe(10);

      // Remove member
      expect(await memberships.remove(roomId, member.id)).toBe(true);
      expect(await memberships.get(roomId, member.id)).toBeNull();

      // Delete room
      expect(await rooms.delete(roomId)).toBe(true);
      expect(await rooms.getById(roomId)).toBeNull();
    });

    it('exercises InviteRepository and JoinRequestRepository', async () => {
      const { users, rooms, invites, joinRequests } = mainFixture.store;
      const creator = await users.create({
        id: `usr_${randomUUID()}`,
        username: `inv_creator_${Date.now()}`,
        displayName: 'Creator',
        passwordHash: 'hash',
      });
      const invitee = await users.create({
        id: `usr_${randomUUID()}`,
        username: `invitee_${Date.now()}`,
        displayName: 'Invitee',
        passwordHash: 'hash',
      });
      const room = await rooms.create({
        id: `room_${randomUUID()}`,
        name: 'Invite Test Room',
        ownerId: creator.id,
        projectId: 'proj_inv',
        projectName: 'InvProj',
      });

      // Direct invite
      const directInvite = await invites.create({
        id: `inv_${randomUUID()}`,
        roomId: room.id,
        kind: 'direct',
        targetUserId: invitee.id,
        role: 'EDITOR',
        createdBy: creator.id,
      });
      expect(directInvite.status).toBe('PENDING');

      const pending = await invites.listPendingForUser(invitee.id);
      expect(pending.some(i => i.id === directInvite.id)).toBe(true);

      await invites.updateStatus(directInvite.id, 'ACCEPTED');
      expect((await invites.getById(directInvite.id))?.status).toBe('ACCEPTED');

      // Code invite
      const codeInvite = await invites.create({
        id: `inv_${randomUUID()}`,
        roomId: room.id,
        kind: 'code',
        code: 'TESTCODE123',
        role: 'VIEWER',
        createdBy: creator.id,
        maxUses: 5,
      });
      expect((await invites.getByCode('TESTCODE123'))?.id).toBe(codeInvite.id);

      await invites.incrementUses(codeInvite.id);
      expect((await invites.getById(codeInvite.id))?.uses).toBe(1);

      // Join requests
      const jreq = await joinRequests.create({
        id: `jreq_${randomUUID()}`,
        roomId: room.id,
        userId: invitee.id,
        message: 'Please let me join',
      });
      expect(jreq.status).toBe('PENDING');

      const byRoom = await joinRequests.listByRoom(room.id);
      expect(byRoom.some(j => j.id === jreq.id)).toBe(true);

      const byUser = await joinRequests.listByUser(invitee.id);
      expect(byUser.some(j => j.id === jreq.id)).toBe(true);

      await joinRequests.update(jreq.id, {
        status: 'APPROVED',
        assignedRole: 'EDITOR',
        reviewedBy: creator.id,
      });
      const updatedJreq = await joinRequests.getById(jreq.id);
      expect(updatedJreq?.status).toBe('APPROVED');
      expect(updatedJreq?.assigned_role).toBe('EDITOR');

      await invites.delete(directInvite.id);
      expect(await invites.getById(directInvite.id)).toBeNull();
    });

    it('exercises RoomBanRepository and AuditRepository', async () => {
      const { users, rooms, bans, audit } = mainFixture.store;
      const admin = await users.create({
        id: `usr_${randomUUID()}`,
        username: `ban_admin_${Date.now()}`,
        displayName: 'Admin',
        passwordHash: 'hash',
      });
      const badUser = await users.create({
        id: `usr_${randomUUID()}`,
        username: `bad_user_${Date.now()}`,
        displayName: 'Bad User',
        passwordHash: 'hash',
      });
      const room = await rooms.create({
        id: `room_${randomUUID()}`,
        name: 'Ban Room',
        ownerId: admin.id,
        projectId: 'p_ban',
        projectName: 'BanProj',
      });

      const ban = await bans.add({
        roomId: room.id,
        userId: badUser.id,
        bannedBy: admin.id,
        reason: 'Spamming',
      });
      expect(ban.reason).toBe('Spamming');

      const roomBans = await bans.listByRoom(room.id);
      expect(roomBans.some(b => b.user_id === badUser.id)).toBe(true);

      expect(await bans.remove(room.id, badUser.id)).toBe(true);
      expect(await bans.get(room.id, badUser.id)).toBeNull();

      // Audit log
      const auditEntry = await audit.append({
        roomId: room.id,
        actorId: admin.id,
        actorName: admin.display_name,
        action: 'member:ban',
        targetId: badUser.id,
        details: { reason: 'Spamming' },
      });
      expect(auditEntry.action).toBe('member:ban');

      const roomAudit = await audit.list({ roomId: room.id });
      expect(roomAudit.some(a => a.id === auditEntry.id)).toBe(true);

      const globalAudit = await audit.list();
      expect(globalAudit.some(a => a.id === auditEntry.id)).toBe(true);
    });

    it('exercises RoomOpsRepository, RoomSnapshotRepository, and RevisionRepository', async () => {
      const { users, rooms, ops, snapshots, revisions } = mainFixture.store;
      const user = await users.create({
        id: `usr_${randomUUID()}`,
        username: `op_user_${Date.now()}`,
        displayName: 'Op User',
        passwordHash: 'hash',
      });
      const room = await rooms.create({
        id: `room_${randomUUID()}`,
        name: 'Op Room',
        ownerId: user.id,
        projectId: 'p_op',
        projectName: 'OpProj',
      });

      // Ops
      const opId = randomUUID();
      const op = await ops.append({
        roomId: room.id,
        seq: 1,
        opId,
        userId: user.id,
        kind: 'item.add',
        payload: { objectType: 'REQUIREMENT', requirementSetId: 'fn_1', values: { name: 'Req 1' } },
        result: { itemId: 'item_1' },
      });
      expect(op.seq).toBe(1);
      expect(op.kind).toBe('item.add');

      expect((await ops.getBySeq(room.id, 1))?.op_id).toBe(opId);
      expect((await ops.getByOpId(room.id, opId))?.seq).toBe(1);

      const sinceOps = await ops.listSince(room.id, 0);
      expect(sinceOps.length).toBe(1);

      // Snapshots
      const ws = createWorkspace('Test Workspace', 'TW');
      const snap = await snapshots.create({
        roomId: room.id,
        seq: 1,
        workspace: ws,
      });
      expect(snap.seq).toBe(1);
      expect(snap.workspace.config.projectName).toBe('Test Workspace');

      const latestSnap = await snapshots.getLatest(room.id);
      expect(latestSnap?.seq).toBe(1);
      expect(latestSnap?.workspace.config.projectName).toBe('Test Workspace');

      const snaps = await snapshots.list(room.id);
      expect(snaps.length).toBe(1);

      // Revisions
      const rev = await revisions.create({
        id: `rev_${randomUUID()}`,
        roomId: room.id,
        seq: 1,
        message: 'First baseline revision',
        authorId: user.id,
        authorName: user.display_name,
        workspace: ws,
      });
      expect(rev.message).toBe('First baseline revision');

      const fetchedRev = await revisions.getById(rev.id);
      expect(fetchedRev?.seq).toBe(1);

      const roomRevs = await revisions.listByRoom(room.id);
      expect(roomRevs.some(r => r.id === rev.id)).toBe(true);
    });

    it('exercises transaction commit and rollback', async () => {
      const { users } = mainFixture.store;
      const username = `tx_user_${Date.now()}`;

      // Successful transaction
      await mainFixture.store.transaction(async tx => {
        await tx.users.create({
          id: `usr_${randomUUID()}`,
          username,
          displayName: 'Tx User',
          passwordHash: 'hash',
        });
      });

      expect(await users.getByUsername(username)).not.toBeNull();

      // Rolled back transaction
      const failedUsername = `fail_tx_${Date.now()}`;
      await expect(
        mainFixture.store.transaction(async tx => {
          await tx.users.create({
            id: `usr_${randomUUID()}`,
            username: failedUsername,
            displayName: 'Will Fail',
            passwordHash: 'hash',
          });
          throw new Error('Simulated abort');
        }),
      ).rejects.toThrow('Simulated abort');

      expect(await users.getByUsername(failedUsername)).toBeNull();
    });
  });
});
