# Ledger: Product Information Manager for WooCommerce on Supabase

A PIM that keeps product data, attributes and categories in a Supabase Postgres database and synchronises them
with a WooCommerce store.

```
web/index.html            The interface (single file, supabase-js loaded from a CDN)
supabase/migrations/      Schema, validation triggers, row level security, optional cron schedule
supabase/seed.sql         Sample categories, attributes and products
supabase/functions/       Edge functions: woo-push, woo-pull, woo-webhook (+ _shared)
supabase/config.toml      Function settings
```

## Design in one page

| Need | How it is done |
|---|---|
| Catalog management | `products` table with a lifecycle `draft → ready → published → archived`. A trigger computes `completeness` and **refuses** `ready`/`published` below 100%. |
| Attribute handling | `attribute_definitions` (type, allowed values, unit) + `category_attributes` (which categories use it, required or not). Values live in `products.attributes jsonb` and are validated by a trigger against the definitions: wrong type, value outside the allowed list, or attribute not in the category's set → the write fails with a readable message. |
| Data synchronisation | `content_hash` changes only when PIM-owned data changes. `wc_product_map` stores the hash last pushed and a snapshot of the store values. Push sends only what changed; pull and webhooks bring stock back and detect edits made in the store. |
| Ownership | **PIM owns** name, descriptions, price, sale price, category, attributes, images. **WooCommerce owns** stock. If a PIM-owned field was changed in the store since the last sync, the product is flagged `conflict` and a person chooses "keep PIM" or "take WooCommerce". Nothing is silently overwritten. |
| Security | Row level security: viewers read, editors edit products, admins also manage structure and roles. Sync tables are written only by edge functions (service role). WooCommerce keys live in Supabase secrets, not in the database or browser. |

Why JSONB for attributes rather than one row per value: reads and writes are one row, adding an attribute needs no
migration, and a GIN index supports filtering (`attributes @> '{"material":"Cotton"}'`). The definitions table still
gives the strictness of a typed model. If you need cross-product reporting on a single attribute at very large scale,
add a generated column or a materialised view for it.

Not included (natural next steps): variable products and variations, multi-currency/language, bulk CSV import,
image upload UI (the storage bucket and policies exist), per-field audit screen (the `product_history` table is
already filled by a trigger).

## Setup

Requirements: a Supabase project, the [Supabase CLI](https://supabase.com/docs/guides/cli), a WooCommerce store with HTTPS.

1. **Link and apply the database**
   ```bash
   supabase link --project-ref YOUR_REF
   supabase db push
   ```
   Optional sample data: paste `supabase/seed.sql` into the SQL editor.

2. **Create a WooCommerce REST key**: WooCommerce → Settings → Advanced → REST API → Add key (Read/Write).

3. **Store secrets**
   ```bash
   supabase secrets set WC_URL=https://shop.example.com WC_KEY=ck_xxx WC_SECRET=cs_xxx \
     WC_WEBHOOK_SECRET=a-long-random-string CRON_SECRET=another-long-random-string
   ```

4. **Deploy the functions**
   ```bash
   supabase functions deploy woo-push woo-pull woo-webhook
   ```

5. **Add WooCommerce webhooks** (Settings → Advanced → Webhooks), one each for *Product created*, *Product updated*,
   *Product deleted*, delivery URL `https://YOUR_REF.supabase.co/functions/v1/woo-webhook`, secret = `WC_WEBHOOK_SECRET`.

6. **Create users**: Authentication → Users → Add user. The first user becomes `admin`; later users are `viewer`.
   Promote someone with:
   ```sql
   update public.profiles set role = 'editor' where email = 'someone@example.com';
   ```
   If you created users *before* running the migrations, add their profile once:
   ```sql
   insert into public.profiles (id, email, role)
   select id, email, 'admin' from auth.users where email = 'you@example.com'
   on conflict (id) do update set role = 'admin';
   ```

7. **Connect the website**: open `web/index.html` and fill in
   ```js
   window.PIM_CONFIG = { SUPABASE_URL: "https://YOUR_REF.supabase.co", SUPABASE_ANON_KEY: "…anon public key…", STORE_URL: "https://shop.example.com" };
   ```
   Serve the folder with any static host (`npx serve web`, Netlify, Cloudflare Pages, Supabase Storage). The anon key
   is meant to be public; row level security protects the data. **Never put the service_role key in the page.**

8. **First import**: on the *WooCommerce sync* page choose *Pull from WooCommerce*. Existing store products arrive as
   drafts, linked by SKU. Assign categories (link them by setting `wc_category_id` on each category) and fill the
   required attributes, then mark products ready.

9. *(Optional)* schedule syncs: rename `supabase/migrations/20260101000004_schedule.sql.example`, replace the
   placeholders and run it. This pushes every 10 minutes and pulls every 15 as a safety net for missed webhooks.

## How a sync behaves

**Push** (`woo-push`) for each ready/published/archived product with changes:
1. Make sure its category exists in WooCommerce (creates it and stores the id).
2. If it has no store id, look it up by SKU first so duplicates are not created.
3. If it is already linked, fetch the store copy and compare PIM-owned fields with the snapshot. Changed in the store →
   conflict, skipped. Otherwise `PUT`.
4. Save the new hash, snapshot and store id in `wc_product_map`. Failures set `state = 'error'` with the message and are
   retried on the next push.

Status mapping: `published → publish`, `ready → draft`, `archived → private`. Attributes are sent as product-level
attributes using each attribute's label, so no WooCommerce attribute taxonomy setup is needed.

**Pull / webhook** (`woo-pull`, `woo-webhook`): update stock; flag conflicts; import unknown products as drafts
(attributes are matched by label against the category's set, and anything that does not match is left out rather than
forced in). Webhooks verify the `X-WC-Webhook-Signature` HMAC and ignore WooCommerce's initial ping.

The echo of your own push (WooCommerce sends `product.updated` back) is recognised because the store values already
equal the PIM values, so it does not create a false conflict.

## Testing checklist
- Try to set a product to *published* with a missing required attribute: the save is rejected with the reason.
- Push a product, then edit its price in WooCommerce and push again: you get a conflict, not an overwrite.
- Change a product's stock in WooCommerce: it appears in the PIM after the webhook or a pull.
- Sign in as a viewer: the form is read-only, and writes are rejected by RLS even if called directly.
