/**
 * Static constants for the Trade Me v1 JSON API.
 *
 * Every path lives here so a version bump (v1 -> v2) is a one-line change and
 * fixture tests fail loudly rather than silently returning nothing.
 */

export const API_ORIGIN = 'https://api.trademe.co.nz';
export const API_VERSION = 'v1';
export const WEB_ORIGIN = 'https://www.trademe.co.nz';

/**
 * The whole gate. Without this header the API answers
 * 401 "This API requires that you supply your application credentials."
 * No token, cookie or API key is involved.
 */
export const REQUIRED_HEADERS = Object.freeze({
  referer: `${WEB_ORIGIN}/`,
  origin: WEB_ORIGIN,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-NZ',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

/** Server-side caps, measured. */
export const MAX_ROWS = 500;
export const MAX_PAGES_PER_QUERY = 190;

/** Shard when a single query would overflow the page ceiling. */
export const SHARD_THRESHOLD = 90000;

export const ENDPOINTS = Object.freeze({
  search: `/v1/search/general.json`,
  listing: (id) => `/v1/Listings/${id}.json`,
  categories: `/v1/Categories.json`,
  areas: `/v1/tmareas.json`,
});

/** Sort orders accepted by the API (all verified 200). */
export const SORTS = Object.freeze({
  default: 'default',
  featured: 'featuredfirst',
  priceAsc: 'priceasc',
  priceDesc: 'pricedesc',
  titleAsc: 'titleasc',
  expiryAsc: 'expiryasc',
  expiryDesc: 'expirydesc',
  bidsMost: 'bidsmost',
  buyNowPrice: 'buynowprice',
  latest: 'latestlisting',
});

/** Condition maps onto the API's own vocabulary. `any` means unset. */
export const CONDITIONS = Object.freeze({
  '': '',
  any: '',
  new: 'new',
  used: 'used',
});

/** shipping_method is server-side; buy-now is not (filtered client-side). */
export const SHIPPING_METHODS = Object.freeze({
  '': '',
  any: '',
  free: 'free',
  pickup: 'pickup',
});

export const LIMITS = Object.freeze({
  concurrency: Number(process.env.TRADEME_CONCURRENCY || 120),
  timeoutMs: Number(process.env.TRADEME_TIMEOUT_MS || 20000),
  retries: Number(process.env.TRADEME_RETRIES || 3),
  backoffBaseMs: 400,
  pushBatch: 100,
});

/** Row fields copied without transformation. */
export const PASSTHROUGH_FIELDS = Object.freeze([
  'ListingId',
  'Title',
  'Subtitle',
  'Category',
  'CategoryPath',
  'Region',
  'Suburb',
  'District',
  'StartPrice',
  'BuyNowPrice',
  'WasPrice',
  'PercentageOff',
  'PriceDisplay',
  'HasBuyNow',
  'IsBuyNowOnly',
  'ReserveState',
  'BidCount',
  'MaxBidAmount',
  'IsReserveMet',
  'ViewCount',
  'BidderAndWatchers',
  'QuantityRemaining',
  'AvailableToBuy',
  'MemberId',
  'StartDate',
  'EndDate',
  'AsAt',
  'PictureHref',
  'ShippingOptions',
  'PaymentMethods',
  'AllowsPickups',
  'Store',
  'Photos',
  'PictureHref',
  'Attributes',
  'Body',
  'Member',
  'PhotoUrls',
]);
