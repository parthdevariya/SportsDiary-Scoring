/**
 * Cashfree Payments (India). PG API version 2023-08-01.
 * Webhook signature: base64(HMAC-SHA256(x-webhook-timestamp + rawBody, clientSecret)).
 */
import { createHmac } from 'node:crypto';
import { SignatureError, header, httpJson, safeEqual, toMajor, type PaymentProvider, type WebhookEvent } from './provider.ts';

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  environment: 'sandbox' | 'production';
}

export function cashfree(cfg: CashfreeConfig): PaymentProvider {
  const base = cfg.environment === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  const call = (path: string, method = 'GET', body?: any, idem?: string) =>
    httpJson(`${base}${path}`, {
      method,
      label: 'Cashfree',
      headers: { 'x-client-id': cfg.appId, 'x-client-secret': cfg.secretKey, 'x-api-version': '2023-08-01', 'content-type': 'application/json', ...(idem ? { 'x-idempotency-key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return {
    id: 'cashfree',
    label: 'Cashfree',
    live: cfg.environment === 'production',
    supports: { currencies: ['INR'], methods: ['upi', 'upi_qr', 'card', 'netbanking', 'wallet'], refunds: true, paymentLinks: false, savedMethods: false },

    async createCheckout(req) {
      const providerOrderId = `sd_${req.orderId.replace(/-/g, '').slice(0, 40)}`;
      const o = await call('/orders', 'POST', {
        order_id: providerOrderId,
        order_amount: Number(toMajor(req.amountMinor)),
        order_currency: req.currency,
        customer_details: { customer_id: req.customer.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50), customer_email: req.customer.email ?? undefined, customer_phone: (req.customer.phone ?? '9999999999').replace(/^\+91/, ''), customer_name: req.customer.name },
        order_meta: { return_url: req.returnUrl, notify_url: req.notifyUrl },
        order_note: req.description.slice(0, 200),
      }, `order-${req.orderId}`);
      return { providerOrderId: o.order_id, client: { provider: 'cashfree', paymentSessionId: o.payment_session_id, mode: cfg.environment } };
    },

    verifyWebhook(rawBody, headers): WebhookEvent {
      const sig = header(headers, 'x-webhook-signature');
      const ts = header(headers, 'x-webhook-timestamp');
      if (!sig || !ts) throw new SignatureError('Missing Cashfree signature headers');
      const expected = createHmac('sha256', cfg.secretKey).update(ts + rawBody.toString('utf8')).digest('base64');
      if (!safeEqual(expected, sig)) throw new SignatureError('Invalid Cashfree signature');
      const ev = JSON.parse(rawBody.toString('utf8'));
      const d = ev.data ?? {};
      switch (ev.type) {
        case 'PAYMENT_SUCCESS_WEBHOOK':
          return { id: `pay:${d.payment?.cf_payment_id}`, type: 'payment.captured', providerOrderId: d.order?.order_id, providerPaymentId: String(d.payment?.cf_payment_id), amountMinor: Math.round(Number(d.payment?.payment_amount) * 100), currency: d.payment?.payment_currency, method: d.payment?.payment_group, raw: ev };
        case 'PAYMENT_FAILED_WEBHOOK':
        case 'PAYMENT_USER_DROPPED_WEBHOOK':
          return { id: `fail:${d.payment?.cf_payment_id}`, type: 'payment.failed', providerOrderId: d.order?.order_id, reason: d.payment?.payment_message, raw: ev };
        case 'REFUND_STATUS_WEBHOOK': {
          const r = d.refund ?? {};
          const type = r.refund_status === 'SUCCESS' ? 'refund.processed' : r.refund_status === 'CANCELLED' || r.refund_status === 'FAILED' ? 'refund.failed' : 'ignored';
          return { id: `refund:${r.cf_refund_id}:${r.refund_status}`, type, providerOrderId: r.order_id, providerRefundId: r.refund_id, amountMinor: Math.round(Number(r.refund_amount) * 100), currency: r.refund_currency, raw: ev };
        }
        default:
          return { id: `${ev.type}:${ev.event_time}`, type: 'ignored', raw: ev };
      }
    },

    async fetchStatus(providerOrderId) {
      const o = await call(`/orders/${providerOrderId}`);
      if (o.order_status === 'PAID') {
        const pays = await call(`/orders/${providerOrderId}/payments`);
        const p = (pays ?? []).find((x: any) => x.payment_status === 'SUCCESS');
        return { status: 'paid', providerPaymentId: p ? String(p.cf_payment_id) : undefined, amountMinor: Math.round(Number(o.order_amount) * 100), currency: o.order_currency, method: p?.payment_group };
      }
      return { status: o.order_status === 'EXPIRED' || o.order_status === 'TERMINATED' ? 'failed' : 'pending' };
    },

    async refund(p) {
      const r = await call(`/orders/${p.providerOrderId}/refunds`, 'POST', { refund_amount: Number(toMajor(p.amountMinor)), refund_id: p.refundRef.slice(0, 40), refund_note: p.reason.slice(0, 100) }, `refund-${p.refundRef}`);
      return { providerRefundId: r.refund_id, status: r.refund_status === 'SUCCESS' ? 'processed' : 'pending' };
    },
  };
}
