# Trade Me Scraper — Build Plan

Status: **plan only, no code yet**
Target: private Apify Actor for Trade Me NZ Marketplace
Scope: **marketplace only** · private (not published) · opt-in detail enrichment · seller counts only

---

## 1. Headline finding: there is a clean, free, unauthenticated JSON API

The public site is an Angular SPA that renders nothing server-side, so a naive
HTML scraper would need a headless browser. It doesn't. The SPA talks to
`api.trademe.co.nz/v1/...`, and those endpoints are open to anyone who sends one
header:

```
Referer: https://www.trademe.co.nz/
```

Verified live on 2026-11-11:

| Test | Result |
| --- | --- |
| No headers | `401` "requires application credentials" |
| `Origin` only | `401` |
| `x-trademe-uniqueclientid` only | `401` |
| **`Referer` only** | **`200`** |
| `Referer` + anything else | `200` |

There is also an unused `__Host-tm_api_token` cookie and an `x-tm-token` header
the SPA sends, but a token is **not required**. A stale/garbage token still
returns 200. We can ignore the whole token dance — no page bootstrap request,
no cookie jar, no token refresh logic.

**Consequence: a plain HTTP actor, no Playwright, no browser downloads.** That
is ~10x cheaper and ~50x faster than the browser-based competitors.

### Throughput and limits measured

| Property | Measured |
| --- | --- |
| 300 concurrent search requests | 300× `200`, 5.6 s total |
| 60 concurrent listing-detail requests | 60× `200`, 0.9 s |
| Max `rows` per request | 500 (silently clamps above) |
| Max pages per query | ~190 (then empty `List`) |
| Retry-After / rate-limit headers | none seen |
| Datacenter IPs | work (3 VPS proxies returned live data) |

Rough ceiling per query: 190 × 500 ≈ **95,000 listings**. Any query broader than
that must be sharded (by category, region, price band) and de-duplicated on
`ListingId`.

### What the API gives us

Everything needed, and more than any competitor documents:

- **Search** (`/v1/search/general.json`): `TotalCount`, `ListingId`, `Title`,
  `StartPrice`, `BuyNowPrice`, `WasPrice`, `PercentageOff`, `Region`, `Suburb`,
  `Category`, `CategoryPath`, `PictureHref`, `HasBuyNow`, `ReserveState`,
  `BidCount`, `MaxBidAmount`, `IsReserveMet`, `ViewCount`, `ShippingDetails`,
  `MemberId`, and per-vertical typed fields (`__type` = `Property:…`, `Motors:…`).
- **Detail** (`/v1/Listings/{id}.json`): full `Body` description, complete photo
  gallery at six resolutions incl. `FullSize`, `Attributes`, `PropertyAttributes`,
  seller `Member` object with feedback counts, `Store`, `Agency`, `Office`,
  `GeographicLocation`, `OpenHomes`, payment/shipping, `ViewCount`.
- **Seller feedback** (`/v1/Member/{id}/Feedback/Received.json`): paginated
  comments, star type, responding member, linked listing.
- **Taxonomy** (`/v1/Categories.json`, `/v1/tmareas.json`): full category tree
  with numeric IDs, and every region/district/suburb with IDs.

Filters that actually work: `search_string`, `category`, `region`, `district`,
`suburb`, `price_min/max`, `condition`, `shipping_method`, `sort_order`
(`priceasc`, `pricedesc`, `latestlisting`, `bidsmost`, `expiryasc`, `default`,
…), `make`, `model`, `year_min/max`, `odometer_max`, `bedrooms_min`, `page`,
`rows`.

Filter that does **not** work server-side: Buy Now only (`buy_now*`,
`has_buy_now` all return unfiltered totals). Filter client-side on `HasBuyNow`.

---

## 2. Competitive note

Existing public actors are useful only as reference — `abotapi` runs a browser
and needs residential proxies, `lexis` is motors-only. Being API-based with
direct field control already puts this well ahead of both. Store positioning is
not a concern here.

---

## 3. Recommended shape

- **Name:** `trademe-marketplace-scraper` (private)
- **Stack:** Node 22 + `apify` SDK + `undici` — the API returns JSON, so no
  Cheerio and no Playwright
- **Concurrency:** 120 within-run, one `x-trademe-uniqueclientid` per run
- **Proxy:** Apify datacenter by default, residential as opt-in fallback
- **Input surface:** flat and small — no vertical switch, no store constructs

### Why not a browser

No JS execution is required. Adding Playwright would cost ~10x compute for zero
extra fields. Keep a browser path only as an optional `useBrowser` escape hatch
if the API surface ever closes.

---

## 4. Architecture

```
input ──► scope resolver ──► page planner ──► fetch pool ──► normaliser ──► dataset
             │                    │               │
        queries/urls       rows=500, page=N   retry+backoff     dedupe by
        → category IDs     shard if >95k     on 429/5xx/ECONN  ListingId
        region/price bands
```

1. **Scope resolver** — turns `queries` + filters, or pasted URLs, into a list of
   canonical query descriptors. Pasted URLs (`/a/marketplace/...`,
   `/Browse/Listing.aspx?id=`, bare ID) are parsed, not fetched.
2. **Page planner** — for each descriptor fetch `rows=500&page=1`, read
   `TotalCount`, then emit page URLs. If `TotalCount > 90_000`, walk
   `/v1/Categories.json` for narrower child categories, then fall back to region
   and price-band splits, emitting one descriptor per slice.
3. **Fetch pool** — `undici` with a 120-slot semaphore, 3 retries, exponential
   backoff, jitter, 20 s timeout. 429/5xx/ECONNRESET retried; 401 aborts with a
   clear message (means the Referer gate changed).
4. **Normaliser** — per-`__type` field maps into one flat schema, `Date(…)`
   numeric strings → ISO 8601, `+++`/`$0` sentinels → `null`.
5. **Sink** — `Actor.pushData` in batches of 100, LRU de-dupe on `ListingId`,
   hard stop at `maxItems`, `Actor.setStatusMessage` with live counts.

Concurrency is bounded by a semaphore rather than `RequestQueue` because
pagination is deterministic; the queue is still used for `resume` (uniqueKey =
`listingId` on detail tasks).

---

## 5. Input schema

Flat and small — deliberately the opposite of abotapi's 40-field form.

```jsonc
{
  "queries": ["iphone 13", "mountain bike"],   // keyword searches
  "startUrls": [],                              // alternative to queries
  "category": "0344-0422-",                     // optional deeper category ID
  "region": "auckland", "district": "", "suburb": "",
  "minPrice": null, "maxPrice": null,
  "condition": "",                              // "", new, used
  "shippingMethod": "",                         // "", free, pickup
  "buyNowOnly": false,                          // client-side filter
  "sort": "default",
  "maxItems": 200, "maxPagesPerQuery": 190,
  "fetchDetails": true,
  "incrementalMode": false, "stateKey": "",
  "proxy": { "useApifyProxy": true, "apifyProxyGroups": ["SHADER"] }
}
```

`fetchDetails` is opt-in and defaults on for this tool, but stays switchable for
cheap search-only sweeps. Listing-URL and bare-ID inputs are always fetched in
full (there is no search row to return). No Motors/Property/Jobs switches in v1.

---

## 6. Output schema

One flat record per listing. `null` rather than omitted so CSV export stays
rectangular.

```jsonc
{
  "listingId": "6214790737",
  "url": "https://www.trademe.co.nz/a/marketplace/listing/6214790737",
  "title": "SALE ! Apple iPhone 13 Mini 128GB Blue",
  "subtitle": null,
  "category": "Mobile phones > iPhone",
  "categoryPath": "/Mobile-phones/Mobile-phones/iPhone/iPhone",
  "price": 474, "priceDisplay": "$474.00 per item",
  "startPrice": 0, "buyNowPrice": 474, "oldPrice": 851.5, "percentageOff": 44,
  "hasBuyNow": true, "isBuyNowOnly": true, "reserveState": 3,
  "bidCount": 0, "maxBidAmount": 0, "viewCount": 19, "watcherCount": 2,
  "region": "Auckland", "suburb": "North Shore",
  "listedAt": "2026-11-06T…Z", "closesAt": "2026-11-12T…Z",
  "quantityRemaining": 39, "availableToBuy": "10+",
  "condition": null, "shipping": { "free": true, "pickup": true, "methods": [] },
  "paymentMethods": [],
  "photos": ["https://trademe.tmcdn.co.nz/photoserver/full/2127600499.jpg"],
  "primaryImage": "https://trademe.tmcdn.co.nz/photoserver/thumb/2127600499.jpg",
  "description": null,                       // fetchDetails only
  "attributes": {},                           // fetchDetails only, labelled
  "seller": { "memberId": "97358", "nickname": "einfo", "isDealer": true,
              "isVerified": true, "positive": 14385, "negative": 280,
              "feedbackPercent": 98.1, "memberSince": "2002-05-06T…Z" },
  "store": { "name": "Expert Infotech" },
  "changeType": null, "firstSeenAt": null, "lastSeenAt": null,
  "scrapedAt": "2026-11-11T…Z"
}
```

Dataset views: `Listings`, `Details`, `Changes`.

---

## 7. Incremental mode

`sort_order=latestlisting` + a named KV-store baseline keyed by a hash of the
search scope. Each scheduled run walks newest-first, stops at the first
already-seen `ListingId`, and emits only `NEW` / `UPDATED` / `REAPPEARED` /
`EXPIRED` tombstones. `UNCHANGED` rows are remembered but not pushed or billed.

Expiry only fires on a run that walked page 1 to natural end; capped or resumed
runs are marked partial and never expire.

---

## 8. Phases

| # | Phase | Scope | Est. |
| --- | --- | --- | --- |
| 0 | Scaffold | `apify create`, `INPUT_SCHEMA.json`, Dockerfile, README | 1 h |
| 1 | Core client | Referer header, semaphore, retry/backoff, 401 watchdog | 3 h |
| 2 | Search + planner | Query/URL parsing, filter mapping, sharding, pagination | 6 h |
| 3 | Detail enrichment | Gallery, description, attributes | 3 h |
| 4 | Normaliser | Field maps, date parsing, sentinel cleanup | 3 h |
| 5 | Incremental + resume | KV baseline, change detection, tombstones | 5 h |
| 6 | Hardening | Fixture-based tests, live smoke, chaos (429/500/timeout) | 5 h |
| 7 | Usage notes | README, example inputs, sample output | 2 h |

Phases 1–4 are the MVP; 5 is the second pass. Total ≈ 26 h.

---

## 9. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Referer gate closes | High | Watchdog on 401 → automatic browser fallback via `useBrowser`, alert in log |
| API version drift (`v1` → `v2`) | High | All paths centralised in one constants module; fixture tests fail loudly |
| `__type` variants appear | Med | Normaliser defaults to a common-field map, unknown types logged not thrown |
| Datacenter IPs start being rejected | Med | `apifyProxyGroups` switch to residential on repeated 403/429 |
| >95k result queries silently truncate | Med | Detect `TotalCount` over cap, auto-shard, warn if a slice still overflows |
| robots.txt disallows `/a/*search?` | Low | We hit the API host, not the disallowed web paths; still identify with a UA |
| ToS: API "is for in-trade sellers" | Low | Read-only, unauthenticated, low rate; document attribution in README |

---

## 10. Economics

10,000 listings at 1 GB, ~40 s of compute:

- Compute: ~0.011 GB-h ≈ **$0.002**
- Datacenter proxy: ~14 MB ≈ **$0.002**

A full end-to-end build plus a 100k-listing soak test lands well under **$2** of
the ~$500 credit — while roughly 20k listings/min at these concurrency levels.
Detail enrichment is the only meaningful multiplier: it adds one request per
listing, so a fully-enriched 100k run is ~10x the search-only cost and takes
minutes rather than seconds.

---

## 11. Settled

- Private actor, not published — no pricing, store assets or review cycle
- Marketplace only — no Motors/Property/Jobs switches in v1
- `fetchDetails` ships in v1 as an opt-in flag
- Seller data limited to embedded counts/score — no feedback-comment paging

---

## 12. Not doing

- No login/account scraping, no bidding, no watchlists.
- No image hosting/re-hosting — CDN links pass through.
- No NZ-wide full-catalogue mirror — sharded or capped, not exhaustive, unless
  explicitly asked.
