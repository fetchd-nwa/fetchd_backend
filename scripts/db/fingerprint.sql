-- Schema fingerprint: one row per object in schema public. READ-ONLY (catalog SELECTs only).
-- Run identically against: a fresh load of schema.sql (reference), the dev DB, the test volume, production.
-- Two databases have the same schema object iff (kind, name, n, md5) match.
select 'table-columns' as kind, c.table_name::text as name, count(*)::int as n,
       md5(string_agg(c.column_name::text||':'||c.udt_name::text||':'||coalesce(c.character_maximum_length::text,'')||':'||c.is_nullable||':'||coalesce(c.column_default,''), '|' order by c.column_name)) as md5
  from information_schema.columns c
  join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
 where c.table_schema='public' group by c.table_name
union all
select 'table-constraints', con.conrelid::regclass::text, count(*)::int,
       md5(string_agg(con.conname::text||':'||con.contype::text||':'||pg_get_constraintdef(con.oid), '|' order by con.conname))
  from pg_constraint con where con.connamespace='public'::regnamespace and con.conrelid<>0 group by con.conrelid
union all
select 'table-indexes', i.tablename::text, count(*)::int, md5(string_agg(i.indexdef, '|' order by i.indexname))
  from pg_indexes i where i.schemaname='public' group by i.tablename
union all
select 'table-triggers', tg.tgrelid::regclass::text, count(*)::int, md5(string_agg(pg_get_triggerdef(tg.oid), '|' order by tg.tgname))
  from pg_trigger tg join pg_class cl on cl.oid=tg.tgrelid
 where not tg.tgisinternal and cl.relnamespace='public'::regnamespace group by tg.tgrelid
union all
select 'enum', ty.typname::text, count(*)::int, md5(string_agg(e.enumlabel, ',' order by e.enumsortorder))
  from pg_type ty join pg_enum e on e.enumtypid=ty.oid where ty.typnamespace='public'::regnamespace group by ty.typname
union all
select 'view', v.viewname::text, 1, md5(v.definition) from pg_views v where v.schemaname='public'
union all
select 'function', p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')', 1, md5(pg_get_functiondef(p.oid))
  from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
union all
select 'table-comment', cl.relname::text, 1, md5(coalesce(obj_description(cl.oid,'pg_class'),''))
  from pg_class cl where cl.relnamespace='public'::regnamespace and cl.relkind='r'
order by 1, 2;
