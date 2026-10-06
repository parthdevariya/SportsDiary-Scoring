/**
 * Stripe (global sponsors: international cards, multi-currency).
 * Checkout Sessions API; webhooks verified with the Stripe-Signature scheme:
 *   signed_payload = `${t}.${rawBody}`, v1 = HMAC-SHA256(signed_payload, endpointSecret), 5-minute tolerance.
 */
import { SignatureError, header, hmacHex, httpJson, safeEqual, type PaymentProvider, type WebhookEvent } from './provider.ts';

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

const API = 'https://api.stripe.com/v1';
const TOLERANCE_S = 300;

function form(obj: Record<string, any>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function stripe(cfg: StripeConfig, nowSec = () => Math.floor(Date.now() / 1000)): PaymentProvider {
  const call = (path: string, method = 'GET', body?: Record<string, any>, idem?: string) =>
    httpJson(`${API}${path}`, {
      method,
      label: 'Stripe',
      headers: { authorization: `Bearer ${cfg.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idem ? { 'idempotency-key': idem } : {}) },
      body: body ? form(body) : undefined,
    });

  return {
    id: 'stripe',
    label: 'Stripe',
    live: cfg.secretKey.startsWith('sk_live_'),
    supports: { currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'], methods: ['card', 'international_card'], refunds: true, paymentLinks: true, savedMethods: true },

    async createCheckout(req) {
      const s = await call(
        '/checkout/sessions',
        'POST',
        {
          mode: 'payment',
          client_reference_id: req.orderId,
          success_url: `${req.returnUrl}${req.returnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: req.cancelUrl,
          customer_email: req.customer.email ?? undefined,
          metadata: { order_id: req.orderId },
          payment_intent_data: { metadata: { order_id: req.orderId }, setup_future_usage: 'off_session' },
          line_items: { 0: { quantity: 1, price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amountMinor, product_data: { name: req.description.slice(0, 250) } } } },
        },
        `checkout-${req.orderId}`,
      );
      return { providerOrderId: s.id, client: { provider: 'stripe', redirectUrl: s.url } };
    },

    verifyWebhook(rawBody, headers): WebhookEvent {
      const sigHeader = header(headers, 'stripe-signature');
      if (!sigHeader) throw new SignatureError('Missing Stripe-Signature');
      const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=') as [string, string]).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
      const sigs = sigHeader.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
      const t = Number(parts.t);
      if (!t || !sigs.length) throw new SignatureError('Malformed Stripe-Signature');
      if (Math.abs(nowSec() - t) > TOLERANCE_S) throw new SignatureError('Stripe event timestamp outside tolerance');
      const expected = hmacHex(cfg.webhookSecret, Buffer.concat([Buffer.from(`${t}.`), rawBody]));
      if (!sigs.some((s) => safeEqual(expected, s))) throw new SignatureError('Invalid Stripe signature');
      const ev = JSON.parse(rawBody.toString('utf8'));
      const o = ev.data?.object ?? {};
      switch (ev.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          if (o.payment_status !== 'paid') return { id: ev.id, type: 'ignored', raw: ev }; // async methods settle later
          return { id: ev.id, type: 'payment.captured', providerOrderId: o.id, providerPaymentId: o.payment_intent, amountMinor: o.amount_total, currency: String(o.currency).toUpperCase(), method: o.payment_method_types?.[0], raw: ev };
        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired':
          return { id: ev.id, type: 'payment.failed', providerOrderId: o.id, reason: ev.type, raw: ev };
        case 'refund.updated':
        case 'refund.created':
          if (o.status === 'succeeded') return { id: ev.id, type: 'refund.processed', providerPaymentId: o.payment_intent, providerRefundId: o.id, amountMinor: o.amount, currency: String(o.currency).toUpperCase(), raw: ev };
          if (o.status === 'failed' || o.status === 'canceled') return { id: ev.id, type: 'refund.failed', providerPaymentId: o.payment_intent, providerRefundId: o.id, raw: ev };
          return { id: ev.id, type: 'ignored', raw: ev };
        default:
          return { id: ev.id, type: 'ignored', raw: ev };
      }
    },

    async fetchStatus(sessionId) {
      const s = await call(`/checkout/sessions/${sessionId}`);
      if (s.payment_status === 'paid') return { status: 'paid', providerPaymentId: s.payment_intent, amountMinor: s.amount_total, currency: String(s.currency).toUpperCase() };
      return { status: s.status === 'expired' ? 'failed' : 'pending' };
    },

    async refund(p) {
      const r = await call('/refunds', 'POST', { payment_intent: p.providerPaymentId, amount: p.amountMinor, metadata: { reason: p.reason.slice(0, 400), ref: p.refundRef } }, `refund-${p.refundRef}`);
      return { providerRefundId: r.id, status: r.status === 'succeeded' ? 'processed' : 'pending' };
    },

    async createPaymentLink(req) {
      const s = await this.createCheckout(req);
      return { url: s.client.redirectUrl, providerOrderId: s.providerOrderId };
    },

    async chargeSaved(req) {
      // customerRef = "cus_x:pm_y" saved by a previous Checkout with setup_future_usage
      const [customer, pm] = req.customerRef.split(':');
      const pi = await call('/payment_intents', 'POST', {
        amount: req.amountMinor, currency: req.currency.toLowerCase(), customer, payment_method: pm, off_session: 'true', confirm: 'true', metadata: { order_id: req.orderId },
      }, `renew-${req.orderId}`);
      return { providerOrderId: pi.id, status: 'pending' };
    },
  };
}
