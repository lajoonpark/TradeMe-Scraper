import { Actor, log } from 'apify';
import { LIMITS } from './constants.js';
import { closeAgent } from './http.js';
import { run } from './run.js';

await Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const proxy = input.proxy ?? { useApifyProxy: true };

  let proxyUrl;
  if (proxy?.proxyUrls?.length) {
    proxyUrl = proxy.proxyUrls[0];
  } else if (proxy?.useApifyProxy) {
    const configuration = await Actor.createProxyConfiguration(proxy);
    proxyUrl = await configuration.newUrl();
  }

  log.info(`Starting with concurrency ${LIMITS.concurrency}${proxyUrl ? ' via proxy' : ' direct'}`);

  try {
    await run(input, { proxyUrl });
  } finally {
    await closeAgent();
  }
});
