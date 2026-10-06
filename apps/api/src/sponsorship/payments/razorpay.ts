/**
 * Razorpay (India: UPI, UPI QR, cards, net banking, wallets, international cards, payment links).
 * Docs: Orders API, Checkout, Webhooks (X-Razorpay-Signature = HMAC-SHA256(rawBody, webhookSecret)),
 * Refunds API, Payment Links API.
 */
import { createHmac } from 'node:crypto';
import { SignatureError, header, hmacHex, httpJson, safeEqual, type CheckoutRequest, type PaymentProvider, type WebhookEvent } from './provider.ts';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const API = 'https://api.razorpay.com/v1';

export function razorpay(cfg: RazorpayConfig): PaymentProvider {
  const auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;
  const call = (path: string, method = 'GET', body?: any) =>
    httpJson(`${API}${path}`, { method, label: 'Razorpay', headers: { authorization: auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  const provider: PaymentProvider = {
    id: 'razorpay',
    label: 'Razorpay',
    live: cfg.keyId.startsWith('rzp_live_'),
    supports: { currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'], methods: ['upi', 'upi_qr', 'card', 'netbanking', 'wallet', 'international_card'], refunds: true, paymentLinks: true, savedMethods: false },

    async createCheckout(req: CheckoutRequest) {
      const order = await call('/orders', 'POST', {
        amount: req.amountMinor,
        currency: req.currency,
        receipt: req.number.slice(0, 40),
        notes: { order_id: req.orderId, sponsor_id: req.customer.id },
      });
      return {
        providerOrderId: order.id,
        client: {
          provider: 'razorpay',
          keyId: cfg.keyId, // publishable key id, safe for the browser
          orderId: order.id,
          amount: req.amountMinor,
          currency: req.currency,
          name: 'Sports Diary',
          description: req.description,
          prefill: { name: req.customer.name, email: req.customer.email ?? undefined, contact: req.customer.phone ?? undefined },
        },
      };
    },

    verifyWebhook(rawBody, headers): WebhookEvent {
      const sig = header(headers, 'x-razorpay-signature');
      if (!sig || !safeEqual(hmacHex(cfg.webhookSecret, rawBody), sig)) throw new SignatureError('Invalid Razorpay signature');
      const ev = JSON.parse(rawBody.toString('utf8'));
      const eventId = header(headers, 'x-razorpay-event-id') ?? `${ev.event}:${ev.payload?.payment?.entity?.id ?? ev.payload?.refund?.entity?.id}:${ev.created_at}`;
      const pay = ev.payload?.payment?.entity;
      const ref = ev.payload?.refund?.entity;
      switch (ev.event) {
        case 'payment.captured':
        case 'order.paid':
          return { id: eventId, type: 'payment.captured', providerOrderId: pay?.order_id, providerPaymentId: pay?.id, amountMinor: pay?.amount, currency: pay?.currency, method: pay?.method, raw: ev };
        case 'payment.failed':
          return { id: eventId, type: 'payment.failed', providerOrderId: pay?.order_id, providerPaymentId: pay?.id, reason: pay?.error_description, raw: ev };
        case 'refund.processed':
          return { id: eventId, type: 'refund.processed', providerPaymentId: ref?.payment_id, providerRefundId: ref?.id, amountMinor: ref?.amount, currency: ref?.currency, raw: ev };
        case 'refund.failed':
          return { id: eventId, type: 'refund.failed', providerPaymentId: ref?.payment_id, providerRefundId: ref?.id, raw: ev };
        default:
          return { id: eventId, type: 'ignored', raw: ev };
      }
    },

    async fetchStatus(providerOrderId) {
      const list = await call(`/orders/${providerOrderId}/payments`);
      const captured = (list.items ?? []).find((p: any) => p.status === 'captured');
      if (captured) return { status: 'paid', providerPaymentId: captured.id, amountMinor: captured.amount, currency: captured.currency, method: captured.method };
      return { status: (list.items ?? []).some((p: any) => p.status === 'failed') ? 'failed' : 'pending' };
    },

    async refund(p) {
      const r = await call(`/payments/${p.providerPaymentId}/refund`, 'POST', { amount: p.amountMinor, notes: { reason: p.reason.slice(0, 200), ref: p.refundRef }, receipt: p.refundRef.slice(0, 40) });
      return { providerRefundId: r.id, status: r.status === 'processed' ? 'processed' : 'pending' };
    },

    async createPaymentLink(req) {
      const link = await call('/payment_links', 'POST', {
        amount: req.amountMinor,
        currency: req.currency,
        description: req.description.slice(0, 2048),
        reference_id: req.number.slice(0, 40),
        customer: { name: req.customer.name, email: req.customer.email ?? undefined, contact: req.customer.phone ?? undefined },
        notify: { email: !!req.customer.email, sms: !!req.customer.phone },
        callback_url: req.returnUrl,
        callback_method: 'get',
        notes: { order_id: req.orderId },
      });
      return { url: link.short_url, providerOrderId: link.order_id ?? link.id };
    },
  };
  return provider;
}

/** Checkout callback check (order_id|payment_id signed with the key secret). Used only as a hint; activation still waits for the API/webhook. */
export function razorpayCheckoutSignatureValid(keySecret: string, orderId: string, paymentId: string, signature: string) {
  return safeEqual(createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}
