export type TrunkInput = {
  name: string;
  providerIp: string;
  providerPort: number;
  username: string;
  password?: string;
  registrationEnabled: boolean;
  registrationServer?: string;
  applicationName: string;
  applicationIp: string;
  applicationPort: number;
  accessPrefix: string;
  stripPrefix: boolean;
  pilotCli: string;
  providerDispatcherSet?: number;
  applicationDispatcherSet?: number;
};

export type Trunk = {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  registration_server: string | null;
  registration_enabled: boolean;
  application_name: string;
  application_ip: string;
  application_port: number;
  access_prefix: string;
  strip_prefix: boolean;
  pilot_cli: string;
  provider_dispatcher_set: number;
  application_dispatcher_set: number;
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
  status: (id: number) => request<unknown>(`/api/trunks/${id}/status`),
};
