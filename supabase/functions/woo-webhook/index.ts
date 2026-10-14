// WooCommerce → PIM, in near real time.
// In WooCommerce: Settings → Advanced → Webhooks → topics "Product created / updated / deleted",
// delivery URL https://<ref>.supabase.co/functions/v1/woo-webhook, secret = WC_WEBHOOK_SECRET.
// deno-lint-ignore-file no-explicit-any
import { adminClient, json, log } from "../_shared/http.ts";
import { applyWcProduct } from "../_shared/pull.ts";

const enc = new TextEncoder();

async function validSignature(raw: Uint8Array, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("WC_WEBHOOK_SECRET") ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0; // constant-time comparison
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await validSignature(raw, req.headers.get("x-wc-webhook-signature") ?? ""))) return json({ error: "Bad signature" }, 401);

  // WooCommerce sends a form-encoded ping when a webhook is saved. Acknowledge and ignore it.
  if (!(req.headers.get("content-type") ?? "").includes("json")) return json({ ok: true });

  const topic = req.headers.get("x-wc-webhook-topic") ?? "";
  const w = JSON.parse(new TextDecoder().decode(raw));
  const admin = adminClient();

  // Redelivery of the same event is harmless but we skip it cheaply.
  const delivery = req.headers.get("x-wc-webhook-delivery-id");
  if (delivery) {
    const { data: seen } = await admin.from("sync_state").select("key").eq("key", `delivery:${delivery}`).maybeSingle();
    if (seen) return json({ ok: true, duplicate: true });
    await admin.from("sync_state").insert({ key: `delivery:${delivery}`, value: new Date().toISOString() });
  }

  try {
    if (topic === "product.deleted") {
      const { data: map } = await admin.from("wc_product_map").select("product_id").eq("wc_product_id", w.id).maybeSingle();
      if (map) {
        await admin.from("wc_product_map").update({ wc_product_id: null, state: "error", last_error: "Deleted in WooCommerce. Push again to recreate it." }).eq("product_id", map.product_id);
        await log(admin, null, map.product_id, "warn", `Store product #${w.id} was deleted in WooCommerce`);
      }
    } else if (topic.startsWith("product.") && w.type !== "variation") {
      await applyWcProduct(admin, w);
    }
  } catch (e) {
    await log(admin, null, null, "error", `Webhook ${topic} failed: ${e instanceof Error ? e.message : e}`);
    return json({ error: "processing failed" }, 500); // non-2xx makes WooCommerce retry
  }
  return json({ ok: true });
});
