// Field ownership and the PIM <-> WooCommerce mapping.
//
// PIM owns:          name, description, short_description, price, sale_price, category, attributes, images
// WooCommerce owns:  stock_quantity (pulled, never pushed after creation)
//
// "Owned" fields are compared against a snapshot taken at the last sync. If the store value moved since
// then, someone edited it in WooCommerce and we raise a conflict instead of overwriting it.

// deno-lint-ignore-file no-explicit-any
export const OWNED = ["name", "description", "short_description", "regular_price", "sale_price"] as const;
export type Owned = Record<(typeof OWNED)[number], string>;

export const money = (v: unknown) => (v === null || v === undefined || v === "" ? "" : Number(v).toFixed(2));

export const ownedFromWc = (p: any): Owned => ({
  name: p.name ?? "", description: p.description ?? "", short_description: p.short_description ?? "",
  regular_price: money(p.regular_price), sale_price: money(p.sale_price),
});

export const ownedFromPim = (p: any): Owned => ({
  name: p.name ?? "", description: p.description ?? "", short_description: p.short_description ?? "",
  regular_price: money(p.price), sale_price: money(p.sale_price),
});

/** Fields where the store changed since the snapshot AND the store now differs from the PIM. */
export function realChanges(snapshot: Partial<Owned> | null, wcNow: Owned, pimNow: Owned) {
  if (!snapshot) return [];
  return OWNED.filter((f) => snapshot[f] !== undefined && snapshot[f] !== wcNow[f] && wcNow[f] !== pimNow[f]);
}

export const wcStatus = (s: string) => (s === "published" ? "publish" : s === "archived" ? "private" : "draft");

function attributeOptions(def: any, value: any): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (def.type === "boolean") return [value ? "Yes" : "No"];
  if (def.type === "number") return [def.unit ? `${value} ${def.unit}` : String(value)];
  return [String(value)];
}

/** Build the body for POST/PUT /products. Attributes become product-level (custom) attributes. */
export function toWooPayload(p: any, wcCategoryId: number | null, defs: any[], isCreate: boolean) {
  const attributes = defs
    .filter((d) => p.attributes?.[d.code] !== undefined && p.attributes[d.code] !== null && p.attributes[d.code] !== "")
    .map((d, i) => ({
      name: d.label, position: i, visible: d.wc_visible, variation: false,
      options: attributeOptions(d, p.attributes[d.code]),
    }));

  const body: Record<string, unknown> = {
    name: p.name, sku: p.sku, type: "simple", status: wcStatus(p.status),
    regular_price: money(p.price), sale_price: money(p.sale_price),
    description: p.description, short_description: p.short_description,
    categories: wcCategoryId ? [{ id: wcCategoryId }] : [],
    attributes,
    images: (p.images ?? []).map((i: any) => ({ src: i.url, alt: i.alt ?? "" })),
    meta_data: [{ key: "_pim_id", value: p.id }],
  };
  if (isCreate) { body.manage_stock = true; body.stock_quantity = p.stock_quantity ?? 0; }
  return body;
}

export const imageUrls = (p: any): string[] => (p.images ?? []).map((i: any) => i.url);
