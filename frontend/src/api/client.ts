export type TrunkInput = {
  name: string;
  providerIp: string;
  providerPort: number;
  username: string;
  password?: string;
  registrationEnabled: boolean;
  registrationExpiry?: number;
  registrationServer?: string;
  bindingUri?: string;
  customPaiUri?: string;
  recordingEnabled: boolean;
  providerDispatcherSet: number;
};

export type Trunk = {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  enabled: boolean;
  registration_server: string | null;
  registration_enabled: boolean;
  registration_expiry: number;
  binding_uri: string | null;
  custom_pai_uri: string | null;
  recording_enabled: boolean;
  application_name: string | null;
  application_ip: string | null;
  application_port: number | null;
  access_prefix: string | null;
  strip_prefix: boolean | null;
  pilot_cli: string | null;
  provider_dispatcher_set: number;
  application_dispatcher_set: number | null;
};

export type Recording = {
  id: string;
  recordedAt: string;
  callStartedAt: string | null;
  callerNumber: string | null;
  calledNumber: string | null;
  sizeBytes: number;
  playable: boolean;
};

export type TrunkStatus = {
  trunkId: number;
  enabled: boolean;
  registration: { enabled: boolean; ok: boolean; state: string; expires: number | null; error?: string };
  provider: { ok: boolean; setId: number; destination: string; state: string; error?: string };
};

export type ProviderDispatcherSet = {
  setId: number;
  trunks: string[];
  destinations: Array<{ destination: string; description: string; state: number }>;
};

export type ProviderDispatcherSets = {
  sets: ProviderDispatcherSet[];
  usedSetIds: number[];
  nextSetId: number;
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
  destination_group_id: number | null;
};

export type InboundRouteInput = {
  startDid: string;
  endDid?: string;
  trunkId: number;
  destinationGroupId: number;
  description?: string;
};

export type ApplicationDestination = {
  id: number;
  name: string;
  dispatcherSetId: number;
  destinations: Array<{
    id: number;
    destination: string;
    ip: string | null;
    port: number | null;
    state: number;
    description: string;
  }>;
  routeCount: number;
  conflicts: string[];
};

export type ApplicationDestinationInput = {
  name: string;
  ip: string;
  port: number;
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
  listRecordings: () => request<Recording[]>('/api/recordings'),
  recordingAudio: (id: string, download = false) => `/api/recordings/${encodeURIComponent(id)}/audio${download ? '?download=1' : ''}`,
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
  setTrunkEnabled: (id: number, enabled: boolean) =>
    request<{ trunk: Trunk }>(`/api/trunks/${id}/enabled`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  trunkStatuses: () => request<TrunkStatus[]>('/api/trunks/statuses'),
  providerSets: () => request<ProviderDispatcherSets>('/api/trunks/provider-sets'),
  status: (id: number) => request<TrunkStatus>(`/api/trunks/${id}/status`),
  listApplicationDestinations: () => request<ApplicationDestination[]>('/api/application-destinations'),
  createApplicationDestination: (input: ApplicationDestinationInput) =>
    request<{ destination: ApplicationDestination }>('/api/application-destinations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
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
