---
description: Authentication, login, sessions, permissions, roles, password reset or access control.
---
Access control is checked on the server, every time.

- Never trust a role or user id sent by the client.
- Sessions expire, and password reset links are single use.
- Add a test for the forbidden case, not only the allowed one.
