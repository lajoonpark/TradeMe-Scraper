/**
 * Runs the actor locally with no Apify platform, printing records as NDJSON.
 *
 *   node test/run-local.js '{"queries":["iphone"],"maxItems":5}'
 *   node test/run-local.js @input.json > out.ndjson
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { run } from '../src/run.js';
import { closeAgent } from '../src/http.js';

const arg = process.argv[2] || '{}';
const input = arg.startsWith('@') ? JSON.parse(readFileSync(arg.slice(1), 'utf8')) : JSON.parse(arg);
const outFile = process.env.OUT;

const collected = [];
const started = Date.now();

const result = await run(input, {
  pushData: async (items) => {
    if (outFile) collected.push(...items);
    else for (const item of items) console.log(JSON.stringify(item));
  },
  setStatusMessage: (text) => console.error(`[status] ${text}`),
  proxyUrl: process.env.TRADEME_PROXY,
});

if (outFile) writeFileSync(outFile, collected.map((item) => JSON.stringify(item)).join('\n'));

console.error(`[done] ${JSON.stringify(result)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await closeAgent();
