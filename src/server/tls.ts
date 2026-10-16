import {
  X509Certificate,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface GenerateTlsCertOptions {
  commonName?: string;
  organization?: string;
  validDays?: number;
  hostnames?: string[];
  ipAddresses?: string[];
  now?: Date;
}

export interface TlsCertificateBundle {
  certPem: string;
  keyPem: string;
  certDer: Buffer;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  subject: string;
}

export interface ManagedTlsCertificateBundle extends TlsCertificateBundle {
  certPath: string;
  keyPath: string;
  created: boolean;
}

const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION_NAME = '2.5.4.10';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

function encodeDerLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeDerElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function encodeDerSequence(items: Buffer[]): Buffer {
  return encodeDerElement(0x30, Buffer.concat(items));
}

function encodeDerSet(items: Buffer[]): Buffer {
  return encodeDerElement(0x31, Buffer.concat(items));
}

function encodeDerInteger(rawBytes: Buffer): Buffer {
  let start = 0;
  while (start < rawBytes.length - 1 && rawBytes[start] === 0x00) {
    start += 1;
  }
  const trimmed = rawBytes.subarray(start);
  const needsLeadingZero = (trimmed[0]! & 0x80) !== 0;
  const content = needsLeadingZero ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
  return encodeDerElement(0x02, content);
}

function encodeDerSmallInteger(value: number): Buffer {
  return encodeDerElement(0x02, Buffer.from([value & 0xff]));
}

function encodeDerBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return encodeDerElement(0x03, Buffer.concat([Buffer.from([unusedBits & 0x07]), bytes]));
}

function encodeDerOctetString(bytes: Buffer): Buffer {
  return encodeDerElement(0x04, bytes);
}

function encodeDerBoolean(value: boolean): Buffer {
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

function encodeDerNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function encodeDerOid(oid: string): Buffer {
  const parts = oid.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (let i = 2; i < parts.length; i += 1) {
    let value = parts[i]!;
    if (value === 0) {
      out.push(0);
      continue;
    }
    const subid: number[] = [];
    while (value > 0) {
      subid.unshift(value & 0x7f);
      value = Math.floor(value / 128);
    }
    for (let j = 0; j < subid.length - 1; j += 1) {
      out.push(subid[j]! | 0x80);
    }
    out.push(subid[subid.length - 1]!);
  }
  return encodeDerElement(0x06, Buffer.from(out));
}

function encodeDerUtf8String(value: string): Buffer {
  return encodeDerElement(0x0c, Buffer.from(value, 'utf8'));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function encodeDerTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  const seconds = pad2(date.getUTCSeconds());

  if (year >= 1950 && year <= 2049) {
    const yy = pad2(year % 100);
    return encodeDerElement(0x17, Buffer.from(`${yy}${month}${day}${hours}${minutes}${seconds}Z`, 'ascii'));
  }
  return encodeDerElement(0x18, Buffer.from(`${year}${month}${day}${hours}${minutes}${seconds}Z`, 'ascii'));
}

function encodeDistinguishedName(attributes: Array<{ oid: string; value: string }>): Buffer {
  const rdns = attributes.map(attr =>
    encodeDerSet([encodeDerSequence([encodeDerOid(attr.oid), encodeDerUtf8String(attr.value)])]),
  );
  return encodeDerSequence(rdns);
}

function parseIpv4Bytes(ip: string): Buffer | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number.parseInt(part, 10);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return Buffer.from(octets);
}

function encodeExtension(oid: string, critical: boolean, valueDer: Buffer): Buffer {
  const elements: Buffer[] = [encodeDerOid(oid)];
  if (critical) {
    elements.push(encodeDerBoolean(true));
  }
  elements.push(encodeDerOctetString(valueDer));
  return encodeDerSequence(elements);
}

function encodeSubjectAltNameExtension(hostnames: string[], ipAddresses: string[]): Buffer {
  const generalNames: Buffer[] = [];
  const uniqueHosts = Array.from(new Set(hostnames.map(h => h.trim()).filter(Boolean)));
  const uniqueIps = Array.from(new Set(ipAddresses.map(ip => ip.trim()).filter(Boolean)));

  for (const host of uniqueHosts) {
    // dNSName [2] IMPLICIT IA5String (0x82)
    generalNames.push(encodeDerElement(0x82, Buffer.from(host, 'ascii')));
  }
  for (const ip of uniqueIps) {
    const ipv4 = parseIpv4Bytes(ip);
    if (ipv4) {
      // iPAddress [7] IMPLICIT OCTET STRING (0x87)
      generalNames.push(encodeDerElement(0x87, ipv4));
    }
  }

  return encodeExtension(OID_SUBJECT_ALT_NAME, false, encodeDerSequence(generalNames));
}

function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function normalizeFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim().toUpperCase();
  const hexWithoutPrefix = trimmed.startsWith('SHA256:') ? trimmed.slice('SHA256:'.length) : trimmed;
  const cleanHex = hexWithoutPrefix.replace(/[^0-9A-F]/g, '');
  if (cleanHex.length !== 64) {
    throw new Error(`Invalid SHA-256 certificate fingerprint: ${fingerprint}`);
  }
  const pairs = cleanHex.match(/.{2}/g)!;
  return `SHA256:${pairs.join(':')}`;
}

export function computeCertFingerprint(certPemOrDer: string | Buffer | Uint8Array): string {
  const input =
    typeof certPemOrDer === 'string'
      ? certPemOrDer
      : Buffer.isBuffer(certPemOrDer)
        ? certPemOrDer
        : Buffer.from(certPemOrDer);
  const x509 = new X509Certificate(input);
  const sha256Hex = createHash('sha256').update(x509.raw).digest('hex').toUpperCase();
  const colonSeparated = sha256Hex.match(/.{2}/g)!.join(':');
  return `SHA256:${colonSeparated}`;
}

export function fingerprintsMatch(a: string, b: string): boolean {
  try {
    const normA = Buffer.from(normalizeFingerprint(a), 'utf8');
    const normB = Buffer.from(normalizeFingerprint(b), 'utf8');
    if (normA.length !== normB.length) return false;
    return timingSafeEqual(normA, normB);
  } catch {
    return false;
  }
}

export function generateSelfSignedCertificate(options: GenerateTlsCertOptions = {}): TlsCertificateBundle {
  const commonName = options.commonName?.trim() || 'HLR Collaboration Server';
  const organization = options.organization?.trim() || 'HLR Writing Tool';
  const validDays = Math.max(1, options.validDays ?? 3650);
  const now = options.now ?? new Date();

  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

  const hostnames = options.hostnames?.length ? options.hostnames : ['localhost'];
  const ipAddresses = options.ipAddresses?.length ? options.ipAddresses : ['127.0.0.1'];

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const serialBytes = randomBytes(16);
  serialBytes[0] = (serialBytes[0]! & 0x7f) | 0x01;

  const versionV3 = encodeDerElement(0xa0, encodeDerSmallInteger(2));
  const serialNumber = encodeDerInteger(serialBytes);
  const signatureAlgorithm = encodeDerSequence([encodeDerOid(OID_SHA256_WITH_RSA), encodeDerNull()]);

  const name = encodeDistinguishedName([
    { oid: OID_ORGANIZATION_NAME, value: organization },
    { oid: OID_COMMON_NAME, value: commonName },
  ]);

  const validity = encodeDerSequence([encodeDerTime(notBefore), encodeDerTime(notAfter)]);

  // BasicConstraints: CA=FALSE (empty SEQUENCE)
  const basicConstraintsExt = encodeExtension(OID_BASIC_CONSTRAINTS, true, encodeDerSequence([]));
  // KeyUsage: digitalSignature (bit 0) | keyEncipherment (bit 2) -> 0b10100000 = 0xa0, 5 unused bits
  const keyUsageExt = encodeExtension(
    OID_KEY_USAGE,
    true,
    encodeDerBitString(Buffer.from([0xa0]), 5),
  );
  // ExtKeyUsage: serverAuth
  const extKeyUsageExt = encodeExtension(
    OID_EXT_KEY_USAGE,
    false,
    encodeDerSequence([encodeDerOid(OID_SERVER_AUTH)]),
  );
  const sanExt = encodeSubjectAltNameExtension(hostnames, ipAddresses);

  const extensionsWrapper = encodeDerElement(
    0xa3,
    encodeDerSequence([basicConstraintsExt, keyUsageExt, extKeyUsageExt, sanExt]),
  );

  const tbsCertificate = encodeDerSequence([
    versionV3,
    serialNumber,
    signatureAlgorithm,
    name,
    validity,
    name,
    spkiDer,
    extensionsWrapper,
  ]);

  const signatureBytes = sign('sha256', tbsCertificate, privateKey);
  const certDer = encodeDerSequence([
    tbsCertificate,
    signatureAlgorithm,
    encodeDerBitString(signatureBytes, 0),
  ]);

  const certPem = derToPem(certDer, 'CERTIFICATE');
  const x509 = new X509Certificate(certPem);
  const fingerprint = computeCertFingerprint(x509.raw);

  return {
    certPem,
    keyPem,
    certDer: Buffer.from(x509.raw),
    fingerprint,
    notBefore: new Date(x509.validFrom),
    notAfter: new Date(x509.validTo),
    subject: x509.subject,
  };
}

export function ensureServerTlsCertificate(
  dataDir: string,
  options: GenerateTlsCertOptions = {},
): ManagedTlsCertificateBundle {
  const tlsDir = path.join(path.resolve(dataDir), 'tls');
  mkdirSync(tlsDir, { recursive: true });
  if (lstatSync(tlsDir).isSymbolicLink()) {
    throw new Error('TLS directory cannot be a symbolic link');
  }

  const certPath = path.join(tlsDir, 'cert.pem');
  const keyPath = path.join(tlsDir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    if (lstatSync(certPath).isSymbolicLink() || lstatSync(keyPath).isSymbolicLink()) {
      throw new Error('TLS certificate or key file cannot be a symbolic link');
    }
    try {
      const certPem = readFileSync(certPath, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      const x509 = new X509Certificate(certPem);
      const now = options.now ?? new Date();
      const notAfter = new Date(x509.validTo);
      if (notAfter.getTime() > now.getTime()) {
        return {
          certPem,
          keyPem,
          certDer: Buffer.from(x509.raw),
          fingerprint: computeCertFingerprint(x509.raw),
          notBefore: new Date(x509.validFrom),
          notAfter,
          subject: x509.subject,
          certPath,
          keyPath,
          created: false,
        };
      }
    } catch {
      // Regenerate if existing files are corrupted or unparseable
    }
  }

  const generated = generateSelfSignedCertificate(options);
  writeFileSync(certPath, generated.certPem, { encoding: 'utf8', mode: 0o644 });
  writeFileSync(keyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Ignore chmod error on platforms without POSIX mode support
  }

  return {
    ...generated,
    certPath,
    keyPath,
    created: true,
  };
}
