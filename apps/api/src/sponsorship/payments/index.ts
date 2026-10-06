/**
 * Provider registry: which gateway (and whose keys) handles a given organizer's payment.
 *
 * Resolution order for an organizer:
 *   1. the organizer's own configured provider + encrypted keys (white-label, direct settlement)
 *   2. the platform's account for that provider (marketplace model: platform collects, then settles)
 *   3. the sandbox, only outside production or when PAYMENTS_ALLOW_SANDBOX=1
 * A currency the chosen provider can't take falls back to Stripe when configured.
 */
import { createHmac } from 'node:crypto';
import { HttpError } from '../../context.ts';
import type { DB } from '../../db.ts';
import { getOrgSettings } from '../settings.ts';
import { cashfree } from './cashfree.ts';
import type { PaymentProvider } from './provider.ts';
import { razorpay } from './razorpay.ts';
import { sandbox, type SandboxState } from './sandbox.ts';
import { stripe } from './stripe.ts';

export * from './provider.ts';

const env = process.env;

function platformConfig(provider: string): Record<string, string> | null {
  if (provider === 'razorpay' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)
    return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET };
  if (provider === 'stripe' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) return { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
  if (provider === 'cashfree' && env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY) return { appId: env.CASHFREE_APP_ID, secretKey: env.CASHFREE_SECRET_KEY, environment: env.CASHFREE_ENV ?? 'sandbox' };
  return null;
}

export const sandboxAllowed = () => env.NODE_ENV !== 'production' || env.PAYMENTS_ALLOW_SANDBOX === '1';

export class PaymentRegistry {
  readonly sandboxState: SandboxState = { orders: new Map(), refunds: new Map() };
  private sandboxSecret: string;
  readonly sandbox: ReturnType<typeof sandbox>;

  constructor(private db: DB, secretSeed: string) {
    this.sandboxSecret = createHmac('sha256', secretSeed).update('sandbox-webhook').digest('hex');
    this.sandbox = sandbox(this.sandboxSecret, this.sandboxState);
  }

  build(name: string, cfg: Record<string, any>): PaymentProvider {
    switch (name) {
      case 'razorpay':
        return razorpay(cfg as any);
      case 'stripe':
        return stripe(cfg as any);
      case 'cashfree':
        return cashfree(cfg as any);
      case 'sandbox':
        if (!sandboxAllowed()) throw new HttpError(503, 'Test payments are disabled in production', 'PAYMENTS_UNAVAILABLE');
        return this.sandbox;
    }
    throw new HttpError(400, `Unknown payment provider ${name}`, 'VALIDATION');
  }

  /** Provider + scope ('org' when the organizer's own keys are used) for an organizer and currency. */
  forOrg(orgId: string, currency: string): { provider: PaymentProvider; scope: 'org' | 'platform' } {
    const s = getOrgSettings(this.db, orgId);
    const tryBuild = (name: string): { provider: PaymentProvider; scope: 'org' | 'platform' } | null => {
      if (name === 'sandbox') return sandboxAllowed() ? { provider: this.sandbox, scope: 'platform' } : null;
      const own = Object.keys(s.providerConfig).length && s.provider === name ? s.providerConfig : null;
      const cfg = own ?? platformConfig(name);
      if (!cfg) return null;
      return { provider: this.build(name, cfg), scope: own ? 'org' : 'platform' };
    };
    const first = tryBuild(s.provider);
    if (first && first.provider.supports.currencies.includes(currency)) return first;
    const fallback = tryBuild('stripe');
    if (fallback && fallback.provider.supports.currencies.includes(currency)) return fallback;
    if (sandboxAllowed()) return { provider: this.sandbox, scope: 'platform' };
    throw new HttpError(503, 'Online payment is not set up for this organizer yet. Contact the organizer.', 'PAYMENTS_UNAVAILABLE');
  }

  /** Provider used to verify an incoming webhook (by name, optionally the organizer's own keys). */
  forWebhook(name: string, orgId?: string): PaymentProvider {
    if (name === 'sandbox') return this.build('sandbox', {});
    if (orgId) {
      const s = getOrgSettings(this.db, orgId);
      if (s.provider === name && Object.keys(s.providerConfig).length) return this.build(name, s.providerConfig);
    }
    const cfg = platformConfig(name);
    if (!cfg) throw new HttpError(404, 'Webhook endpoint not configured', 'NOT_FOUND');
    return this.build(name, cfg);
  }

  /** Detect which provider sent an unrouted webhook from its signature header. */
  static detect(headers: Record<string, any>): string | null {
    if (headers['x-razorpay-signature']) return 'razorpay';
    if (headers['stripe-signature']) return 'stripe';
    if (headers['x-webhook-signature'] && headers['x-webhook-timestamp']) return 'cashfree';
    if (headers['x-sandbox-signature']) return 'sandbox';
    return null;
  }

  /** What admins see: which providers are usable and whether they are live. */
  status() {
    return ['razorpay', 'stripe', 'cashfree', 'sandbox'].map((n) => {
      if (n === 'sandbox') return { id: n, configured: sandboxAllowed(), live: false };
      const cfg = platformConfig(n);
      return { id: n, configured: !!cfg, live: cfg ? this.build(n, cfg).live : false };
    });
  }
}
