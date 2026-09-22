import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pcapToWav } from './pcap-to-wav';

const MAX_PCAP_BYTES = 40 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,240}$/;

@Injectable()
export class RecordingsService {
  constructor(private readonly config: ConfigService) {}

  private directory(): string {
    if (this.config.get<string>('RECORDINGS_ENABLED') !== 'true') {
      throw new ForbiddenException('Recording browser is disabled.');
    }
    const root = this.config.get<string>('RECORDINGS_DIR');
    if (!root || !root.startsWith('/')) {
      throw new ServiceUnavailableException('RECORDINGS_DIR must be an absolute path.');
    }
    return join(root, 'pcaps');
  }

  async list() {
    const dir = this.directory();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new ServiceUnavailableException('Cannot read RTPengine PCAP directory. Check the service account permissions.');
    }
    const rows = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pcap') && ID_PATTERN.test(entry.name.slice(0, -5)))
      .map(async (entry) => {
        const info = await stat(join(dir, entry.name));
        return {
          id: entry.name.slice(0, -5),
          recordedAt: info.mtime.toISOString(),
          sizeBytes: info.size,
          playable: info.size > 24 && info.size <= MAX_PCAP_BYTES,
        };
      }));
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 500);
  }

  async audio(id: string): Promise<Buffer> {
    if (!ID_PATTERN.test(id) || id === '.' || id === '..') throw new NotFoundException('Recording not found.');
    const path = join(this.directory(), `${id}.pcap`);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new NotFoundException('Recording not found.');
      if (info.size > MAX_PCAP_BYTES) throw new UnprocessableEntityException('Recording exceeds the 40 MB conversion limit.');
      return pcapToWav(await handle.readFile());
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof UnprocessableEntityException) throw error;
      throw new NotFoundException('Recording not found or not readable.');
    } finally {
      await handle?.close();
    }
  }
}
