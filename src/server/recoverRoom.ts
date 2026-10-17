import { validateWorkspace } from '../main/services/validation.js';
import { collabOpSchema } from '../shared/collab/protocol.js';
import { CollabServiceError } from './errors.js';
import { applyWorkspaceOp, type OpResult } from './opEngine.js';
import type { ServerStore } from './store/types.js';

/** Lock the room while reading the snapshot and log, so they represent one committed head. */
export async function recoverRoom(store: ServerStore, roomId: string) {
  return store.transaction(async tx => {
    const room = await tx.rooms.lockForUpdate(roomId);
    if (!room) throw new CollabServiceError('NOT_FOUND', 'Room not found');
    const snapshot = await tx.snapshots.getLatest(roomId);
    if (!snapshot) throw new Error('Room snapshot is missing');
    let workspace = validateWorkspace(snapshot.workspace);
    let seq = snapshot.seq;
    if (seq > room.head_seq) throw new Error('Snapshot exceeds room head');
    while (seq < room.head_seq) {
      const rows = await tx.ops.listSince(roomId, seq);
      if (!rows.length) throw new Error('Room operation log is incomplete');
      for (const row of rows) {
        if (row.seq !== seq + 1 || row.seq > room.head_seq) throw new Error('Room operation log has a gap');
        const op = collabOpSchema.parse({ opId: row.op_id, kind: row.kind, payload: row.payload });
        workspace = applyWorkspaceOp(workspace, op, row.result as OpResult).workspace;
        seq = row.seq;
      }
    }
    return { workspace, seq, lastAutosavedAt: room.last_autosaved_at };
  });
}
