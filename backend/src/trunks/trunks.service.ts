import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuditService } from '../audit/audit.service';
import { DatabaseService, DbConnection } from '../database/database.service';
import { MiService } from '../mi/mi.service';
import { CredentialService } from './credential.service';
import { CreateTrunkDto, UpdateTrunkDto } from './dto';
import { Trunk } from './trunk.types';

type TrunkRow = RowDataPacket & Trunk & { encrypted_password?: string };

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
      trunk.registration_enabled ? this.mi.registrationStatus(trunk.username) : Promise.resolve(null),
      this.mi.dispatcherStatus(),
    ]);

    return {
      registration,
      dispatcher,
      inbound: `${trunk.username} -> ${trunk.application_name} (${trunk.application_ip}:${trunk.application_port})`,
      outbound: `${trunk.access_prefix} -> ${trunk.name} (set ${trunk.provider_dispatcher_set})`,
    };
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
    const providerSet = input.providerDispatcherSet ?? 1;
    const applicationSet = input.applicationDispatcherSet ?? 8;
    const encryptedPassword = input.password ? this.credentials.encrypt(input.password) : null;
    const params = {
      name: input.name,
      providerIp: input.providerIp,
      providerPort: input.providerPort,
      username: input.username,
      encryptedPassword,
      registrationEnabled: input.registrationEnabled ? 1 : 0,
      registrationServer: input.registrationServer?.trim() || null,
      applicationName: input.applicationName,
      applicationIp: input.applicationIp,
      applicationPort: input.applicationPort,
      accessPrefix: input.accessPrefix,
      stripPrefix: input.stripPrefix ? 1 : 0,
      pilotCli: input.pilotCli,
      providerSet,
      applicationSet,
    };

    if (id) {
      await this.database.query<ResultSetHeader>(
        `update sbc_trunks
         set name = :name, provider_ip = :providerIp, provider_port = :providerPort,
             username = :username,
             encrypted_password = coalesce(:encryptedPassword, encrypted_password),
             registration_enabled = :registrationEnabled,
             registration_server = :registrationServer,
             application_name = :applicationName, application_ip = :applicationIp,
             application_port = :applicationPort, access_prefix = :accessPrefix,
             strip_prefix = :stripPrefix, pilot_cli = :pilotCli,
             provider_dispatcher_set = :providerSet,
             application_dispatcher_set = :applicationSet
         where id = :id`,
        { ...params, id },
        connection,
      );
      return id;
    }

    const result = await this.database.query<ResultSetHeader>(
      `insert into sbc_trunks
       (name, provider_ip, provider_port, username, encrypted_password, registration_enabled,
        registration_server, application_name, application_ip, application_port, access_prefix,
        strip_prefix, pilot_cli, provider_dispatcher_set, application_dispatcher_set)
       values
       (:name, :providerIp, :providerPort, :username, :encryptedPassword, :registrationEnabled,
        :registrationServer, :applicationName, :applicationIp, :applicationPort, :accessPrefix,
        :stripPrefix, :pilotCli, :providerSet, :applicationSet)`,
      params,
      connection,
    );
    return result.insertId;
  }

  private async provisionTables(id: number, input: CreateTrunkDto | UpdateTrunkDto, connection: DbConnection) {
    const providerSet = input.providerDispatcherSet ?? 1;
    const applicationSet = input.applicationDispatcherSet ?? 8;
    const providerDestination = `sip:${input.providerIp}:${input.providerPort}`;
    const applicationDestination = `sip:${input.applicationIp}:${input.applicationPort}`;

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
    await this.upsertDispatcher(applicationSet, applicationDestination, input.applicationName, connection);

    await this.upsertAddress(1, input.providerIp, input.providerPort, input.pilotCli, id, connection);
    await this.upsertAddress(2, input.applicationIp, input.applicationPort, input.pilotCli, id, connection);

    await this.upsertDidMapping(input.username, applicationSet, input.applicationName, connection);

    await this.database.query(
      `insert into prefix_mapping (prefix, sipline_set_id, description, routing_mode, strip_prefix)
       values (:prefix, :dispatcherSet, :description, 'dial_prefix', :stripPrefix)
       on duplicate key update sipline_set_id = values(sipline_set_id), description = values(description),
                               routing_mode = values(routing_mode), strip_prefix = values(strip_prefix)`,
      {
        prefix: input.accessPrefix,
        dispatcherSet: providerSet,
        description: input.name.slice(0, 64),
        stripPrefix: input.stripPrefix ? 1 : 0,
      },
      connection,
    );
  }

  private async upsertDidMapping(
    did: string,
    destinationSetId: number,
    description: string,
    connection: DbConnection,
  ) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from did_mapping
       where start_did = :did and end_did = :did
       order by id
       limit 1`,
      { did },
      connection,
    );
    const params = {
      did,
      destinationSetId,
      description: description.slice(0, 100),
    };

    if (rows[0]) {
      await this.database.query(
        `update did_mapping
         set destination_set_id = :destinationSetId, description = :description
         where start_did = :did and end_did = :did`,
        params,
        connection,
      );
      return;
    }

    await this.database.query(
      `insert into did_mapping (start_did, end_did, destination_set_id, description)
       values (:did, :did, :destinationSetId, :description)`,
      params,
      connection,
    );
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
      strip_prefix: Boolean(row.strip_prefix),
    };
  }

  private redact(input: CreateTrunkDto | UpdateTrunkDto) {
    const { password: _password, ...safe } = input;
    return { ...safe, password: input.password ? '********' : undefined };
  }
}
