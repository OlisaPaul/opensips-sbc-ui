import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(action: string, actor: string, target: string, payload: unknown) {
    await this.database.query(
      `insert into sbc_audit_log (action, actor, target, payload_json)
       values (:action, :actor, :target, :payload)`,
      {
        action,
        actor,
        target,
        payload: JSON.stringify(payload),
      },
    );
  }
}
