---
description: How releases are built, versioned, tagged, deployed to production and rolled back.
---
# Deploy pipeline

Releases go out from `main` through `.github/workflows/deploy.yml`.

- Every push to `main` runs the tests and builds a container image named after the commit.
- A release is a tag such as `v1.4.0` on a commit whose build passed. Pushing the tag starts the deploy job, which reuses that commit's image and never builds again.
- The image goes to staging first. Production follows once the smoke tests pass there, one instance at a time, with five minutes of watching the error rate after the first.

To roll back, run the deploy workflow by hand with the previous tag. Its image is still in the registry, so this takes about two minutes. Never delete or move a release tag.
