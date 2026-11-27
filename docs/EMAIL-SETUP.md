# Email with Azure Communication Services

NexpatchOnline sends its email (sign-up notices, request updates, outage notices, Communications Center messages)
through **Azure Communication Services Email**. It lives in the same Azure portal and resource group as the rest of the
platform, so there is one place to set it up, watch it and pay for it. It needs two app settings:

| Setting | Value |
| --- | --- |
| `ACS_EMAIL_CONNECTION_STRING` | The Communication Services connection string (a secret). |
| `EMAIL_SENDER` | The address mail is sent from, for example `notifications@nexpatchonline.com`. |
| `EMAIL_ADMIN_EMAILS` | Optional. Who gets new request and enquiry notices (separated by commas or semicolons). |
| `EMAIL_SENDER_NAME` | Optional. Display name, default NexpatchOnline. |

If the two Azure settings are missing, the old Brevo settings keep working, so you can switch over without a gap.

Good to know
- This service **sends** mail only. You still need a mailbox or forwarding for replies (your Cloudflare forwarding keeps working).
- New resources have low sending limits (roughly 30 messages a minute and 100 an hour) that Microsoft raises on request from the portal. Check the current limits and prices on Microsoft's Azure Communication Services pricing and quota pages.
- "Schedule for later" in the Communications Center is not available with this service; send now instead.

## 1. Create the resources (Azure portal, resource group `nexpatch-rg`)
1. Search **Email Communication Services**, then Create. Name it `nexpatch-email`. Pick the data location closest to you (Canada is available).
2. Open it, choose **Provision domains**, then **Add domain**:
   - **Azure managed domain** gives you an address like `DoNotReply@xxxx.azurecomm.net` straight away. Use it to test; mail may land in spam.
   - **Custom domain** `nexpatchonline.com` is what you use for real.
3. Search **Communication Services**, then Create. Name it `nexpatch-comms`, same data location.
4. In `nexpatch-comms`, open **Email, Domains, Connect domain**, and pick the domain from step 2.

## 2. Verify your own domain (one time)
On the custom domain page choose **Verify domain**. Azure shows DNS records to add where your DNS is hosted (Cloudflare):
- one TXT record to prove you own the domain,
- one SPF TXT record, and
- two DKIM CNAME records.

Notes for Cloudflare: set the CNAME records to **DNS only** (grey cloud). A domain can have only **one** SPF record, so merge
what is already there instead of adding a second one. For example, if you use Cloudflare Email Routing and Azure, a single record looks like
`v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com ~all`. Use the exact value Azure shows you.
When Azure marks SPF and DKIM as **Verified**, add a **sender username**: **MailFrom addresses, Add**, then `notifications`
(this makes `notifications@nexpatchonline.com`).

## 3. Give the settings to the Function App
Open `nexpatch-comms`, **Settings, Keys**, and copy the **connection string** (primary). Then in Cloud Shell (bash):

```bash
read -rsp "Connection string: " CS; echo
az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 \
  --settings "ACS_EMAIL_CONNECTION_STRING=$CS" "EMAIL_SENDER=notifications@nexpatchonline.com" --output none
unset CS
```
Better still, keep the connection string in Key Vault and use a Key Vault reference as the setting's value.

## 4. Test
Sign in to the Admin Center, open **Email**, and send a test message to yourself. The page shows
"Configured (Azure Communication Services)" and the sender address. A "message ID" means Azure accepted it; delivery can take a minute.

## 5. Turn Brevo off (when the test works)
```bash
az functionapp config appsettings delete -g nexpatch-rg -n nexpatch-api-20022 \
  --setting-names BREVO_API_KEY BREVO_SENDER_EMAIL BREVO_SENDER_NAME BREVO_ADMIN_EMAILS
```
Then remove the Brevo records (its SPF include and DKIM) from your DNS and close the Brevo account.

## If something goes wrong
- **Not configured** in the Admin Center: one of the two settings is missing or the sender is not a valid address.
- **The email service did not accept the test message**: the sender must belong to a domain that is verified and connected to the Communication Services resource, and the connection string must be the one from that resource.
- Message accepted but nothing arrives: check spam, and the **Email, Insights** page of the Communication Services resource in Azure for delivery status.
