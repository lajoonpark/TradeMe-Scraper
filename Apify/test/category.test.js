import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCategoryId, resetCaches } from '../src/category.js';

const tree = {
  Number: 'Root',
  Subcategories: [
    {
      Number: '0001-',
      Name: 'Trade Me Motors',
      Subcategories: [
        {
          Number: '0001-0268-',
          Name: 'Cars',
          Subcategories: [{ Number: '0001-0268-0272-', Name: 'Toyota' }],
        },
      ],
    },
    { Number: '0344-', Name: 'Mobile phones' },
  ],
};

const client = { async get() { return tree; } };

test.beforeEach(() => resetCaches());

test('web-path roots match the "Trade Me" tree roots', async () => {
  assert.equal(await resolveCategoryId(client, ['motors', 'cars', 'toyota']), '0001-0268-0272-');
  assert.equal(await resolveCategoryId(client, ['mobile-phones']), '0344-');
});

test('the deepest matching category wins', async () => {
  assert.equal(await resolveCategoryId(client, ['motors', 'cars']), '0001-0268-');
});
