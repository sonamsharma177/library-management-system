import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** Service-role client: bypasses RLS. Only ever used inside edge functions. */
export const adminClient = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

/** Allow: scheduled calls with the cron secret, or a signed-in admin/editor. */
export async function authorize(req: Request, admin: SupabaseClient): Promise<boolean> {
  const cron = req.headers.get("x-cron-secret");
  if (cron && cron === Deno.env.get("CRON_SECRET")) return true;

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return false;
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  return profile?.role === "admin" || profile?.role === "editor";
}

export async function log(
  admin: SupabaseClient, jobId: string | null, productId: string | null,
  level: "info" | "warn" | "error", message: string,
) {
  await admin.from("sync_log").insert({ job_id: jobId, product_id: productId, level, message });
}
