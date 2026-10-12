import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Analyzer } from './analyzer.mjs';
import { defaults, validateConfig, networkMatcher, captureFilter } from './config.mjs';
import { readCapture, decodeUDP, encodePcap } from './packets.mjs';
import { Storage } from './storage.mjs';

const BASE = 1791611350;
const config = extra => validateConfig({ ...defaults, providerNetworks: ['192.0.2.0/24'], sbcAddresses: ['198.51.100.10'],
  inputDir: path.resolve('.dtmf-test-output/input'), outputDir: path.resolve('.dtmf-test-output/results'), ...extra });
function udp(payload, src = '192.0.2.20', sp = 13016, dst = '198.51.100.10', dp = 13986) {
  const b = Buffer.alloc(28 + payload.length); b[0] = 0x45; b.writeUInt16BE(b.length, 2); b[8] = 64; b[9] = 17;
  src.split('.').forEach((v, i) => b[12 + i] = +v); dst.split('.').forEach((v, i) => b[16 + i] = +v);
  b.writeUInt16BE(sp, 20); b.writeUInt16BE(dp, 22); b.writeUInt16BE(payload.length + 8, 24); payload.copy(b, 28); return b;
}
function invite(cid = 'test-call@example', at = BASE - 1) {
  const text = `INVITE sip:08029002900@198.51.100.10 SIP/2.0\r\nCall-ID: ${cid}\r\nFrom: <sip:08036396757@example>\r\nTo: <sip:08029002900@example>\r\nContent-Type: application/sdp\r\n\r\nv=0\r\nc=IN IP4 192.0.2.20\r\nm=audio 13016 RTP/AVP 8 116\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:116 telephone-event/8000\r\n`;
  return { at, link: 101, data: udp(Buffer.from(text), '192.0.2.20', 5060, '198.51.100.10', 5060) };
}
function event(digit, ssrc, at, timestamp, end = false, seq = 1, overrides = {}) {
  const b = Buffer.alloc(16); b[0] = 0x80; b[1] = overrides.pt ?? 116;
  b.writeUInt16BE(seq, 2); b.writeUInt32BE(timestamp, 4); b.writeUInt32BE(ssrc, 8);
  b[12] = digit; b[13] = (end ? 128 : 0) | 9; b.writeUInt16BE(end ? 800 : 160, 14);
  return { at, link: 101, data: udp(b, overrides.src, overrides.sp, overrides.dst, overrides.dp) };
}
function setup(extra = {}) { const alerts = []; return { alerts, analyzer: new Analyzer(config(extra), async (a, p) => alerts.push({ ...a, packets: p })) }; }

test('normal repeats and legitimate 1122# in one SSRC are not duplicate digits', async () => {
  const { analyzer, alerts } = setup(); await analyzer.packet(invite(), 'a.pcap');
  let i = 0; for (const digit of [1, 1, 2, 2, 11]) {
    const at = BASE + i, ts = 10000 + i * 8000;
    for (let n = 0; n < 4; n++) await analyzer.packet(event(digit, 1, at + n * .02, ts, n > 0, n + 1), 'a.pcap'); i++;
  }
  assert.equal(analyzer.stats.events, 5); assert.equal(alerts.length, 0);
});

test('three matching cross-SSRC events alert once and evidence contains no audio', async () => {
  const { analyzer, alerts } = setup(); await analyzer.packet(invite(), 'a.pcap');
  for (let i = 0; i < 4; i++) {
    await analyzer.packet(event(i, 0xcad6a8bb, BASE + i, 1000 + i * 8000), 'a.pcap');
    await analyzer.packet(event(i, 0xeea865ae, BASE + i + .2, 90000 + i * 8000), 'b.pcap');
  }
  assert.equal(alerts.length, 1); assert.equal(alerts[0].sequence, '[redacted]');
  assert.deepEqual(alerts[0].delaysMs, [200, 200, 200]); assert.equal(alerts[0].callId, 'test-call@example');
  assert.equal(alerts[0].packets.length, 7);
});

test('unrelated digits, SSRC handover, and events outside delay window are not flagged', async () => {
  for (const mode of ['different', 'handover', 'late']) {
    const { analyzer, alerts } = setup(); await analyzer.packet(invite(), 'a');
    for (let i = 0; i < 3; i++) await analyzer.packet(event(i, 1, BASE + i, 1000 + i * 8000), 'a');
    for (let i = 0; i < 3; i++) await analyzer.packet(event(mode === 'different' ? 5 + i : i, 2,
      BASE + i + (mode === 'different' ? .2 : 10), 90000 + i * 8000), 'b');
    assert.equal(alerts.length, 0, mode);
  }
});

test('forwarded leg, unnegotiated payload and calls missing setup cannot produce provider alerts', async () => {
  const { analyzer, alerts } = setup();
  await analyzer.packet(event(1, 1, BASE, 1000), 'a'); assert.equal(analyzer.stats.events, 0);
  await analyzer.packet(invite(), 'a');
  for (let i = 0; i < 3; i++) {
    await analyzer.packet(event(i, 1, BASE + i, 1000 + i), 'a');
    await analyzer.packet(event(i, 2, BASE + i + .2, 9000 + i, false, 1, { src: '198.51.100.10', dst: '10.0.0.1' }), 'a');
    await analyzer.packet(event(i, 3, BASE + i + .2, 9000 + i, false, 1, { pt: 8 }), 'a');
  }
  assert.equal(alerts.length, 0); assert.equal(analyzer.stats.events, 3);
});

test('memory state is bounded; capacity and ambiguous endpoint reuse are observable', async () => {
  const { analyzer } = setup({ maxCalls: 2, maxEventsPerStream: 3 });
  await analyzer.packet(invite('first'), 'a');
  for (let i = 0; i < 10; i++) await analyzer.packet(event(i % 10, 1, BASE + i, i * 8000), 'a');
  assert.equal([...analyzer.calls.values()][0].streams.values().next().value.events.size, 3);
  await analyzer.packet(invite('second', BASE + 10), 'a'); await analyzer.packet(invite('third', BASE + 11), 'a');
  assert.equal(analyzer.calls.size, 2); assert.equal(analyzer.stats.evictedCalls, 1);
  const before = analyzer.stats.events; await analyzer.packet(event(1, 1, BASE + 12, 9999), 'a');
  assert.equal(analyzer.stats.events, before); assert.ok(analyzer.stats.uncorrelatedRtp > 0);
});

test('IPv4 CIDR validation and capture filters reject unsafe/unbounded configuration', () => {
  const match = networkMatcher(['192.0.2.0/24']); assert.ok(match('192.0.2.20')); assert.equal(match('192.0.3.20'), false);
  assert.throws(() => config({ providerNetworks: ['192.0.2.0/24 or port 22'] }));
  assert.throws(() => config({ captureFiles: 1000 })); assert.throws(() => config({ enabled: 'true' }));
  assert.match(captureFilter(config()), /ip and udp/);
});

test('streaming PCAP reader carries correlation across capture boundaries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtmf-test-'));
  try {
    const first = path.join(dir, 'a.pcap'), second = path.join(dir, 'b.pcap');
    const a = [invite()]; const b = [];
    for (let i = 0; i < 3; i++) {
      const target = i < 2 ? a : b;
      target.push(event(i, 1, BASE + i, i * 8000), event(i, 2, BASE + i + .2, 90000 + i * 8000));
    }
    await writeFile(first, encodePcap(a)); await writeFile(second, encodePcap(b));
    const { analyzer, alerts } = setup();
    for (const file of [first, second]) for await (const p of readCapture(file)) await analyzer.packet(p, path.basename(file));
    assert.equal(alerts.length, 1); assert.equal(alerts[0].sourceFile, 'b.pcap');
    const bad = path.join(dir, 'bad.pcap'); await writeFile(bad, Buffer.from('not a capture'));
    await assert.rejects(async () => { for await (const p of readCapture(bad)) void p; });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Ethernet VLAN and Linux cooked headers decode; fragments/truncation are not inferred', () => {
  const ip = event(1, 1, BASE, 1).data;
  const eth = Buffer.alloc(18); eth.writeUInt16BE(0x8100, 12); eth.writeUInt16BE(0x0800, 16);
  assert.equal(decodeUDP({ link: 1, data: Buffer.concat([eth, ip]) }).src, '192.0.2.20');
  const sll = Buffer.alloc(16); sll.writeUInt16BE(0x0800, 14);
  assert.equal(decodeUDP({ link: 113, data: Buffer.concat([sll, ip]) }).dp, 13986);
  const sll2 = Buffer.alloc(20); sll2.writeUInt16BE(0x0800);
  assert.equal(decodeUDP({ link: 276, data: Buffer.concat([sll2, ip]) }).sp, 13016);
  const fragment = Buffer.from(ip); fragment.writeUInt16BE(0x2000, 6);
  assert.ok(decodeUDP({ link: 101, data: fragment }).fragmented);
  assert.ok(decodeUDP({ link: 101, data: ip.subarray(0, 30) }).truncated);
});

test('PCAPNG endian/timestamp handling and malformed block bounds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtmf-ng-test-'));
  try {
    for (const le of [true, false]) {
      const u16 = (b, n, p) => le ? b.writeUInt16LE(n, p) : b.writeUInt16BE(n, p);
      const u32 = (b, n, p) => le ? b.writeUInt32LE(n, p) : b.writeUInt32BE(n, p);
      const block = (type, body) => { const b = Buffer.alloc(12 + body.length); u32(b, type, 0); u32(b, b.length, 4); body.copy(b, 8); u32(b, b.length, b.length - 4); return b; };
      const sh = Buffer.alloc(16); u32(sh, 0x1a2b3c4d, 0); u16(sh, 1, 4); sh.fill(255, 8);
      const id = Buffer.alloc(8); u16(id, 101, 0); u32(id, 65535, 4);
      const ip = event(1, 1, BASE, 123).data, ep = Buffer.alloc(20 + Math.ceil(ip.length / 4) * 4);
      const micros = BigInt(BASE) * 1000000n; u32(ep, Number(micros >> 32n), 4); u32(ep, Number(micros & 0xffffffffn), 8);
      u32(ep, ip.length, 12); u32(ep, ip.length, 16); ip.copy(ep, 20);
      const f = path.join(dir, `${le}.pcapng`); await writeFile(f, Buffer.concat([block(0x0a0d0d0a, sh), block(1, id), block(6, ep)]));
      const packets = []; for await (const p of readCapture(f)) packets.push(p);
      assert.equal(packets.length, 1); assert.equal(packets[0].at, BASE); assert.deepEqual(packets[0].data, ip);
      const damaged = await readFile(f); damaged.writeUInt32LE(0, damaged.length - 4); await writeFile(f, damaged);
      await assert.rejects(async () => { for await (const p of readCapture(f)) void p; });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('evidence retention has a hard file count and logs redact digits by default', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtmf-storage-test-'));
  try {
    const storage = new Storage(config({ outputDir: dir, minFreeMB: 256, evidenceFiles: 2 })); await storage.init();
    for (let i = 0; i < 3; i++) await storage.alert({ type: 'suspected_duplicate_dtmf', sequence: '[redacted]' }, [invite()]);
    assert.equal((await readdir(dir)).filter(n => n.endsWith('.pcap')).length, 2);
    assert.match(await readFile(path.join(dir, 'events.jsonl'), 'utf8'), /\[redacted\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
