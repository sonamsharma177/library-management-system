// Minimal WooCommerce REST v3 client. Credentials come from Supabase secrets only.
const base = () => `${(Deno.env.get("WC_URL") ?? "").replace(/\/$/, "")}/wp-json/wc/v3`;
const auth = () => "Basic " + btoa(`${Deno.env.get("WC_KEY")}:${Deno.env.get("WC_SECRET")}`);

// deno-lint-ignore no-explicit-any
export async function wc<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base() + path, {
    ...init,
    headers: { Authorization: auth(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`WooCommerce ${res.status} on ${init.method ?? "GET"} ${path}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// deno-lint-ignore no-explicit-any
export async function* wcPaged(path: string): AsyncGenerator<any> {
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const batch = await wc<unknown[]>(`${path}${sep}per_page=100&page=${page}`);
    yield* batch;
    if (batch.length < 100) return;
  }
}
