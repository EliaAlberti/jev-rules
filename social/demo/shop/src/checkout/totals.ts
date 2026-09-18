import { applyDiscount } from "./discount";
import { addTax } from "./tax";

export function orderTotalPence(subtotalPence: number, discountPercent: number): number {
  return Math.round(addTax(applyDiscount(subtotalPence, discountPercent)));
}
