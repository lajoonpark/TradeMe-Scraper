import { Agent, ProxyAgent, request } from 'undici';
import { LIMITS, REQUIRED_HEADERS, API_ORIGIN } from './constants.js';

/**
 * Raised when the Referer gate closes. Distinct from a transient failure so the
 * caller can abort the whole run instead of retrying hundreds of times.
 */
export class AuthError extends Error {
  constructor(url, status, body, kind = 'referer-gate') {
    const hint =
      kind === 'exit-ip-blocked'
        ? 'Trade Me blocked the exit IP (security policy); use a residential proxy'
        : 'The Referer gate has probably changed';
    super(`${hint} (HTTP ${status}). ${url} :: ${String(body).slice(0, 200)}`);
    this.name = 'AuthError';
    this.status = status;
    this.kind = kind;
  }
}

/** 403s that come from the exit IP being refused, not from the Referer gate. */
const IP_BLOCK = /security policy|access denied/i;

const agent = new Agent({
  connections: LIMITS.concurrency + 20,
  pipelining: 1,
  keepAliveTimeout: 30000,
  headersTimeout: LIMITS.timeoutMs,
  bodyTimeout: LIMITS.timeoutMs,
});

let dispatcher = agent;
let proxyDispatcher = null;
let proxyRefresher = null;
let rotating = null;

/** Points the client at an Apify Proxy URL, or back at the direct agent. */
export function setProxy(proxyUrl) {
  if (proxyDispatcher) {
    proxyDispatcher.close().catch(() => {});
    proxyDispatcher = null;
  }
  if (proxyUrl) {
    proxyDispatcher = new ProxyAgent({ uri: proxyUrl, connections: LIMITS.concurrency + 20 });
    dispatcher = proxyDispatcher;
  } else {
    dispatcher = agent;
  }
}

/**
 * Supplies a way to obtain a fresh proxy URL, which is how a blocked exit IP is
 * rotated. Without it a 403 from the IP block stays fatal.
 */
export function setProxyRefresher(fn) {
  proxyRefresher = typeof fn === 'function' ? fn : null;
}

/**
 * Rotate to a new exit IP. Requests that were blocked at the same moment share
 * a single rotation instead of each opening its own proxy session.
 */
async function rotateProxy() {
  if (!proxyRefresher) return false;
  if (!rotating) {
    rotating = (async () => {
      try {
        const url = await proxyRefresher();
        if (!url) return false;
        setProxy(url);
        return true;
      } catch {
        return false;
      }
    })();
    const settle = () => {
      rotating = null;
    };
    rotating.then(settle, settle);
  }
  return rotating;
}

/** Counting semaphore — bounds in-flight requests without a queue dependency. */
export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt) {
  const base = LIMITS.backoffBaseMs * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 0.4);
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 408, 520, 522, 524]);

/**
 * GET a JSON document from the Trade Me API with bounded concurrency, retries and
 * backoff. `signal` aborts the whole run once `maxItems` is reached.
 */
export async function getJson(path, { params, signal, semaphore } = {}) {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const target = url.toString();
  const send = () => getOnce(target, signal);

  return semaphore ? semaphore.run(send) : send();
}

async function getOnce(target, signal) {
  let lastError;

  for (let attempt = 0; attempt <= LIMITS.retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');

    let res;
    let body;
    try {
      res = await request(target, {
        method: 'GET',
        dispatcher,
        // Undici's ProxyAgent mutates the headers object (it adds `host`), so
        // hand it a copy — REQUIRED_HEADERS is frozen.
        headers: { ...REQUIRED_HEADERS },
        signal,
      });
      // Reading the body is where a residential proxy usually drops the
      // connection ("other side closed"), so it has to sit inside the retry —
      // otherwise one dropped body kills the whole run.
      body = await res.body.text();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      if (attempt === LIMITS.retries) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    const status = res.statusCode;

    if (status === 200) {
      try {
        return JSON.parse(body);
      } catch (error) {
        lastError = new Error(`Unparseable JSON from ${target}: ${body.slice(0, 120)}`);
        if (attempt === LIMITS.retries) break;
        await sleep(backoffMs(attempt));
        continue;
      }
    }

    if (status === 404) return null;

    if (status === 401 || status === 403) {
      const blocked = status === 403 && IP_BLOCK.test(body);
      // A blocked exit IP is worth retrying on a fresh proxy session; a closed
      // Referer gate is not.
      if (blocked && attempt < LIMITS.retries && (await rotateProxy())) {
        await sleep(backoffMs(0));
        continue;
      }
      throw new AuthError(target, status, body, blocked ? 'exit-ip-blocked' : 'referer-gate');
    }

    if (!RETRY_STATUS.has(status)) {
      throw new Error(`Unexpected HTTP ${status} from ${target}: ${body.slice(0, 160)}`);
    }

    lastError = new Error(`HTTP ${status} from ${target}`);
    if (attempt === LIMITS.retries) break;
    const retryAfter = Number(res.headers['retry-after']);
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
  }

  throw lastError ?? new Error(`Request failed: ${target}`);
}

export async function closeAgent() {
  await Promise.allSettled([agent.close(), ...(proxyDispatcher ? [proxyDispatcher.close()] : [])]);
}
