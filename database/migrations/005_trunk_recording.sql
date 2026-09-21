alter table sbc_trunks
  add column if not exists recording_enabled tinyint(1) not null default 0 after custom_pai_uri;
