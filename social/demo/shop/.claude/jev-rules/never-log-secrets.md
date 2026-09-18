---
description: Adding or changing logging, error reporting or analytics events, or handling API keys, tokens, passwords or personal data.
---
Logs are read by more people than you think.

- Never log tokens, passwords, card numbers, full emails or request bodies.
- Log ids, not objects. Redact with the shared `redact()` helper.
- Secrets come from the environment, never from a committed file.
