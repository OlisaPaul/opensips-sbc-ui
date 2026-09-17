alter table sbc_trunks
  add column if not exists custom_pai_uri varchar(255) null after binding_uri;
