---
description: Adding or changing a public API endpoint, its request or response shape, status codes or versioning.
---
The API is a promise to other teams.

- Additive changes only within a version. Removing or renaming a field needs a new version.
- Update the OpenAPI file in the same change, with an example.
- Errors use the shared problem-details shape and the right status code.
