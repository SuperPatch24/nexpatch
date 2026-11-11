# Reproducible build

Status: `api/package-lock.json` is NOT yet committed. It could not be generated in the review sandbox (no npm registry access), so a clean `npm ci` has not been verified.

One-time, on a machine with internet access (Node 22, npm 10):

```
cd api
npm install --package-lock-only
npm ci
npm test
git add package-lock.json && git commit -m "Add lockfile"
```

Confirm `@azure/storage-queue` (12.32.0) appears in the lockfile. Do not remove or downgrade dependencies to make the install pass.

After the lockfile is committed, change the install step in `.github/workflows/deploy-backend.yml` from `npm install --omit=dev` to `npm ci --omit=dev`. `.github/workflows/ci.yml` already enforces `npm ci`, syntax checks and tests, and fails until the lockfile exists.
