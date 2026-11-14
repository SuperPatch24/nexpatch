# NexpatchOnline proposed launch pricing

These are suggested public list prices in USD, not active billing. Change them in one place, `api/src/lib/plans.js`, and mirror the same table in `public/index.html` (the `PLANS` constant). A test (`pricing-page.test.js`) fails if the two differ.

Every organization starts with a **15-day free trial, no credit card**, with Pro limits. The trial starts when an administrator connects the organization.

## Model

Platform license (monthly or annual) + per-device usage + optional App Control add-on.

| Plan | Platform license | Per device / month | Devices | Custom app builds / month | App package requests / month | Annual license |
|---|---:|---:|---:|---:|---:|---:|
| Starter | $29 | none | up to 25 | 2 | 2 | not offered (monthly only) |
| Pro | $99 | $3.00 | up to 100 | 10 | 10 | $1,009.80 / year |
| Pro Plus | $249 | $2.75 | up to 300 | 40 | 40 | $2,539.80 / year |
| Enterprise | quote | quote | over 300, or custom | custom | custom | quote |

- **App Control add-on:** $0.40 per device per month, any plan.
- **Annual billing:** 15% off the platform license only. Per-device usage is billed monthly.
- **Limits:** custom app builds are packaging drafts started in the month; package requests are application requests submitted in the month. Both reset on the 1st (UTC). Device counts are shown against the plan but not blocked.
- Organizations marked paid before tiers existed have no limits until a tier is set.

## What is and is not implemented

Implemented: the pricing page and estimator, the free trial, plan tiers recorded by platform admins, and monthly limits on custom builds and package requests.

Not implemented: checkout, invoicing, tax, device metering for billing, overage handling, cancellation and refunds. Do not promise these prices as billing terms until they are.

## Open choices to confirm

- Prices and limits above are starting proposals, not researched figures.
- Starter is read as "under 25 devices: flat monthly price, no annual option, no per-device usage". Change `TIERS.starter` if you meant something else.

Benchmark context: Patch My PC advertises a $3,500/year starting minimum for up to 1,000 devices, while Action1 advertises its first 200 endpoints free. Check current competitor pricing before launch.
