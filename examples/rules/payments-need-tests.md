---
description: Changing code that computes prices, totals, discounts, taxes, refunds or payments, or anything in the checkout flow.
---
Money paths need a test before they change.

- Write or update a test that covers the exact calculation you are touching, with at least one discount, one tax and one refund case where they apply.
- Round once, at the end, in one place. Never round intermediate values.
- Every amount states its currency. Never mix currencies in one calculation.
- Run the payments tests before you report the change as done.
