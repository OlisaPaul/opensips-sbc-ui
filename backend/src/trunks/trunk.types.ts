export type Trunk = {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  registration_server: string | null;
  registration_enabled: number;
  application_name: string;
  application_ip: string;
  application_port: number;
  access_prefix: string;
  strip_prefix: number;
  pilot_cli: string;
  provider_dispatcher_set: number;
  application_dispatcher_set: number;
  created_at: string;
  updated_at: string;
};

export type PlannedAction = {
  label: string;
  sql?: string;
  params?: Record<string, unknown>;
  mi?: string;
  note?: string;
};

export type ProvisionPlan = {
  summary: string[];
  actions: PlannedAction[];
  warnings: string[];
};
