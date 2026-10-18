import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import { TlsPinning, serverAddress } from './tlsPinning.js';
import { DraftStore } from './draftStore.js';
import { DiscoveryClient } from './discoveryClient.js';
import { wsServerMessageSchema } from '../../shared/collab/protocol.js';
import { COLLAB_PROTOCOL_VERSION, type CollabOp, type ServerPublicInfo, type WsClientMessage, type WsServerMessage } from '../../shared/collab/types.js';
import type { CollabState, RoomDraft } from '../../shared/collab/client.js';
import type { Item, Workspace } from '../../shared/types/workspace.js';
import { applyWorkspaceOp, type OpResult } from '../../server/opEngine.js';

export class CollabClient extends EventEmitter {
  readonly pins: TlsPinning;
  private drafts: DraftStore;
  private discovery = new DiscoveryClient();
  private token: string | null = null;
  private socket: WebSocket | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retries = 0;
  private lastPong = Date.now();
  private generation = 0;
  private held = new Set<string>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private value: CollabState = { address: null, server: null, user: null, connection: 'offline', roomId: null, role: null, workspace: null, seq: 0, sessionKey: null, connectionId: null, settingsChange: null, locks: {}, presence: [], draft: null, notice: '', autosave: '', discovered: [], remembered: [] };
  constructor(root: string) {
    super(); this.pins = new TlsPinning(path.join(root, 'servers.json')); this.drafts = new DraftStore(path.join(root, 'collab-cache'));
    this.value.remembered = this.pins.remembered();
    this.discovery.on('servers', discovered => { this.value.discovered = discovered; this.publish(); });
    this.discovery.on('error', error => { this.value.notice = `Discovery unavailable: ${error.message}. Enter an address manually.`; this.publish(); });
  }
  state() { return structuredClone(this.value); }
  private publish() { this.emit('state', this.state()); }
  async discover() { await this.discovery.start(); return this.state(); }
  async probe(address: string) { address = serverAddress(address); return { address, fingerprint: await this.pins.probe(address), previous: this.pins.get(address) ?? null }; }
  async connect(address: string, pin: string | null, allowHttp = false) {
    address = serverAddress(address);
    if (address.startsWith('http:') && !allowHttp) throw new Error('Plain HTTP must be explicitly allowed');
    const observed = await this.pins.probe(address);
    if (observed !== pin) throw new Error('The certificate changed during confirmation. Review it again.');
    this.disconnect();
    if (pin) this.pins.trust(address, pin);
    this.value.address = address; this.value.remembered = this.pins.remembered();
    const server = (await this.request('GET', '/api/server/public')).server as ServerPublicInfo;
    if (server.protocolVersion !== COLLAB_PROTOCOL_VERSION) { this.value.address = null; throw new Error(`This server speaks collaboration protocol ${server.protocolVersion ?? 1}; this app needs ${COLLAB_PROTOCOL_VERSION}. Install the same HLR version on the server and desktop.`); }
    this.value.server = server; this.publish(); return this.state();
  }
  async request(method: string, route: string, body?: unknown): Promise<any> {
    if (!this.value.address) throw new Error('Connect to a server first');
    if (!/^\/api\/[A-Za-z0-9/_?=&.%+-]+$/.test(route) || route.includes('..') || route.includes('://')) throw new Error('Invalid API route');
    const url = new URL(route, this.value.address);
    if (url.origin !== this.value.address) throw new Error('Invalid server origin');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, { method,
        agent: url.protocol === 'https:' ? this.pins.agent(this.value.address!) : false,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) res.destroy(new Error('Response is too large')); else chunks.push(chunk); });
        res.once('error', reject); res.on('end', () => { try { const json = JSON.parse(Buffer.concat(chunks).toString()); if (!json.ok) throw new Error(json.error || 'Server request failed'); resolve(json.value); } catch (error) { reject(error); } });
      });
      req.setTimeout(15000, () => req.destroy(new Error('Request timed out'))); req.once('error', reject); req.end(payload);
    });
  }
  async auth(method: 'login' | 'register' | 'setup', body: unknown) {
    const result = await this.request('POST', `/api/auth/${method}`, body);
    if (result.token) { this.token = result.token; this.value.user = result.user; this.value.notice = ''; }
    else this.value.notice = 'Your account is awaiting administrator approval.';
    this.publish(); return this.state();
  }
  async join(roomId: string) {
    if (!this.token || !this.value.address) throw new Error('Sign in first');
    this.leave(); this.value.roomId = roomId;
    this.value.draft = this.drafts.load(this.value.address + ':' + this.value.user!.id, roomId);
    this.value.connection = 'connecting'; this.openSocket(); this.publish();
    return this.state();
  }
  private openSocket() {
    const generation = ++this.generation;
    const url = `${this.value.address!.replace(/^http/, 'ws')}/ws/rooms/${encodeURIComponent(this.value.roomId!)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` }, agent: this.value.address!.startsWith('https:') ? this.pins.agent(this.value.address!) : undefined });
    this.socket = ws;
    ws.on('message', data => { if (generation !== this.generation) return; try { this.receive(wsServerMessageSchema.parse(JSON.parse(data.toString()))); } catch (error) { this.value.notice = String(error); this.publish(); } });
    ws.on('error', error => { if (generation === this.generation) { this.value.notice = error.message; this.publish(); } });
    ws.on('close', code => {
      if (generation !== this.generation) return;
      this.rejectPending('Connection lost; your draft is preserved.');
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.value.connection = code >= 4400 ? 'offline' : 'reconnecting'; this.publish();
      if (code < 4400 && this.value.roomId) this.timer = setTimeout(() => this.openSocket(), Math.min(500 * 2 ** this.retries++, 5000));
    });
  }
  private send(message: WsClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Room is disconnected. Your draft is preserved.');
    this.socket.send(JSON.stringify(message));
  }
  private wait(key: string, send: () => void): Promise<unknown> {
    if (this.pending.has(key)) return Promise.reject(new Error('Request is already pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('Server response timed out')); }, 15000);
      this.pending.set(key, { resolve, reject, timer });
      try { send(); } catch (error) { clearTimeout(timer); this.pending.delete(key); reject(error); }
    });
  }
  private settle(key: string, value: unknown, error?: string) { const pending = this.pending.get(key); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(key); error ? pending.reject(new Error(error)) : pending.resolve(value); }
  private rejectPending(message: string) { for (const key of this.pending.keys()) this.settle(key, null, message); }
  async sendOp(op: CollabOp) { if (this.value.connection !== 'connected') throw new Error('Room is read-only until reconnected'); return this.wait(op.opId, () => this.send({ type: 'op', op })); }
  async lock(kind: 'acquire' | 'release' | 'force-release', key: string) {
    if (kind === 'acquire') return this.wait(`lock:${key}`, () => this.send({ type: 'lock-acquire', key }));
    if (kind === 'release') this.held.delete(key);
    this.send({ type: kind === 'release' ? 'lock-release' : 'lock-force-release', key });
  }
  presence(state: Extract<WsClientMessage, { type: 'presence-update' }>) { if (this.value.connection === 'connected') this.send(state); }
  setDraft(draft: RoomDraft | null) {
    if (!this.value.address || !this.value.roomId) throw new Error('No room open');
    this.drafts.save(this.value.address + ':' + this.value.user!.id, this.value.roomId, draft); this.value.draft = draft; this.publish();
  }
  private apply(seq: number, op: CollabOp, result: unknown) {
    if (seq <= this.value.seq) return;
    if (seq !== this.value.seq + 1 || !this.value.workspace) { this.send({ type: 'ops-since', seq: this.value.seq }); return; }
    const before = this.value.workspace.config;
    this.value.workspace = applyWorkspaceOp(this.value.workspace, op, result as OpResult).workspace; this.value.seq = seq;
    if (op.kind === 'config.update' || op.kind === 'room.restore') this.reconcileSettings(before);
  }
  private mine(key: string) { return !!this.value.sessionKey && this.value.locks[key]?.sessionKey === this.value.sessionKey; }
  /** Columns may vanish while a draft is open; drop their values instead of failing the next save. */
  private reconcileSettings(before: Workspace['config']) {
    const after = this.value.workspace!.config;
    const names = (config: Workspace['config']) => new Map(Object.values(config.objectTypes).flatMap(o => o.columns.map(c => [c.id, c.name] as const)));
    const was = names(before), now = names(after);
    const columnsAdded = [...now].filter(([id]) => !was.has(id)).map(([, name]) => name);
    const columnsRemoved = [...was].filter(([id]) => !now.has(id)).map(([, name]) => name);
    const draftValuesDropped: string[] = [];
    const draft = this.value.draft;
    if (draft && draft.kind !== 'description') {
      const valid = new Set(after.objectTypes[draft.objectType].columns.map(c => c.id));
      const keep = (values: Item['values']) => Object.fromEntries(Object.entries(values).filter(([id]) => valid.has(id)));
      draftValuesDropped.push(...Object.keys(draft.values).filter(id => !valid.has(id)).map(id => was.get(id) ?? id));
      if (draftValuesDropped.length) this.setDraft({ ...draft, values: keep(draft.values), baseValues: keep(draft.baseValues) });
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) this.value.settingsChange = { columnsAdded, columnsRemoved, draftValuesDropped };
  }
  ackSettingsChange() { this.value.settingsChange = null; this.publish(); }
  private receive(message: WsServerMessage) {
    switch (message.type) {
      case 'room-welcome':
        this.value = { ...this.value, roomId: message.roomId, role: message.role, workspace: message.workspace, seq: message.seq, sessionKey: message.sessionKey, connectionId: message.connectionId, locks: message.locks, presence: message.presence, connection: 'connected', notice: '' };
        this.retries = 0; this.lastPong = Date.now();
        this.held = new Set([...this.held].filter(k => message.locks[k]?.sessionKey === message.sessionKey));
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => { if (Date.now() - this.lastPong > 30000) { this.socket?.terminate(); return; } if (this.socket?.readyState === WebSocket.OPEN) { this.send({ type: 'ping', timestamp: Date.now() }); for (const key of this.held) this.send({ type: 'lock-heartbeat', key }); } }, 10000);
        void this.reconcileDraft(); break;
      case 'op-applied': this.apply(message.seq, message.op, message.result); break;
      case 'ops-since-reply': for (const entry of message.ops) this.apply(entry.seq, entry.op, entry.result); break;
      case 'snapshot': this.value.workspace = message.workspace; this.value.seq = message.seq; break;
      case 'op-ack': { const id = (message.result as OpResult | undefined)?.createdId; if (id && this.mine(`item:${id}`)) this.held.add(`item:${id}`); this.settle(message.opId, message); break; }
      case 'op-rejected': this.settle(message.opId, null, message.message); break;
      case 'lock-granted': this.held.add(message.key); this.settle(`lock:${message.key}`, message); break;
      case 'lock-denied': this.settle(`lock:${message.key}`, null, `Being edited by ${message.holder.name}`); break;
      case 'locks-changed': if (message.holder) this.value.locks[message.key] = message.holder; else { delete this.value.locks[message.key]; this.held.delete(message.key); } break;
      case 'lock-revoked': this.held.delete(message.key); this.value.notice = message.reason; if (this.value.draft) this.setDraft({ ...this.value.draft, conflict: message.reason }); break;
      case 'presence': this.value.presence = [...this.value.presence.filter(p => p.connectionId !== message.connectionId), message]; break;
      case 'presence-left': this.value.presence = this.value.presence.filter(p => p.connectionId !== message.connectionId); break;
      case 'pong': this.lastPong = Date.now(); break;
      case 'autosave-status': this.value.autosave = message.status === 'autosaved' ? `Autosaved ${message.lastAutosavedAt}` : 'Saving…'; break;
      case 'room-notification': this.value.notice = message.message; if (message.targetUserId === this.value.user?.id && message.newRole) { this.value.role = message.newRole; if (message.newRole === 'VIEWER' && this.value.draft) this.setDraft({ ...this.value.draft, conflict: 'Your role is now read-only. Your draft is preserved for copying.' }); } break;
      case 'revision-saved': this.value.notice = `Revision saved: ${message.revision.message}`; break;
      case 'kicked': case 'banned': case 'room-deleted': this.value.notice = message.reason; this.value.connection = 'offline'; ++this.generation; this.socket?.close(); this.rejectPending(message.reason); if (this.heartbeat) clearInterval(this.heartbeat); break;
      case 'error': this.value.notice = message.message; if (message.requestId) this.settle(message.requestId, null, message.message); break;
    }
    this.publish();
  }
  private async reconcileDraft() {
    const draft = this.value.draft; if (!draft || draft.conflict) return;
    if (draft.kind === 'description') {
      const fn = this.value.workspace?.domains[draft.objectType].requirementSets.find(f => f.requirementSetId === draft.requirementSetId);
      const key = `rs-desc:${draft.requirementSetId}`;
      if (fn?.description === draft.values.description) { this.setDraft(null); return; }
      if (!fn || fn.description !== draft.baseValues.description || !this.mine(key)) { this.setDraft({ ...draft, conflict: 'The requirement set scope changed or its lock was lost. Review your preserved scope.' }); return; }
      try { await this.lock('acquire', key); await this.sendOp({ opId: randomUUID(), kind: 'requirementSet.description', payload: { objectType: draft.objectType, requirementSetId: draft.requirementSetId, description: String(draft.values.description) } }); if (this.value.draft === draft) this.setDraft(null); }
      catch (error) { this.setDraft({ ...draft, conflict: String(error) }); }
      return;
    }
    if (!draft.itemId) return;
    const item = this.value.workspace?.domains[draft.objectType].requirementSets.find(f => f.requirementSetId === draft.requirementSetId)?.items.find(i => i.id === draft.itemId);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (item && Object.entries(draft.values).every(([k,v]) => same(item.values[k],v))) { this.setDraft(null); return; }
    if (!item || !Object.entries(draft.baseValues).every(([k,v]) => same(item.values[k],v)) || !this.mine(`item:${draft.itemId}`)) {
      this.setDraft({ ...draft, conflict: item ? 'The row changed or your edit lock was lost. Review before reapplying.' : 'This row was deleted. Copy your draft before dismissing it.' }); return;
    }
    try {
      await this.lock('acquire', `item:${draft.itemId}`);
      await this.sendOp({ opId: randomUUID(), kind: 'item.edit', payload: { objectType: draft.objectType, requirementSetId: draft.requirementSetId, itemId: draft.itemId, values: draft.values } });
      if (this.value.draft === draft) this.setDraft(null);
    } catch (error) { this.setDraft({ ...draft, conflict: String(error) }); }
  }
  leave() { ++this.generation; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); for (const key of this.held) if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'lock-release', key }); this.held.clear(); this.socket?.close(); this.socket = null; this.rejectPending('Room closed'); this.value = { ...this.value, roomId: null, workspace: null, role: null, seq: 0, sessionKey: null, connectionId: null, settingsChange: null, locks: {}, presence: [], draft: null, connection: 'offline' }; this.publish(); }
  async logout() { try { if (this.token) await this.request('POST', '/api/auth/logout', {}); } finally { this.disconnect(); } }
  disconnect() { this.leave(); this.token = null; this.value.user = null; this.value.server = null; this.value.address = null; this.publish(); }
  close() { this.disconnect(); void this.discovery.stop(); }
}
