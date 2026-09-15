export type Trunk = {
  id: number;
  name: string;
  provider_ip: string;
  provider_port: number;
  username: string;
  registration_server: string | null;
  registration_enabled: number;
  registration_expiry: number;
  application_name: string | null;
  application_ip: string | null;
  application_port: number | null;
  access_prefix: string | null;
  strip_prefix: number | null;
  pilot_cli: string | null;
  provider_dispatcher_set: number;
  application_dispatcher_set: number | null;
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
