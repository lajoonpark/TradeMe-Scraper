import { ENDPOINTS, MAX_ROWS, MAX_PAGES_PER_QUERY, SHARD_THRESHOLD, SORTS, CONDITIONS, SHIPPING_METHODS } from './constants.js';
import { resolveCategoryId, resolveRegion } from './category.js';

/**
 * Turns one descriptor plus the run's filters into concrete page requests.
 *
 * A single query is capped at ~190 pages x 500 rows, so any query whose
 * TotalCount exceeds the shard threshold is bisected by child category and then
 * by price band before pages are emitted.
 */

const PRICE_BANDS = [
  [0, 25], [25, 50], [50, 100], [100, 250], [250, 500],
  [500, 1000], [1000, 2500], [2500, 5000], [5000, 10000], [10000, 25000], [25000, null],
];

function buildBase(descriptor, input, ids) {
  const params = {};
  if (descriptor.searchString) params.search_string = descriptor.searchString;
  if (ids.category) params.category = ids.category;

  const region = ids.region ?? descriptor.params.region;
  if (region) params.region = region;
  if (ids.district ?? descriptor.params.district) params.district = ids.district ?? descriptor.params.district;
  if (ids.suburb ?? descriptor.params.suburb) params.suburb = ids.suburb ?? descriptor.params.suburb;

  const minPrice =
    input.minPrice !== null && input.minPrice !== undefined && input.minPrice !== ''
      ? input.minPrice
      : descriptor.params.price_min;
  const maxPrice =
    input.maxPrice !== null && input.maxPrice !== undefined && input.maxPrice !== ''
      ? input.maxPrice
      : descriptor.params.price_max;
  if (minPrice !== null && minPrice !== undefined && minPrice !== '') params.price_min = Number(minPrice);
  if (maxPrice !== null && maxPrice !== undefined && maxPrice !== '') params.price_max = Number(maxPrice);

  // An empty/default run filter must not clobber a filter carried by the URL.
  const condition = CONDITIONS[input.condition ?? ''] ?? '';
  if (condition) params.condition = condition;
  else if (descriptor.params.condition) params.condition = descriptor.params.condition;

  const shipping = SHIPPING_METHODS[input.shippingMethod ?? ''] ?? '';
  if (shipping) params.shipping_method = shipping;
  else if (descriptor.params.shipping_method) params.shipping_method = descriptor.params.shipping_method;

  const sort = SORTS[input.sort ?? ''] ?? '';
  if (sort && (sort !== SORTS.default || !descriptor.params.sort_order)) params.sort_order = sort;
  else if (descriptor.params.sort_order) params.sort_order = descriptor.params.sort_order;

  return params;
}

function label(params) {
  const bits = [params.search_string, params.category, params.region, params.price_min, params.price_max]
    .filter((bit) => bit !== undefined && bit !== null && bit !== '');
  return bits.join(' ') || 'all marketplace';
}

let treeCache;

async function categoryTree(client) {
  if (treeCache) return treeCache;
  treeCache = (await client.get(ENDPOINTS.categories)) || {};
  return treeCache;
}

function findNode(node, id) {
  if (node.Number === id) return node;
  for (const child of node.Subcategories || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

async function childCategoryIds(client, categoryId, limit) {
  const node = findNode(await categoryTree(client), categoryId);
  return (node?.Subcategories || []).slice(0, limit).map((child) => child.Number).filter(Boolean);
}

async function rootCategoryIds(client, limit) {
  const tree = await categoryTree(client);
  return (tree.Subcategories || []).slice(0, limit).map((child) => child.Number).filter(Boolean);
}

function priceBands(params) {
  return PRICE_BANDS.map(([min, max]) => {
    const next = { ...params, price_min: min };
    if (max !== null) next.price_max = max;
    return next;
  });
}

function pagesFor(total, maxPages, rowSize = MAX_ROWS) {
  const cap = Math.min(maxPages ?? MAX_PAGES_PER_QUERY, MAX_PAGES_PER_QUERY);
  return Math.max(1, Math.min(Math.ceil(total / rowSize), cap));
}

/**
 * @returns {Promise<{pages: object[], total: number, truncated: boolean, label: string}>}
 */
export async function planQuery(client, descriptor, input, { semaphore, signal, maxPages } = {}) {
  const ids = {
    category:
      (await resolveCategoryId(client, descriptor.categorySegments || [])) ??
      (input.category ? String(input.category).replace(/^\/+|\/+$/g, '') : null) ??
      (descriptor.params.category ? String(descriptor.params.category) : null),
    region: await resolveRegion(client, input.region ?? descriptor.params.region),
    district: input.district ?? descriptor.params.district,
    suburb: input.suburb ?? descriptor.params.suburb,
  };

  const base = buildBase(descriptor, input, ids);
  if (!base.search_string && !base.category && !base.region) {
    throw new Error(`Nothing to search for: "${descriptor.url}"`);
  }

  const probe = await client.get(ENDPOINTS.search, { params: { ...base, rows: 1 }, semaphore, signal });
  const total = probe?.TotalCount ?? 0;
  let slices = [{ params: base, total }];
  let sharded = false;

  if (total > SHARD_THRESHOLD) {
    const children = base.category
      ? await childCategoryIds(client, base.category, 12)
      : await rootCategoryIds(client, 30);
    const candidates = children.length ? children.map((id) => ({ ...base, category: id })) : priceBands(base);
    sharded = true;
    slices = [];

    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const sub = await client.get(ENDPOINTS.search, { params: { ...candidate, rows: 1 }, semaphore, signal });
      const subTotal = sub?.TotalCount ?? 0;
      if (subTotal === 0) continue;
      if (subTotal > SHARD_THRESHOLD) {
        for (const band of priceBands(candidate)) slices.push({ params: band, total: null });
      } else {
        slices.push({ params: candidate, total: subTotal });
      }
    }
  }

  const pages = [];
  let truncated = sharded;
  // Small runs don't need 500-row pages; keep every page at the same size so
  // the page offsets stay aligned.
  const wanted = Number(input.maxItems);
  const rowSize = Number.isFinite(wanted) && wanted > 0 && wanted < MAX_ROWS ? Math.max(1, wanted + 25) : MAX_ROWS;
  for (const slice of slices) {
    const slicePages = slice.total === null ? (maxPages ?? MAX_PAGES_PER_QUERY) : pagesFor(slice.total, maxPages, rowSize);
    if (slice.total !== null && slice.total > rowSize * slicePages) truncated = true;
    for (let page = 1; page <= slicePages; page += 1) {
      pages.push({ ...slice.params, rows: rowSize, page });
    }
  }

  return { pages, total, truncated, label: label(base) };
}

export function resetPlannerCaches() {
  treeCache = undefined;
}
