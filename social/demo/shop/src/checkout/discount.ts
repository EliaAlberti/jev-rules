// Amounts are integer pence (GBP). Rounding happens once, in totals.ts.
export function applyDiscount(subtotalPence: number, percent: number): number {
  return subtotalPence - subtotalPence * percent;
}
