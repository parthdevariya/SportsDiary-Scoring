# Sponsorship Marketplace

A first-class module inside Sports Diary (`apps/api/src/sponsorship/`). It reuses the platform's identity, organizer RBAC, tenants, tournaments, matches, venues, TV displays, realtime hub and audit log rather than duplicating them.

## Who uses what

| Surface | URL | Who |
|---|---|---|
| Marketplace + AI advisor | `/sponsorships`, `/sponsorships/<slug>` | Anyone |
| Sponsor directory / public profile | `/sponsors`, `/sponsor/<slug>` | Anyone |
| Sponsor portal | `/sponsor` | Sponsor teams (Owner, Admin, Marketing, Finance, Viewer) |
| Organizer tab | `/console#sponsorships` | Organizers (`sponsor.manage`; payment settings need `org.manage`) |
| Platform admin | `/admin` | Users listed in `PLATFORM_ADMIN_EMAILS` |
| Test checkout | `/pay/sandbox/<id>` | Sandbox only (disabled in production) |

One person has one login. Sponsor access is a membership row, so organizer permissions never leak into sponsor accounts or the reverse.

## Order lifecycle

```
DRAFT → PENDING_PAYMENT ──signed webhook / provider API──▶ PAYMENT_RECEIVED
          (stock held)                                        │ approval mode
                                                              ├─ auto ─────────────▶ ACTIVE ⇄ PAUSED → EXPIRED
                                                              ├─ manual ──▶ PENDING_APPROVAL ─┘
                                                              └─ asset_review ──▶ ASSET_REVIEW ─┘
any paid state ──cancel/decline──▶ CANCELLED ──refund.processed──▶ REFUNDED
```

* **The browser never marks anything paid.** An order becomes paid only in `OrderService.capture()`, reached from a provider webhook whose signature was verified over the raw bytes, or from `/confirm`, which asks the provider's API from the server.
* Webhooks are idempotent per `(provider, event id)`; a failed processing run is un-claimed so the provider's retry succeeds.
* Amount or currency mismatch → money is recorded, the order is held with a risk flag, and the platform is notified. Nothing activates.
* A second payment for the same order is refunded automatically. A payment that arrives after the stock hold lapsed revives the order if the slot is still free, otherwise it is refunded.
* Prices are always computed on the server (`money.price()`); client-sent amounts are ignored.

## Payments

`payments/provider.ts` defines the interface (`createCheckout`, `verifyWebhook`, `fetchStatus`, `refund`, optional `createPaymentLink` and `chargeSaved`). Implementations: **Razorpay** (UPI, UPI QR, cards, net banking, wallets, payment links), **Cashfree**, **Stripe** (international cards, multi-currency), and **Sandbox** (test mode, signed webhooks through the same path).

Resolution per order (`PaymentRegistry.forOrg`):
1. the organizer's own gateway keys (encrypted at rest with AES-256-GCM): money settles directly, platform commission is invoiced to the organizer;
2. otherwise the platform's account: the ledger tracks the organizer's share, and admins create payouts (`/admin#payouts`). The settlement provider is manual (bank transfer with a UTR reference); split-payment APIs are not assumed.

Webhook URLs: `/api/payments/webhook/<provider>` (platform keys) or `/api/payments/webhook/<provider>/<orgId>` (organizer keys).

## Money, tax and documents

* Integer minor units + ISO currency everywhere. Sponsors are charged in the listing's currency; other currencies are shown as approximate.
* GST 18% (configurable) on sponsorship + platform fee; zero-rated for foreign-currency or non-Indian sponsors. Invoices split CGST/SGST for intra-state supply and IGST otherwise, SAC 998397.
* Ledger per order: `charge`, `commission`, `platform_fee`, `tax_platform`, `organizer_payable` (or `organizer_collected` + `commission_receivable` for organizer-owned gateways). Refunds reverse proportionally; duplicate/late money is booked as `refund_unbooked`.
* Documents are stored immutably with a SHA-256 hash and rendered as HTML or PDF: agreement (accepted digitally with person, time, IP and hash), tax invoice (gap-free series per organizer and financial year), receipt, confirmation, asset approval, renewal notice and credit notes.

## Activation and branding

Each inventory type in `catalog.ts` declares the surfaces it activates. Activation creates **placements** (surface × scope: organizer, tournament, venue or match). Physical and social items become **deliverables** that the organizer marks delivered with a proof link.

Surfaces resolve their placements automatically, with no manual steps:

* **TV screens**: persistent corner logo, "This match is brought to you by" full-screen interstitial (image, banner or ≤30 s video), rotation slots, today's match sponsor, timeout sponsor, break sponsor ("Powered by"), Player of the Match presenter, sponsor QR, and a "presented by" strip for naming rights;
* **Live score and tournament pages**: sponsor strip, banners and sponsor wall;
* **OBS overlay** (`/overlay/m/<code>`): broadcast placements.

Pausing, expiry, refunds or suspending a sponsor removes branding immediately (caches are invalidated and connected screens and pages are pushed new state).

## Measurement

* **Screens** report every 15 s which placements they rendered. Only placements the server assigned to that screen are credited, and floods are ignored.
* **Pages** send a beacon, deduplicated per anonymous viewer and placement every 5 minutes.
* **Clicks** (`/c/<placement>`) and **QR scans** (`/q/<code>`) are server-side redirects that also log the match or tournament.
* **Exposure Score** = `min(100, round(20·log10(1 + points/10)))`, where points = 0.5·impressions + 2·unique viewers + 0.02·screen audience-minutes + 0.1·in-venue audience + 10·clicks + 15·QR scans.
* **Estimated reach** = unique online viewers + in-venue audience (per screen per day) + unique QR scanners.

Audience sizes entered by organizers are always labelled as estimates.

## Selling models

Fixed price, first come first served, RFP, negotiated offers (threads with offers and counter-proposals; accepting creates an order at the agreed price, held 72 h), and auctions (proxy bidding, the winner pays the second-highest bid plus one increment, a bid in the last 2 minutes extends the auction, reserve price, the winner has 48 h to pay).

## AI matching

`recommend.ts` scores every open package from 0 to 100 on budget, sport and industry, location, audience age, goals and value, and returns its reasons. The advisor parses requests such as "I have ₹5 lakh and want maximum visibility among young cricket audiences in Gujarat." It turns them into a query, builds a budget plan that treats the stated sport and location as hard requirements and upgrades packages within budget, then explains the plan. With `ANTHROPIC_API_KEY` set, Claude writes the explanation from the computed facts only; the response always names the engine used.

## Security

* Authentication by password, email code, SMS OTP, or Google/Apple ID tokens (RS256, verified against JWKS on the server).
* RBAC for sponsor roles, organizer permissions and platform admins, with tenant checks on every organizer and sponsor query.
* Payment and webhook security as described in the order lifecycle above.
* Uploads are validated by content, not file name. SVGs with active content are rejected, files are checked for the EICAR signature plus an optional ClamAV scan (`CLAMAV_HOST`), and images are re-encoded to WebP. The public only ever receives re-encoded variants; private previews use signed, expiring URLs.
* Rate limits apply to auth, uploads, the AI advisor, beacons and order velocity. All commercial actions are written to the audit log, and moderation decisions to the compliance log.

## Configuration

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Base URL for emails and gateway callbacks (**required in production**; host headers are not trusted) |
| `SECRETS_KEY` | 32-byte base64 key for encrypting stored gateway keys (**required in production**) |
| `PAYMENT_PROVIDER` | Platform default: `razorpay`, `cashfree`, `stripe` or `sandbox` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | Razorpay |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe |
| `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` / `CASHFREE_ENV` | Cashfree |
| `PAYMENTS_ALLOW_SANDBOX=1` | Allow test payments in production (not recommended) |
| `GOOGLE_CLIENT_ID`, `APPLE_CLIENT_ID` | Google and Apple sign-in |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` / `TWILIO_WHATSAPP_FROM` | SMS and WhatsApp |
| `CLAMAV_HOST` / `CLAMAV_PORT` | Malware scanning of uploads |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | AI advisor explanations |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated platform admins |

Without a provider configured, messages are written to the outbox with status `logged` (visible in `/admin#outbox`). Nothing pretends to have been delivered.

## Honest status

* Real gateway integrations are written against each provider's documented API and signature scheme, and their signature verification is unit-tested. They have **not** been exercised against live Razorpay, Stripe or Cashfree accounts from this environment: do a test-mode run with real keys before going live.
* Saved-card auto-renewal uses Stripe off-session charges when a customer reference is stored. Otherwise renewals send a payment link, which is the default.
* Payouts are recorded manually. Automated split settlement (e.g. Razorpay Route) can be added behind the same settlement record.
* Push notifications for the sponsor app are not implemented; in-app, email, SMS and WhatsApp are.
* Demo data includes simulated historical exposure; production numbers come only from screens and pages.
