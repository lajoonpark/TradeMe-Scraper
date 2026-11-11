import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { ENDPOINTS, LIMITS, MAX_ROWS } from './constants.js';
import { getJson, Semaphore, closeAgent, setProxy, AuthError } from './http.js';
import { parseInput, dedupeDescriptors } from './urls.js';
import { planQuery } from './planner.js';
import { normalise } from './normalise.js';

const DEFAULTS = {
  maxItems: 200,
  fetchDetails: true,
  buyNowOnly: false,
  sort: 'default',
  condition: 'any',
  shippingMethod: 'any',
};

function client(semaphore) {
  return {
    get: (path, options) => getJson(path, { ...options, semaphore }),
  };
}

/** Builds descriptors from queries, startUrls and filters. */
function collectDescriptors(input) {
  const descriptors = [];

  if (Array.isArray(input.startUrls)) {
    for (const entry of input.startUrls) {
      const raw = typeof entry === 'string' ? entry : entry?.url;
      const parsed = parseInput(raw);
      if (parsed) descriptors.push(parsed);
      else log.warning(`Skipped unsupported URL: ${raw}`);
    }
  }

  const queries = (Array.isArray(input.queries) ? input.queries : []).filter(Boolean);
  const sharedParams = {};
  if (input.category !== undefined && input.category !== null && String(input.category).trim() !== '') {
    sharedParams.category = String(input.category).trim().replace(/^\/+|\/+$/g, '');
  }
  for (const name of ['price_min', 'price_max', 'condition', 'shipping_method', 'sort_order']) {
    if (input[name] !== undefined && input[name] !== '') sharedParams[name] = input[name];
  }

  for (const query of queries) {
    descriptors.push({
      kind: 'search',
      searchString: String(query),
      categorySegments: [],
      params: { ...sharedParams },
      url: `query:${query}`,
    });
  }

  // A category or region on its own is a valid scope: scrape that slice.
  if (!descriptors.length && (sharedParams.category || input.region)) {
    descriptors.push({
      kind: 'search',
      searchString: '',
      categorySegments: [],
      params: { ...sharedParams },
      url: `scope:${sharedParams.category ?? ''}${input.region ? ` region=${input.region}` : ''}`,
    });
  }

  return dedupeDescriptors(descriptors);
}

export async function run(rawInput, { pushData, setStatusMessage, proxyUrl } = {}) {
  const input = { ...DEFAULTS, ...(rawInput || {}) };
  const maxItems = Number(input.maxItems) > 0 ? Number(input.maxItems) : Infinity;

  if (proxyUrl) setProxy(proxyUrl);
  pushData = pushData || ((items) => Actor.pushData(items));
  setStatusMessage = setStatusMessage || ((text) => Actor.setStatusMessage(text));

  const descriptors = collectDescriptors(input);
  if (!descriptors.length) {
    setStatusMessage('No input');
    log.warning('Nothing to scrape: supply queries or startUrls.');
    return { pushed: 0 };
  }

  const semaphore = new Semaphore(LIMITS.concurrency);
  const api = client(semaphore);
  const controller = new AbortController();
  const seen = new Set();

  // Incremental state: remember what we saw and only push what moved.
  const incremental = Boolean(input.incrementalMode);
  let stateStore = null;
  let stateAddr = null;
  let prior = {};
  let skippedUnchanged = 0;

  if (incremental) {
    const scope = createHash('sha1')
      .update(input.stateKey || JSON.stringify(descriptors) + JSON.stringify({ ...input, stateKey: undefined, proxy: undefined }))
      .digest('hex');
    stateAddr = `state-${scope}`;
    try {
      stateStore = await Actor.openKeyValueStore('trademe-state');
      prior = (await stateStore.getValue(stateAddr)) || {};
    } catch (error) {
      log.warning(`Incremental state unavailable (${error.message}); behaving like a normal run.`);
    }
  }

  const fingerprint = (record) =>
    createHash('sha1')
      .update(JSON.stringify([record.title, record.price, record.buyNowPrice, record.hasBuyNow, record.closesAt]))
      .digest('hex');

  let pushed = 0;
  let scanned = 0;
  let skippedFiltered = 0;
  let skippedDuplicate = 0;
  let batch = [];

  const flush = async (force = false) => {
    if (!batch.length) return;
    if (!force && batch.length < LIMITS.pushBatch) return;
    const items = batch;
    batch = [];
    await pushData(items);
  };

  const stop = () => {
    if (pushed >= maxItems && !controller.signal.aborted) controller.abort(new Error('maxItems reached'));
  };

  async function emit(row, detail) {
    const record = normalise(row, detail);

    if (input.buyNowOnly && !record.hasBuyNow) {
      skippedFiltered += 1;
      return;
    }

    // Trade Me only honours price_min/price_max when a category is in play, so
    // enforce them here too. Records without a price are kept.
    const min = input.minPrice === null || input.minPrice === undefined || input.minPrice === '' ? null : Number(input.minPrice);
    const max = input.maxPrice === null || input.maxPrice === undefined || input.maxPrice === '' ? null : Number(input.maxPrice);
    if (record.price !== null && ((min !== null && record.price < min) || (max !== null && record.price > max))) {
      skippedFiltered += 1;
      return;
    }

    if (seen.has(record.listingId)) {
      skippedDuplicate += 1;
      return;
    }

    if (incremental && stateStore) {
      const now = new Date().toISOString();
      const digest = fingerprint(record);
      const previous = prior[record.listingId];
      if (previous && previous.fingerprint === digest) {
        skippedUnchanged += 1;
        return;
      }
      record.changeType = previous ? 'UPDATED' : 'NEW';
      record.firstSeenAt = previous?.firstSeenAt ?? now;
      record.lastSeenAt = now;
      prior[record.listingId] = { fingerprint: digest, firstSeenAt: record.firstSeenAt, lastSeenAt: now };
    }

    seen.add(record.listingId);
    batch.push(record);
    pushed += 1;
    if (pushed % 250 === 0) {
      setStatusMessage(`Scraped ${pushed} listings (scanned ${scanned})`);
    }
    if (pushed >= maxItems) stop();
    await flush();
  }

  async function processDescriptor(descriptor) {
    if (controller.signal.aborted) return;

    if (descriptor.kind === 'listing') {
      const detail = await api.get(ENDPOINTS.listing(descriptor.listingId), { signal: controller.signal, semaphore });
      scanned += 1;
      if (detail) await emit({ ListingId: descriptor.listingId }, detail);
      return;
    }

    const plan = await planQuery(api, descriptor, input, {
      semaphore,
      signal: controller.signal,
      maxPages: input.maxPagesPerQuery,
    });

    if (plan.truncated) {
      log.warning(`Query "${plan.label}" was sharded/truncated to stay under the page ceiling.`);
    }

    // No slot is held while rows are processed: every api.get acquires and
    // releases its own slot. Keep a bounded lookahead of pages in flight and
    // consume them in page order, so `sort: latest` plus a small `maxItems`
    // still yields the newest rows without buffering a whole query. Small runs
    // keep the lookahead small so they don't pull megabytes they won't use.
    const lookahead = Math.max(
      1,
      Math.min(
        16,
        plan.pages.length,
        maxItems === Infinity ? plan.pages.length : Math.ceil((maxItems / MAX_ROWS) * 2) + 1,
      ),
    );
    const pending = [];
    let nextPage = 0;

    for (let index = 0; index < plan.pages.length; index += 1) {
      while (pending.length < lookahead && nextPage < plan.pages.length) {
        const params = plan.pages[nextPage];
        nextPage += 1;
        pending.push(
          api.get(ENDPOINTS.search, { params, signal: controller.signal }).then(
            (page) => ({ page }),
            (error) => ({ error }),
          ),
        );
      }

      if (controller.signal.aborted) break;
      const { page, error } = await pending.shift();
      if (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
      if (!page?.List?.length) continue;

      // No point fetching details for a whole page when only a few rows can
      // still be pushed. The +25 buffer covers client-side filtering.
      const wanted =
        maxItems === Infinity
          ? page.List.length
          : Math.min(page.List.length, Math.max(0, maxItems - pushed) + 25);
      if (wanted === 0) break;
      const rows = page.List.slice(0, wanted);

      // Fetch the page's details concurrently, but emit them in row order.
      const details = input.fetchDetails
        ? await Promise.all(
            rows.map((row) =>
              row.ListingId
                ? api.get(ENDPOINTS.listing(row.ListingId), { signal: controller.signal }).catch(() => null)
                : null,
            ),
          )
        : null;

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (controller.signal.aborted) break;
        const row = rows[rowIndex];
        scanned += 1;
        if (!row.ListingId) continue;

        if (input.fetchDetails) {
          const detail = details[rowIndex];
          if (!detail) continue;
          await emit(row, detail);
        } else {
          await emit(row, null);
        }
      }
    }
  }

  let failure = null;
  try {
    await Promise.all(descriptors.map((descriptor) => processDescriptor(descriptor)));
  } catch (error) {
    if (!controller.signal.aborted) failure = error;
  }

  await flush(true);

  if (stateStore) {
    await stateStore.setValue(stateAddr, prior).catch((error) => log.warning(`Could not save incremental state: ${error.message}`));
  }

  const summary = `Scraped ${pushed} listings (scanned ${scanned}, ${skippedDuplicate} dupes, ${skippedFiltered} filtered, ${skippedUnchanged} unchanged)`;
  setStatusMessage(summary);
  log.info(summary);

  if (failure) {
    if (failure instanceof AuthError) {
      log.error(failure.message);
      throw failure;
    }
    throw failure;
  }

  return { pushed, scanned, skippedDuplicate, skippedFiltered, skippedUnchanged };
}
