import { ENDPOINTS } from './constants.js';

/**
 * Resolves human-supplied web paths and place names onto the numeric IDs the API
 * wants. Both documents are fetched once per run and cached.
 */

const slug = (value) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

let categoryCache;

async function categoryIndex(client) {
  if (categoryCache) return categoryCache;
  const tree = await client.get(ENDPOINTS.categories);
  const index = [];
  const walk = (node, trail) => {
    const next = node.Name && node.Name !== 'Root' ? [...trail, slug(node.Name)] : trail;
    if (node.Number) index.push({ id: node.Number, slugs: next });
    for (const child of node.Subcategories || []) walk(child, next);
  };
  walk(tree || {}, []);
  categoryCache = index;
  return index;
}

export function resetCaches() {
  categoryCache = undefined;
  areaCache = undefined;
}

/**
 * Match the deepest category whose slug trail is a suffix of the supplied path.
 * Returns the longest match so `/a/marketplace/computers/laptops` prefers
 * Computers > Laptops over the bare Computers node.
 */
export async function resolveCategoryId(client, segments) {
  const wanted = segments.map(slug).filter(Boolean);
  if (!wanted.length) return null;
  const index = await categoryIndex(client);

  let best = null;
  for (const entry of index) {
    if (entry.slugs.length > wanted.length) continue;
    const tail = wanted.slice(wanted.length - entry.slugs.length);
    if (tail.every((part, i) => part === entry.slugs[i])) {
      if (!best || entry.slugs.length > best.slugs.length) best = entry;
    }
  }
  return best?.id ?? null;
}

let areaCache;

async function areas(client) {
  if (areaCache) return areaCache;
  areaCache = (await client.get(ENDPOINTS.areas)) || [];
  return areaCache;
}

async function resolvePlace(client, value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^\d+$/.test(String(value))) return Number(value);

  const needle = slug(value);
  for (const locality of await areas(client)) {
    if (slug(locality.Name) === needle) return locality.LocalityId;
    for (const district of locality.Districts || []) {
      if (slug(district.Name) === needle) return district.DistrictId;
    }
  }
  return null;
}

export async function resolveRegion(client, value) {
  return resolvePlace(client, value);
}
