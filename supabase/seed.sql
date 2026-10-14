-- Sample data. Run in the SQL editor after the migrations.
insert into categories (name, slug, wc_category_id, position) values
  ('Bath & Body', 'bath-body', null, 1), ('Pantry', 'pantry', null, 2),
  ('Textiles', 'textiles', null, 3), ('Home & Kitchen', 'home-kitchen', null, 4)
on conflict (slug) do nothing;

insert into attribute_definitions (code, label, type, options, unit, help_text) values
  ('weight_g',          'Net weight',       'number',      '[]',                                              'g',      'Weight without packaging'),
  ('ingredients',       'Ingredients',      'textarea',    '[]',                                              null,     'List in order of quantity'),
  ('skin_type',         'Skin type',        'multiselect', '["Dry","Oily","Sensitive","All"]',                null,     ''),
  ('organic',           'Certified organic','boolean',     '[]',                                              null,     ''),
  ('shelf_life_months', 'Shelf life',       'number',      '[]',                                              'months', ''),
  ('origin',            'Origin',           'text',        '[]',                                              null,     'State or region of production'),
  ('material',          'Material',         'select',      '["Cotton","Linen","Jute","Cane","Clay"]',         null,     ''),
  ('color',             'Colour',           'multiselect', '["Indigo","Ochre","Natural","Terracotta","Charcoal"]', null, ''),
  ('care',              'Care instructions','textarea',    '[]',                                              null,     '')
on conflict (code) do nothing;

insert into category_attributes (category_id, attribute_id, required, position)
select c.id, d.id, v.req, v.pos
from (values
  ('bath-body','weight_g',true,1), ('bath-body','ingredients',true,2), ('bath-body','skin_type',true,3), ('bath-body','organic',false,4), ('bath-body','origin',false,5),
  ('pantry','weight_g',true,1), ('pantry','ingredients',true,2), ('pantry','shelf_life_months',true,3), ('pantry','organic',false,4), ('pantry','origin',false,5),
  ('textiles','material',true,1), ('textiles','color',true,2), ('textiles','care',true,3), ('textiles','origin',false,4),
  ('home-kitchen','material',true,1), ('home-kitchen','color',false,2)
) as v(cat, attr, req, pos)
join categories c on c.slug = v.cat
join attribute_definitions d on d.code = v.attr
on conflict do nothing;

insert into products (sku, name, description, category_id, status, price, stock_quantity, attributes, images)
select v.sku, v.name, v.descr, c.id, v.status::product_status, v.price, v.stock, v.attrs::jsonb, v.imgs::jsonb
from (values
  ('KOK-SOAP-3', 'Kokum Butter Soap Set (3)', 'Hand-poured soap bars made with cold-pressed kokum butter. Gentle on dry and sensitive skin.', 'bath-body', 'published', 449, 64,
   '{"weight_g":300,"ingredients":"Kokum butter, coconut oil, sodium hydroxide, essential oils","skin_type":["Dry","Sensitive"],"organic":true,"origin":"Goa"}',
   '[{"url":"https://picsum.photos/seed/kokum/600","alt":"Three kokum soap bars"}]'),
  ('CSH-RST-250', 'Roasted Cashew Nuts 250 g', 'Slow-roasted cashew nuts lightly salted with sea salt for a clean crunch.', 'pantry', 'published', 780, 120,
   '{"weight_g":250,"ingredients":"Cashew nuts, sea salt","shelf_life_months":6,"organic":false,"origin":"Goa"}',
   '[{"url":"https://picsum.photos/seed/cashew/600","alt":"Roasted cashews"}]'),
  ('SPC-SMP-6', 'Spice Sampler (6 jars)', 'Six whole-spice jars blended for everyday Indian cooking, packed in glass jars.', 'pantry', 'ready', 520, 48,
   '{"weight_g":180,"ingredients":"Pepper, cardamom, cinnamon, clove, turmeric, cumin","shelf_life_months":12}',
   '[{"url":"https://picsum.photos/seed/spice/600","alt":"Six spice jars"}]'),
  ('COC-OIL-500', 'Cold-pressed Coconut Oil 500 ml', 'Cold-pressed coconut oil.', 'pantry', 'draft', 360, 30,
   '{"weight_g":460}', '[]'),
  ('HLM-SCARF', 'Handloom Cotton Scarf', 'Soft handloom cotton scarf woven by artisans and finished with natural dye.', 'textiles', 'published', 1290, 18,
   '{"material":"Cotton","color":["Indigo","Natural"],"care":"Hand wash cold, dry in shade","origin":"Karnataka"}',
   '[{"url":"https://picsum.photos/seed/scarf/600","alt":"Indigo scarf"}]'),
  ('TRC-MUG-2', 'Terracotta Mug Pair', 'Wheel-thrown terracotta mugs that keep drinks cool in summer and warm in winter.', 'home-kitchen', 'published', 640, 36,
   '{"material":"Clay","color":["Terracotta"]}',
   '[{"url":"https://picsum.photos/seed/mug/600","alt":"Two terracotta mugs"}]')
) as v(sku, name, descr, cat, status, price, stock, attrs, imgs)
join categories c on c.slug = v.cat
on conflict (sku) do nothing;
