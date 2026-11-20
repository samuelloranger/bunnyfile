import { createHash, type Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';

/** The flexible-checksum algorithms S3 accepts in `x-amz-checksum-*`. */
export const CHECKSUM_ALGORITHMS = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export function isChecksumAlgorithm(name: string): name is ChecksumAlgorithm {
  return (CHECKSUM_ALGORITHMS as readonly string[]).includes(name);
}

export interface Checksum {
  update(data: Uint8Array): void;
  /** Base64 of the big-endian digest, as S3 sends it in headers and trailers. */
  digestBase64(): string;
}

function reflectedTable32(poly: number): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32C_TABLE = reflectedTable32(0x82f63b78);

// CRC-64/NVME (reflected poly 0x9a6c9329ac4bc9b5) split into 32-bit halves so
// the per-byte loop stays in fast integer math instead of BigInt.
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
{
  const polyLo = 0xac4bc9b5;
  const polyHi = 0x9a6c9329;
  for (let i = 0; i < 256; i++) {
    let lo = i;
    let hi = 0;
    for (let k = 0; k < 8; k++) {
      const lsb = lo & 1;
      lo = ((lo >>> 1) | (hi << 31)) >>> 0;
      hi = hi >>> 1;
      if (lsb) {
        lo = (lo ^ polyLo) >>> 0;
        hi = (hi ^ polyHi) >>> 0;
      }
    }
    CRC64_LO[i] = lo;
    CRC64_HI[i] = hi;
  }
}

function u32be(...words: number[]): string {
  const out = Buffer.alloc(words.length * 4);
  for (const [i, w] of words.entries()) out.writeUInt32BE(w >>> 0, i * 4);
  return out.toString('base64');
}

class Crc32 implements Checksum {
  private value = 0;
  update(data: Uint8Array) {
    this.value = crc32(data, this.value);
  }
  digestBase64() {
    return u32be(this.value);
  }
}

class Crc32c implements Checksum {
  private value = 0xffffffff;
  update(data: Uint8Array) {
    let c = this.value;
    for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    this.value = c;
  }
  digestBase64() {
    return u32be(~this.value);
  }
}

class Crc64Nvme implements Checksum {
  private lo = 0xffffffff;
  private hi = 0xffffffff;
  update(data: Uint8Array) {
    let lo = this.lo;
    let hi = this.hi;
    for (let i = 0; i < data.length; i++) {
      const idx = (lo ^ data[i]!) & 0xff;
      lo = ((lo >>> 8) | (hi << 24)) ^ CRC64_LO[idx]!;
      hi = (hi >>> 8) ^ CRC64_HI[idx]!;
    }
    this.lo = lo;
    this.hi = hi;
  }
  digestBase64() {
    return u32be(~this.hi, ~this.lo);
  }
}

class NodeHash implements Checksum {
  private hash: Hash;
  constructor(algorithm: string) {
    this.hash = createHash(algorithm);
  }
  update(data: Uint8Array) {
    this.hash.update(data);
  }
  digestBase64() {
    return this.hash.digest('base64');
  }
}

export function createChecksum(algorithm: ChecksumAlgorithm | 'md5'): Checksum {
  switch (algorithm) {
    case 'md5':
      return new NodeHash('md5');
    case 'crc32':
      return new Crc32();
    case 'crc32c':
      return new Crc32c();
    case 'crc64nvme':
      return new Crc64Nvme();
    case 'sha1':
      return new NodeHash('sha1');
    case 'sha256':
      return new NodeHash('sha256');
  }
}
