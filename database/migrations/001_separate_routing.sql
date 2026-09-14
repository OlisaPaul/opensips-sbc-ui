alter table sbc_trunks
  modify application_name varchar(128) null,
  modify application_ip varchar(64) null,
  modify application_port int null,
  modify access_prefix varchar(32) null,
  modify strip_prefix tinyint(1) null,
  modify pilot_cli varchar(128) null,
  modify application_dispatcher_set int null;
