export type TrunkInput = {
  name: string;
  providerIp: string;
  providerPort: number;
  username: string;
  password?: string;
  registrationEnabled: boolean;
  registrationServer?: string;
  providerDispatcherSet: number;
};

export type Trunk = {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  registration_server: string | null;
  registration_enabled: boolean;
  application_name: string | null;
  application_ip: string | null;
  application_port: number | null;
  access_prefix: string | null;
  strip_prefix: boolean | null;
  pilot_cli: string | null;
  provider_dispatcher_set: number;
  application_dispatcher_set: number | null;
};

export type TrunkStatus = {
  trunkId: number;
  registration: { enabled: boolean; ok: boolean; state: string; expires: number | null; error?: string };
  provider: { ok: boolean; setId: number; destination: string; state: string; error?: string };
};

export type InboundRoute = {
  id: number;
  start_did: string;
  end_did: string;
  destination_set_id: number;
  description: string | null;
  trunk_id: number | null;
  trunk_name: string;
  provider_set_id: number | null;
  application_name: string;
  application_destination: string | null;
  application_ip: string | null;
  application_port: number | null;
};

export type InboundRouteInput = {
  startDid: string;
  endDid?: string;
  trunkId: number;
  applicationName: string;
  applicationIp: string;
  applicationPort: number;
  destinationSetId: number;
  description?: string;
};

export type OutboundRoute = {
  id: number;
  prefix: string;
  sipline_set_id: number;
  description: string;
  routing_mode: string;
  strip_prefix: boolean;
  trunk_id: number | null;
  trunk_name: string;
  provider_destination: string | null;
  pilot_cli: string | null;
};

export type OutboundRouteInput = {
  prefix: string;
  trunkId: number;
  pilotCli: string;
  stripPrefix: boolean;
  routingMode?: 'dial_prefix';
  description?: string;
};

export type ProvisionPlan = {
  summary: string[];
  warnings: string[];
  actions: Array<{
    label: string;
    sql?: string;
    mi?: string;
    params?: Record<string, unknown>;
    note?: string;
  }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }

  return response.json() as Promise<T>;
}

export const api = {
  listTrunks: () => request<Trunk[]>('/api/trunks'),
  previewTrunk: (input: TrunkInput) =>
    request<ProvisionPlan>('/api/trunks/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createTrunk: (input: TrunkInput) =>
    request<{ trunk: Trunk }>('/api/trunks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateTrunk: (id: number, input: TrunkInput) =>
    request<{ trunk: Trunk }>(`/api/trunks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  trunkStatuses: () => request<TrunkStatus[]>('/api/trunks/statuses'),
  status: (id: number) => request<TrunkStatus>(`/api/trunks/${id}/status`),
  listInboundRoutes: () => request<InboundRoute[]>('/api/inbound-routes'),
  createInboundRoute: (input: InboundRouteInput) =>
    request<{ route: InboundRoute }>('/api/inbound-routes', { method: 'POST', body: JSON.stringify(input) }),
  updateInboundRoute: (id: number, input: InboundRouteInput) =>
    request<{ route: InboundRoute }>(`/api/inbound-routes/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  listOutboundRoutes: () => request<OutboundRoute[]>('/api/outbound-routes'),
  createOutboundRoute: (input: OutboundRouteInput) =>
    request<{ route: OutboundRoute }>('/api/outbound-routes', { method: 'POST', body: JSON.stringify(input) }),
  updateOutboundRoute: (id: number, input: OutboundRouteInput) =>
    request<{ route: OutboundRoute }>(`/api/outbound-routes/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
};
