import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
  ) {}

  async list() {
    const rows = await this.database.query<TrunkRow[]>(
      `select t.id, t.name, t.provider_ip, t.provider_port, t.username, t.enabled, t.registration_enabled,
              t.registration_expiry, t.binding_uri, t.custom_pai_uri, registration_server, application_name, application_ip, application_port, access_prefix,
              strip_prefix, pilot_cli, provider_dispatcher_set, application_dispatcher_set,
              created_at, updated_at
       from sbc_trunks t
       order by t.name`,
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

  async setEnabled(id: number, enabled: boolean) {
    const previous = await this.findTrunk(id);
    if (Boolean(previous.enabled) === enabled) {
      return { trunk: this.toPublic(previous), reload: [] };
    }

    await this.database.transaction(async (connection) => {
      await this.database.query(
        'update sbc_trunks set enabled = :enabled where id = :id',
        { id, enabled: enabled ? 1 : 0 },
        connection,
      );
      if (enabled) {
        await this.provisionStoredTrunk(previous, connection);
      } else {
        await this.deprovisionTrunk(previous, connection);
      }
    });

    const reload = await this.mi.reloadTrunkProvisioning();
    await this.audit.record(enabled ? 'trunk.enable' : 'trunk.disable', 'system', `trunk:${id}`, { reload });
    return { trunk: await this.get(id), reload };
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

    const reload = await this.mi.reloadTrunkProvisioning();
    await this.audit.record('trunk.create', 'system', `trunk:${id}`, {
      trunk: this.redact(input),
      reload,
    });

    return { trunk: await this.get(id), reload };
  }

  async update(id: number, input: UpdateTrunkDto) {
    const previous = await this.findTrunk(id);
    await this.database.transaction(async (connection) => {
      await this.saveTrunk(input, connection, id);
      if (previous.enabled) {
        await this.provisionTables(id, input, connection, previous.username);
      } else {
        await this.deprovisionTrunk({
          ...previous,
          username: input.username,
          provider_ip: input.providerIp,
          provider_port: input.providerPort,
          provider_dispatcher_set: input.providerDispatcherSet,
        }, connection, previous.username);
      }
    });

    const reload = await this.mi.reloadTrunkProvisioning();
    await this.audit.record('trunk.update', 'system', `trunk:${id}`, {
      trunk: this.redact(input),
      reload,
    });

    return { trunk: await this.get(id), reload };
  }

  async status(id: number) {
    const trunk = await this.findTrunk(id);
    const [registration, dispatcher] = await Promise.all([
      trunk.enabled && trunk.registration_enabled ? this.mi.execute('reg_list') : Promise.resolve(null),
      this.mi.dispatcherStatus(),
    ]);
    return this.buildStatus(trunk, registration, dispatcher);
  }

  private async findTrunk(id: number) {
    const rows = await this.database.query<TrunkRow[]>(
      'select t.* from sbc_trunks t where t.id = :id limit 1',
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
      registrationExpiry: input.registrationExpiry ?? 3600,
      bindingUri: input.bindingUri?.trim() || null,
      customPaiUri: input.customPaiUri?.trim() || null,
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
             registration_expiry = :registrationExpiry,
             binding_uri = coalesce(:bindingUri, binding_uri),
             custom_pai_uri = :customPaiUri,
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
       (name, provider_ip, provider_port, username, encrypted_password, enabled, registration_enabled,
        registration_expiry, binding_uri, custom_pai_uri, registration_server, provider_dispatcher_set)
       values
       (:name, :providerIp, :providerPort, :username, :encryptedPassword, 1, :registrationEnabled,
        :registrationExpiry, :bindingUri, :customPaiUri, :registrationServer, :providerSet)`,
      params,
      connection,
    );
    return result.insertId;
  }

  private async provisionTables(
    id: number,
    input: CreateTrunkDto | UpdateTrunkDto,
    connection: DbConnection,
    previousUsername?: string,
  ) {
    const providerSet = input.providerDispatcherSet;
    const providerDestination = `sip:${input.providerIp}:${input.providerPort}`;

    if (input.registrationEnabled) {
      const password = await this.registrationPassword(id, input, connection);
      const bindingUri = await this.registrationBindingUri(input, connection);
      const registrationExpiry = input.registrationExpiry ?? 3600;
      await this.database.query(
        `update sbc_trunks
         set registration_expiry = :registrationExpiry, binding_uri = :bindingUri
         where id = :id`,
        { id, registrationExpiry, bindingUri },
        connection,
      );
      const existing = await this.database.query<(RowDataPacket & { id: number })[]>(
        `select id from registrant
         where username = :username or (:previousUsername is not null and username = :previousUsername)
         order by (username = :username) desc, id
         limit 1`,
        { username: input.username, previousUsername: previousUsername ?? null },
        connection,
      );
      const registration = {
        id: existing[0]?.id,
        registrar: input.registrationServer?.trim() || providerDestination,
        proxy: providerDestination,
        aor: `sip:${input.username}@${input.providerIp}`,
        username: input.username,
        password,
        bindingUri,
        registrationExpiry,
      };
      if (existing[0]) {
        await this.database.query(
          `update registrant
           set registrar = :registrar, proxy = :proxy, aor = :aor, username = :username,
               password = :password, binding_uri = :bindingUri, expiry = :registrationExpiry
           where id = :id`,
          registration,
          connection,
        );
      } else {
        await this.database.query(
          `insert into registrant
           (registrar, proxy, aor, third_party_registrant, username, password, binding_uri, expiry)
           values
           (:registrar, :proxy, :aor, '', :username, :password, :bindingUri, :registrationExpiry)`,
          registration,
          connection,
        );
      }
    } else {
      await this.database.query(
        `delete from registrant
         where username = :username or (:previousUsername is not null and username = :previousUsername)`,
        { username: input.username, previousUsername: previousUsername ?? null },
        connection,
      );
    }

    await this.upsertDispatcher(providerSet, providerDestination, input.name, connection);
    await this.upsertAddress(1, input.providerIp, input.providerPort, input.username, id, connection);
  }

  private async provisionStoredTrunk(trunk: TrunkRow, connection: DbConnection) {
    const input: UpdateTrunkDto = {
      name: trunk.name,
      providerIp: trunk.provider_ip,
      providerPort: trunk.provider_port,
      username: trunk.username,
      registrationEnabled: Boolean(trunk.registration_enabled),
      registrationExpiry: trunk.registration_expiry || 3600,
      registrationServer: trunk.registration_server ?? undefined,
      bindingUri: trunk.binding_uri ?? undefined,
      customPaiUri: trunk.custom_pai_uri ?? undefined,
      providerDispatcherSet: trunk.provider_dispatcher_set,
    };
    await this.provisionTables(trunk.id, input, connection);
  }

  private async deprovisionTrunk(trunk: TrunkRow, connection: DbConnection, previousUsername?: string) {
    await this.database.query(
      `delete from registrant
       where username = :username or (:previousUsername is not null and username = :previousUsername)`,
      { username: trunk.username, previousUsername: previousUsername ?? null },
      connection,
    );

    const otherUsers = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from sbc_trunks
       where enabled = 1 and id <> :id and provider_dispatcher_set = :providerSet
       limit 1`,
      { id: trunk.id, providerSet: trunk.provider_dispatcher_set },
      connection,
    );
    if (!otherUsers[0]) {
      await this.database.query(
        'delete from dispatcher where setid = :providerSet and destination = :destination',
        {
          providerSet: trunk.provider_dispatcher_set,
          destination: `sip:${trunk.provider_ip}:${trunk.provider_port}`,
        },
        connection,
      );
    }
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

  private async registrationBindingUri(
    input: CreateTrunkDto | UpdateTrunkDto,
    connection: DbConnection,
  ) {
    const supplied = input.bindingUri?.trim();
    if (supplied) {
      this.assertSipUri(supplied, 'SBC Contact URI');
      return supplied;
    }

    const bindingIp = this.config.get<string>('SIP_BINDING_IP')?.trim();
    const configuredPort = Number(this.config.get<string>('SIP_BINDING_PORT') ?? 5060);
    const bindingPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
      ? configuredPort
      : 5060;
    if (bindingIp) {
      return `sip:${input.username}@${bindingIp}:${bindingPort}`;
    }

    const existing = await this.database.query<(RowDataPacket & { binding_uri: string })[]>(
      `select binding_uri from registrant
       where binding_uri is not null and binding_uri <> ''
       order by (username = :username) desc, id
       limit 20`,
      { username: input.username },
      connection,
    );
    for (const row of existing) {
      const match = row.binding_uri.match(/^(sips?):[^@]+@([^:;>]+)(.*)$/i);
      if (match && match[2] !== input.providerIp) {
        return `${match[1]}:${input.username}@${match[2]}${match[3]}`;
      }
    }

    throw new BadRequestException(
      'SBC Contact URI is required for registration. Enter it in the trunk form or set SIP_BINDING_IP in backend/.env.',
    );
  }

  private assertSipUri(value: string, label: string) {
    if (!/^sips?:[^@\s]+@[^@\s]+$/i.test(value)) {
      throw new BadRequestException(`${label} must be a valid SIP URI such as sip:user@10.81.0.194:5060.`);
    }
  }

  private toPublic(row: TrunkRow) {
    const { encrypted_password: _encryptedPassword, ...safe } = row;
    return {
      ...safe,
      enabled: Boolean(row.enabled),
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
      enabled: Boolean(trunk.enabled),
      registration: {
        enabled: Boolean(trunk.enabled && trunk.registration_enabled),
        ok: !trunk.enabled || !trunk.registration_enabled || (Boolean(registration?.ok) && record?.state === 'REGISTERED_STATE'),
        state: !trunk.enabled ? 'TRUNK DISABLED' : trunk.registration_enabled ? record?.state ?? 'NOT_FOUND' : 'DISABLED',
        expires: record?.expires ?? null,
        error: registration?.error,
      },
      provider: {
        ok: Boolean(trunk.enabled) && Boolean(dispatcher.ok) && destination?.state?.toLowerCase() === 'active',
        setId: trunk.provider_dispatcher_set,
        destination: providerDestination,
        state: !trunk.enabled ? 'Trunk disabled' : destination?.state ?? 'Not found',
        error: dispatcher.error,
      },
    };
  }
}
