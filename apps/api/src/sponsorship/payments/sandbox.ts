/**
 * Sandbox provider: a complete test gateway for development, demos and automated tests.
 *
 * It behaves like a real provider: checkout opens a hosted page (/pay/sandbox/:id), and the
 * outcome reaches the platform ONLY as an HMAC-signed webhook that goes through the same
 * verification and processing path as Razorpay/Stripe/Cashfree. No real money moves, and
 * every screen it touches says so.
 */
import { randomUUID } from 'node:crypto';
import { SignatureError, header, hmacHex, safeEqual, type PaymentProvider, type WebhookEvent } from './provider.ts';

export interface SandboxState {
  orders: Map<string, { amountMinor: number; currency: string; orderId: string; status: 'created' | 'paid' | 'failed'; paymentId?: string; method?: string; description: string; returnUrl: string; cancelUrl: string; customerRef?: string }>;
  refunds: Map<string, { paymentId: string; amountMinor: number; currency: string; status: 'pending' | 'processed' }>;
}

export function sandbox(webhookSecret: string, state: SandboxState): PaymentProvider & {
  sign(body: string): Record<string, string>;
  complete(providerOrderId: string, outcome: 'success' | 'failure', method: string): { body: string; headers: Record<string, string> };
  settleRefund(providerRefundId: string): { body: string; headers: Record<string, string> } | null;
  peek(providerOrderId: string): any;
} {
  const sign = (body: string) => {
    const t = String(Math.floor(Date.now() / 1000));
    return { 'x-sandbox-timestamp': t, 'x-sandbox-signature': hmacHex(webhookSecret, `${t}.${body}`), 'content-type': 'application/json' };
  };
  const event = (type: string, data: any) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, created: Date.now(), data });
    return { body, headers: sign(body) };
  };
  return {
    id: 'sandbox',
    label: 'Test mode (no real money)',
    live: false,
    supports: { currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'], methods: ['upi', 'upi_qr', 'card', 'netbanking', 'wallet', 'international_card'], refunds: true, paymentLinks: true, savedMethods: true },

    async createCheckout(req) {
      const providerOrderId = `sbx_order_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      state.orders.set(providerOrderId, { amountMinor: req.amountMinor, currency: req.currency, orderId: req.orderId, status: 'created', description: req.description, returnUrl: req.returnUrl, cancelUrl: req.cancelUrl });
      return { providerOrderId, client: { provider: 'sandbox', redirectUrl: `/pay/sandbox/${providerOrderId}` } };
    },

    verifyWebhook(rawBody, headers): WebhookEvent {
      const sig = header(headers, 'x-sandbox-signature');
      const t = header(headers, 'x-sandbox-timestamp');
      if (!sig || !t) throw new SignatureError('Missing sandbox signature');
      if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new SignatureError('Sandbox event timestamp outside tolerance');
      if (!safeEqual(hmacHex(webhookSecret, `${t}.${rawBody.toString('utf8')}`), sig)) throw new SignatureError('Invalid sandbox signature');
      const ev = JSON.parse(rawBody.toString('utf8'));
      const d = ev.data ?? {};
      switch (ev.type) {
        case 'payment.captured':
          return { id: ev.id, type: 'payment.captured', providerOrderId: d.order_id, providerPaymentId: d.payment_id, amountMinor: d.amount, currency: d.currency, method: d.method, raw: ev };
        case 'payment.failed':
          return { id: ev.id, type: 'payment.failed', providerOrderId: d.order_id, providerPaymentId: d.payment_id, reason: d.reason, raw: ev };
        case 'refund.processed':
          return { id: ev.id, type: 'refund.processed', providerPaymentId: d.payment_id, providerRefundId: d.refund_id, amountMinor: d.amount, currency: d.currency, raw: ev };
        default:
          return { id: ev.id, type: 'ignored', raw: ev };
      }
    },

    async fetchStatus(providerOrderId) {
      const o = state.orders.get(providerOrderId);
      if (!o) return { status: 'pending' };
      return o.status === 'paid' ? { status: 'paid', providerPaymentId: o.paymentId, amountMinor: o.amountMinor, currency: o.currency, method: o.method } : { status: o.status === 'failed' ? 'failed' : 'pending' };
    },

    async refund(p) {
      const providerRefundId = `sbx_rfnd_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      state.refunds.set(providerRefundId, { paymentId: p.providerPaymentId, amountMinor: p.amountMinor, currency: p.currency, status: 'pending' });
      return { providerRefundId, status: 'pending' }; // settles via a signed refund.processed webhook
    },

    async createPaymentLink(req) {
      const s = await this.createCheckout(req);
      return { url: s.client.redirectUrl, providerOrderId: s.providerOrderId };
    },

    async chargeSaved(req) {
      const s = await this.createCheckout(req);
      return { providerOrderId: s.providerOrderId, status: 'pending' };
    },

    sign,

    /** The hosted test page's "pay" button lands here (server side) and emits a signed event. */
    complete(providerOrderId, outcome, method) {
      const o = state.orders.get(providerOrderId);
      if (!o) throw new Error('Unknown sandbox order');
      const paymentId = `sbx_pay_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      if (outcome === 'success') {
        o.status = 'paid';
        o.paymentId = paymentId;
        o.method = method;
        return event('payment.captured', { order_id: providerOrderId, payment_id: paymentId, amount: o.amountMinor, currency: o.currency, method });
      }
      o.status = 'failed';
      return event('payment.failed', { order_id: providerOrderId, payment_id: paymentId, reason: 'Declined in test mode' });
    },

    settleRefund(providerRefundId) {
      const r = state.refunds.get(providerRefundId);
      if (!r || r.status === 'processed') return null;
      r.status = 'processed';
      return event('refund.processed', { refund_id: providerRefundId, payment_id: r.paymentId, amount: r.amountMinor, currency: r.currency });
    },

    peek(providerOrderId) {
      return state.orders.get(providerOrderId);
    },
  };
}
