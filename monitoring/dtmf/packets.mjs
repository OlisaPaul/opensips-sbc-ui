import { open } from 'node:fs/promises';

// Bounded, streaming reader. No audio decoding, no full capture loaded into RAM.
export async function* readCapture(file) {
  const h = await open(file, 'r'); let offset = 0, frame = 0, cache = Buffer.alloc(0), cursor = 0;
  async function read(n, allowEOF = false) {
    if (cache.length - cursor >= n) { const b = cache.subarray(cursor, cursor + n); cursor += n; offset += n; return b; }
    const b = Buffer.alloc(n); let filled = 0;
    while (filled < n) {
      if (cursor >= cache.length) {
        const slab = Buffer.alloc(256 * 1024); const r = await h.read(slab, 0, slab.length, offset);
        if (!r.bytesRead) { if (!filled && allowEOF) return null; throw new Error('Truncated capture'); }
        cache = slab.subarray(0, r.bytesRead); cursor = 0;
      }
      const size = Math.min(n - filled, cache.length - cursor);
      cache.copy(b, filled, cursor, cursor + size); cursor += size; offset += size; filled += size;
    }
    return b;
  }
  try {
    const magic = await read(4); const hex = magic.toString('hex');
    if (hex !== '0a0d0d0a') {
      if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(hex)) throw new Error('Unsupported capture format');
      const le = ['d4c3b2a1', '4d3cb2a1'].includes(hex), nano = ['4d3cb2a1', 'a1b23c4d'].includes(hex);
      const u32 = (b, p) => le ? b.readUInt32LE(p) : b.readUInt32BE(p);
      const global = await read(20), link = u32(global, 16) & 0xffff;
      for (;;) {
        const head = await read(16, true); if (!head) break;
        const length = u32(head, 8); if (length > 1024 * 1024) throw new Error('Oversized capture packet');
        yield { frame: ++frame, at: u32(head, 0) + u32(head, 4) / (nano ? 1e9 : 1e6), link, data: await read(length) };
      }
      return;
    }
    offset = 0; cache = Buffer.alloc(0); cursor = 0; let le = true, interfaces = [];
    for (;;) {
      const head = await read(12, true); if (!head) break;
      const section = head.readUInt32LE(0) === 0x0a0d0d0a;
      if (section) {
        const bom = head.subarray(8, 12).toString('hex');
        if (!['4d3c2b1a', '1a2b3c4d'].includes(bom)) throw new Error('Invalid PCAPNG byte order');
        le = bom === '4d3c2b1a'; interfaces = [];
      }
      const u32 = (b, p) => le ? b.readUInt32LE(p) : b.readUInt32BE(p);
      const u16 = (b, p) => le ? b.readUInt16LE(p) : b.readUInt16BE(p);
      const length = u32(head, 4), type = u32(head, 0);
      if (length < 12 || length % 4 || length > 1024 * 1024) throw new Error('Invalid/oversized PCAPNG block');
      const b = Buffer.concat([head, await read(length - 12)]);
      if (u32(b, length - 4) !== length) throw new Error('Invalid PCAPNG block trailer');
      if (type === 1) {
        if (length < 20 || interfaces.length >= 64) throw new Error('Invalid capture interface');
        let resolution = 1e-6, timestampOffset = 0;
        for (let p = 16; p + 4 <= length - 4;) {
          const code = u16(b, p), n = u16(b, p + 2); if (p + 4 + n > length - 4) throw new Error('Invalid interface option');
          if (!code) break;
          if (code === 9 && n === 1) resolution = b[p + 4] & 128 ? 2 ** -(b[p + 4] & 127) : 10 ** -b[p + 4];
          if (code === 14 && n === 8) timestampOffset = Number(le ? b.readBigInt64LE(p + 4) : b.readBigInt64BE(p + 4));
          p += 4 + Math.ceil(n / 4) * 4;
        }
        interfaces.push({ link: u16(b, 8), resolution, timestampOffset });
      } else if (type === 6) {
        if (length < 32) throw new Error('Invalid packet block');
        const inf = interfaces[u32(b, 8)], cap = u32(b, 20);
        if (!inf || cap > length - 32) throw new Error('Invalid captured length/interface');
        yield { frame: ++frame, at: (u32(b, 12) * 4294967296 + u32(b, 16)) * inf.resolution + inf.timestampOffset,
          link: inf.link, data: b.subarray(28, 28 + cap) };
      } else if (type === 5) {
        if (length < 24) throw new Error('Invalid interface statistics');
        let dropped = 0;
        for (let p = 20; p + 4 <= length - 4;) {
          const code = u16(b, p), n = u16(b, p + 2);
          if (p + 4 + n > length - 4) throw new Error('Invalid capture statistics option');
          if (!code) break;
          if ([5, 7].includes(code) && n === 8) dropped += Number(le ? b.readBigUInt64LE(p + 4) : b.readBigUInt64BE(p + 4));
          p += 4 + Math.ceil(n / 4) * 4;
        }
        yield { statistics: true, dropped };
      }
    }
  } finally { await h.close(); }
}

export function decodeUDP(packet) {
  const b = packet.data; let p = 0, eth;
  if (packet.link === 1) {
    if (b.length < 14) return null; eth = b.readUInt16BE(12); p = 14;
    while ([0x8100, 0x88a8].includes(eth)) { if (p + 4 > b.length) return null; eth = b.readUInt16BE(p + 2); p += 4; }
  } else if (packet.link === 113) { if (b.length < 16) return null; eth = b.readUInt16BE(14); p = 16; }
  else if (packet.link === 276) { if (b.length < 20) return null; eth = b.readUInt16BE(0); p = 20; }
  else if (![101, 228].includes(packet.link)) return { unsupportedLink: true };
  if (eth !== undefined && eth !== 0x0800) return null; // IPv4 MVP; IPv6 is intentionally not inferred.
  if (p + 20 > b.length || b[p] >> 4 !== 4 || b[p + 9] !== 17) return null;
  const start = p, ihl = (b[p] & 15) * 4, length = b.readUInt16BE(p + 2);
  if (ihl < 20 || length < ihl + 8 || p + ihl + 8 > b.length) return null;
  if (start + length > b.length) return { truncated: true };
  if (b.readUInt16BE(p + 6) & 0x3fff) return { fragmented: true };
  const src = [...b.subarray(p + 12, p + 16)].join('.'), dst = [...b.subarray(p + 16, p + 20)].join('.');
  p += ihl; const sp = b.readUInt16BE(p), dp = b.readUInt16BE(p + 2), n = b.readUInt16BE(p + 4);
  if (n < 8 || n > length - ihl || p + n > b.length) return { truncated: true };
  return { ...packet, src, dst, sp, dp, payload: b.subarray(p + 8, p + n), rawIP: b.subarray(start, start + length) };
}

export function decodeEvent(payload, payloadTypes) {
  if (payload.length < 16 || payload[0] >> 6 !== 2 || !payloadTypes.has(payload[1] & 127)) return null;
  let p = 12 + (payload[0] & 15) * 4;
  if (p > payload.length) return null;
  if (payload[0] & 16) { if (p + 4 > payload.length) return null; p += 4 + payload.readUInt16BE(p + 2) * 4; }
  const padding = payload[0] & 32 ? payload.at(-1) : 0;
  if ((payload[0] & 32) && (!padding || padding > payload.length - p)) return null;
  // RFC4733 basic DTMF events only; no heuristic decoding of arbitrary audio.
  if (payload.length - padding - p !== 4 || payload[p] > 15) return null;
  return { ssrc: `0x${payload.readUInt32BE(8).toString(16).padStart(8, '0')}`,
    timestamp: payload.readUInt32BE(4), sequence: payload.readUInt16BE(2),
    digit: '0123456789*#ABCD'[payload[p]], duration: payload.readUInt16BE(p + 2),
    end: Boolean(payload[p + 1] & 128), payloadType: payload[1] & 127 };
}

export function encodePcap(packets) {
  const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16); header.writeUInt32LE(101, 20); // Raw IP, independent of original interface.
  return Buffer.concat([header, ...packets.flatMap(p => {
    const h = Buffer.alloc(16), sec = Math.floor(p.at);
    h.writeUInt32LE(sec, 0); h.writeUInt32LE(Math.min(999999, Math.round((p.at - sec) * 1e6)), 4);
    h.writeUInt32LE(p.data.length, 8); h.writeUInt32LE(p.data.length, 12); return [h, p.data];
  })]);
}
