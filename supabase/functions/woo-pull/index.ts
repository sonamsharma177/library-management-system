// POST { overwrite_product_ids?: string[] }
// Default: reads products modified in WooCommerce since the last pull, updates stock, flags conflicts,
// imports unknown products as drafts.
// With overwrite_product_ids: takes the WooCommerce values for those PIM products (conflict resolution).
// deno-lint-ignore-file no-explicit-any
import { adminClient, authorize, cors, json } from "../_shared/http.ts";
import { wc, wcPaged } from "../_shared/woo.ts";
import { applyWcProduct } from "../_shared/pull.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = adminClient();
  if (!(await authorize(req, admin))) return json({ error: "Not authorised" }, 401);
  const body = await req.json().catch(() => ({}));

  const { data: job } = await admin.from("sync_jobs").insert({ kind: "pull" }).select().single();
  const count = { created: 0, updated: 0, conflicts: 0, failed: 0 };
  const tally = (r: string) => { if (r === "created") count.created++; else if (r === "conflict") count.conflicts++; else count.updated++; };

  try {
    if (body.overwrite_product_ids?.length) {
      const { data: maps } = await admin.from("wc_product_map").select("wc_product_id").in("product_id", body.overwrite_product_ids);
      for (const m of maps ?? []) {
        if (!m.wc_product_id) continue;
        try { tally(await applyWcProduct(admin, await wc(`/products/${m.wc_product_id}`), { overwrite: true, jobId: job.id })); }
        catch { count.failed++; }
      }
    } else {
      const { data: st } = await admin.from("sync_state").select("value").eq("key", "last_pull").maybeSingle();
      const since = st?.value ?? new Date(Date.now() - 30 * 864e5).toISOString();
      const started = new Date().toISOString();
      for await (const w of wcPaged(`/products?modified_after=${encodeURIComponent(since)}&orderby=modified&order=asc&status=any`)) {
        try { tally(await applyWcProduct(admin, w, { jobId: job.id })); } catch { count.failed++; }
      }
      await admin.from("sync_state").upsert({ key: "last_pull", value: started });
    }
  } catch (e) {
    await admin.from("sync_jobs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("id", job.id);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  const done = count.created + count.updated + count.conflicts;
  await admin.from("sync_jobs").update({
    status: count.failed ? "partial" : "success", total: done + count.failed, succeeded: done, failed: count.failed, finished_at: new Date().toISOString(),
  }).eq("id", job.id);
  return json({ job_id: job.id, ...count });
});
