import { WEB_ORIGIN } from './constants.js';

/**
 * Parses every accepted input shape into a descriptor. Nothing is fetched here —
 * URLs are read, not requested.
 *
 * Accepted:
 *   https://www.trademe.co.nz/a/marketplace/listing/1234567890
 *   https://www.trademe.co.nz/Browse/Listing.aspx?id=1234567890
 *   https://www.trademe.co.nz/1234567890
 *   https://www.trademe.co.nz/a/marketplace/search?search_string=iphone
 *   https://www.trademe.co.nz/a/marketplace/computers/laptops?price_max=900
 *   m.trademe.co.nz variants of all of the above
 */

const LISTING_PATTERNS = [
  /\/listing\/(\d{6,})/,
  /[?&]id=(\d{6,})/,
  /trademe\.co\.nz\/(\d{6,})(?:[/?#]|$)/,
];

const PLACE_PARAMS = ['region', 'district', 'suburb'];

/** Returns a normalised URL object, or null when the string is unusable. */
function toUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let text = raw.trim();

  if (/^\d{6,}$/.test(text)) return { listingId: text };

  text = text.replace(/^https?:\/\/m\.trademe\.co\.nz/i, WEB_ORIGIN);
  if (!/^https?:\/\//i.test(text)) {
    if (text.startsWith('/')) text = WEB_ORIGIN + text;
    else if (/trademe\.co\.nz/i.test(text)) text = `https://${text.replace(/^\/+/, '')}`;
    else return null;
  }

  try {
    const url = new URL(text);
    if (!/(^|\.)trademe\.co\.nz$/i.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseListingId(raw) {
  const text = String(raw ?? '');
  for (const pattern of LISTING_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return /^\d{6,}$/.test(text.trim()) ? text.trim() : null;
}

/**
 * @returns {{kind:'listing', listingId:string, url:string}
 *          |{kind:'search', searchString:string, categorySegments:string[], params:object, url:string}
 *          |null}
 */
export function parseInput(raw) {
  const listingId = parseListingId(raw);
  if (listingId) {
    return {
      kind: 'listing',
      listingId,
      url: `${WEB_ORIGIN}/a/marketplace/listing/${listingId}`,
    };
  }

  const url = toUrl(raw);
  if (!url) return null;

  const segments = url.pathname
    .replace(/^\/a\//, '/')
    .split('/')
    .filter(Boolean);

  const vertical = segments[0];
  if (vertical && vertical !== 'marketplace' && vertical !== 'browse') {
    // Motors/property/jobs still resolve through the same search endpoint, so
    // only the marketplace slice keeps the leading token.
    if (!['Browse', 'browse'].includes(vertical)) segments.unshift('marketplace');
  }

  const categorySegments = segments
    .slice(1)
    .filter((part) => part !== 'search' && part !== 's');

  const params = {};
  const searchString = url.searchParams.get('search_string') || '';
  for (const name of ['category', 'price_min', 'price_max', 'condition', 'shipping_method', 'sort_order']) {
    const value = url.searchParams.get(name);
    if (value) params[name] = value;
  }
  for (const name of PLACE_PARAMS) {
    const value = url.searchParams.get(name);
    if (value) params[name] = value;
  }

  if (!searchString && !categorySegments.length) return null;

  return { kind: 'search', searchString, categorySegments, params, url: url.toString() };
}

export function dedupeDescriptors(descriptors) {
  const seen = new Set();
  return descriptors.filter((descriptor) => {
    const key =
      descriptor.kind === 'listing'
        ? `l:${descriptor.listingId}`
        : `s:${descriptor.searchString}|${descriptor.categorySegments.join('/')}|${JSON.stringify(descriptor.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
