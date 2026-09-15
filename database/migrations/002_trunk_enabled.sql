alter table sbc_trunks
  add column if not exists enabled tinyint(1) not null default 1 after encrypted_password,
  add column if not exists registration_expiry int not null default 3600 after registration_enabled,
  add column if not exists binding_uri varchar(255) null after registration_expiry;

update sbc_trunks t
left join (
  select r.username, r.expiry, r.binding_uri
  from registrant r
  join (
    select username, max(id) as id
    from registrant
    group by username
  ) latest on latest.id = r.id
) registration on registration.username = t.username
set t.registration_expiry = coalesce(registration.expiry, t.registration_expiry, 3600),
    t.binding_uri = coalesce(t.binding_uri, registration.binding_uri)
where registration.username is not null;
