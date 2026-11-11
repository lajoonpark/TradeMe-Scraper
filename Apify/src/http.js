import { Agent, ProxyAgent, request } from 'undici';
import { LIMITS, REQUIRED_HEADERS, API_ORIGIN } from './constants.js';

/**
 * Raised when the Referer gate closes. Distinct from a transient failure so the
 * caller can abort the whole run instead of retrying hundreds of times.
 */
export class AuthError extends Error {
  constructor(url, status, body) {
    super(`Trade Me rejected the request (HTTP ${status}). The Referer gate has probably changed. ${url} :: ${body.slice(0, 200)}`);
    this.name = 'AuthError';
    this.status = status;
  }
}

const agent = new Agent({
  connections: LIMITS.concurrency + 20,
  pipelining: 1,
  keepAliveTimeout: 30000,
  headersTimeout: LIMITS.timeoutMs,
  bodyTimeout: LIMITS.timeoutMs,
});

let dispatcher = agent;

/** Points the client at an Apify Proxy URL, or back at the direct agent. */
export function setProxy(proxyUrl) {
  dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, connections: LIMITS.concurrency + 20 }) : agent;
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
    try {
      res = await request(target, {
        method: 'GET',
        dispatcher,
        headers: REQUIRED_HEADERS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error.name === 'AbortError') throw error;
      lastError = error;
      if (attempt === LIMITS.retries) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    const status = res.statusCode;
    const body = await res.body.text();

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

    if (status === 401 || status === 403) throw new AuthError(target, status, body);

    if (status === 404) return null;

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
  await agent.close();
}
