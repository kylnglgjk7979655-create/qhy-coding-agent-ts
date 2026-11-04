import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutTotal } from '../src/checkout.js';

test('BUG: exactly 100 should receive the discount', () => {
  assert.equal(checkoutTotal(100), 90);
});
