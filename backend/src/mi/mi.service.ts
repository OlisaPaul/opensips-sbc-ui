import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request } from 'undici';

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

    try {
      const url = this.config.get<string>('MI_URL') ?? 'http://127.0.0.1:8888/mi';
      const timeout = this.config.get<number>('MI_TIMEOUT_MS') ?? 3000;
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
    return this.execute('reg_list', [aor]);
  }

  async dispatcherStatus() {
    return this.execute('ds_list');
  }
}
