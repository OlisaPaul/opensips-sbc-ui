import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuditService } from '../audit/audit.service';
import { DatabaseService, DbConnection } from '../database/database.service';
import { MiService } from '../mi/mi.service';
import { CredentialService } from './credential.service';
import { CreateTrunkDto, UpdateTrunkDto } from './dto';
import { Trunk } from './trunk.types';

type TrunkRow = RowDataPacket & Trunk & { encrypted_password?: string };
type DispatcherSetRow = RowDataPacket & {
  setid: number;
  destination: string;
  description: string;
  state: number;
};
type SetReferenceRow = RowDataPacket & { setid: number };
type TrunkSetRow = RowDataPacket & { name: string; provider_dispatcher_set: number };
type ProviderAddressRow = RowDataPacket & { ip: string };

@Injectable()
export class TrunksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mi: MiService,
    private readonly audit: AuditService,
    private readonly credentials: CredentialService,
  ) {}

  async list() {
    const rows = await this.database.query<TrunkRow[]>(
      `select id, name, provider_ip, provider_port, username, registration_enabled,
              registration_server, application_name, application_ip, application_port, access_prefix,
              strip_prefix, pilot_cli, provider_dispatcher_set, application_dispatcher_set,
              created_at, updated_at
       from sbc_trunks
       order by name`,
    );

    return rows.map((row) => this.toPublic(row));
  }

  async get(id: number) {
    const row = await this.findTrunk(id);
    return this.toPublic(row);
  }

  async statuses() {
    const trunks = await this.database.query<TrunkRow[]>('select * from sbc_trunks order by name');
    const [registration, dispatcher] = await Promise.all([
      this.mi.execute('reg_list'),
      this.mi.dispatcherStatus(),
    ]);
    return trunks.map((trunk) => this.buildStatus(trunk, registration, dispatcher));
  }

  async providerSets() {
    const [dispatcherRows, trunkRows, prefixRows, inboundRows, providerAddresses] = await Promise.all([
      this.database.query<DispatcherSetRow[]>(
        'select setid, destination, description, state from dispatcher order by setid, id',
      ),
      this.database.query<TrunkSetRow[]>(
        'select name, provider_dispatcher_set from sbc_trunks order by name',
      ),
      this.database.query<SetReferenceRow[]>(
        'select distinct sipline_set_id as setid from prefix_mapping where sipline_set_id is not null',
      ),
      this.database.query<SetReferenceRow[]>(
        'select distinct sipline_set_id as setid from did_provider_mapping where sipline_set_id is not null',
      ),
      this.database.query<ProviderAddressRow[]>(
        'select distinct ip from address where grp = 1',
      ),
    ]);

    const providerIps = new Set(providerAddresses.map((row) => row.ip));
    const addressMatchedIds = dispatcherRows
      .filter((row) => {
        const host = row.destination.match(/^sips?:([^:;>]+)/i)?.[1];
        return Boolean(host && providerIps.has(host));
      })
      .map((row) => Number(row.setid));
    const providerIds = new Set<number>([
      ...trunkRows.map((row) => Number(row.provider_dispatcher_set)),
      ...prefixRows.map((row) => Number(row.setid)),
      ...inboundRows.map((row) => Number(row.setid)),
      ...addressMatchedIds,
    ].filter((id) => Number.isInteger(id) && id > 0));
    const allUsedIds = [...new Set(dispatcherRows.map((row) => Number(row.setid)))].sort((a, b) => a - b);
    const referencedIds = [...providerIds].sort((a, b) => a - b);

    return {
      sets: referencedIds.map((setId) => ({
        setId,
        trunks: trunkRows.filter((row) => Number(row.provider_dispatcher_set) === setId).map((row) => row.name),
        destinations: dispatcherRows
          .filter((row) => Number(row.setid) === setId)
          .map((row) => ({ destination: row.destination, description: row.description, state: row.state })),
      })),
      usedSetIds: allUsedIds,
      nextSetId: Math.max(0, ...allUsedIds, ...referencedIds) + 1,
    };
  }

  async create(input: CreateTrunkDto) {
    if (input.registrationEnabled && !input.password) {
      throw new BadRequestException('Password is required when registration is enabled.');
    }

    const id = await this.database.transaction(async (connection) => {
      const trunkId = await this.saveTrunk(input, connection);
      await this.provisionTables(trunkId, input, connection);
      return trunkId;
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('trunk.create', 'system', `trunk:${id}`, {
      trunk: this.redact(input),
      reload,
    });

    return { trunk: await this.get(id), reload };
  }

  async update(id: number, input: UpdateTrunkDto) {
    await this.findTrunk(id);
    await this.database.transaction(async (connection) => {
      await this.saveTrunk(input, connection, id);
      await this.provisionTables(id, input, connection);
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('trunk.update', 'system', `trunk:${id}`, {
      trunk: this.redact(input),
      reload,
    });

    return { trunk: await this.get(id), reload };
  }

  async status(id: number) {
    const trunk = await this.findTrunk(id);
    const [registration, dispatcher] = await Promise.all([
      trunk.registration_enabled ? this.mi.execute('reg_list') : Promise.resolve(null),
      this.mi.dispatcherStatus(),
    ]);
    return this.buildStatus(trunk, registration, dispatcher);
  }

  private async findTrunk(id: number) {
    const rows = await this.database.query<TrunkRow[]>(
      `select * from sbc_trunks where id = :id limit 1`,
      { id },
    );
    if (!rows[0]) {
      throw new NotFoundException('Trunk not found.');
    }
    return rows[0];
  }

  private async saveTrunk(input: CreateTrunkDto | UpdateTrunkDto, connection: DbConnection, id?: number) {
    const providerSet = input.providerDispatcherSet;
    const encryptedPassword = input.password ? this.credentials.encrypt(input.password) : null;
    const params = {
      name: input.name,
      providerIp: input.providerIp,
      providerPort: input.providerPort,
      username: input.username,
      encryptedPassword,
      registrationEnabled: input.registrationEnabled ? 1 : 0,
      registrationServer: input.registrationServer?.trim() || null,
      providerSet,
    };

    if (id) {
      await this.database.query<ResultSetHeader>(
        `update sbc_trunks
         set name = :name, provider_ip = :providerIp, provider_port = :providerPort,
             username = :username,
             encrypted_password = coalesce(:encryptedPassword, encrypted_password),
             registration_enabled = :registrationEnabled,
             registration_server = :registrationServer,
             provider_dispatcher_set = :providerSet
         where id = :id`,
        { ...params, id },
        connection,
      );
      return id;
    }

    const result = await this.database.query<ResultSetHeader>(
      `insert into sbc_trunks
       (name, provider_ip, provider_port, username, encrypted_password, registration_enabled,
        registration_server, provider_dispatcher_set)
       values
       (:name, :providerIp, :providerPort, :username, :encryptedPassword, :registrationEnabled,
        :registrationServer, :providerSet)`,
      params,
      connection,
    );
    return result.insertId;
  }

  private async provisionTables(id: number, input: CreateTrunkDto | UpdateTrunkDto, connection: DbConnection) {
    const providerSet = input.providerDispatcherSet;
    const providerDestination = `sip:${input.providerIp}:${input.providerPort}`;

    if (input.registrationEnabled) {
      const password = await this.registrationPassword(id, input, connection);
      await this.database.query(
        `insert into registrant (registrar, proxy, aor, third_party_registrant, username, password, binding_uri)
         values (:registrar, :proxy, :aor, '', :username, :password, :bindingUri)
         on duplicate key update proxy = values(proxy), password = values(password), binding_uri = values(binding_uri)`,
        {
          registrar: input.registrationServer?.trim() || providerDestination,
          proxy: providerDestination,
          aor: `sip:${input.username}@${input.providerIp}`,
          username: input.username,
          password,
          bindingUri: `sip:${input.username}@${input.providerIp}`,
        },
        connection,
      );
    } else {
      await this.database.query(
        `delete from registrant where username = :username`,
        { username: input.username },
        connection,
      );
    }

    await this.upsertDispatcher(providerSet, providerDestination, input.name, connection);
    await this.upsertAddress(1, input.providerIp, input.providerPort, input.username, id, connection);
  }

  private async upsertAddress(
    group: number,
    ip: string,
    port: number,
    pattern: string,
    trunkId: number,
    connection: DbConnection,
  ) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from address
       where grp = :group and ip = :ip and proto = 'udp'
       order by id
       limit 1`,
      { group, ip },
      connection,
    );
    const params = {
      group,
      ip,
      port,
      pattern: pattern.slice(0, 64),
      contextInfo: `trunk:${trunkId}`,
    };

    if (rows[0]) {
      await this.database.query(
        `update address
         set mask = 32, port = :port, pattern = :pattern, context_info = :contextInfo
         where grp = :group and ip = :ip and proto = 'udp'`,
        params,
        connection,
      );
      return;
    }

    await this.database.query(
      `insert into address (grp, ip, mask, port, proto, pattern, context_info)
       values (:group, :ip, 32, :port, 'udp', :pattern, :contextInfo)`,
      params,
      connection,
    );
  }

  private async upsertDispatcher(setid: number, destination: string, description: string, connection: DbConnection) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from dispatcher
       where setid = :setid and destination = :destination
       order by id
       limit 1`,
      { setid, destination },
      connection,
    );
    const params = { setid, destination, description: description.slice(0, 64) };

    if (rows[0]) {
      await this.database.query(
        `update dispatcher
         set description = :description, state = 0
         where setid = :setid and destination = :destination`,
        params,
        connection,
      );
      return;
    }

    await this.database.query(
      `insert into dispatcher (setid, destination, socket, state, weight, priority, attrs, description)
       values (:setid, :destination, null, 0, 1, 0, '', :description)`,
      params,
      connection,
    );
  }

  private async registrationPassword(
    id: number,
    input: CreateTrunkDto | UpdateTrunkDto,
    connection: DbConnection,
  ) {
    if (input.password) {
      return input.password;
    }

    const rows = await this.database.query<TrunkRow[]>(
      `select encrypted_password from sbc_trunks where id = :id limit 1`,
      { id },
      connection,
    );
    const encrypted = rows[0]?.encrypted_password;
    if (!encrypted) {
      throw new BadRequestException('Password is required when registration is enabled.');
    }
    return this.credentials.decrypt(encrypted);
  }

  private toPublic(row: TrunkRow) {
    const { encrypted_password: _encryptedPassword, ...safe } = row;
    return {
      ...safe,
      registration_enabled: Boolean(row.registration_enabled),
      strip_prefix: row.strip_prefix === null ? null : Boolean(row.strip_prefix),
    };
  }

  private redact(input: CreateTrunkDto | UpdateTrunkDto) {
    const { password: _password, ...safe } = input;
    return { ...safe, password: input.password ? '********' : undefined };
  }

  private buildStatus(trunk: TrunkRow, registrationResult: unknown, dispatcherResult: unknown) {
    const registration = registrationResult as {
      ok?: boolean;
      error?: string;
      response?: { Records?: Array<Record<string, unknown> & { AOR?: string; state?: string; expires?: number }> };
    } | null;
    const dispatcher = dispatcherResult as {
      ok?: boolean;
      error?: string;
      response?: { PARTITIONS?: Array<{ SETS?: Array<{ id?: number; Destinations?: Array<{ URI?: string; state?: string }> }> }> };
    };
    const record = registration?.response?.Records?.find(
      (candidate) => candidate.AOR === trunk.username || candidate.AOR?.startsWith(`sip:${trunk.username}@`),
    );
    const providerDestination = `sip:${trunk.provider_ip}:${trunk.provider_port}`;
    const set = dispatcher.response?.PARTITIONS?.flatMap((partition) => partition.SETS ?? [])
      .find((candidate) => Number(candidate.id) === Number(trunk.provider_dispatcher_set));
    const destination = set?.Destinations?.find((candidate) => candidate.URI === providerDestination)
      ?? set?.Destinations?.[0];

    return {
      trunkId: trunk.id,
      registration: {
        enabled: Boolean(trunk.registration_enabled),
        ok: !trunk.registration_enabled || (Boolean(registration?.ok) && record?.state === 'REGISTERED_STATE'),
        state: trunk.registration_enabled ? record?.state ?? 'NOT_FOUND' : 'DISABLED',
        expires: record?.expires ?? null,
        error: registration?.error,
      },
      provider: {
        ok: Boolean(dispatcher.ok) && destination?.state?.toLowerCase() === 'active',
        setId: trunk.provider_dispatcher_set,
        destination: providerDestination,
        state: destination?.state ?? 'Not found',
        error: dispatcher.error,
      },
    };
  }
}
