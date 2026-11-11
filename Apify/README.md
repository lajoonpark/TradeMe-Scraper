# Trade Me NZ Marketplace Scraper

Apify actor that scrapes `trademe.co.nz` Marketplace listings as structured JSON.

**No browser.** Trade Me's front end is an Angular SPA, but it is backed by a plain
JSON API. This actor talks to that API directly, so it runs roughly two orders of
magnitude faster than a Playwright-based scraper for the same data.

---

## Why there is no browser

`https://api.trademe.co.nz/v1/...` sits behind exactly one gate:

```
Referer: https://www.trademe.co.nz/
```

Without it the API answers `401 This API requires that you supply your application
credentials.` The SPA also sends a signed `x-tm-token` header and an
`__Host-tm_api_token` cookie, but **neither is required** — a stale or garbage
token still returns `200`. So there is no token fetch, no cookie jar and no
refresh logic. `src/constants.js` holds the header set; if the gate ever changes,
that file is the one place to edit and `AuthError` will surface it loudly.

Measured on 2026-11-11: 300 concurrent search requests all returned `200` in
5.6s and the API sent no rate-limit headers back. Datacenter IPs work, so Apify
proxy group `SHADER` is enough — residential is not needed.

## Install and run

```bash
npm install
npm test                                        # 21 unit tests, no network

# live smoke test, no Apify platform needed
OUT=out.ndjson node test/run-local.js '{"queries":["iphone 13"],"maxItems":5}'

# via proxy
TRADEME_PROXY='http://user:pass@proxy:8000' node test/run-local.js '{"queries":["bike"],"maxItems":3}'
```

On the Apify platform, push with `apify push` and run from the console or API.

## Input

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `queries` | string[] | `["iphone 13"]` | Keywords. Each is walked to its last page. |
| `startUrls` | `{url}`[] | — | Search, category or listing URLs. An input with `/a/motors/...` still resolves through the marketplace endpoint. |
| `category` | string | — | Category number, e.g. `0344-0422-`. |
| `region` / `district` / `suburb` | string | — | Name or numeric ID. |
| `minPrice` / `maxPrice` | integer | — | NZD. |
| `condition` | `""` \| `new` \| `used` | `""` | Server-side. |
| `shippingMethod` | `""` \| `free` \| `pickup` | `""` | Server-side. |
| `buyNowOnly` | boolean | `false` | **Client-side** — see below. |
| `sort` | enum | `default` | `latest` is the one to use for polling. |
| `maxItems` | integer | `200` | Hard stop. `0` = unlimited. |
| `maxPagesPerQuery` | integer | `190` | Server caps at 190 pages × 500 rows. |
| `fetchDetails` | boolean | `true` | Adds description, full gallery, attributes. One request per listing. |
| `incrementalMode` / `stateKey` | boolean / string | `false` / — | Scheduled-run mode, see below. |
| `proxy` | object | datacenter | `SHADER` group. |

`buyNowOnly` has no server-side equivalent — `buy_now_only`, `buy_now` and
`has_buy_now` all return unfiltered totals — so it is applied after normalising
and is reflected in `skippedFiltered`. `minPrice`/`maxPrice` are enforced
client-side as well, because the API only honours them when a category is
present.

## Output

One flat record per listing. See `PLAN.md` §6 for the full schema and the dataset
views (`Listings`, `Details`).

Fields that matter operationally:

- `price` prefers `buyNowPrice` when `hasBuyNow`, otherwise `startPrice`, otherwise `null`
- `photos` is the full gallery when `fetchDetails` is on, otherwise the single thumbnail
- `seller.feedbackPercent` derives from unique positive/negative counts
- `shipping.free` / `shipping.pickup` derive from the API's shipping option types (3 = free, 2 = pickup)

## How pagination behaves

Page 1 is probed for `TotalCount`. Pages are emitted at 500 rows each, up to
`maxPagesPerQuery` and the server's 190-page ceiling. If a query's `TotalCount`
exceeds 90,000 it is sharded by child category, then by price band, because a
single query cannot return more than ~95,000 records. A run that had to shard is
logged and the plan is flagged `truncated`.

De-duplication on `listingId` is global across the run, so overlap between
shards and between queries is free.

## Incremental mode

For scheduled runs. State is kept in the `trademe-state` key-value store, keyed
by a hash of the search scope or by `stateKey`. Each run pushes only `NEW` and
`UPDATED` rows — comparing title, price, buy-now price, buy-now flag and closing
time — and stamps `changeType`, `firstSeenAt` and `lastSeenAt`.

Pair it with `sort: "latest"` so the run finds new listings first. Expiry
tombstones are not emitted; a listing that disappears simply stops appearing.

## Layout

| File | Role |
| --- | --- |
| `src/constants.js` | API paths, the gate headers, caps, filter vocabularies |
| `src/http.js` | Undici client, semaphore, retries/backoff, `AuthError`, proxy switching |
| `src/urls.js` | Input URL parsing and de-duplication |
| `src/category.js` | Slug → category ID, place name → region ID (cached) |
| `src/planner.js` | Filter assembly, probing, sharding, page emission |
| `src/normalise.js` | API row/detail → flat record |
| `src/run.js` | Orchestration, de-dupe, batching, incremental state |
| `src/main.js` | Actor entry point |

## Tests

`npm test` covers URL parsing, normalisation (dates, prices, shipping types,
sentinels), and the planner (caps, sharding, filter precedence) against fixtures
captured from the live API. Fixtures live in `test/fixtures/`.

## Known limits

- Search rows carry only a thumbnail and no description; that is what
  `fetchDetails` is for.
- **Price and condition filters only take effect server-side when a `category` is
  supplied.** With a bare keyword search Trade Me ignores both — the live website
  ignores them too. `minPrice`/`maxPrice` are therefore also enforced
  client-side, so results are always in range, but a keyword-only run packs in
  fewer matching records per page and scans more to fill `maxItems`. Supply a
  category for efficient price-filtered runs. `condition` has no record field to
  fall back on, so a keyword-only `condition` filter is advisory only.
- `buyNowOnly` has no server-side equivalent and is always client-side.
- Marketplace only. Motors, Property, Jobs and Services resolve through the same
  endpoint but their typed fields (`make`, `bedrooms`, …) are not mapped yet.
- A 401 or 403 aborts the run rather than retrying — it means the gate moved.
