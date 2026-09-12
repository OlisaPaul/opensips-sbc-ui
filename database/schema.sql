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

set @index_exists = (
  select count(*) from information_schema.statistics
  where table_schema = database() and table_name = 'registrant' and index_name = 'uniq_registrant_aor'
);
set @sql = if(@index_exists = 0,
  'alter table registrant add unique key uniq_registrant_aor (aor)',
  'select ''registrant index already exists'''
);
prepare stmt from @sql;
execute stmt;
deallocate prepare stmt;

set @index_exists = (
  select count(*) from information_schema.statistics
  where table_schema = database() and table_name = 'dispatcher' and index_name = 'uniq_dispatcher_set_destination'
);
set @sql = if(@index_exists = 0,
  'alter table dispatcher add unique key uniq_dispatcher_set_destination (setid, destination)',
  'select ''dispatcher index already exists'''
);
prepare stmt from @sql;
execute stmt;
deallocate prepare stmt;

set @index_exists = (
  select count(*) from information_schema.statistics
  where table_schema = database() and table_name = 'address' and index_name = 'uniq_address_group_ip_proto'
);
set @sql = if(@index_exists = 0,
  'alter table address add unique key uniq_address_group_ip_proto (grp, ip, proto)',
  'select ''address index already exists'''
);
prepare stmt from @sql;
execute stmt;
deallocate prepare stmt;

set @index_exists = (
  select count(*) from information_schema.statistics
  where table_schema = database() and table_name = 'did_mapping' and index_name = 'uniq_did_mapping_did'
);
set @sql = if(@index_exists = 0,
  'alter table did_mapping add unique key uniq_did_mapping_did (did)',
  'select ''did_mapping index already exists'''
);
prepare stmt from @sql;
execute stmt;
deallocate prepare stmt;

set @index_exists = (
  select count(*) from information_schema.statistics
  where table_schema = database() and table_name = 'prefix_mapping' and index_name = 'uniq_prefix_mapping_prefix'
);
set @sql = if(@index_exists = 0,
  'alter table prefix_mapping add unique key uniq_prefix_mapping_prefix (prefix)',
  'select ''prefix_mapping index already exists'''
);
prepare stmt from @sql;
execute stmt;
deallocate prepare stmt;
