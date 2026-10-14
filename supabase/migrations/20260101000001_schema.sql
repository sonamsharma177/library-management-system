-- =====================================================================
-- Ledger PIM: core schema
-- Products, categories, attribute definitions, WooCommerce sync tables
-- =====================================================================
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create type public.product_status  as enum ('draft', 'ready', 'published', 'archived');
create type public.attribute_type  as enum ('text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date');

-- ---------- people ----------
create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text,
  role       text not null default 'viewer' check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

-- ---------- taxonomy ----------
create table public.categories (
  id             uuid primary key default gen_random_uuid(),
  parent_id      uuid references public.categories(id) on delete set null,
  name           text not null,
  slug           text not null unique,
  wc_category_id bigint,                       -- id of the matching WooCommerce category
  position       int  not null default 0,
  created_at     timestamptz not null default now()
);

-- ---------- attributes ----------
-- What a piece of product data IS (type, allowed values, unit).
create table public.attribute_definitions (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  type       public.attribute_type not null,
  options    jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  unit       text,
  help_text  text not null default '',
  wc_visible boolean not null default true,    -- "visible on the product page" in WooCommerce
  created_at timestamptz not null default now(),
  check (type not in ('select', 'multiselect') or jsonb_array_length(options) > 0)
);

-- Which attributes a category's products carry, and which are required.
create table public.category_attributes (
  category_id  uuid not null references public.categories(id) on delete cascade,
  attribute_id uuid not null references public.attribute_definitions(id) on delete cascade,
  required     boolean not null default false,
  position     int not null default 0,
  primary key (category_id, attribute_id)
);

-- ---------- products ----------
create table public.products (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique check (length(trim(sku)) > 0),
  name              text not null check (length(trim(name)) > 0),
  slug              text,
  description       text not null default '',
  short_description text not null default '',
  category_id       uuid references public.categories(id) on delete set null,
  status            public.product_status not null default 'draft',
  price             numeric(12,2) check (price is null or price >= 0),
  sale_price        numeric(12,2) check (sale_price is null or sale_price >= 0),
  stock_quantity    int not null default 0,                 -- owned by WooCommerce, written by sync
  attributes        jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  images            jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array'),  -- [{url, alt}]
  completeness      smallint not null default 0,            -- set by trigger
  content_hash      text,                                   -- set by trigger; changes when PIM-owned data changes
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users on delete set null
);
create index products_category_idx   on public.products (category_id);
create index products_status_idx     on public.products (status);
create index products_attributes_gin on public.products using gin (attributes jsonb_path_ops);
create index products_name_trgm      on public.products using gin (name gin_trgm_ops);

-- ---------- history ----------
create table public.product_history (
  id         bigserial primary key,
  product_id uuid not null,
  op         text not null,
  changes    jsonb not null,                -- {field: {old, new}}
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index product_history_product_idx on public.product_history (product_id, changed_at desc);

-- ---------- WooCommerce sync ----------
create table public.wc_product_map (
  product_id       uuid primary key references public.products(id) on delete cascade,
  wc_product_id    bigint unique,            -- null after the store product is deleted
  state            text not null default 'synced' check (state in ('synced', 'conflict', 'error')),
  last_synced_hash text,                     -- products.content_hash at the last successful push
  last_synced_at   timestamptz,
  wc_modified_at   timestamptz,
  wc_snapshot      jsonb,                    -- store values of PIM-owned fields as last seen (+ image_urls)
  conflict         jsonb,                    -- [{field, pim, wc}] while state = 'conflict'
  last_error       text
);

create table public.sync_jobs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('push', 'pull', 'webhook')),
  status      text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  total       int not null default 0,
  succeeded   int not null default 0,
  failed      int not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create table public.sync_log (
  id         bigserial primary key,
  job_id     uuid references public.sync_jobs(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  level      text not null default 'info' check (level in ('info', 'warn', 'error')),
  message    text not null,
  created_at timestamptz not null default now()
);
create index sync_log_created_idx on public.sync_log (created_at desc);

create table public.sync_state (key text primary key, value text not null);

-- Derived view: what should the UI show for each product?
create or replace view public.product_sync_status with (security_invoker = true) as
select p.id as product_id, p.sku, p.status,
       case when m.product_id is null then 'never'
            when m.state in ('conflict', 'error') then m.state
            when m.last_synced_hash is distinct from p.content_hash then 'pending'
            else 'synced' end as sync_state,
       m.wc_product_id, m.last_synced_at
from public.products p
left join public.wc_product_map m on m.product_id = p.id;
