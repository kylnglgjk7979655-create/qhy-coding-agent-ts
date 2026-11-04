import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutTotal } from './checkout.js';

test('small orders retain their price', () => {
  assert.equal(checkoutTotal(40), 40);
  assert.equal(checkoutTotal(0), 0);
});

test('large orders receive a discount', () => {
  assert.equal(checkoutTotal(150), 135);
});

test('invalid amounts are rejected', () => {
  assert.throws(() => checkoutTotal(-1), RangeError);
  assert.throws(() => checkoutTotal(1.5), RangeError);
});
