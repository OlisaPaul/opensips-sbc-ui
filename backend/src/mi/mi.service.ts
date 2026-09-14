import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'undici';

const execFileAsync = promisify(execFile);
const allowedCommands = new Set(['address_reload', 'ds_list', 'ds_reload', 'reg_list', 'reg_reload']);

export type MiResult = {
  command: string;
  skipped: boolean;
  ok: boolean;
  response?: unknown;
  error?: string;
};

@Injectable()
export class MiService {
  constructor(private readonly config: ConfigService) {}

  async execute(command: string, params: string[] = []): Promise<MiResult> {
    if (this.config.get<string>('MI_ENABLED') === 'false') {
      return { command, skipped: true, ok: true };
    }

    if (!allowedCommands.has(command)) {
      return { command, skipped: false, ok: false, error: `Unsupported MI command: ${command}` };
    }

    const configuredTimeout = Number(this.config.get<string>('MI_TIMEOUT_MS') ?? 3000);
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 3000;
    const transport = this.config.get<string>('MI_TRANSPORT')?.toLowerCase() ?? 'cli';

    try {
      if (transport === 'cli') {
        return await this.executeCli(command, params, timeout);
      }
      if (transport !== 'http') {
        return { command, skipped: false, ok: false, error: `Unsupported MI transport: ${transport}` };
      }

      const url = this.config.get<string>('MI_URL') ?? 'http://127.0.0.1:8888/mi';
      const { body } = await request(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: command, params }),
        headers: { 'content-type': 'application/json' },
        bodyTimeout: timeout,
        headersTimeout: timeout,
      });
      const response = await body.json();
      return { command, skipped: false, ok: !(response as { error?: unknown }).error, response };
    } catch (error) {
      return {
        command,
        skipped: false,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown MI error',
      };
    }
  }

  async reloadProvisioning() {
    return Promise.all([
      this.execute('address_reload'),
      this.execute('ds_reload'),
    ]);
  }

  async registrationStatus(aor: string) {
    const result = await this.execute('reg_list');
    if (!result.ok) {
      return result;
    }

    const records = (result.response as { Records?: Array<{ AOR?: string }> } | undefined)?.Records;
    if (!Array.isArray(records)) {
      return result;
    }

    return {
      ...result,
      response: {
        Records: records.filter((record) => record.AOR === aor || record.AOR?.startsWith(`sip:${aor}@`)),
      },
    };
  }

  async reloadTrunkProvisioning() {
    return Promise.all([
      this.execute('reg_reload'),
      this.execute('address_reload'),
      this.execute('ds_reload'),
    ]);
  }

  async dispatcherStatus() {
    return this.execute('ds_list');
  }

  private async executeCli(command: string, params: string[], timeout: number): Promise<MiResult> {
    const executable = this.config.get<string>('MI_CLI_PATH') ?? '/usr/bin/opensips-cli';
    const { stdout } = await execFileAsync(executable, ['-x', 'mi', command, ...params], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    });
    const output = stdout.trim();
    let response: unknown = output;

    if (output) {
      try {
        response = JSON.parse(output);
      } catch {
        // Preserve non-JSON CLI output for MI commands that return plain text.
      }
    }

    return { command, skipped: false, ok: true, response };
  }
}
