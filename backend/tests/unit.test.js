// Unit tests: pure logic only (no database, no server).  Run:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, tokens, rankItems, packSizeFromName } = require('../catalog-search');
const { calcMaterials } = require('../planning');
const { scrub } = require('../audit');

const catalogue = [
  { id: 1, code: 'FG-0001', name: 'HK WHEEL CLEANER 1 KG', aliases: [] },
  { id: 2, code: 'FG-0002', name: 'HK WHEEL CLEANER TOUCHLESS 5KG', aliases: [] },
  { id: 3, code: 'FG-0003', name: 'DU CAR SHAMPOO CONC. 5KG', aliases: ['car shampoo concentrate'] },
  { id: 4, code: 'FG-0004', name: 'DU WASH N WAX CAR SHAMPOO 5KG', aliases: [] },
  { id: 5, code: 'FG-0005', name: 'HK X1 COMPOUND 500 ML', aliases: ['x1'] }
];

test('normalize ignores case, punctuation and spacing', () => {
  assert.equal(normalize('  DU  Car-Shampoo, Conc. '), 'du car shampoo conc');
  assert.equal(normalize(null), '');
});

test('"5KG" and "5 kg" tokenise the same way', () => {
  assert.deepEqual(tokens('5KG'), ['5', 'kg']);
  assert.deepEqual(tokens('5 kg'), ['5', 'kg']);
});

test('an abbreviation returns EVERY candidate; it never silently picks one', () => {
  const r = rankItems(catalogue, 'hk wheel');
  assert.deepEqual(r.map(x => x.id).sort(), [1, 2]);
});

test('extra words narrow the match to the right item', () => {
  assert.deepEqual(rankItems(catalogue, 'wheel 5kg').map(x => x.id), [2]);
  assert.deepEqual(rankItems(catalogue, 'wheel 5 kg').map(x => x.id), [2]);
});

test('an alias finds its product, and an exact code ranks first', () => {
  assert.equal(rankItems(catalogue, 'x1')[0].id, 5);
  assert.equal(rankItems(catalogue, 'x1')[0].matched_via, 'alias');
  const c = rankItems(catalogue, 'fg-0003');
  assert.equal(c[0].id, 3);
  assert.equal(c[0].matched_via, 'code');
});

test('words missing from an item exclude it; empty input returns nothing', () => {
  assert.deepEqual(rankItems(catalogue, 'wheel shampoo'), []);
  assert.deepEqual(rankItems(catalogue, '   '), []);
});

test('pack size is read from the name, not invented', () => {
  assert.equal(packSizeFromName('HK X1 COMPOUND 500 ML'), '500 ML');
  assert.equal(packSizeFromName('DU TYRE DRESSER 5 KG'), '5 KG');
  assert.equal(packSizeFromName('HK GOLDEN GLAZE WAX 1LTR'), '1 L');
  assert.equal(packSizeFromName('HK PVA CHAMOIS'), null);
});

// ---------- planning ----------
const recipe = (over = {}) => ({
  id: 7, version: 1, base_output_qty: 1, wastage_included: true, wastage_pct: 0,
  lines: [
    { material_id: 1, code: 'R1', name: 'SLS POWDER', unit: 'Kg', qty_per_unit: 1.2 },
    { material_id: 2, code: 'R2', name: 'CAN', unit: 'Nos', qty_per_unit: 1 }
  ], ...over
});
const item = (over = {}) => ({ item_id: 1, item_name: 'DU CAR SHAMPOO CONC. 5KG', product_id: 3, product_name: 'DU CAR SHAMPOO CONC. 5KG', quantity: 10, recipe: recipe(), ...over });

test('requirement = recipe quantity x requested packs', () => {
  const r = calcMaterials([item()]);
  assert.equal(r.complete, true);
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 12);
  assert.equal(r.totals.find(t => t.name === 'CAN').qty, 10);
});

test('a recipe for a larger batch is scaled down per pack', () => {
  const r = calcMaterials([item({ quantity: 50, recipe: recipe({ base_output_qty: 100 }) })]);
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 0.6); // 1.2 per 100 packs x 50
});

test('wastage already inside the recipe is NOT added again', () => {
  const r = calcMaterials([item({ recipe: recipe({ wastage_included: true, wastage_pct: 10 }) })]);
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 12);
});

test('a net recipe gets its wastage allowance exactly once', () => {
  const r = calcMaterials([item({ recipe: recipe({ wastage_included: false, wastage_pct: 10 }) })]);
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 13.2);
});

test('the same material from two products is added up', () => {
  const r = calcMaterials([item(), item({ item_id: 2, product_id: 4, quantity: 5 })]);
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 18);
  assert.equal(r.totals.length, 2);
});

test('floating-point noise does not leak into quantities', () => {
  const r = calcMaterials([item({ quantity: 3, recipe: recipe({ lines: [{ material_id: 1, code: 'R1', name: 'X', unit: 'Kg', qty_per_unit: 0.1 }] }) })]);
  assert.equal(r.totals[0].qty, 0.3);
});

test('missing recipe BLOCKS planning and names the unresolved demand', () => {
  const r = calcMaterials([item(), item({ item_id: 2, item_name: 'HK RAIN OUT 200ML', product_id: 9, product_name: 'HK RAIN OUT 200ML', quantity: 4, recipe: null })]);
  assert.equal(r.complete, false);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].reason, 'recipe_missing');
  assert.equal(r.blocked[0].quantity, 4);
  assert.equal(r.blocked[0].item_name, 'HK RAIN OUT 200ML');
  assert.equal(r.totals.find(t => t.name === 'SLS POWDER').qty, 12, 'the resolved item is still calculated');
});

test('an item not linked to the catalogue is blocked, not guessed', () => {
  const r = calcMaterials([item({ product_id: null, product_name: null, recipe: null })]);
  assert.equal(r.complete, false);
  assert.equal(r.blocked[0].reason, 'unmapped');
});

test('an empty recipe is blocked and nothing at all is not "complete"', () => {
  assert.equal(calcMaterials([item({ recipe: recipe({ lines: [] }) })]).blocked[0].reason, 'recipe_empty');
  assert.equal(calcMaterials([]).complete, false);
});

test('the basis is labelled gross, because stock is not subtracted', () => {
  const r = calcMaterials([item()]);
  assert.equal(r.basis, 'gross_requirement');
  assert.match(r.basis_note, /not subtracted/i);
});

// ---------- audit ----------
test('secrets never reach the audit history', () => {
  const s = scrub({ name: 'A', password: 'x', password_hash: 'y', nested: { api_key: 'z', token: 't', ok: 1 }, list: [{ secret: 's', v: 2 }] });
  assert.equal(s.name, 'A');
  assert.equal(s.password, '[hidden]');
  assert.equal(s.password_hash, '[hidden]');
  assert.equal(s.nested.api_key, '[hidden]');
  assert.equal(s.nested.token, '[hidden]');
  assert.equal(s.nested.ok, 1);
  assert.equal(s.list[0].secret, '[hidden]');
  assert.equal(s.list[0].v, 2);
});
