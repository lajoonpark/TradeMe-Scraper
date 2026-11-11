import { WEB_ORIGIN } from './constants.js';

/** Parses the API's `/Date(1234)/` form, plain epoch numbers and ISO strings. */
export function toIso(value) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const wrapped = value.match(/^\/Date\((-?\d+)\)\/$/);
    if (wrapped) return Number(wrapped[1]) === 0 ? null : new Date(Number(wrapped[1])).toISOString();
    if (/^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

const clean = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '+++') return null;
    return trimmed;
  }
  return value;
};

const num = (value) => {
  if (value === undefined || value === null || value === '' || value === '+++') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const bool = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return null;
  return Boolean(Number(value) || value === true);
};

function shipFrom(options) {
  if (!Array.isArray(options) || !options.length) {
    return { free: null, pickup: null, methods: [] };
  }
  const methods = options.map((option) => ({
    method: clean(option.Method) || null,
    price: num(option.Price),
    type: option.Type ?? null,
  }));
  return {
    free: options.some((option) => option.Type === 3),
    pickup: options.some((option) => option.Type === 2),
    methods,
  };
}

function attributesFrom(list) {
  if (!Array.isArray(list)) return {};
  const out = {};
  for (const attribute of list) {
    const key = clean(attribute?.DisplayName) || clean(attribute?.Name);
    const value = clean(attribute?.DisplayValue) || clean(attribute?.Value);
    if (key && value) out[key] = value;
  }
  return out;
}

function sellerFrom(member, memberId) {
  if (!member && !memberId) return null;
  const positive = num(member?.UniquePositive);
  const negative = num(member?.UniqueNegative);
  const total = (positive ?? 0) + (negative ?? 0);
  return {
    memberId: member?.MemberId != null ? String(member.MemberId) : memberId ? String(memberId) : null,
    nickname: clean(member?.Nickname),
    isDealer: member ? bool(member.IsInTrade) : null,
    isVerified: member ? bool(member.IsAddressVerified) : null,
    positive,
    negative,
    feedbackPercent: total > 0 ? Math.round((positive / total) * 1000) / 10 : null,
    memberSince: toIso(member?.DateJoined),
  };
}

function photosFrom(detail, row) {
  if (Array.isArray(detail?.Photos)) {
    const urls = detail.Photos.map((photo) => clean(photo?.Value?.FullSize) || clean(photo?.Value?.Large)).filter(Boolean);
    if (urls.length) return urls;
  }
  const inline = Array.isArray(detail?.PhotoUrls) ? detail.PhotoUrls.filter(Boolean) : [];
  if (inline.length) return inline;
  const primary = clean(detail?.PictureHref) || clean(row?.PictureHref);
  return primary ? [primary] : [];
}

/**
 * Maps one search row (and its optional detail payload) onto the flat output
 * schema. Search rows are thin by design — detail adds description, gallery,
 * attributes and the seller object.
 */
export function normalise(row, detail) {
  const source = { ...(row || {}), ...(detail || {}) };
  const listingId = String(source.ListingId ?? row?.ListingId ?? detail?.ListingId ?? '');

  const buyNow = num(source.BuyNowPrice);
  const start = num(source.StartPrice);
  const price = source.HasBuyNow && buyNow ? buyNow : buyNow || start || null;

  const shipping = shipFrom(source.ShippingOptions);

  return {
    listingId,
    url: `${WEB_ORIGIN}/a/marketplace/listing/${listingId}`,
    title: clean(source.Title),
    subtitle: clean(source.Subtitle) || null,
    category: clean(source.CategoryPath)
      ? String(source.CategoryPath).replace(/^\//, '').replace(/\//g, ' > ')
      : clean(source.CategoryName),
    categoryPath: clean(source.CategoryPath),
    price,
    priceDisplay: clean(source.PriceDisplay),
    startPrice: start,
    buyNowPrice: buyNow,
    oldPrice: num(source.WasPrice),
    percentageOff: num(source.PercentageOff),
    hasBuyNow: bool(source.HasBuyNow),
    isBuyNowOnly: bool(source.IsBuyNowOnly),
    reserveState: source.ReserveState ?? null,
    isReserveMet: source.IsReserveMet === undefined ? null : bool(source.IsReserveMet),
    bidCount: num(source.BidCount),
    maxBidAmount: num(source.MaxBidAmount),
    viewCount: num(source.ViewCount),
    watcherCount: num(source.BidderAndWatchers),
    region: clean(source.Region),
    suburb: clean(source.Suburb),
    listedAt: toIso(source.StartDate),
    closesAt: toIso(source.EndDate),
    quantityRemaining: num(source.QuantityRemaining),
    availableToBuy: clean(source.AvailableToBuy),
    condition: attributesFrom(source.Attributes).Condition
      ? attributesFrom(source.Attributes).Condition
      : clean(source.Condition),
    shipping,
    paymentMethods: Array.isArray(source.PaymentMethods)
      ? source.PaymentMethods.map((method) => clean(method?.Name)).filter(Boolean)
      : [],
    photos: photosFrom(detail, row),
    primaryImage: clean(row?.PictureHref) || photosFrom(detail, row)[0] || null,
    description: clean(detail?.Body) || null,
    attributes: detail ? attributesFrom(detail.Attributes) : {},
    seller: sellerFrom(detail?.Member, source.MemberId ?? row?.MemberId),
    store: detail?.Store ? { name: clean(detail.Store.Name) } : null,
    changeType: null,
    firstSeenAt: null,
    lastSeenAt: null,
    scrapedAt: new Date().toISOString(),
  };
}
