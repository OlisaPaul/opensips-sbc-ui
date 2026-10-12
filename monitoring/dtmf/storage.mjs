import { appendFile, mkdir, stat, rename, unlink, readdir, writeFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodePcap } from './packets.mjs';

export async function freeMB(dir) {
  const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize) / 1024 / 1024;
}

export class Storage {
  constructor(config) { this.c = config; this.log = path.join(config.outputDir, 'events.jsonl'); }
  async init() { await mkdir(this.c.outputDir, { recursive: true, mode: 0o700 }); }
  async record(data) {
    const line = JSON.stringify({ loggedAt: new Date().toISOString(), ...data }) + '\n';
    const size = await stat(this.log).then(s => s.size).catch(e => { if (e.code === 'ENOENT') return 0; throw e; });
    if (size + Buffer.byteLength(line) > this.c.logFileMB * 1024 * 1024) {
      for (let i = this.c.logFiles - 1; i >= 1; i--) {
        const dest = `${this.log}.${i}`, src = i === 1 ? this.log : `${this.log}.${i - 1}`;
        await unlink(dest).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rename(src, dest).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      if (this.c.logFiles === 1) await unlink(this.log).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    await appendFile(this.log, line, { mode: 0o600 });
  }
  async alert(alert, packets) {
    let evidence = null;
    if (await freeMB(this.c.outputDir) >= this.c.minFreeMB) {
      const existing = (await readdir(this.c.outputDir)).filter(n => /^evidence-[\w-]+\.pcap$/.test(n)).sort();
      while (existing.length >= this.c.evidenceFiles) await unlink(path.join(this.c.outputDir, existing.shift()));
      const buffer = encodePcap(packets);
      if (buffer.length <= this.c.evidenceFileMB * 1024 * 1024) {
        evidence = `evidence-${Date.now()}-${randomUUID()}.pcap`;
        await writeFile(path.join(this.c.outputDir, evidence), buffer, { mode: 0o600, flag: 'wx' });
      }
    }
    await this.record({ ...alert, evidence, evidenceScope: 'Bounded SIP context and telephone-events up to detection; no audio; may be incomplete.' });
  }
}
