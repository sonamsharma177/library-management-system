-- =====================================================================
-- Row level security
--   viewer : read everything
--   editor : edit products
--   admin  : edit products, categories, attributes, roles
-- Sync tables are written only by edge functions (service role bypasses RLS).
-- =====================================================================
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

alter table public.profiles             enable row level security;
alter table public.categories           enable row level security;
alter table public.attribute_definitions enable row level security;
alter table public.category_attributes  enable row level security;
alter table public.products             enable row level security;
alter table public.product_history      enable row level security;
alter table public.wc_product_map       enable row level security;
alter table public.sync_jobs            enable row level security;
alter table public.sync_log             enable row level security;
alter table public.sync_state           enable row level security;

-- profiles
create policy "read own or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_role_name() = 'admin');
create policy "admin updates roles" on public.profiles for update to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');

-- everyone signed in can read the catalog
create policy "read" on public.categories            for select to authenticated using (true);
create policy "read" on public.attribute_definitions for select to authenticated using (true);
create policy "read" on public.category_attributes   for select to authenticated using (true);
create policy "read" on public.products              for select to authenticated using (true);
create policy "read" on public.product_history       for select to authenticated using (true);
create policy "read" on public.wc_product_map        for select to authenticated using (true);
create policy "read" on public.sync_jobs             for select to authenticated using (true);
create policy "read" on public.sync_log              for select to authenticated using (true);

-- products: editors and admins write
create policy "editors insert" on public.products for insert to authenticated
  with check (public.current_role_name() in ('admin', 'editor'));
create policy "editors update" on public.products for update to authenticated
  using (public.current_role_name() in ('admin', 'editor')) with check (public.current_role_name() in ('admin', 'editor'));
create policy "admins delete" on public.products for delete to authenticated
  using (public.current_role_name() = 'admin');

-- structure: admins write
create policy "admins write" on public.categories            for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');
create policy "admins write" on public.attribute_definitions for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');
create policy "admins write" on public.category_attributes   for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');

-- sync_state: no policies = only the service role can touch it

-- ---------- image storage ----------
insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
on conflict (id) do nothing;

create policy "public read images" on storage.objects for select using (bucket_id = 'product-images');
create policy "editors upload images" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.current_role_name() in ('admin', 'editor'));
create policy "editors replace images" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.current_role_name() in ('admin', 'editor'));
create policy "editors delete images" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.current_role_name() in ('admin', 'editor'));
