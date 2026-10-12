#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readdir, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, captureFilter } from './config.mjs';
import { Analyzer } from './analyzer.mjs';
import { readCapture } from './packets.mjs';
import { Storage, freeMB } from './storage.mjs';

let stopping = false, child;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; child?.kill('SIGINT'); });
function health(type, extra = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), type, ...extra })); }

async function trimCaptureRing(c) {
  // dumpcap's ring applies only to its current process. Also bound previous runs.
  const names = (await readdir(c.inputDir)).filter(n => /^dtmf_\d+_\d+\.pcapng$/.test(n));
  const files = [];
  for (const name of names) {
    const s = await lstat(path.join(c.inputDir, name)).catch(() => null);
    if (s?.isFile() && !s.isSymbolicLink()) files.push({ name, at: s.mtimeMs });
  }
  files.sort((a, b) => a.at - b.at);
  while (files.length > c.captureFiles) {
    const file = files.shift();
    await unlink(path.join(c.inputDir, file.name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

export async function analyzeFile(file, analyzer, config) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > config.maxFileMB * 1024 * 1024) throw new Error('Not a regular file or file exceeds maxFileMB');
  let count = 0;
  for await (const packet of readCapture(file)) {
    if (stopping) throw new Error('Analysis interrupted');
    await analyzer.packet(packet, path.basename(file));
    if (++count % 10000 === 0) await delay(1); // Yield; never monopolise the event loop.
  }
  const after = await lstat(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('Capture changed during analysis; coverage is incomplete');
}

async function capture(c) {
  await mkdir(c.inputDir, { recursive: true, mode: 0o700 });
  await trimCaptureRing(c);
  if (await freeMB(c.inputDir) < c.minFreeMB) throw new Error('Capture refused: free-space reserve reached');
  const args = ['-q', '-p', '-i', c.interface, '-s', '0', '-B', '8', '-f', captureFilter(c),
    '-b', `filesize:${c.captureFileKB}`, '-b', `duration:${c.captureSeconds}`, '-b', `files:${c.captureFiles}`,
    '-w', path.join(c.inputDir, 'dtmf.pcapng')];
  health('capture_start', { filter: captureFilter(c), captureLimitKB: c.captureFileKB * c.captureFiles });
  child = spawn(c.dumpcap, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  let lowSpace = false;
  let checking = false;
  const check = setInterval(() => {
    if (checking) return; checking = true;
    trimCaptureRing(c).then(() => freeMB(c.inputDir)).then(free => {
      if (free < c.minFreeMB && !lowSpace) { lowSpace = true; health('capture_stopped_low_disk', { freeMB: Math.floor(free) }); child.kill('SIGINT'); }
    }).catch(() => { lowSpace = true; child.kill('SIGINT'); }).finally(() => { checking = false; });
  }, 10000);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => stopping || lowSpace || code === 0 ? resolve() : reject(new Error(`dumpcap exited ${code ?? signal}`)));
    });
  } finally { clearInterval(check); }
  // Low disk intentionally does not cause an automatic restart loop.
}

async function worker(c, files) {
  const storage = new Storage(c); await storage.init();
  const lockFile = path.join(c.outputDir, '.worker.lock');
  let lock;
  // flock in systemd handles daemon singleton. This process lock protects manual/offline use.
  try { lock = await open(lockFile, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch { throw new Error('Another worker or a stale .worker.lock exists in outputDir; verify no worker is running before removing it'); }
  const analyzer = new Analyzer(c, (alert, packets) => storage.alert(alert, packets));
  try {
    if (files.length) {
      for (const file of files) await analyzeFile(path.resolve(file), analyzer, c);
      await storage.record({ type: 'analysis_summary', ...analyzer.stats, activeCalls: analyzer.calls.size });
      health('analysis_complete', analyzer.stats); return;
    }
    await mkdir(c.inputDir, { recursive: true, mode: 0o700 });
    const done = new Map(); let lastReport = 0, lastRotation = null;
    health('worker_start', { inputDir: c.inputDir, note: 'IPv4/UDP telephone-event only; in-band audio is not decoded' });
    while (!stopping) {
      if (await freeMB(c.outputDir) < c.minFreeMB) { health('worker_paused_low_disk'); await delay(c.pollSeconds * 1000); continue; }
      const names = (await readdir(c.inputDir)).filter(n => /\.(pcap|pcapng)$/.test(n));
      const ready = [];
      for (const name of names) {
        const s = await lstat(path.join(c.inputDir, name)).catch(() => null);
        if (!s?.isFile() || s.isSymbolicLink() || Date.now() - s.mtimeMs < c.settleSeconds * 1000) continue;
        const identity = `${s.ino}/${s.size}/${s.mtimeMs}`;
        if (done.get(name) !== identity) ready.push({ name, s, identity });
      }
      ready.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs || a.name.localeCompare(b.name));
      for (const item of ready) {
        if (stopping) break;
        const rotation = item.name.match(/^dtmf_(\d+)_/);
        if (rotation && lastRotation !== null && +rotation[1] !== lastRotation + 1) {
          await storage.record({ type: 'capture_gap', previousRotation: lastRotation, nextRotation: +rotation[1], note: 'Capture may have rotated before analysis; correlation reset' });
          analyzer.reset();
        }
        try { await analyzeFile(path.join(c.inputDir, item.name), analyzer, c); }
        catch (error) {
          analyzer.reset(); await storage.record({ type: 'coverage_warning', sourceFile: item.name, message: error.message });
        }
        if (rotation) lastRotation = +rotation[1];
        done.set(item.name, item.identity);
        while (done.size > 128) done.delete(done.keys().next().value);
      }
      if (Date.now() - lastReport >= 60000) {
        await storage.record({ type: 'monitor_health', ...analyzer.stats, activeCalls: analyzer.calls.size, pendingFiles: ready.length }); lastReport = Date.now();
      }
      await delay(c.pollSeconds * 1000);
    }
  } finally { await lock.close(); await unlink(lockFile).catch(() => {}); }
}

async function main() {
  if (+process.versions.node.split('.')[0] < 20) throw new Error('Node.js 20+ is required');
  process.umask(0o077);
  const [mode, file, ...files] = process.argv.slice(2);
  if (!['check', 'capture', 'watch', 'analyze'].includes(mode) || !file) throw new Error('Usage: node cli.mjs check|capture|watch|analyze CONFIG.json [ordered captures...]');
  const c = await loadConfig(path.resolve(file));
  if (mode === 'check') { health('config_valid', { enabled: c.enabled, captureFilter: captureFilter(c) }); return; }
  if (mode === 'analyze') { if (!files.length) throw new Error('Supply captures in chronological order'); await worker(c, files); return; }
  if (!c.enabled) { health('disabled'); return; }
  if (mode === 'capture') await capture(c); else await worker(c, []);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { health('fatal', { message: error.message }); process.exitCode = 1; });
}
