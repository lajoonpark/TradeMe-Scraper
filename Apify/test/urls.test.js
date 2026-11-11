import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, parseListingId, dedupeDescriptors } from '../src/urls.js';

test('parses every listing URL shape', () => {
  assert.equal(parseListingId('https://www.trademe.co.nz/a/marketplace/listing/6214790737'), '6214790737');
  assert.equal(parseListingId('https://www.trademe.co.nz/Browse/Listing.aspx?id=6214790737'), '6214790737');
  assert.equal(parseListingId('https://www.trademe.co.nz/6214790737'), '6214790737');
  assert.equal(parseListingId('https://www.trademe.co.nz/a/motors/cars/toyota/aqua/listing/6177402562'), '6177402562');
  assert.equal(parseListingId('6177402562'), '6177402562');
  assert.equal(parseListingId('https://www.trademe.co.nz/a/marketplace/search?search_string=iphone'), null);
});

test('listing URLs become listing descriptors', () => {
  const descriptor = parseInput('https://m.trademe.co.nz/a/marketplace/listing/6214790737');
  assert.equal(descriptor.kind, 'listing');
  assert.equal(descriptor.listingId, '6214790737');
  assert.match(descriptor.url, /^https:\/\/www\.trademe\.co\.nz\//);
});

test('search URLs keep keyword, category path and filters', () => {
  const descriptor = parseInput('https://www.trademe.co.nz/a/marketplace/computers/laptops?search_string=macbook&category=0002-9844-&price_max=900&sort_order=priceasc');
  assert.equal(descriptor.kind, 'search');
  assert.equal(descriptor.searchString, 'macbook');
  assert.deepEqual(descriptor.categorySegments, ['computers', 'laptops']);
  assert.equal(descriptor.params.category, '0002-9844-');
  assert.equal(descriptor.params.price_max, '900');
  assert.equal(descriptor.params.sort_order, 'priceasc');
});

test('category-only URLs are accepted', () => {
  const descriptor = parseInput('https://www.trademe.co.nz/a/marketplace/computers/laptops');
  assert.equal(descriptor.kind, 'search');
  assert.equal(descriptor.searchString, '');
  assert.deepEqual(descriptor.categorySegments, ['computers', 'laptops']);
});

test('non-trademe and junk input is rejected', () => {
  assert.equal(parseInput('https://example.com/foo'), null);
  assert.equal(parseInput('not a url'), null);
  assert.equal(parseInput(''), null);
  assert.equal(parseInput(null), null);
});

test('descriptors are de-duplicated', () => {
  const a = parseInput('https://www.trademe.co.nz/a/marketplace/search?search_string=bike');
  const b = parseInput('https://www.trademe.co.nz/a/marketplace/search?search_string=bike');
  const c = parseInput('https://www.trademe.co.nz/a/marketplace/listing/6214790737');
  assert.equal(dedupeDescriptors([a, b, c]).length, 2);
});
