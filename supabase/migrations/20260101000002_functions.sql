-- =====================================================================
-- Validation, completeness, content hash, history, new-user profile
-- =====================================================================

-- Checks that decide whether a product is "complete".
-- Core checks + every attribute marked required for the product's category.
create or replace function public.product_checks(p public.products)
returns table (check_name text, passed boolean)
language sql stable as $$
  select 'name',        length(trim(coalesce(p.name, ''))) > 0
  union all select 'sku',         length(trim(coalesce(p.sku, ''))) > 0
  union all select 'description', length(trim(coalesce(p.description, ''))) >= 50
  union all select 'price',       coalesce(p.price, 0) > 0
  union all select 'image',       jsonb_array_length(p.images) > 0
  union all select 'category',    p.category_id is not null
  union all
  select 'attr:' || d.code,
         coalesce(nullif(trim(p.attributes ->> d.code), '') is not null
                  and p.attributes -> d.code <> '[]'::jsonb, false)
  from public.category_attributes ca
  join public.attribute_definitions d on d.id = ca.attribute_id
  where ca.required and ca.category_id = p.category_id
$$;

-- Returns a list of human-readable problems with the attribute values.
create or replace function public.validate_attributes(p public.products)
returns text[]
language plpgsql stable as $$
declare
  errs text[] := '{}';
  k text; v jsonb; d public.attribute_definitions;
begin
  for k, v in select * from jsonb_each(p.attributes) loop
    select ad.* into d
    from public.attribute_definitions ad
    join public.category_attributes ca on ca.attribute_id = ad.id
    where ad.code = k and ca.category_id = p.category_id;

    if not found then
      errs := errs || format('Attribute "%s" is not defined for this category', k);
      continue;
    end if;
    if v = 'null'::jsonb then continue; end if;

    if d.type = 'number' and jsonb_typeof(v) <> 'number' then
      errs := errs || format('%s must be a number', d.label);
    elsif d.type = 'boolean' and jsonb_typeof(v) <> 'boolean' then
      errs := errs || format('%s must be true or false', d.label);
    elsif d.type = 'select' and (jsonb_typeof(v) <> 'string' or not (d.options ? (v #>> '{}'))) then
      errs := errs || format('%s must be one of: %s', d.label, (select string_agg(o, ', ') from jsonb_array_elements_text(d.options) o));
    elsif d.type = 'multiselect' and (jsonb_typeof(v) <> 'array'
          or exists (select 1 from jsonb_array_elements_text(v) e where not (d.options ? e))) then
      errs := errs || format('%s must be a list of: %s', d.label, (select string_agg(o, ', ') from jsonb_array_elements_text(d.options) o));
    elsif d.type = 'date' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$') then
      errs := errs || format('%s must be a date (YYYY-MM-DD)', d.label);
    elsif d.type in ('text', 'textarea') and jsonb_typeof(v) <> 'string' then
      errs := errs || format('%s must be text', d.label);
    end if;
  end loop;
  return errs;
end $$;

-- Runs before every insert/update on products.
create or replace function public.products_biu()
returns trigger language plpgsql as $$
declare errs text[]; total int; ok int;
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  if new.slug is null or new.slug = '' then
    new.slug := trim(both '-' from regexp_replace(lower(new.name), '[^a-z0-9]+', '-', 'g'));
  end if;

  errs := public.validate_attributes(new);
  if array_length(errs, 1) > 0 then
    raise exception 'Invalid attributes: %', array_to_string(errs, '; ') using errcode = 'check_violation';
  end if;

  select count(*), count(*) filter (where passed) into total, ok from public.product_checks(new);
  new.completeness := round(100.0 * ok / greatest(total, 1));

  if new.status in ('ready', 'published') and new.completeness < 100 then
    raise exception '% is % percent complete; 100 percent is required for status "%"', new.sku, new.completeness, new.status
      using errcode = 'check_violation';
  end if;

  -- Hash of everything the PIM owns and pushes. Stock is excluded on purpose (WooCommerce owns it).
  new.content_hash := md5(jsonb_build_object(
    'name', new.name, 'sku', new.sku, 'description', new.description, 'short_description', new.short_description,
    'price', new.price, 'sale_price', new.sale_price, 'category_id', new.category_id, 'status', new.status,
    'attributes', new.attributes, 'images', new.images)::text);
  return new;
end $$;

create trigger products_biu before insert or update on public.products
for each row execute function public.products_biu();

-- Field-level change history.
create or replace function public.products_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb;
begin
  if tg_op = 'INSERT' then
    insert into product_history(product_id, op, changes, changed_by) values (new.id, 'insert', jsonb_build_object('sku', jsonb_build_object('new', new.sku)), auth.uid());
  elsif tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', to_jsonb(old) -> n.key, 'new', n.value)), '{}')
      into diff
    from jsonb_each(to_jsonb(new)) n
    where n.key not in ('updated_at', 'updated_by', 'completeness', 'content_hash')
      and to_jsonb(old) -> n.key is distinct from n.value;
    if diff <> '{}' then
      insert into product_history(product_id, op, changes, changed_by) values (new.id, 'update', diff, auth.uid());
    end if;
  end if;
  return null;
end $$;

create trigger products_audit after insert or update on public.products
for each row execute function public.products_audit();

-- Every new auth user gets a profile. The very first user becomes admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, case when not exists (select 1 from public.profiles) then 'admin' else 'viewer' end)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();
