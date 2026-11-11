import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, toIso } from '../src/normalise.js';

const row = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('./fixtures/search-row.json', import.meta.url))));
const detail = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('./fixtures/detail.json', import.meta.url))));

test('toIso parses the API date wrapper, epochs and ISO', () => {
  assert.equal(toIso('/Date(1793948523747)/'), new Date(1793948523747).toISOString());
  assert.equal(toIso(1793948523747), new Date(1793948523747).toISOString());
  assert.equal(toIso('2026-11-06T00:00:00Z'), '2026-11-06T00:00:00.000Z');
  assert.equal(toIso(0), null);
  assert.equal(toIso('/Date(0)/'), null);
  assert.equal(toIso('nonsense'), null);
});

test('detail records carry description, gallery, attributes and seller', () => {
  const record = normalise(row, detail);
  assert.equal(record.listingId, String(detail.ListingId));
  assert.ok(record.description.length > 20);
  assert.ok(record.photos[0].includes('/photoserver/full/'));
  assert.equal(record.attributes.Memory, '16 to 31 GB');
  assert.equal(record.seller.memberId, String(detail.Member.MemberId));
  assert.equal(record.seller.nickname, detail.Member.Nickname);
  assert.equal(typeof record.seller.feedbackPercent, 'number');
});

test('search-only records still produce a usable record', () => {
  const record = normalise(row, null);
  assert.equal(record.description, null);
  assert.deepEqual(record.attributes, {});
  assert.equal(record.seller.memberId, String(row.MemberId));
  assert.equal(record.seller.nickname, null);
  assert.equal(record.photos.length, 1);
});

test('price prefers Buy Now when present', () => {
  const record = normalise({ ...row, HasBuyNow: true, BuyNowPrice: 120, StartPrice: 40 }, null);
  assert.equal(record.price, 120);
});

test('price falls back to start price, then null', () => {
  assert.equal(normalise({ ...row, HasBuyNow: false, BuyNowPrice: 0, StartPrice: 40 }, null).price, 40);
  assert.equal(normalise({ ...row, HasBuyNow: false, BuyNowPrice: 0, StartPrice: 0 }, null).price, null);
});

test('price ignores a lingering Buy Now price when Buy Now is off', () => {
  const record = normalise({ ...row, HasBuyNow: false, BuyNowPrice: 120, StartPrice: 40 }, null);
  assert.equal(record.price, 40);
});

test('shipping flags derive from option types', () => {
  const free = normalise({ ...row, ShippingOptions: [{ Type: 3, Price: 0 }, { Type: 2, Price: 0 }] }, null);
  assert.equal(free.shipping.free, true);
  assert.equal(free.shipping.pickup, true);
  assert.equal(free.shipping.methods.length, 2);

  const none = normalise({ ...row, ShippingOptions: null }, null);
  assert.equal(none.shipping.free, null);
  assert.deepEqual(none.shipping.methods, []);
});

test('sentinel values are cleaned', () => {
  const record = normalise({ ...row, Title: '  spaced  ', Subtitle: '+++' }, null);
  assert.equal(record.title, 'spaced');
  assert.equal(record.subtitle, null);
});

test('url is rebuilt on the marketplace host', () => {
  assert.match(normalise(row, null).url, /^https:\/\/www\.trademe\.co\.nz\/a\/marketplace\/listing\/\d+$/);
});
