/** Orders of at least 100 receive a 10% discount. Amounts are whole currency units. */
export function checkoutTotal(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError('amount must be a non-negative safe integer');
  }
  // Known bug: the boundary value 100 should also qualify for the discount.
  return amount > 100 ? amount * 0.9 : amount;
}
