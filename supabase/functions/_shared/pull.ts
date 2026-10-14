// Applies one WooCommerce product payload to the PIM. Used by woo-pull and woo-webhook.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { log } from "./http.ts";
import { ownedFromPim, ownedFromWc, realChanges } from "./mapping.ts";

type Result = "created" | "updated" | "conflict" | "skipped";

function attributeValue(def: any, options: string[]) {
  const lower = (def.options ?? []).map((o: string) => o.toLowerCase());
  switch (def.type) {
    case "number": { const n = parseFloat(options[0]); return Number.isFinite(n) ? n : undefined; }
    case "boolean": return /^(yes|true|1)$/i.test(options[0] ?? "");
    case "select": { const i = lower.indexOf((options[0] ?? "").toLowerCase()); return i >= 0 ? def.options[i] : undefined; }
    case "multiselect": { const v = options.map((o) => lower.indexOf(o.toLowerCase())).filter((i) => i >= 0).map((i) => def.options[i]); return v.length ? v : undefined; }
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(options[0] ?? "") ? options[0] : undefined;
    default: return options.join(", ");
  }
}

export async function applyWcProduct(admin: SupabaseClient, w: any, opts: { overwrite?: boolean; jobId?: string | null } = {}): Promise<Result> {
  const jobId = opts.jobId ?? null;
  const wcOwned = ownedFromWc(w);
  const stock = w.manage_stock ? { stock_quantity: w.stock_quantity ?? 0 } : {};

  // 1. Is this store product already linked?
  let { data: map } = await admin.from("wc_product_map").select("*").eq("wc_product_id", w.id).maybeSingle();
  let product: any = null;
  if (map) {
    product = (await admin.from("products").select("*").eq("id", map.product_id).single()).data;
  } else if (w.sku) { // 2. Same SKU already in the PIM: link it
    product = (await admin.from("products").select("*").eq("sku", w.sku).maybeSingle()).data;
    if (product) {
      const { data } = await admin.from("wc_product_map").upsert({ product_id: product.id, wc_product_id: w.id, state: "synced", last_synced_hash: null, wc_snapshot: { ...wcOwned, image_urls: [] } }).select().single();
      map = data;
    }
  }

  // ---- existing product ----
  if (product && map) {
    const pimOwned = ownedFromPim(product);
    const changes = realChanges(map.wc_snapshot, wcOwned, pimOwned);

    if (opts.overwrite) { // "take WooCommerce values": the store wins for the PIM-owned fields
      const { data: updated, error } = await admin.from("products").update({
        name: w.name, description: w.description ?? "", short_description: w.short_description ?? "",
        price: w.regular_price ? Number(w.regular_price) : product.price, sale_price: w.sale_price ? Number(w.sale_price) : null, ...stock,
      }).eq("id", product.id).select().single();
      if (error) throw new Error(error.message);
      await admin.from("wc_product_map").update({
        state: "synced", conflict: null, last_error: null, last_synced_hash: updated.content_hash, last_synced_at: new Date().toISOString(),
        wc_snapshot: { ...wcOwned, image_urls: map.wc_snapshot?.image_urls ?? [] },
      }).eq("product_id", product.id);
      await log(admin, jobId, product.id, "info", `${product.sku}: took WooCommerce values`);
      return "updated";
    }

    if (Object.keys(stock).length && product.stock_quantity !== (stock as any).stock_quantity) {
      await admin.from("products").update(stock).eq("id", product.id);
    }
    if (changes.length) {
      await admin.from("wc_product_map").update({ state: "conflict", conflict: changes.map((f) => ({ field: f, pim: (pimOwned as any)[f], wc: (wcOwned as any)[f] })) }).eq("product_id", product.id);
      await log(admin, jobId, product.id, "warn", `${product.sku}: edited in WooCommerce (${changes.join(", ")}); marked as conflict`);
      return "conflict";
    }
    await admin.from("wc_product_map").update({ wc_modified_at: w.date_modified_gmt ? w.date_modified_gmt + "Z" : null }).eq("product_id", product.id);
    return "updated";
  }

  // ---- new product: import as a draft ----
  const { data: category } = w.categories?.[0]?.id
    ? await admin.from("categories").select("id").eq("wc_category_id", w.categories[0].id).maybeSingle()
    : { data: null };

  const attributes: Record<string, unknown> = {};
  if (category) {
    const { data: rows } = await admin.from("category_attributes").select("attribute_definitions(*)").eq("category_id", category.id);
    for (const wa of w.attributes ?? []) {
      const def = (rows ?? []).map((r: any) => r.attribute_definitions).find((d: any) => d.label.toLowerCase() === String(wa.name).toLowerCase());
      if (!def) continue; // attribute not in this category's set: left out, never forced in
      const v = attributeValue(def, wa.options ?? []);
      if (v !== undefined && v !== "") attributes[def.code] = v;
    }
  }
  const images = (w.images ?? []).map((i: any) => ({ url: i.src, alt: i.alt ?? "" }));
  const { data: created, error } = await admin.from("products").insert({
    sku: w.sku || `wc-${w.id}`, name: w.name, description: w.description ?? "", short_description: w.short_description ?? "",
    category_id: category?.id ?? null, status: "draft", price: w.regular_price ? Number(w.regular_price) : null,
    sale_price: w.sale_price ? Number(w.sale_price) : null, attributes, images, ...stock,
  }).select().single();
  if (error) throw new Error(`Could not import "${w.name}": ${error.message}`);

  await admin.from("wc_product_map").insert({
    product_id: created.id, wc_product_id: w.id, state: "synced", last_synced_hash: created.content_hash, last_synced_at: new Date().toISOString(),
    wc_modified_at: w.date_modified_gmt ? w.date_modified_gmt + "Z" : null, wc_snapshot: { ...wcOwned, image_urls: images.map((i: any) => i.url) },
  });
  await log(admin, jobId, created.id, "info", `${created.sku}: imported from WooCommerce as a draft`);
  return "created";
}
