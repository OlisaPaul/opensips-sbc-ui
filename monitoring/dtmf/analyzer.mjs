import { networkMatcher } from './config.mjs';
import { decodeUDP, decodeEvent } from './packets.mjs';

function parseSIP(payload) {
  if (payload.length > 65535) return null;
  const text = payload.toString('utf8');
  if (!/^(?:SIP\/2\.0 \d{3}|(?:INVITE|ACK|BYE|CANCEL|UPDATE|PRACK) \S+ SIP\/2\.0)\r?\n/.test(text)) return null;
  const split = text.search(/\r?\n\r?\n/); if (split < 0) return null;
  const head = text.slice(0, split).replace(/\r?\n[ \t]+/g, ' ');
  const header = name => head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))?.[1]?.trim();
  const cid = header('Call-ID') ?? header('i'); if (!cid || cid.length > 256) return null;
  const number = value => value?.match(/sips?:([^@;>\s]+)@/i)?.[1]?.slice(0, 80) ?? null;
  const body = text.slice(split).trim(), media = [];
  let globalAddress = null, current = null;
  for (const line of body.split(/\r?\n/)) {
    const conn = line.match(/^c=IN IP4 (\d+\.\d+\.\d+\.\d+)/);
    if (conn) { if (current) current.address = conn[1]; else globalAddress = conn[1]; }
    const m = line.match(/^m=(\S+) (\d+) (\S+) (.*)/);
    if (m) { current = { audio: m[1] === 'audio', port: +m[2], address: globalAddress, types: new Set(), offered: new Set(m[4].split(/\s+/).map(Number)) }; media.push(current); }
    const pt = line.match(/^a=rtpmap:(\d+) telephone-event\/(\d+)/i);
    if (pt && current && +pt[2] === 8000 && current.offered.has(+pt[1])) current.types.add(+pt[1]);
  }
  return { cid, caller: number(header('From') ?? header('f')), called: number(header('To') ?? header('t')),
    firstLine: text.split(/\r?\n/)[0], media: media.filter(m => m.audio && m.address && m.port > 0 && m.port <= 65535) };
}

export class Analyzer {
  constructor(config, onAlert) {
    this.c = config; this.provider = networkMatcher(config.providerNetworks); this.sbc = new Set(config.sbcAddresses);
    this.onAlert = onAlert; this.calls = new Map(); this.endpoints = new Map(); this.now = 0;
    this.stats = { packets: 0, sip: 0, dtmfPackets: 0, events: 0, alerts: 0, uncorrelatedRtp: 0,
      fragmented: 0, truncated: 0, unsupportedLink: 0, captureStatisticsBlocks: 0, evictedCalls: 0, streamLimit: 0 };
    this.stats.observedCaptureDrops = 0;
  }
  remove(cid) {
    const call = this.calls.get(cid); if (!call) return;
    for (const endpoint of call.endpoints.keys()) {
      const ids = this.endpoints.get(endpoint); ids?.delete(cid); if (!ids?.size) this.endpoints.delete(endpoint);
    }
    this.calls.delete(cid);
  }
  sweep() {
    for (const [cid, call] of this.calls) if (this.now - call.last > this.c.callIdleSeconds) this.remove(cid);
  }
  reset() { this.calls.clear(); this.endpoints.clear(); }
  remember(call, packet, sip = false) {
    // Copy only evidence packets, never reference a full capture block/reader buffer.
    if (sip) {
      if (call.sipBytes + packet.rawIP.length > 16384) return;
      call.sip.push({ at: packet.at, data: Buffer.from(packet.rawIP) }); call.sipBytes += packet.rawIP.length;
    } else {
      if (packet.rawIP.length > 512) return;
      call.evidence.push({ at: packet.at, data: Buffer.from(packet.rawIP) });
      if (call.evidence.length > 256) call.evidence.shift();
    }
  }
  async packet(record, source) {
    if (record.statistics) { this.stats.captureStatisticsBlocks++; this.stats.observedCaptureDrops = Math.max(this.stats.observedCaptureDrops, record.dropped ?? 0); return; }
    this.stats.packets++; this.now = Math.max(this.now, record.at);
    if (this.stats.packets % 10000 === 0) this.sweep();
    const p = decodeUDP(record); if (!p) return;
    for (const kind of ['fragmented', 'truncated', 'unsupportedLink']) if (p[kind]) { this.stats[kind]++; return; }
    if (this.c.sipPorts.includes(p.sp) || this.c.sipPorts.includes(p.dp)) {
      const sip = parseSIP(p.payload); if (!sip) return;
      this.stats.sip++;
      let call = this.calls.get(sip.cid);
      // Start correlation only from this provider's traffic into the configured SBC.
      if (!call && (!this.provider(p.src) || !this.sbc.has(p.dst) || !sip.firstLine.startsWith('INVITE '))) return;
      if (!call) {
        this.sweep();
        if (this.calls.size >= this.c.maxCalls) {
          let oldest; for (const c of this.calls.values()) if (!oldest || c.last < oldest.last) oldest = c;
          this.remove(oldest.cid); this.stats.evictedCalls++;
        }
        call = { cid: sip.cid, caller: sip.caller, called: sip.called, last: p.at,
          endpoints: new Map(), streams: new Map(), reported: new Set(), sip: [], sipBytes: 0, evidence: [] };
        this.calls.set(sip.cid, call);
      }
      call.last = Math.max(call.last, p.at); this.remember(call, p, true);
      for (const m of sip.media) {
        const endpoint = `${m.address}:${m.port}`;
        if (!call.endpoints.has(endpoint) && call.endpoints.size >= 16) continue;
        call.endpoints.set(endpoint, m.types);
        if (!this.endpoints.has(endpoint)) this.endpoints.set(endpoint, new Set());
        this.endpoints.get(endpoint).add(sip.cid);
      }
      // Keep ended-call state briefly for late packets; idle sweeping bounds retention.
      return;
    }
    if (!this.provider(p.src) || !this.sbc.has(p.dst)) return; // Do not compare the forwarded leg with ingress.
    const srcEndpoint = `${p.src}:${p.sp}`, dstEndpoint = `${p.dst}:${p.dp}`;
    const ids = new Set([...(this.endpoints.get(srcEndpoint) ?? []), ...(this.endpoints.get(dstEndpoint) ?? [])]);
    const eligible = [...ids].map(id => this.calls.get(id)).filter(c => c && p.at - c.last <= this.c.callIdleSeconds);
    if (eligible.length !== 1) { this.stats.uncorrelatedRtp++; return; } // Ambiguous port reuse is not evidence.
    const call = eligible[0]; call.last = Math.max(call.last, p.at);
    const types = call.endpoints.get(srcEndpoint)?.size ? call.endpoints.get(srcEndpoint) : call.endpoints.get(dstEndpoint);
    const e = decodeEvent(p.payload, types ?? new Set()); if (!e) return;
    this.stats.dtmfPackets++; this.remember(call, p);
    const transport = `${srcEndpoint}>${dstEndpoint}`, key = `${transport}/${e.ssrc}`;
    let stream = call.streams.get(key);
    if (!stream) {
      if (call.streams.size >= this.c.maxStreamsPerCall) { this.stats.streamLimit++; return; }
      stream = { key, transport, ssrc: e.ssrc, events: new Map() }; call.streams.set(key, stream);
    }
    for (const [k, old] of stream.events) if (p.at - old.first > this.c.eventWindowSeconds) stream.events.delete(k);
    const eventKey = `${e.timestamp}/${e.digit}`;
    let event = stream.events.get(eventKey);
    if (event) { event.duration = Math.max(event.duration, e.duration); event.end ||= e.end; return; }
    event = { ...e, first: p.at }; stream.events.set(eventKey, event); this.stats.events++;
    if (stream.events.size > this.c.maxEventsPerStream) stream.events.delete(stream.events.keys().next().value);
    for (const other of call.streams.values()) {
      if (other === stream || other.transport !== transport) continue;
      const pair = [stream.key, other.key].sort().join('|'); if (call.reported.has(pair)) continue;
      const a = [...stream.events.values()], b = [...other.events.values()], n = this.c.minMatchingEvents;
      if (a.length < n || b.length < n) continue;
      const tail = a.slice(-n);
      for (let stop = b.length; stop >= n; stop--) {
        const window = b.slice(stop - n, stop);
        if (!tail.every((x, i) => x.digit === window[i].digit && Math.abs(x.first - window[i].first) * 1000 <= this.c.maxDelayMs)) continue;
        // Three+ adjacent matching events are suspicious, not proof of caller intent.
        call.reported.add(pair); this.stats.alerts++;
        const alert = { type: 'suspected_duplicate_dtmf', provider: this.c.providerName, callId: call.cid,
          caller: call.caller, called: call.called, direction: 'provider_to_sbc', providerEndpoint: srcEndpoint,
          sbcEndpoint: dstEndpoint, ssrcs: [other.ssrc, stream.ssrc], matchingEvents: n,
          firstEventAt: new Date(Math.min(tail[0].first, window[0].first) * 1000).toISOString(),
          detectedAt: new Date(p.at * 1000).toISOString(), sourceFile: source,
          delaysMs: tail.map((x, i) => Math.round(Math.abs(x.first - window[i].first) * 1000)),
          sequence: this.c.logDigits ? tail.map(x => x.digit).join('') : '[redacted]',
          note: 'Matching cross-SSRC sequences; no digit suppression or attribution to an upstream device.' };
        await this.onAlert(alert, [...call.sip, ...call.evidence].sort((x, y) => x.at - y.at));
        break;
      }
    }
  }
}
