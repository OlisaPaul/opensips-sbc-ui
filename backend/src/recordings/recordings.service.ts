import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RowDataPacket } from 'mysql2/promise';
import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseService } from '../database/database.service';
import { pcapToWav } from './pcap-to-wav';

const MAX_PCAP_BYTES = 40 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._%-]{1,240}$/;

type AccountingRow = RowDataPacket & {
  callid: string;
  caller: string | null;
  callee: string | null;
  created: Date | null;
  time: Date;
};

function callIdFromCapture(id: string): string {
  const encoded = id.replace(/-[0-9a-f]{16}$/i, '');
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

@Injectable()
export class RecordingsService {
  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
  ) {}

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
    const recent = rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 500);
    if (!recent.length) return [];

    const callIds = [...new Set(recent.map((row) => callIdFromCapture(row.id)))];
    const parameters = Object.fromEntries(callIds.map((callId, index) => [`callId${index}`, callId]));
    const placeholders = callIds.map((_, index) => `:callId${index}`).join(', ');
    const accounting = await this.database.query<AccountingRow[]>(
      `SELECT callid, caller, callee, created, time
       FROM acc
       WHERE method = 'INVITE' AND callid IN (${placeholders})
       ORDER BY id DESC`,
      parameters,
    );
    const byCallId = new Map<string, AccountingRow>();
    for (const row of accounting) {
      if (!byCallId.has(row.callid)) byCallId.set(row.callid, row);
    }
    return recent.map((row) => {
      const detail = byCallId.get(callIdFromCapture(row.id));
      return {
        ...row,
        callerNumber: detail?.caller || null,
        calledNumber: detail?.callee || null,
        callStartedAt: detail?.created?.toISOString() ?? null,
      };
    });
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
