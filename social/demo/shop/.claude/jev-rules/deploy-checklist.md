---
description: Deploying, releasing, shipping to production, tagging a version or publishing a package.
---
Before anything reaches production, in this order:

1. Run the full test suite and stop if anything fails.
2. Bump the version and add a changelog entry that a user can understand.
3. Confirm the rollback path: the previous version is tagged and can be redeployed in one step.
4. Deploy, then check the health endpoint and the error rate for five minutes.
