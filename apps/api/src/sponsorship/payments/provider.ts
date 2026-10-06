/**
 * Payment provider abstraction. The sponsorship engine only ever talks to this interface,
 * so providers can be added or swapped without touching orders, activation or invoices.
 *
 * Contract: nothing is "paid" until verifyWebhook() accepts a signed event from the
 * provider, or fetchStatus() confirms it with the provider's API from our server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutRequest {
  orderId: string;
  number: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: { name: string; email?: string | null; phone?: string | null; id: string };
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
}

export interface CheckoutSession {
  providerOrderId: string;
  /** What the browser needs to open the provider's checkout (never contains secrets). */
  client: Record<string, any>;
}

export type EventType = 'payment.captured' | 'payment.failed' | 'refund.processed' | 'refund.failed' | 'ignored';

export interface WebhookEvent {
  id: string;
  type: EventType;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  amountMinor?: number;
  currency?: string;
  method?: string;
  reason?: string;
  raw: any;
}

export interface PaymentStatus {
  status: 'paid' | 'pending' | 'failed';
  providerPaymentId?: string;
  amountMinor?: number;
  currency?: string;
  method?: string;
}

export interface PaymentProvider {
  id: string;
  label: string;
  live: boolean;
  supports: { currencies: string[]; methods: string[]; refunds: boolean; paymentLinks: boolean; savedMethods: boolean };
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Throws if the signature is missing or wrong. Never trust an unsigned body. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
  fetchStatus(providerOrderId: string): Promise<PaymentStatus>;
  refund(p: { providerOrderId: string; providerPaymentId: string; amountMinor: number; currency: string; reason: string; refundRef: string }): Promise<{ providerRefundId: string; status: 'pending' | 'processed' }>;
  createPaymentLink?(req: CheckoutRequest): Promise<{ url: string; providerOrderId: string }>;
  /** Charge a saved method without the sponsor present (auto-renewal). */
  chargeSaved?(req: CheckoutRequest & { customerRef: string }): Promise<{ providerOrderId: string; status: 'pending' }>;
}

export class SignatureError extends Error {}

export const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function hmacHex(secret: string, data: Buffer | string) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function httpJson(url: string, init: RequestInit & { label: string }): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e: any) {
    throw new Error(`${init.label} unreachable: ${e?.message ?? e}`);
  }
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const msg = body?.error?.description ?? body?.error?.message ?? body?.message ?? text.slice(0, 200);
    throw new Error(`${init.label} ${r.status}: ${msg}`);
  }
  return body;
}

/** Minor units → provider decimal string for APIs that take major units (e.g. Cashfree). */
export const toMajor = (minor: number) => (minor / 100).toFixed(2);
