import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const defaults = {
  enabled: false, providerName: 'Provider', providerNetworks: [], sbcAddresses: [],
  interface: 'any', sipPorts: [5060], dumpcap: '/usr/bin/dumpcap',
  inputDir: '/var/lib/sbc-dtmf/capture', outputDir: '/var/lib/sbc-dtmf/results',
  captureFileKB: 100000, captureFiles: 10, captureSeconds: 60,
  pollSeconds: 10, settleSeconds: 30, maxFileMB: 128, maxCalls: 250,
  callIdleSeconds: 1800, eventWindowSeconds: 60, maxStreamsPerCall: 8,
  maxEventsPerStream: 64, maxDelayMs: 600, minMatchingEvents: 3,
  logFileMB: 5, logFiles: 5, evidenceFiles: 50, evidenceFileMB: 1,
  minFreeMB: 2048, logDigits: false,
};

export function ipv4Number(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || +p > 255)) throw new Error(`Invalid IPv4 address: ${address}`);
  return parts.reduce((n, p) => (n * 256 + +p) >>> 0, 0);
}

export function networkMatcher(networks) {
  const parsed = networks.map(value => {
    const [address, prefix = '32', extra] = value.split('/');
    if (extra !== undefined || !/^\d+$/.test(prefix) || +prefix > 32) throw new Error(`Invalid IPv4 network: ${value}`);
    const mask = +prefix === 0 ? 0 : (0xffffffff << (32 - +prefix)) >>> 0;
    return { net: (ipv4Number(address) & mask) >>> 0, mask };
  });
  return address => {
    try { const n = ipv4Number(address); return parsed.some(p => ((n & p.mask) >>> 0) === p.net); }
    catch { return false; }
  };
}

export function validateConfig(input) {
  for (const key of Object.keys(input)) if (!(key in defaults)) throw new Error(`Unknown setting: ${key}`);
  const c = { ...defaults, ...input };
  for (const key of ['enabled', 'logDigits']) if (typeof c[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  const ranges = {
    captureFileKB: [1000, 100000], captureFiles: [2, 20], captureSeconds: [10, 300],
    pollSeconds: [1, 60], settleSeconds: [10, 120], maxFileMB: [1, 256],
    maxCalls: [1, 1000], callIdleSeconds: [60, 7200], eventWindowSeconds: [1, 120],
    maxStreamsPerCall: [2, 8], maxEventsPerStream: [3, 64], maxDelayMs: [50, 1000],
    minMatchingEvents: [3, 10], logFileMB: [1, 10], logFiles: [1, 10],
    evidenceFiles: [1, 100], evidenceFileMB: [1, 2], minFreeMB: [256, 102400],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  if (c.minMatchingEvents > c.maxEventsPerStream) throw new Error('minMatchingEvents exceeds event history');
  for (const key of ['providerNetworks', 'sbcAddresses', 'sipPorts']) if (!Array.isArray(c[key]) || c[key].length > 32) throw new Error(`Invalid ${key}`);
  if (!c.providerNetworks.length || !c.sbcAddresses.length) throw new Error('Configure providerNetworks and sbcAddresses explicitly');
  networkMatcher(c.providerNetworks); c.sbcAddresses.forEach(ipv4Number);
  if (!c.sipPorts.length || c.sipPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('Invalid sipPorts');
  if (!/^[\w .-]{1,80}$/.test(c.providerName)) throw new Error('Invalid providerName');
  if (!/^[\w:.-]{1,80}$/.test(c.interface)) throw new Error('Invalid interface');
  for (const key of ['inputDir', 'outputDir', 'dumpcap']) if (!path.isAbsolute(c[key])) throw new Error(`${key} must be absolute`);
  if (path.resolve(c.inputDir) === path.resolve(c.outputDir)) throw new Error('Input and output directories must differ');
  return c;
}

export async function loadConfig(file) { return validateConfig(JSON.parse(await readFile(file, 'utf8'))); }

export function captureFilter(c) {
  const sip = c.sipPorts.map(p => `port ${p}`).join(' or ');
  const media = c.providerNetworks.map(n => `net ${n}`).join(' or ');
  return `ip and udp and ((${sip}) or (${media}))`;
}
