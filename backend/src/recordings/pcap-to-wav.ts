import { UnprocessableEntityException } from '@nestjs/common';

type Packet = { atMs: number; timestamp: number; payloadType: number; payload: Buffer };
type Stream = { key: string; source: string; packets: Packet[] };

const SAMPLE_RATE = 8000;
const MAX_SECONDS = 30 * 60;

function decodeAlaw(byte: number): number {
  const value = byte ^ 0x55;
  const segment = (value & 0x70) >> 4;
  let sample = ((value & 0x0f) << 4) + 8;
  if (segment >= 1) sample += 0x100;
  if (segment > 1) sample <<= segment - 1;
  return (value & 0x80) ? sample : -sample;
}

function decodeUlaw(byte: number): number {
  const value = ~byte & 0xff;
  const sample = (((value & 0x0f) << 3) + 0x84) << ((value & 0x70) >> 4);
  return (value & 0x80) ? 0x84 - sample : sample - 0x84;
}

function ipv4(buffer: Buffer, offset: number): string {
  return `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
}

export function pcapToWav(pcap: Buffer): Buffer {
  if (pcap.length < 24) throw new UnprocessableEntityException('The capture is empty or incomplete.');
  const magic = pcap.subarray(0, 4).toString('hex');
  const littleEndian = magic === 'd4c3b2a1' || magic === '4d3cb2a1';
  const nano = magic === '4d3cb2a1' || magic === 'a1b23c4d';
  if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) {
    throw new UnprocessableEntityException('Unsupported PCAP format.');
  }
  const u16 = (offset: number) => littleEndian ? pcap.readUInt16LE(offset) : pcap.readUInt16BE(offset);
  const u32 = (offset: number) => littleEndian ? pcap.readUInt32LE(offset) : pcap.readUInt32BE(offset);
  if (u16(4) !== 2) throw new UnprocessableEntityException('Unsupported PCAP version.');
  const linkType = u32(20);
  if (linkType !== 101 && linkType !== 1) {
    throw new UnprocessableEntityException(`Unsupported PCAP link type ${linkType}.`);
  }

  const streams = new Map<string, Stream>();
  const unsupported = new Set<number>();
  let offset = 24;
  while (offset + 16 <= pcap.length) {
    const captured = u32(offset + 8);
    if (captured > pcap.length - offset - 16) {
      throw new UnprocessableEntityException('The capture has an incomplete packet.');
    }
    const frame = offset + 16;
    offset = frame + captured;
    let ip = frame;
    if (linkType === 1) {
      if (captured < 14 || pcap.readUInt16BE(frame + 12) !== 0x0800) continue;
      ip += 14;
    }
    const end = frame + captured;
    if (ip + 20 > end || (pcap[ip] >> 4) !== 4) continue;
    const ihl = (pcap[ip] & 0x0f) * 4;
    if (ihl < 20 || ip + ihl + 8 + 12 > end || pcap[ip + 9] !== 17) continue;
    if (pcap.readUInt16BE(ip + 6) & 0x3fff) continue; // Fragmented IP is not safe to decode independently.
    const udp = ip + ihl;
    const udpLength = pcap.readUInt16BE(udp + 4);
    if (udpLength < 20 || udp + udpLength > end) continue;
    const rtp = udp + 8;
    const rtpEnd = udp + udpLength;
    if ((pcap[rtp] >> 6) !== 2) continue;
    const payloadType = pcap[rtp + 1] & 0x7f;
    if (pcap[rtp + 1] >= 200 && pcap[rtp + 1] <= 204) continue; // RTCP.
    let headerSize = 12 + (pcap[rtp] & 0x0f) * 4;
    if (rtp + headerSize > rtpEnd) continue;
    if (pcap[rtp] & 0x10) {
      if (rtp + headerSize + 4 > rtpEnd) continue;
      headerSize += 4 + pcap.readUInt16BE(rtp + headerSize + 2) * 4;
    }
    if (rtp + headerSize >= rtpEnd) continue;
    const padding = (pcap[rtp] & 0x20) ? pcap[rtpEnd - 1] : 0;
    if (padding > rtpEnd - rtp - headerSize) continue;
    if (payloadType !== 0 && payloadType !== 8) {
      unsupported.add(payloadType);
      continue;
    }
    const source = `${ipv4(pcap, ip + 12)}:${pcap.readUInt16BE(udp)}`;
    const key = `${source}/${pcap.readUInt32BE(rtp + 8)}`;
    let stream = streams.get(key);
    if (!stream) {
      stream = { key, source, packets: [] };
      streams.set(key, stream);
    }
    stream.packets.push({
      atMs: u32(frame - 16) * 1000 + u32(frame - 12) / (nano ? 1_000_000 : 1000),
      timestamp: pcap.readUInt32BE(rtp + 4),
      payloadType,
      payload: pcap.subarray(rtp + headerSize, rtpEnd - padding),
    });
  }
  if (offset !== pcap.length) throw new UnprocessableEntityException('The capture has trailing incomplete data.');
  const ranked = [...streams.values()].sort((a, b) => b.packets.length - a.packets.length);
  if (!ranked.length) {
    throw new UnprocessableEntityException(unsupported.size
      ? `No G.711 audio found. Unsupported RTP payload type(s): ${[...unsupported].join(', ')}.`
      : 'No RTP audio packets found in this capture.');
  }
  const first = ranked[0];
  const second = ranked.find((stream) => stream.source !== first.source);
  const selected = second ? [first, second] : [first];
  const startMs = Math.min(...selected.map((stream) => stream.packets[0].atMs));
  let sampleCount = 0;
  for (const stream of selected) {
    const initial = stream.packets[0];
    for (const packet of stream.packets) {
      const sampleOffset = Math.round((initial.atMs - startMs) * 8) + ((packet.timestamp - initial.timestamp) >>> 0);
      if (sampleOffset < 0 || sampleOffset > MAX_SECONDS * SAMPLE_RATE) continue;
      sampleCount = Math.max(sampleCount, sampleOffset + packet.payload.length);
    }
  }
  if (sampleCount < 1 || sampleCount > MAX_SECONDS * SAMPLE_RATE) {
    throw new UnprocessableEntityException('Recording exceeds the 30-minute playback limit.');
  }
  const channels = selected.map(() => new Int16Array(sampleCount));
  selected.forEach((stream, channel) => {
    const initial = stream.packets[0];
    for (const packet of stream.packets) {
      const sampleOffset = Math.round((initial.atMs - startMs) * 8) + ((packet.timestamp - initial.timestamp) >>> 0);
      if (sampleOffset < 0 || sampleOffset + packet.payload.length > sampleCount) continue;
      for (let i = 0; i < packet.payload.length; i++) {
        channels[channel][sampleOffset + i] = packet.payloadType === 8 ? decodeAlaw(packet.payload[i]) : decodeUlaw(packet.payload[i]);
      }
    }
  });
  // Keep each RTP direction on its own stereo channel for one-way-audio diagnosis.
  const wav = Buffer.allocUnsafe(44 + sampleCount * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(sampleCount * 4, 40);
  for (let i = 0; i < sampleCount; i++) {
    wav.writeInt16LE(channels[0][i], 44 + i * 4);
    wav.writeInt16LE(channels[1]?.[i] ?? 0, 46 + i * 4);
  }
  return wav;
}
