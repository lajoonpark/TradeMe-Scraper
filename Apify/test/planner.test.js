import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planQuery, resetPlannerCaches } from '../src/planner.js';
import { resetCaches } from '../src/category.js';
import { MAX_PAGES_PER_QUERY } from '../src/constants.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const categories = load('categories.json');
const areas = load('areas.json');

function fakeClient({ total = 1234, totalsByCategory = {}, totalsByBand = {} } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, { params } = {}) {
      calls.push({ path, params });
      if (path === '/v1/Categories.json') return categories;
      if (path === '/v1/tmareas.json') return areas;
      if (params?.category && totalsByCategory[params.category] !== undefined) {
        return { TotalCount: totalsByCategory[params.category], List: [] };
      }
      if (params?.price_min !== undefined) {
        return { TotalCount: totalsByBand[params.price_min] ?? 10, List: [] };
      }
      return { TotalCount: total, List: [] };
    },
  };
}

const descriptor = (overrides = {}) => ({
  kind: 'search',
  searchString: 'iphone',
  categorySegments: [],
  params: {},
  url: 'query:iphone',
  ...overrides,
});

test.beforeEach(() => {
  resetCaches();
  resetPlannerCaches();
});

test('emits one page per 500 rows, capped by maxPages', async () => {
  const client = fakeClient({ total: 1200 });
  const plan = await planQuery(client, descriptor(), {}, {});
  assert.equal(plan.pages.length, 3);
  assert.equal(plan.pages[0].rows, 500);
  assert.equal(plan.pages[0].page, 1);
  assert.equal(plan.pages[2].page, 3);

  const capped = await planQuery(fakeClient({ total: 90000 }), descriptor(), {}, { maxPages: 4 });
  assert.equal(capped.pages.length, 4);
  assert.equal(capped.truncated, true);
});

test('never exceeds the server page ceiling per slice', async () => {
  const plan = await planQuery(fakeClient({ total: 10_000_000 }), descriptor(), {}, {});
  const perSlice = new Map();
  for (const page of plan.pages) {
    const key = `${page.category ?? '*'}|${page.price_min ?? '*'}`;
    perSlice.set(key, (perSlice.get(key) ?? 0) + 1);
  }
  for (const count of perSlice.values()) {
    assert.ok(count <= MAX_PAGES_PER_QUERY, `slice had ${count} pages`);
  }
});

test('resolves category slugs and region names to IDs', async () => {
  const client = fakeClient();
  const plan = await planQuery(
    client,
    descriptor({ categorySegments: ['computers', 'laptops'] }),
    { region: 'auckland' },
    {},
  );
  assert.equal(plan.pages[0].category, '0002-9844-');
  assert.equal(plan.pages[0].region, 2);
});

test('shards a broad query by child category', async () => {
  const client = fakeClient({
    total: 500000,
    totalsByCategory: { '0344-': 1200, '0002-': 800, '0350-': 0 },
  });
  const plan = await planQuery(client, descriptor(), {}, {});
  assert.equal(plan.truncated, true);
  const cats = new Set(plan.pages.map((page) => page.category));
  assert.deepEqual([...cats].sort(), ['0002-', '0344-']);
  assert.ok(!cats.has('0350-'), 'empty shards are dropped');
  assert.ok(plan.pages.every((page) => page.search_string === 'iphone'));
});

test('falls back to price bands when a shard is still too broad', async () => {
  const client = fakeClient({
    total: 500000,
    totalsByCategory: { '0344-': 500000, '0002-': 0, '0350-': 0 },
    totalsByBand: {},
  });
  const plan = await planQuery(client, descriptor(), {}, { maxPages: 3 });
  const bands = new Set(plan.pages.map((page) => page.price_min));
  assert.ok(bands.size >= 10, `expected price bands, got ${[...bands]}`);
  assert.equal(plan.pages[0].category, '0344-');
});

test('applies run filters over descriptor params', async () => {
  const plan = await planQuery(
    fakeClient(),
    descriptor({ params: { price_max: '50', condition: 'new' } }),
    { minPrice: 10, condition: 'used', shippingMethod: 'free', sort: 'priceAsc' },
    {},
  );
  const page = plan.pages[0];
  assert.equal(page.price_min, 10);
  assert.equal(page.price_max, 50);
  assert.equal(page.condition, 'used');
  assert.equal(page.shipping_method, 'free');
  assert.equal(page.sort_order, 'priceasc');
});

test('empty searches throw a clear error', async () => {
  await assert.rejects(
    planQuery(fakeClient(), descriptor({ searchString: '', categorySegments: [] }), {}, {}),
    /Nothing to search for/,
  );
});
