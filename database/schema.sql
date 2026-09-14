create table if not exists sbc_trunks (
  id bigint unsigned not null auto_increment primary key,
  name varchar(128) not null,
  provider_ip varchar(64) not null,
  provider_port int not null default 5060,
  username varchar(128) not null,
  encrypted_password text null,
  registration_enabled tinyint(1) not null default 1,
  registration_server varchar(255) null,
  application_name varchar(128) not null,
  application_ip varchar(64) not null,
  application_port int not null default 5060,
  access_prefix varchar(32) not null,
  strip_prefix tinyint(1) not null default 1,
  pilot_cli varchar(128) not null,
  provider_dispatcher_set int not null default 1,
  application_dispatcher_set int not null default 8,
  created_at timestamp not null default current_timestamp,
  updated_at timestamp not null default current_timestamp on update current_timestamp,
  unique key uniq_sbc_trunks_name (name),
  unique key uniq_sbc_trunks_username (username),
  unique key uniq_sbc_trunks_prefix (access_prefix)
);

create table if not exists sbc_audit_log (
  id bigint unsigned not null auto_increment primary key,
  action varchar(64) not null,
  actor varchar(128) not null,
  target varchar(128) not null,
  payload_json json not null,
  created_at timestamp not null default current_timestamp,
  key idx_sbc_audit_target (target),
  key idx_sbc_audit_created_at (created_at)
);
