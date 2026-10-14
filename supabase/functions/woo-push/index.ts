// POST { product_ids?: string[], force?: boolean }
// Pushes ready/published/archived products to WooCommerce.
// Without product_ids it pushes only what changed (never synced, hash differs, or last attempt failed).
// deno-lint-ignore-file no-explicit-any
import { adminClient, authorize, cors, json, log } from "../_shared/http.ts";
import { wc } from "../_shared/woo.ts";
import { imageUrls, ownedFromPim, ownedFromWc, realChanges, toWooPayload } from "../_shared/mapping.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = adminClient();
  if (!(await authorize(req, admin))) return json({ error: "Not authorised" }, 401);

  const body = await req.json().catch(() => ({}));
  const force = !!body.force;

  let q = admin.from("products").select("*").in("status", ["ready", "published", "archived"]);
  if (body.product_ids?.length) q = q.in("id", body.product_ids);
  const { data: all, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const { data: maps } = await admin.from("wc_product_map").select("*");
  const mapOf = new Map<string, any>((maps ?? []).map((m: any) => [m.product_id, m] as [string, any]));
  const products = (all ?? []).filter((p: any) => {
    if (body.product_ids?.length) return true;
    const m: any = mapOf.get(p.id);
    return !m || m.state === "error" || (m.state === "synced" && m.last_synced_hash !== p.content_hash);
  });

  const { data: job } = await admin.from("sync_jobs").insert({ kind: "push", total: products.length }).select().single();
  const [{ data: cats }, { data: defs }, { data: catAttrs }] = await Promise.all([
    admin.from("categories").select("*"), admin.from("attribute_definitions").select("*"), admin.from("category_attributes").select("*"),
  ]);
  const catById = new Map<string, any>((cats ?? []).map((c: any) => [c.id, c] as [string, any]));

  /** Make sure the category (and its parent) exists in WooCommerce; remember the id. */
  async function ensureCategory(id: string | null): Promise<number | null> {
    const c: any = id ? catById.get(id) : null;
    if (!c) return null;
    if (c.wc_category_id) return c.wc_category_id;
    const parent = c.parent_id ? await ensureCategory(c.parent_id) : null;
    let wcId: number;
    try {
      const made = await wc("/products/categories", { method: "POST", body: JSON.stringify({ name: c.name, slug: c.slug, ...(parent ? { parent } : {}) }) });
      wcId = made.id;
    } catch (e) {
      const m = String(e).match(/"resource_id":(\d+)/); // term_exists: WooCommerce tells us the existing id
      if (!m) throw e;
      wcId = Number(m[1]);
    }
    c.wc_category_id = wcId;
    await admin.from("categories").update({ wc_category_id: wcId }).eq("id", c.id);
    return wcId;
  }

  let pushed = 0, skipped = 0, failed = 0;
  for (const p of products as any[]) {
    const m: any = mapOf.get(p.id);
    try {
      const attrDefs = (catAttrs ?? []).filter((x: any) => x.category_id === p.category_id)
        .sort((a: any, b: any) => a.position - b.position)
        .map((x: any) => (defs ?? []).find((d: any) => d.id === x.attribute_id)).filter(Boolean);
      const wcCat = await ensureCategory(p.category_id);
      let wcId: number | null = m?.wc_product_id ?? null;
      let linkedBySku = false;

      if (!wcId) { // adopt an existing store product with the same SKU instead of creating a duplicate
        const found = await wc<any[]>(`/products?sku=${encodeURIComponent(p.sku)}`);
        if (found.length) { wcId = found[0].id; linkedBySku = true; await log(admin, job.id, p.id, "info", `${p.sku}: linked to existing store product #${wcId}`); }
      }

      const urls = imageUrls(p);
      const payload: any = toWooPayload(p, wcCat, attrDefs, !wcId);

      if (wcId) {
        if (!linkedBySku && m?.wc_snapshot) {
          const current = await wc(`/products/${wcId}`);
          const changes = realChanges(m.wc_snapshot, ownedFromWc(current), ownedFromPim(p));
          if (changes.length && !force) {
            const wcNow: any = ownedFromWc(current), pimNow: any = ownedFromPim(p);
            await admin.from("wc_product_map").update({ state: "conflict", conflict: changes.map((f) => ({ field: f, pim: pimNow[f], wc: wcNow[f] })) }).eq("product_id", p.id);
            await log(admin, job.id, p.id, "warn", `${p.sku}: edited in WooCommerce since last sync (${changes.join(", ")}); push skipped`);
            skipped++; continue;
          }
          // Re-sending identical image URLs would make WooCommerce download them again.
          if (JSON.stringify(m.wc_snapshot.image_urls ?? []) === JSON.stringify(urls)) delete payload.images;
        }
      }

      const res = await wc(wcId ? `/products/${wcId}` : "/products", { method: wcId ? "PUT" : "POST", body: JSON.stringify(payload) });
      await admin.from("wc_product_map").upsert({
        product_id: p.id, wc_product_id: res.id, state: "synced", last_synced_hash: p.content_hash,
        last_synced_at: new Date().toISOString(), wc_modified_at: res.date_modified_gmt ? res.date_modified_gmt + "Z" : null,
        wc_snapshot: { ...ownedFromWc(res), image_urls: urls }, conflict: null, last_error: null,
      });
      await log(admin, job.id, p.id, "info", `${p.sku}: ${wcId && !linkedBySku ? "updated" : "created"} in WooCommerce (#${res.id})`);
      pushed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("wc_product_map").upsert({ product_id: p.id, wc_product_id: m?.wc_product_id ?? null, state: "error", last_error: msg.slice(0, 500), last_synced_hash: m?.last_synced_hash ?? null, wc_snapshot: m?.wc_snapshot ?? null });
      await log(admin, job.id, p.id, "error", `${p.sku}: ${msg.slice(0, 200)}`);
    }
  }

  await admin.from("sync_jobs").update({
    status: failed === 0 ? "success" : pushed > 0 ? "partial" : "failed", succeeded: pushed, failed, finished_at: new Date().toISOString(),
  }).eq("id", job.id);
  return json({ job_id: job.id, pushed, skipped, failed });
});
