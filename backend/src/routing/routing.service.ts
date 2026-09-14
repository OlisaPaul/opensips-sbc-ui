import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuditService } from '../audit/audit.service';
import { DatabaseService, DbConnection } from '../database/database.service';
import { MiService } from '../mi/mi.service';
import { InboundRouteInputDto, OutboundRouteInputDto } from './dto';

type TrunkRow = RowDataPacket & {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  provider_dispatcher_set: number;
};

type InboundRow = RowDataPacket & {
  id: number;
  start_did: string | null;
  end_did: string | null;
  destination_set_id: number;
  description: string | null;
};

type ProviderMappingRow = RowDataPacket & {
  id: number;
  start_did: string;
  end_did: string | null;
  provider: string;
  sipline_set_id: number | null;
};

type DispatcherRow = RowDataPacket & {
  id: number;
  setid: number;
  destination: string;
  state: number;
  description: string;
};

type OutboundRow = RowDataPacket & {
  id: number;
  prefix: string;
  sipline_set_id: number;
  description: string;
  routing_mode: string;
  strip_prefix: number;
};

type AddressRow = RowDataPacket & {
  ip: string;
  pattern: string | null;
};

@Injectable()
export class RoutingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mi: MiService,
    private readonly audit: AuditService,
  ) {}

  async listInbound() {
    const [routes, mappings, trunks, dispatchers] = await Promise.all([
      this.database.query<InboundRow[]>('select * from did_mapping order by start_did, end_did, id'),
      this.database.query<ProviderMappingRow[]>('select * from did_provider_mapping order by id'),
      this.listTrunkRows(),
      this.database.query<DispatcherRow[]>('select id, setid, destination, state, description from dispatcher order by id'),
    ]);

    return routes.map((route) => {
      const endDid = route.end_did || route.start_did;
      const mapping = mappings.find((candidate) =>
        candidate.start_did === route.start_did && (candidate.end_did || candidate.start_did) === endDid,
      );
      const trunk = trunks.find((candidate) =>
        candidate.provider_dispatcher_set === mapping?.sipline_set_id,
      ) ?? trunks.find((candidate) => candidate.username === route.start_did);
      const destination = dispatchers.find((candidate) => candidate.setid === route.destination_set_id);
      const destinationMatch = destination?.destination.match(/^sip:([^:]+):(\d+)$/);

      return {
        ...route,
        end_did: endDid,
        trunk_id: trunk?.id ?? null,
        trunk_name: trunk?.name ?? mapping?.provider ?? 'Unassigned',
        provider_set_id: mapping?.sipline_set_id ?? trunk?.provider_dispatcher_set ?? null,
        application_name: destination?.description || route.description || `Set ${route.destination_set_id}`,
        application_destination: destination?.destination ?? null,
        application_ip: destinationMatch?.[1] ?? null,
        application_port: destinationMatch ? Number(destinationMatch[2]) : null,
      };
    });
  }

  async getInbound(id: number) {
    const route = (await this.listInbound()).find((candidate) => candidate.id === id);
    if (!route) throw new NotFoundException('Inbound route not found.');
    return route;
  }

  async createInbound(input: InboundRouteInputDto) {
    const routeId = await this.database.transaction(async (connection) => {
      const trunk = await this.findTrunk(input.trunkId, connection);
      const endDid = input.endDid?.trim() || input.startDid;
      await this.ensureInboundRangeAvailable(input.startDid, endDid, connection);
      await this.upsertApplicationDestination(input, connection);
      const result = await this.database.query<ResultSetHeader>(
        `insert into did_mapping (start_did, end_did, destination_set_id, description)
         values (:startDid, :endDid, :destinationSetId, :description)`,
        {
          startDid: input.startDid,
          endDid,
          destinationSetId: input.destinationSetId,
          description: (input.description?.trim() || input.applicationName).slice(0, 100),
        },
        connection,
      );
      await this.upsertProviderMapping(input.startDid, endDid, trunk, connection);
      return result.insertId;
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('inbound-route.create', 'system', `inbound-route:${routeId}`, { input, reload });
    return { route: await this.getInbound(routeId), reload };
  }

  async updateInbound(id: number, input: InboundRouteInputDto) {
    const previous = await this.findInbound(id);
    await this.database.transaction(async (connection) => {
      const trunk = await this.findTrunk(input.trunkId, connection);
      const endDid = input.endDid?.trim() || input.startDid;
      await this.ensureInboundRangeAvailable(input.startDid, endDid, connection, id);
      await this.upsertApplicationDestination(input, connection);
      await this.database.query(
        `update did_mapping
         set start_did = :startDid, end_did = :endDid, destination_set_id = :destinationSetId,
             description = :description
         where id = :id`,
        {
          id,
          startDid: input.startDid,
          endDid,
          destinationSetId: input.destinationSetId,
          description: (input.description?.trim() || input.applicationName).slice(0, 100),
        },
        connection,
      );
      await this.upsertProviderMapping(input.startDid, endDid, trunk, connection, previous);
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('inbound-route.update', 'system', `inbound-route:${id}`, { input, reload });
    return { route: await this.getInbound(id), reload };
  }

  async listOutbound() {
    const [routes, trunks, dispatchers, addresses] = await Promise.all([
      this.database.query<OutboundRow[]>('select * from prefix_mapping order by prefix, id'),
      this.listTrunkRows(),
      this.database.query<DispatcherRow[]>('select id, setid, destination, state, description from dispatcher order by id'),
      this.database.query<AddressRow[]>("select ip, pattern from address where grp = 1 and proto = 'udp' order by id"),
    ]);

    return routes.map((route) => {
      const trunk = trunks.find((candidate) => candidate.provider_dispatcher_set === route.sipline_set_id);
      const destination = dispatchers.find((candidate) => candidate.setid === route.sipline_set_id);
      return {
        ...route,
        strip_prefix: Boolean(route.strip_prefix),
        trunk_id: trunk?.id ?? null,
        trunk_name: trunk?.name ?? route.description ?? 'Unassigned',
        provider_destination: destination?.destination ?? null,
        pilot_cli: addresses.find((candidate) => candidate.ip === trunk?.provider_ip)?.pattern ?? trunk?.username ?? null,
      };
    });
  }

  async getOutbound(id: number) {
    const route = (await this.listOutbound()).find((candidate) => candidate.id === id);
    if (!route) throw new NotFoundException('Outbound route not found.');
    return route;
  }

  async createOutbound(input: OutboundRouteInputDto) {
    const routeId = await this.database.transaction(async (connection) => {
      const trunk = await this.findTrunk(input.trunkId, connection);
      await this.ensurePrefixAvailable(input.prefix, connection);
      const result = await this.database.query<ResultSetHeader>(
        `insert into prefix_mapping (prefix, sipline_set_id, description, routing_mode, strip_prefix)
         values (:prefix, :setId, :description, :routingMode, :stripPrefix)`,
        this.outboundParams(input, trunk),
        connection,
      );
      await this.upsertProviderAddress(trunk, input.pilotCli, connection);
      return result.insertId;
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('outbound-route.create', 'system', `outbound-route:${routeId}`, { input, reload });
    return { route: await this.getOutbound(routeId), reload };
  }

  async updateOutbound(id: number, input: OutboundRouteInputDto) {
    await this.findOutbound(id);
    await this.database.transaction(async (connection) => {
      const trunk = await this.findTrunk(input.trunkId, connection);
      await this.ensurePrefixAvailable(input.prefix, connection, id);
      await this.database.query(
        `update prefix_mapping
         set prefix = :prefix, sipline_set_id = :setId, description = :description,
             routing_mode = :routingMode, strip_prefix = :stripPrefix
         where id = :id`,
        { id, ...this.outboundParams(input, trunk) },
        connection,
      );
      await this.upsertProviderAddress(trunk, input.pilotCli, connection);
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('outbound-route.update', 'system', `outbound-route:${id}`, { input, reload });
    return { route: await this.getOutbound(id), reload };
  }

  private async listTrunkRows(connection?: DbConnection) {
    return this.database.query<TrunkRow[]>(
      `select id, name, provider_ip, provider_port, username, provider_dispatcher_set
       from sbc_trunks order by name`,
      {},
      connection,
    );
  }

  private async findTrunk(id: number, connection?: DbConnection) {
    const rows = await this.database.query<TrunkRow[]>(
      `select id, name, provider_ip, provider_port, username, provider_dispatcher_set
       from sbc_trunks where id = :id limit 1`,
      { id },
      connection,
    );
    if (!rows[0]) throw new NotFoundException('Trunk not found.');
    return rows[0];
  }

  private async findInbound(id: number) {
    const rows = await this.database.query<InboundRow[]>('select * from did_mapping where id = :id limit 1', { id });
    if (!rows[0]) throw new NotFoundException('Inbound route not found.');
    return rows[0];
  }

  private async findOutbound(id: number) {
    const rows = await this.database.query<OutboundRow[]>('select * from prefix_mapping where id = :id limit 1', { id });
    if (!rows[0]) throw new NotFoundException('Outbound route not found.');
    return rows[0];
  }

  private async ensureInboundRangeAvailable(startDid: string, endDid: string, connection: DbConnection, id?: number) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from did_mapping
       where start_did = :startDid and coalesce(end_did, start_did) = :endDid
         and (:id is null or id <> :id)
       limit 1`,
      { startDid, endDid, id: id ?? null },
      connection,
    );
    if (rows[0]) throw new BadRequestException('An inbound route already exists for this DID range.');
  }

  private async ensurePrefixAvailable(prefix: string, connection: DbConnection, id?: number) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from prefix_mapping where prefix = :prefix and (:id is null or id <> :id) limit 1`,
      { prefix, id: id ?? null },
      connection,
    );
    if (rows[0]) throw new BadRequestException('An outbound route already exists for this prefix.');
  }

  private async upsertApplicationDestination(input: InboundRouteInputDto, connection: DbConnection) {
    const destination = `sip:${input.applicationIp}:${input.applicationPort}`;
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from dispatcher where setid = :setId and destination = :destination limit 1`,
      { setId: input.destinationSetId, destination },
      connection,
    );
    const params = { setId: input.destinationSetId, destination, description: input.applicationName.slice(0, 64) };
    if (rows[0]) {
      await this.database.query(
        `update dispatcher set description = :description, state = 0
         where setid = :setId and destination = :destination`,
        params,
        connection,
      );
    } else {
      await this.database.query(
        `insert into dispatcher (setid, destination, socket, state, weight, priority, attrs, description)
         values (:setId, :destination, null, 0, 1, 0, '', :description)`,
        params,
        connection,
      );
    }

    await this.upsertAddress(2, input.applicationIp, input.applicationPort, input.startDid, connection);
  }

  private async upsertProviderMapping(
    startDid: string,
    endDid: string,
    trunk: TrunkRow,
    connection: DbConnection,
    previous?: InboundRow,
  ) {
    const previousEnd = previous?.end_did || previous?.start_did;
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from did_provider_mapping
       where start_did = :startDid and coalesce(end_did, start_did) = :endDid
       order by id limit 1`,
      { startDid: previous?.start_did ?? startDid, endDid: previousEnd ?? endDid },
      connection,
    );
    const params = {
      id: rows[0]?.id,
      startDid,
      endDid,
      provider: trunk.name.slice(0, 20),
      setId: trunk.provider_dispatcher_set,
      description: `${trunk.name} inbound`.slice(0, 255),
    };
    if (rows[0]) {
      await this.database.query(
        `update did_provider_mapping
         set start_did = :startDid, end_did = :endDid, provider = :provider,
             sipline_set_id = :setId, description = :description
         where id = :id`,
        params,
        connection,
      );
    } else {
      await this.database.query(
        `insert into did_provider_mapping
         (start_did, end_did, provider, sipline_set_id, description)
         values (:startDid, :endDid, :provider, :setId, :description)`,
        params,
        connection,
      );
    }
  }

  private outboundParams(input: OutboundRouteInputDto, trunk: TrunkRow) {
    return {
      prefix: input.prefix,
      setId: trunk.provider_dispatcher_set,
      description: (input.description?.trim() || trunk.name).slice(0, 64),
      routingMode: input.routingMode ?? 'dial_prefix',
      stripPrefix: input.stripPrefix ? 1 : 0,
    };
  }

  private async upsertProviderAddress(trunk: TrunkRow, pattern: string, connection: DbConnection) {
    await this.upsertAddress(1, trunk.provider_ip, trunk.provider_port, pattern, connection);
  }

  private async upsertAddress(group: number, ip: string, port: number, pattern: string, connection: DbConnection) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from address where grp = :group and ip = :ip and proto = 'udp' order by id limit 1`,
      { group, ip },
      connection,
    );
    const params = { group, ip, port, pattern: pattern.slice(0, 64), contextInfo: 'sbc-ui' };
    if (rows[0]) {
      await this.database.query(
        `update address set mask = 32, port = :port, pattern = :pattern, context_info = :contextInfo
         where grp = :group and ip = :ip and proto = 'udp'`,
        params,
        connection,
      );
    } else {
      await this.database.query(
        `insert into address (grp, ip, mask, port, proto, pattern, context_info)
         values (:group, :ip, 32, :port, 'udp', :pattern, :contextInfo)`,
        params,
        connection,
      );
    }
  }
}
