import { Actor, log } from 'apify';
import { LIMITS } from './constants.js';
import { closeAgent } from './http.js';
import { run } from './run.js';

await Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  // Datacenter proxy by default; one `auto` URL for the whole run is enough.
  const proxy = input.proxy ?? { useApifyProxy: true };

  let proxyUrl;
  if (proxy?.proxyUrls?.length) {
    proxyUrl = proxy.proxyUrls[0];
  } else if (proxy?.useApifyProxy) {
    try {
      const configuration = await Actor.createProxyConfiguration(proxy);
      proxyUrl = configuration ? await configuration.newUrl() : undefined;
      if (!configuration) log.warning('Proxy group unavailable; falling back to the default proxy.');
    } catch (error) {
      log.warning(`Proxy setup failed (${error.message}); retrying without a proxy group.`);
    }
    if (!proxyUrl) {
      // A group that the account cannot access (e.g. a stale SHADER default)
      // should degrade to the default proxy instead of failing the whole run.
      const configuration = await Actor.createProxyConfiguration({
        useApifyProxy: true,
        ...(proxy.apifyProxyCountry ? { apifyProxyCountry: proxy.apifyProxyCountry } : {}),
      }).catch(() => undefined);
      proxyUrl = configuration ? await configuration.newUrl().catch(() => undefined) : undefined;
    }
  }

  log.info(`Starting with concurrency ${LIMITS.concurrency}${proxyUrl ? ' via proxy' : ' direct'}`);

  try {
    await run(input, { proxyUrl });
  } finally {
    await closeAgent();
  }
});
