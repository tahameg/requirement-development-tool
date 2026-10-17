import { z } from 'zod';
import { hierarchyCommandSchema } from '../hierarchy.js';
import { objectTypeSchema, projectConfigSchema, workspaceSchema } from '../types/schema.js';
import {
  API_ERROR_CODES,
  COLLAB_OP_KINDS,
  DISCOVERY_BEACON_MAGIC,
  INVITE_KINDS,
  INVITE_STATUSES,
  JOIN_REQUEST_STATUSES,
  OP_REJECT_CODES,
  REGISTRATION_MODES,
  ROOM_CREATION_MODES,
  ROOM_ROLES,
  ROOM_VISIBILITIES,
  SERVER_ROLES,
  USER_STATUSES,
} from './types.js';

const nonEmptyString = z.string().min(1);
const trimmedName = z.string().trim().min(1);
const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may contain letters, numbers, underscores, dots, and hyphens');
const passwordSchema = z.string().min(6).max(256);
const isoDateTimeSchema = z.string().datetime();
const fingerprintSchema = z
  .string()
  .regex(/^SHA256:[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})+$/, 'Expected SHA256:<hex-colon-separated> fingerprint');
const primitiveCellValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const serverRoleSchema = z.enum(SERVER_ROLES);
export const roomRoleSchema = z.enum(ROOM_ROLES);
export const assignableRoomRoleSchema = z.enum(['VIEWER', 'EDITOR', 'ROOM_ADMIN']);
export const belowAdminRoomRoleSchema = z.enum(['VIEWER', 'EDITOR']);
export const registrationModeSchema = z.enum(REGISTRATION_MODES);
export const roomCreationModeSchema = z.enum(ROOM_CREATION_MODES);
export const userStatusSchema = z.enum(USER_STATUSES);
export const roomVisibilitySchema = z.enum(ROOM_VISIBILITIES);
export const inviteKindSchema = z.enum(INVITE_KINDS);
export const inviteStatusSchema = z.enum(INVITE_STATUSES);
export const joinRequestStatusSchema = z.enum(JOIN_REQUEST_STATUSES);
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export function apiSuccessEnvelopeSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      ok: z.literal(true),
      value: valueSchema,
    })
    .strict();
}

export const apiErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    code: apiErrorCodeSchema,
    error: nonEmptyString,
  })
  .strict();

// --- Shared Entity Schemas ---

export const serverSettingsSchema = z
  .object({
    serverId: nonEmptyString,
    name: trimmedName,
    registrationMode: registrationModeSchema,
    roomCreationMode: roomCreationModeSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const serverPublicInfoSchema = z
  .object({
    serverId: nonEmptyString,
    name: trimmedName,
    version: nonEmptyString,
    tls: z.boolean(),
    fingerprint: fingerprintSchema.nullable(),
    setupRequired: z.boolean(),
    registrationMode: registrationModeSchema,
    roomCreationMode: roomCreationModeSchema,
  })
  .strict();

export const userProfileSchema = z
  .object({
    id: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
    serverRole: serverRoleSchema,
    status: userStatusSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const userAdminRecordSchema = userProfileSchema;

export const userDirectoryEntrySchema = z
  .object({
    id: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
  })
  .strict();

export const roomSummarySchema = z
  .object({
    id: nonEmptyString,
    name: trimmedName,
    visibility: roomVisibilitySchema,
    ownerId: nonEmptyString,
    ownerDisplayName: trimmedName.optional(),
    projectId: nonEmptyString,
    projectName: trimmedName,
    myRole: roomRoleSchema.nullable(),
    memberCount: z.number().int().nonnegative(),
    onlineCount: z.number().int().nonnegative().optional(),
    lastAutosavedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const listedRoomSummarySchema = z
  .object({
    id: nonEmptyString,
    name: trimmedName,
    visibility: z.literal('listed'),
    ownerId: nonEmptyString,
    ownerDisplayName: trimmedName,
    projectId: nonEmptyString,
    projectName: trimmedName,
    memberCount: z.number().int().nonnegative(),
    hasPendingJoinRequest: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const roomDetailSchema = roomSummarySchema;

export const roomMemberInfoSchema = z
  .object({
    roomId: nonEmptyString,
    userId: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
    role: roomRoleSchema,
    joinedAt: isoDateTimeSchema,
    online: z.boolean().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();

export const roomBanInfoSchema = z
  .object({
    roomId: nonEmptyString,
    userId: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
    bannedBy: nonEmptyString,
    reason: z.string(),
    bannedAt: isoDateTimeSchema,
  })
  .strict();

export const directInviteSummarySchema = z
  .object({
    id: nonEmptyString,
    roomId: nonEmptyString,
    roomName: trimmedName,
    kind: z.literal('direct'),
    targetUserId: nonEmptyString,
    targetUsername: usernameSchema,
    targetDisplayName: trimmedName,
    role: assignableRoomRoleSchema,
    createdBy: nonEmptyString,
    createdByDisplayName: trimmedName,
    status: inviteStatusSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const inviteCodeInfoSchema = z
  .object({
    id: nonEmptyString,
    roomId: nonEmptyString,
    kind: z.literal('code'),
    code: nonEmptyString,
    role: belowAdminRoomRoleSchema,
    createdBy: nonEmptyString,
    status: inviteStatusSchema,
    uses: z.number().int().nonnegative(),
    maxUses: z.number().int().positive().nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const inviteInfoSchema = z.union([directInviteSummarySchema, inviteCodeInfoSchema]);

export const joinRequestSummarySchema = z
  .object({
    id: nonEmptyString,
    roomId: nonEmptyString,
    roomName: trimmedName,
    userId: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
    message: z.string(),
    status: joinRequestStatusSchema,
    assignedRole: roomRoleSchema.nullable(),
    reviewedBy: nonEmptyString.nullable(),
    createdAt: isoDateTimeSchema,
    reviewedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const revisionMetadataSchema = z
  .object({
    id: nonEmptyString,
    roomId: nonEmptyString,
    seq: z.number().int().nonnegative(),
    message: z.string(),
    authorId: nonEmptyString,
    authorName: trimmedName,
    snapshotFilename: nonEmptyString,
    restoredFromId: nonEmptyString.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const revisionDiffEntityChangeSchema = z
  .object({
    id: nonEmptyString,
    objectType: objectTypeSchema,
    name: z.string(),
  })
  .strict();

export const revisionDiffItemChangeSchema = z
  .object({
    id: nonEmptyString,
    objectType: objectTypeSchema,
    functionId: nonEmptyString,
    changedColumns: z.array(z.string()).optional(),
  })
  .strict();

export const revisionDiffSchema = z
  .object({
    fromRevisionId: nonEmptyString,
    toTarget: nonEmptyString,
    configChanged: z.boolean(),
    modules: z
      .object({
        added: z.array(revisionDiffEntityChangeSchema),
        modified: z.array(revisionDiffEntityChangeSchema),
        deleted: z.array(revisionDiffEntityChangeSchema),
      })
      .strict(),
    functions: z
      .object({
        added: z.array(revisionDiffEntityChangeSchema),
        modified: z.array(revisionDiffEntityChangeSchema),
        deleted: z.array(revisionDiffEntityChangeSchema),
      })
      .strict(),
    items: z
      .object({
        added: z.array(revisionDiffItemChangeSchema),
        modified: z.array(revisionDiffItemChangeSchema),
        deleted: z.array(revisionDiffItemChangeSchema),
      })
      .strict(),
  })
  .strict();

export const auditEntrySchema = z
  .object({
    id: nonEmptyString,
    roomId: nonEmptyString.nullable(),
    actorId: nonEmptyString.nullable(),
    actorName: trimmedName,
    action: nonEmptyString,
    targetId: nonEmptyString.nullable(),
    details: z.record(z.unknown()),
    createdAt: isoDateTimeSchema,
  })
  .strict();

// --- REST Endpoint Payload Schemas ---

export const setupRequestSchema = z
  .object({
    setupToken: nonEmptyString,
    username: usernameSchema,
    displayName: trimmedName,
    password: passwordSchema,
  })
  .strict();

export const registerRequestSchema = z
  .object({
    username: usernameSchema,
    displayName: trimmedName,
    password: passwordSchema,
  })
  .strict();

export const loginRequestSchema = z
  .object({
    username: usernameSchema,
    password: nonEmptyString,
  })
  .strict();

export const logoutRequestSchema = z.object({}).strict();

export const authSessionResponseSchema = z
  .object({
    status: z.literal('ACTIVE').optional(),
    user: userProfileSchema,
    token: nonEmptyString,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const registerResponseSchema = z.union([
  authSessionResponseSchema,
  z
    .object({
      status: z.literal('PENDING_APPROVAL'),
      user: userProfileSchema,
    })
    .strict(),
]);

export const logoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
  })
  .strict();

export const meResponseSchema = z
  .object({
    user: userProfileSchema,
  })
  .strict();

export const userDirectoryResponseSchema = z
  .object({
    users: z.array(userDirectoryEntrySchema),
  })
  .strict();

export const updateServerSettingsRequestSchema = z
  .object({
    name: trimmedName.optional(),
    registrationMode: registrationModeSchema.optional(),
    roomCreationMode: roomCreationModeSchema.optional(),
  })
  .strict()
  .refine(
    data =>
      data.name !== undefined ||
      data.registrationMode !== undefined ||
      data.roomCreationMode !== undefined,
    'At least one setting must be provided for update',
  );

export const updateServerSettingsResponseSchema = z
  .object({
    settings: serverSettingsSchema,
  })
  .strict();

export const adminListUsersResponseSchema = z
  .object({
    users: z.array(userAdminRecordSchema),
  })
  .strict();

export const adminCreateUserRequestSchema = z
  .object({
    username: usernameSchema,
    displayName: trimmedName,
    password: passwordSchema,
    serverRole: z.enum(['USER', 'SERVER_ADMIN']).optional(),
  })
  .strict();

export const adminUserResponseSchema = z
  .object({
    user: userAdminRecordSchema,
  })
  .strict();

export const adminUpdateUserRequestSchema = z
  .object({
    status: userStatusSchema.optional(),
    serverRole: serverRoleSchema.optional(),
    displayName: trimmedName.optional(),
  })
  .strict()
  .refine(
    data =>
      data.status !== undefined || data.serverRole !== undefined || data.displayName !== undefined,
    'At least one user field must be provided for update',
  );

export const adminResetPasswordRequestSchema = z
  .object({
    newPassword: passwordSchema,
  })
  .strict();

export const adminResetPasswordResponseSchema = z
  .object({
    reset: z.literal(true),
  })
  .strict();

export const adminListRoomsResponseSchema = z
  .object({
    rooms: z.array(roomSummarySchema),
  })
  .strict();

export const adminResolveRoomRequestSchema = z
  .object({
    userId: nonEmptyString,
    role: z.enum(['ROOM_ADMIN', 'ROOM_OWNER']),
  })
  .strict();

export const auditListResponseSchema = z
  .object({
    entries: z.array(auditEntrySchema),
  })
  .strict();

export const listRoomsResponseSchema = z
  .object({
    myRooms: z.array(roomSummarySchema),
    listedRooms: z.array(listedRoomSummarySchema),
    myInvites: z.array(directInviteSummarySchema),
    myJoinRequests: z.array(joinRequestSummarySchema),
  })
  .strict();

export const createRoomRequestSchema = z
  .object({
    name: trimmedName,
    visibility: roomVisibilitySchema,
    projectName: trimmedName.optional(),
    projectPrefix: z
      .string()
      .regex(/^[\p{L}\p{N}_]*$/u, 'Prefixes may contain letters, numbers and underscores')
      .optional(),
    workspace: workspaceSchema.optional(),
  })
  .strict();

export const roomSummaryResponseSchema = z
  .object({
    room: roomSummarySchema,
  })
  .strict();

export const getRoomResponseSchema = z
  .object({
    room: roomDetailSchema,
    members: z.array(roomMemberInfoSchema),
    invites: z.array(inviteInfoSchema),
    joinRequests: z.array(joinRequestSummarySchema),
    bans: z.array(roomBanInfoSchema),
    workspace: workspaceSchema,
  })
  .strict();

export const updateRoomRequestSchema = z
  .object({
    name: trimmedName.optional(),
    visibility: roomVisibilitySchema.optional(),
  })
  .strict()
  .refine(
    data => data.name !== undefined || data.visibility !== undefined,
    'At least one room attribute must be provided for update',
  );

export const deleteRoomResponseSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

export const leaveRoomResponseSchema = z
  .object({
    left: z.literal(true),
  })
  .strict();

export const transferOwnershipRequestSchema = z
  .object({
    newOwnerUserId: nonEmptyString,
  })
  .strict();

export const createDirectInviteRequestSchema = z
  .object({
    targetUserId: nonEmptyString,
    role: assignableRoomRoleSchema,
  })
  .strict();

export const createDirectInviteResponseSchema = z
  .object({
    invite: directInviteSummarySchema,
  })
  .strict();

export const respondInviteRequestSchema = z
  .object({
    accept: z.boolean(),
  })
  .strict();

export const respondInviteResponseSchema = z
  .object({
    accepted: z.boolean(),
    roomId: nonEmptyString.optional(),
    role: roomRoleSchema.optional(),
  })
  .strict();

export const createInviteCodeRequestSchema = z
  .object({
    role: belowAdminRoomRoleSchema,
    expiresInSeconds: z.number().int().positive().optional(),
    maxUses: z.number().int().positive().optional(),
  })
  .strict();

export const createInviteCodeResponseSchema = z
  .object({
    inviteCode: inviteCodeInfoSchema,
  })
  .strict();

export const redeemInviteCodeRequestSchema = z
  .object({
    code: nonEmptyString,
  })
  .strict();

export const redeemInviteCodeResponseSchema = z
  .object({
    room: roomSummarySchema,
    role: roomRoleSchema,
  })
  .strict();

export const revokeInviteResponseSchema = z
  .object({
    revoked: z.literal(true),
  })
  .strict();

export const createJoinRequestSchema = z
  .object({
    message: z.string().max(1000).optional(),
  })
  .strict();

export const joinRequestResponseSchema = z
  .object({
    joinRequest: joinRequestSummarySchema,
  })
  .strict();

export const reviewJoinRequestSchema = z
  .object({
    approve: z.boolean(),
    role: belowAdminRoomRoleSchema.optional(),
  })
  .strict()
  .refine(
    data => !data.approve || data.role !== undefined,
    'Approving a join request requires specifying an assigned role',
  );

export const updateRoomMemberRoleRequestSchema = z
  .object({
    role: assignableRoomRoleSchema,
  })
  .strict();

export const updateRoomMemberRoleResponseSchema = z
  .object({
    member: roomMemberInfoSchema,
  })
  .strict();

export const kickOrBanMemberRequestSchema = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .strict();

export const kickMemberResponseSchema = z
  .object({
    kicked: z.literal(true),
  })
  .strict();

export const banMemberResponseSchema = z
  .object({
    banned: z.literal(true),
  })
  .strict();

export const unbanMemberResponseSchema = z
  .object({
    unbanned: z.literal(true),
  })
  .strict();

export const roomExportQuerySchema = z
  .object({
    format: z.enum(['json', 'csv', 'markdown']),
    objectType: objectTypeSchema.optional(),
    functionId: nonEmptyString.optional(),
  })
  .strict();

export const roomExportResponseSchema = z
  .object({
    format: z.enum(['json', 'csv', 'markdown']),
    content: z.union([z.string(), workspaceSchema]),
  })
  .strict();

export const listRevisionsResponseSchema = z
  .object({
    revisions: z.array(revisionMetadataSchema),
  })
  .strict();

export const createRevisionRequestSchema = z
  .object({
    message: trimmedName,
  })
  .strict();

export const createRevisionResponseSchema = z
  .object({
    revision: revisionMetadataSchema,
  })
  .strict();

export const getRevisionResponseSchema = z
  .object({
    revision: revisionMetadataSchema,
    workspace: workspaceSchema,
  })
  .strict();

export const getRevisionDiffResponseSchema = z
  .object({
    diff: revisionDiffSchema,
  })
  .strict();

export const restoreRevisionResponseSchema = z
  .object({
    revision: revisionMetadataSchema,
    workspace: workspaceSchema,
  })
  .strict();

// --- Architecture v2: Operations, Locks, Presence, and WebSocket Schemas ---

export const collabOpKindSchema = z.enum(COLLAB_OP_KINDS);
export const opRejectCodeSchema = z.enum(OP_REJECT_CODES);

export const hierarchyOpPayloadSchema = hierarchyCommandSchema;

export const itemAddOpPayloadSchema = z
  .object({
    objectType: objectTypeSchema,
    functionId: nonEmptyString,
    values: z.record(primitiveCellValueSchema),
  })
  .strict();

export const itemEditOpPayloadSchema = z
  .object({
    objectType: objectTypeSchema,
    functionId: nonEmptyString,
    itemId: nonEmptyString,
    values: z.record(primitiveCellValueSchema),
  })
  .strict();

export const itemDeleteOpPayloadSchema = z
  .object({
    objectType: objectTypeSchema,
    functionId: nonEmptyString,
    itemId: nonEmptyString,
  })
  .strict();

export const functionDescriptionOpPayloadSchema = z
  .object({
    objectType: objectTypeSchema,
    functionId: nonEmptyString,
    description: z.string(),
  })
  .strict();

export const configUpdateOpPayloadSchema = projectConfigSchema;

export const roomRestoreOpPayloadSchema = z
  .object({
    revisionId: nonEmptyString,
  })
  .strict();

export const collabOpSchema = z.discriminatedUnion('kind', [
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('hierarchy'),
      payload: hierarchyOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('item.add'),
      payload: itemAddOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('item.edit'),
      payload: itemEditOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('item.delete'),
      payload: itemDeleteOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('function.description'),
      payload: functionDescriptionOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('config.update'),
      payload: configUpdateOpPayloadSchema,
    })
    .strict(),
  z
    .object({
      opId: nonEmptyString,
      kind: z.literal('room.restore'),
      payload: roomRestoreOpPayloadSchema,
    })
    .strict(),
]);

export const lockHolderSchema = z
  .object({
    userId: nonEmptyString,
    name: trimmedName,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

export const lockInfoSchema = z
  .object({
    holder: lockHolderSchema,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export const lockAcquireSchema = z
  .object({
    type: z.literal('lock-acquire'),
    key: nonEmptyString,
  })
  .strict();

export const lockReleaseSchema = z
  .object({
    type: z.literal('lock-release'),
    key: nonEmptyString,
  })
  .strict();

export const lockHeartbeatSchema = z
  .object({
    type: z.literal('lock-heartbeat'),
    key: nonEmptyString,
  })
  .strict();

export const lockForceReleaseSchema = z
  .object({
    type: z.literal('lock-force-release'),
    key: nonEmptyString,
  })
  .strict();

export const lockGrantedSchema = z
  .object({
    type: z.literal('lock-granted'),
    key: nonEmptyString,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export const lockDeniedSchema = z
  .object({
    type: z.literal('lock-denied'),
    key: nonEmptyString,
    holder: lockHolderSchema,
  })
  .strict();

export const locksChangedSchema = z
  .object({
    type: z.literal('locks-changed'),
    key: nonEmptyString,
    holder: lockHolderSchema.nullable(),
  })
  .strict();

export const presenceViewSchema = z
  .object({
    objectType: objectTypeSchema,
    nodeId: nonEmptyString,
  })
  .strict();

export const presenceFocusSchema = z
  .object({
    itemId: nonEmptyString,
    columnId: nonEmptyString,
  })
  .strict();

export const presenceStateSchema = z
  .object({
    view: presenceViewSchema.nullable(),
    focus: presenceFocusSchema.nullable(),
    drafting: nonEmptyString.nullable(),
  })
  .strict();

export const presenceBroadcastEntrySchema = z
  .object({
    connectionId: nonEmptyString,
    user: z
      .object({
        userId: nonEmptyString,
        name: trimmedName,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
    state: presenceStateSchema,
  })
  .strict();

export const presenceUpdateMessageSchema = z
  .object({
    type: z.literal('presence-update'),
    view: presenceViewSchema.nullable(),
    focus: presenceFocusSchema.nullable(),
    drafting: nonEmptyString.nullable(),
  })
  .strict();

export const presenceBroadcastMessageSchema = z
  .object({
    type: z.literal('presence'),
    connectionId: nonEmptyString,
    user: z
      .object({
        userId: nonEmptyString,
        name: trimmedName,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
    state: presenceStateSchema,
  })
  .strict();

export const opAckSchema = z
  .object({
    type: z.literal('op-ack'),
    opId: nonEmptyString,
    seq: z.number().int().nonnegative(),
    result: z.unknown().optional(),
  })
  .strict();

export const opRejectedSchema = z
  .object({
    type: z.literal('op-rejected'),
    opId: nonEmptyString,
    code: opRejectCodeSchema,
    message: nonEmptyString,
  })
  .strict();

export const opAppliedSchema = z
  .object({
    type: z.literal('op-applied'),
    seq: z.number().int().nonnegative(),
    op: collabOpSchema,
    result: z.unknown().optional(),
  })
  .strict();

export const opsSinceSchema = z
  .object({
    type: z.literal('ops-since'),
    seq: z.number().int().nonnegative(),
  })
  .strict();

export const opsSinceReplySchema = z
  .object({
    type: z.literal('ops-since-reply'),
    sinceSeq: z.number().int().nonnegative(),
    ops: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          op: collabOpSchema,
          result: z.unknown().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const snapshotSchema = z
  .object({
    type: z.literal('snapshot'),
    seq: z.number().int().nonnegative(),
    workspace: workspaceSchema,
  })
  .strict();

export const roomWelcomeSchema = z
  .object({
    type: z.literal('room-welcome'),
    roomId: nonEmptyString,
    role: roomRoleSchema,
    seq: z.number().int().nonnegative(),
    workspace: workspaceSchema,
    locks: z.record(lockHolderSchema),
    presence: z.array(presenceBroadcastEntrySchema),
    members: z.array(roomMemberInfoSchema),
    autosaveStatus: z
      .object({
        status: z.enum(['autosaved', 'saving']),
        lastAutosavedAt: isoDateTimeSchema.nullable(),
      })
      .strict()
      .optional(),
    lastRevision: revisionMetadataSchema.nullable().optional(),
  })
  .strict();

export const roomNotificationKindSchema = z.enum([
  'user-joined',
  'user-left',
  'role-changed',
  'join-request-created',
  'join-request-reviewed',
  'member-kicked',
  'member-banned',
  'ownership-transferred',
]);

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('op'),
      op: collabOpSchema,
    })
    .strict(),
  opsSinceSchema,
  lockAcquireSchema,
  lockReleaseSchema,
  lockHeartbeatSchema,
  lockForceReleaseSchema,
  presenceUpdateMessageSchema,
  z
    .object({
      type: z.literal('ping'),
      timestamp: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('presence-left'), connectionId: z.string() }).strict(),
  z.object({ type: z.literal('lock-revoked'), key: z.string(), reason: z.string() }).strict(),
  roomWelcomeSchema,
  opAckSchema,
  opRejectedSchema,
  opAppliedSchema,
  opsSinceReplySchema,
  snapshotSchema,
  lockGrantedSchema,
  lockDeniedSchema,
  locksChangedSchema,
  presenceBroadcastMessageSchema,
  z
    .object({
      type: z.literal('room-notification'),
      kind: roomNotificationKindSchema,
      message: nonEmptyString,
      targetUserId: nonEmptyString.optional(),
      newRole: roomRoleSchema.optional(),
      joinRequest: joinRequestSummarySchema.optional(),
      timestamp: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('autosave-status'),
      status: z.enum(['saving', 'autosaved']),
      lastAutosavedAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('revision-saved'),
      revision: revisionMetadataSchema,
      restoredFromId: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('kicked'),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('banned'),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('room-deleted'),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pong'),
      timestamp: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      code: nonEmptyString,
      message: nonEmptyString,
      requestId: nonEmptyString.optional(),
    })
    .strict(),
]);

// --- UDP LAN Discovery Beacon Schema ---

export const discoveryBeaconSchema = z
  .object({
    magic: z.literal(DISCOVERY_BEACON_MAGIC),
    serverId: nonEmptyString,
    name: trimmedName,
    version: nonEmptyString,
    host: nonEmptyString,
    port: z.number().int().min(1).max(65535),
    tls: z.boolean(),
    fingerprint: fingerprintSchema.nullable(),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();
