---
description: How the checkout computes totals, discounts, tax and rounding, and where that code lives.
---
# Checkout

The checkout turns a basket into an order total. All of it lives in `src/checkout/`, one step per file, run in this order:

1. `basket.ts` adds up the line items. Every amount is a whole number of pence, never a float.
2. `discount.ts` applies discount codes: percentage codes first, then fixed amounts, then free delivery. A discount never takes a line below zero.
3. `tax.ts` adds VAT to each line at the rate for its product category, on the discounted price. The rates are in `tax-rates.json`.
4. `totals.ts` adds delivery and rounds once, at the end, half up to the nearest penny.

Each step has its own test file in `test/checkout/`. A bug in a total is almost always in the order of steps 2 and 3, so check that first.
