# Taking payment with Stripe

NexpatchOnline uses Stripe Checkout (Stripe's own payment page), so card details never touch your servers.
A company pays from **Organization → Change plan → Pay by card**. When the payment goes through, Stripe tells the
API and the plan switches on by itself. Manual activation in the Admin Center still works for invoiced customers.

What is charged
- Platform license (Starter $19, Pro $49, Pro Plus $129 a month; annual is 15% off the license).
- Per-device usage on Pro and Pro Plus, and the optional App Control price per device.
- Monthly plans bill every month. Annual plans bill the whole year at once, including per-device lines.
- Device counts follow the devices the company really has: a daily job (06:30 UTC) updates the quantities, with no
  proration (a change appears on the next invoice).
- Enterprise is by quote, not through Checkout.
- Prices are in US dollars. Prices come from `api/src/lib/plans.js`, so the pricing page and Stripe never differ.

## 1. Stripe account (in the Stripe Dashboard)
1. Create the account and finish the business details. Use your real legal business name.
2. Start in **Test mode** (toggle at the top right). Do everything below in test mode first.
3. **Developers → API keys:** note the *secret key* (starts `sk_test_`). Don't paste it in chat or in the repo.
4. **Settings → Billing → Customer portal:** turn it on. Allow: update payment method, view invoice history, cancel
   subscription. Leave "customers can switch plans" off (plan changes go through the Change plan request).
5. Optional: **Settings → Tax**, then set `STRIPE_AUTOMATIC_TAX=true` below so Stripe adds sales tax/GST/HST.

## 2. Webhook
**Developers → Webhooks → Add endpoint**
- URL: `https://nexpatch-api-20022.azurewebsites.net/api/stripe/webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`,
  `invoice.marked_uncollectible`
- After saving, reveal the **signing secret** (starts `whsec_`).

## 3. Give the two secrets to the Function App
Run this in Azure Cloud Shell (bash). It asks you to paste each value without showing it on screen.

```bash
read -rsp "Stripe secret key: " SK; echo
read -rsp "Stripe webhook signing secret: " WH; echo
az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 \
  --settings "STRIPE_SECRET_KEY=$SK" "STRIPE_WEBHOOK_SECRET=$WH" --output none
unset SK WH
```
Optional: `STRIPE_AUTOMATIC_TAX=true` and `PUBLIC_APP_URL=https://nexpatchonline.com`.
(Better still, keep them in Key Vault and use Key Vault references as the app setting values.)

## 4. Test (test mode)
1. Sign in as a company admin, go to Organization, choose Change plan, then Pay by card.
2. Pay with card `4242 4242 4242 4242`, any future expiry, any CVC and postal code.
3. You return to the Organization page. Within a few seconds the plan shows as active, with "Renews on".
4. In the Admin Center, open Billing: the subscription, monthly revenue and the invoice appear.
5. Press Manage billing on the company page to check the Stripe customer portal opens.
6. In the Dashboard, cancel the test subscription and check the company falls back to the expired plan.
7. Failed payment test card: `4000 0000 0000 0341`.

## 5. Go live
1. Switch Stripe to live mode, repeat steps 1.3, 1.4 and 2 there (live keys and a live webhook are separate), and
   replace the two app settings with the live values.
2. Run one real small purchase yourself and refund it from the Dashboard.

## How it behaves
- Paid or trialing: plan on. Past due: plan stays on and the company is told to update the card. Cancelled or unpaid: plan ends.
- Each company can have one Stripe subscription. If they already have one, Change plan sends a request instead.
- Stripe retries a webhook that fails. The API checks the signature on every call and rejects anything else.
- Invoices are copied into the Admin Center from Stripe; refunds and credit notes are done in Stripe.
- Without the two settings the Pay button simply doesn't appear and the request flow keeps working.
