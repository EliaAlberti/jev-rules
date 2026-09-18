---
description: Creating or changing a database migration, schema, table, column or index.
---
Every migration ships with its way back.

- Write the down migration in the same change and run it locally once.
- Never drop or rename a column in one step: add, backfill, switch reads, then remove in a later release.
- Large tables get batched backfills, never a single UPDATE.
