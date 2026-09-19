import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuditService } from '../audit/audit.service';
import { DatabaseService, DbConnection } from '../database/database.service';
import { MiService } from '../mi/mi.service';
import { ApplicationDestinationInputDto, InboundRouteInputDto, OutboundRouteInputDto } from './dto';

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

type ApplicationDestinationGroupRow = RowDataPacket & {
  id: number;
  name: string;
  dispatcher_set_id: number;
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

  async listApplicationDestinations() {
    const [groups, dispatchers, routes, providerSets] = await Promise.all([
      this.database.query<ApplicationDestinationGroupRow[]>(
        'select id, name, dispatcher_set_id from sbc_application_destination_groups order by name, id',
      ),
      this.database.query<DispatcherRow[]>(
        'select id, setid, destination, state, description from dispatcher order by setid, id',
      ),
      this.database.query<(RowDataPacket & { destination_set_id: number })[]>(
        'select destination_set_id from did_mapping',
      ),
      this.database.query<(RowDataPacket & { provider_dispatcher_set: number })[]>(
        'select provider_dispatcher_set from sbc_trunks',
      ),
    ]);
    const providerSetIds = new Set(providerSets.map((row) => Number(row.provider_dispatcher_set)));
    const providerDestinations = new Set(
      dispatchers.filter((row) => providerSetIds.has(Number(row.setid))).map((row) => row.destination),
    );

    return groups.map((group) => {
      const destinations = dispatchers
        .filter((row) => Number(row.setid) === Number(group.dispatcher_set_id))
        .map((row) => ({
          id: Number(row.id),
          destination: row.destination,
          ...this.parseSipDestination(row.destination),
          state: Number(row.state),
          description: row.description,
        }));
      const conflicts = destinations
        .filter((destination) => providerDestinations.has(destination.destination))
        .map((destination) => `${destination.destination} is also assigned to a provider group`);
      if (providerSetIds.has(Number(group.dispatcher_set_id))) {
        conflicts.unshift(`Set ${group.dispatcher_set_id} is also assigned to a provider trunk`);
      }
      return {
        id: Number(group.id),
        name: group.name,
        dispatcherSetId: Number(group.dispatcher_set_id),
        destinations,
        routeCount: routes.filter((route) => Number(route.destination_set_id) === Number(group.dispatcher_set_id)).length,
        conflicts,
      };
    });
  }

  async createApplicationDestination(input: ApplicationDestinationInputDto) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Application destination name is required.');
    const destination = this.formatSipDestination(input.ip, input.port);
    const groupId = await this.database.transaction(async (connection) => {
      const existingName = await this.database.query<(RowDataPacket & { id: number })[]>(
        'select id from sbc_application_destination_groups where lower(name) = lower(:name) limit 1',
        { name },
        connection,
      );
      if (existingName[0]) throw new BadRequestException('An application destination with this name already exists.');

      const existingDestination = await this.database.query<(RowDataPacket & { setid: number })[]>(
        'select setid from dispatcher where destination = :destination order by id limit 1',
        { destination },
        connection,
      );
      if (existingDestination[0]) {
        throw new BadRequestException(
          `${destination} already belongs to dispatcher set ${existingDestination[0].setid}. Select that destination or correct the existing dispatcher data.`,
        );
      }

      const setId = await this.nextDispatcherSetId(connection);
      const result = await this.database.query<ResultSetHeader>(
        `insert into sbc_application_destination_groups (name, dispatcher_set_id)
         values (:name, :setId)`,
        { name, setId },
        connection,
      );
      await this.database.query(
        `insert into dispatcher (setid, destination, socket, state, weight, priority, attrs, description)
         values (:setId, :destination, null, 0, 1, 0, '', :description)`,
        { setId, destination, description: name.slice(0, 64) },
        connection,
      );
      return result.insertId;
    });

    const reload = await this.mi.reloadProvisioning();
    await this.audit.record('application-destination.create', 'system', `application-destination:${groupId}`, { input, reload });
    const group = (await this.listApplicationDestinations()).find((candidate) => candidate.id === groupId);
    if (!group) throw new NotFoundException('The application destination was created but could not be loaded.');
    return { destination: group, reload };
  }

  async listInbound() {
    const [routes, mappings, trunks, dispatchers, groups] = await Promise.all([
      this.database.query<InboundRow[]>('select * from did_mapping order by start_did, end_did, id'),
      this.database.query<ProviderMappingRow[]>('select * from did_provider_mapping order by id'),
      this.listTrunkRows(),
      this.database.query<DispatcherRow[]>('select id, setid, destination, state, description from dispatcher order by id'),
      this.database.query<ApplicationDestinationGroupRow[]>(
        'select id, name, dispatcher_set_id from sbc_application_destination_groups order by id',
      ),
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
      const group = groups.find((candidate) => Number(candidate.dispatcher_set_id) === Number(route.destination_set_id));
      const destinationMatch = destination?.destination.match(/^sip:([^:]+):(\d+)$/);

      return {
        ...route,
        end_did: endDid,
        trunk_id: trunk?.id ?? null,
        trunk_name: trunk?.name ?? mapping?.provider ?? 'Unassigned',
        provider_set_id: mapping?.sipline_set_id ?? trunk?.provider_dispatcher_set ?? null,
        application_name: group?.name || destination?.description || route.description || `Set ${route.destination_set_id}`,
        destination_group_id: group?.id ?? null,
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
      const startDid = input.startDid.trim();
      const endDid = input.endDid?.trim() || startDid;
      this.validateDidRange(startDid, endDid);
      await this.ensureInboundRangeAvailable(startDid, endDid, connection);
      const destinationGroup = await this.findApplicationDestinationGroup(input.destinationGroupId, connection);
      const result = await this.database.query<ResultSetHeader>(
        `insert into did_mapping (start_did, end_did, destination_set_id, description)
         values (:startDid, :endDid, :destinationSetId, :description)`,
        {
          startDid,
          endDid,
          destinationSetId: destinationGroup.dispatcher_set_id,
          description: (input.description?.trim() || destinationGroup.name).slice(0, 100),
        },
        connection,
      );
      await this.upsertProviderMapping(startDid, endDid, trunk, connection);
      await this.authorizeApplicationDestination(destinationGroup, startDid, connection);
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
      const startDid = input.startDid.trim();
      const endDid = input.endDid?.trim() || startDid;
      this.validateDidRange(startDid, endDid);
      await this.ensureInboundRangeAvailable(startDid, endDid, connection, id);
      const destinationGroup = await this.findApplicationDestinationGroup(input.destinationGroupId, connection);
      await this.database.query(
        `update did_mapping
         set start_did = :startDid, end_did = :endDid, destination_set_id = :destinationSetId,
             description = :description
         where id = :id`,
        {
          id,
          startDid,
          endDid,
          destinationSetId: destinationGroup.dispatcher_set_id,
          description: (input.description?.trim() || destinationGroup.name).slice(0, 100),
        },
        connection,
      );
      await this.upsertProviderMapping(startDid, endDid, trunk, connection, previous);
      await this.authorizeApplicationDestination(destinationGroup, startDid, connection);
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
    const rows = await this.database.query<(RowDataPacket & { id: number; start_did: string; end_did: string | null })[]>(
      `select id, start_did, end_did from did_mapping
       where (:id is null or id <> :id)`,
      { id: id ?? null },
      connection,
    );
    const requested = this.didRange(startDid, endDid);
    const overlap = rows.find((row) => {
      const existingEnd = row.end_did || row.start_did;
      if (!this.compatibleDidFormats(startDid, row.start_did) || !this.compatibleDidFormats(endDid, existingEnd)) return false;
      const existing = this.didRange(row.start_did, existingEnd);
      return requested.start <= existing.end && requested.end >= existing.start;
    });
    if (overlap) {
      throw new BadRequestException(
        `This DID range overlaps inbound route ${overlap.id} (${overlap.start_did}–${overlap.end_did || overlap.start_did}).`,
      );
    }
  }

  private async ensurePrefixAvailable(prefix: string, connection: DbConnection, id?: number) {
    const rows = await this.database.query<(RowDataPacket & { id: number })[]>(
      `select id from prefix_mapping where prefix = :prefix and (:id is null or id <> :id) limit 1`,
      { prefix, id: id ?? null },
      connection,
    );
    if (rows[0]) throw new BadRequestException('An outbound route already exists for this prefix.');
  }

  private async findApplicationDestinationGroup(id: number, connection: DbConnection) {
    const groups = await this.database.query<ApplicationDestinationGroupRow[]>(
      `select id, name, dispatcher_set_id
       from sbc_application_destination_groups where id = :id limit 1`,
      { id },
      connection,
    );
    const group = groups[0];
    if (!group) throw new NotFoundException('Application destination not found.');

    const providerSet = await this.database.query<(RowDataPacket & { id: number })[]>(
      'select id from sbc_trunks where provider_dispatcher_set = :setId limit 1',
      { setId: group.dispatcher_set_id },
      connection,
    );
    if (providerSet[0]) {
      throw new BadRequestException(`Destination set ${group.dispatcher_set_id} is also assigned to a provider trunk.`);
    }

    const destinations = await this.database.query<DispatcherRow[]>(
      `select id, setid, destination, state, description
       from dispatcher where setid = :setId order by id`,
      { setId: group.dispatcher_set_id },
      connection,
    );
    if (!destinations[0]) throw new BadRequestException('The selected application destination has no dispatcher gateway.');

    const duplicate = await this.database.query<(RowDataPacket & { destination: string; provider_set: number })[]>(
      `select app.destination, provider.setid as provider_set
       from dispatcher app
       join dispatcher provider on provider.destination = app.destination and provider.setid <> app.setid
       join sbc_trunks trunk on trunk.provider_dispatcher_set = provider.setid
       where app.setid = :setId
       limit 1`,
      { setId: group.dispatcher_set_id },
      connection,
    );
    if (duplicate[0]) {
      throw new BadRequestException(
        `${duplicate[0].destination} is also assigned to provider set ${duplicate[0].provider_set}. Correct the dispatcher data before using this destination.`,
      );
    }
    return { ...group, destinations };
  }

  private async authorizeApplicationDestination(
    group: ApplicationDestinationGroupRow & { destinations: DispatcherRow[] },
    pattern: string,
    connection: DbConnection,
  ) {
    const parsed = this.parseSipDestination(group.destinations[0].destination);
    if (!parsed.ip || !parsed.port) {
      throw new BadRequestException(`Unsupported SIP destination: ${group.destinations[0].destination}`);
    }
    await this.upsertAddress(2, parsed.ip, parsed.port, pattern, connection);
  }

  private async nextDispatcherSetId(connection: DbConnection) {
    const rows = await this.database.query<(RowDataPacket & { next_set_id: number })[]>(
      `select coalesce(max(set_id), 0) + 1 as next_set_id
       from (
         select setid as set_id from dispatcher
         union all select provider_dispatcher_set from sbc_trunks
         union all select dispatcher_set_id from sbc_application_destination_groups
         union all select destination_set_id from did_mapping
         union all select sipline_set_id from prefix_mapping
       ) used_sets`,
      {},
      connection,
    );
    return Number(rows[0]?.next_set_id ?? 1);
  }

  private validateDidRange(startDid: string, endDid: string) {
    if (!this.compatibleDidFormats(startDid, endDid)) {
      throw new BadRequestException('Start DID and end DID must use the same format and contain the same number of digits.');
    }
    const range = this.didRange(startDid, endDid);
    if (range.end < range.start) throw new BadRequestException('End DID must be greater than or equal to start DID.');
  }

  private compatibleDidFormats(left: string, right: string) {
    return left.startsWith('+') === right.startsWith('+') && left.replace(/^\+/, '').length === right.replace(/^\+/, '').length;
  }

  private didRange(startDid: string, endDid: string) {
    return { start: BigInt(startDid.replace(/^\+/, '')), end: BigInt(endDid.replace(/^\+/, '')) };
  }

  private formatSipDestination(ip: string, port: number) {
    return `sip:${ip.includes(':') ? `[${ip}]` : ip}:${port}`;
  }

  private parseSipDestination(destination: string) {
    const match = destination.match(/^sip:(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    return { ip: match?.[1] ?? match?.[2] ?? null, port: match ? Number(match[3]) : null };
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
