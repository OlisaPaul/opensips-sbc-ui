create table if not exists sbc_application_destination_groups (
  id bigint unsigned not null auto_increment primary key,
  name varchar(100) not null,
  dispatcher_set_id int not null,
  created_at timestamp not null default current_timestamp,
  updated_at timestamp not null default current_timestamp on update current_timestamp,
  unique key uniq_sbc_application_destination_set (dispatcher_set_id)
);

insert ignore into sbc_application_destination_groups (name, dispatcher_set_id)
select left(coalesce(nullif(min(m.description), ''), nullif(min(d.description), ''), concat('Application set ', m.destination_set_id)), 100),
       m.destination_set_id
from did_mapping m
left join dispatcher d on d.setid = m.destination_set_id
group by m.destination_set_id;
