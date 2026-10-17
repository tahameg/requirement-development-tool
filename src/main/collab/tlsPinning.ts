import tls from 'node:tls';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
export function serverAddress(raw: string): string {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter a server address, such as https://192.168.1.20:8443');
  return url.origin;
}
export function fingerprint(raw: Buffer) { return `SHA256:${new X509Certificate(raw).fingerprint256}`; }
export class TlsPinning {
  private pins: Record<string, string>;
  constructor(private filename: string) { this.pins = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {}; }
  remembered() { return Object.keys(this.pins); }
  get(address: string) { return this.pins[serverAddress(address)]; }
  trust(address: string, value: string) {
    if (!/^SHA256:(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value)) throw new Error('Invalid fingerprint');
    this.pins[serverAddress(address)] = value;
    mkdirSync(path.dirname(this.filename), { recursive: true });
    writeFileSync(this.filename + '.tmp', JSON.stringify(this.pins, null, 2), { mode: 0o600 });
    renameSync(this.filename + '.tmp', this.filename);
  }
  async probe(address: string): Promise<string | null> {
    const url = new URL(serverAddress(address)); if (url.protocol === 'http:') return null;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }, () => {
        try { resolve(fingerprint(socket.getPeerCertificate().raw)); } catch (e) { reject(e); } finally { socket.destroy(); }
      });
      socket.setTimeout(10000, () => socket.destroy(new Error('Server connection timed out')));
      socket.once('error', reject);
    });
  }
  agent(address: string) {
    const url = new URL(serverAddress(address));
    const expected = this.get(address); if (!expected) throw new Error('Trust the server certificate before signing in');
    const agent = new https.Agent({ keepAlive: false }) as https.Agent & { createConnection: (options: tls.ConnectionOptions, callback: (error: Error | null, socket?: tls.TLSSocket) => void) => undefined };
    // Do not return a socket until its certificate is pinned: no credentials are sent before verification.
    agent.createConnection = ((options: tls.ConnectionOptions, callback: (error: Error | null, socket?: tls.TLSSocket) => void) => {
      let finished = false;
      const done = (error: Error | null, socket?: tls.TLSSocket) => { if (!finished) { finished = true; callback(error, socket); } };
      const socket = tls.connect({ ...options, host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }, () => {
        if (fingerprint(socket.getPeerCertificate().raw) !== expected) { const error = new Error('Server certificate changed. Reconnect and review its fingerprint.'); done(error); socket.destroy(); }
        else { socket.setTimeout(0); done(null, socket); }
      });
      socket.setTimeout(10000, () => socket.destroy(new Error('TLS handshake timed out')));
      socket.once('error', error => done(error));
      return undefined;
    }) as typeof agent.createConnection;
    return agent;
  }
}
