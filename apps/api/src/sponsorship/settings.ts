/**
 * Platform-wide sponsorship settings (admin-managed) with per-organization overrides
 * (white-label: own commission, fee, payment provider, invoice series).
 */
import type { DB } from '../db.ts';
import { J, P, now } from '../db.ts';
import { open, seal } from './secrets.ts';

export interface PlatformSettings {
  commissionBps: number; // platform commission on the sponsorship amount
  platformFeeMinor: number; // flat fee added to the sponsor's bill (INR minor units)
  taxRateBps: number; // GST/VAT applied on subtotal + fee
  taxName: string;
  fxRatesPerINR: Record<string, number>; // indicative display conversion only
  prohibitedCategories: string[]; // product categories that may not advertise
  sponsorApproval: 'auto' | 'manual'; // whether new sponsor accounts need platform approval
  featuredFeeMinor: number; // price to feature an opportunity
  defaultProvider: string; // payment provider when an org has none configured
  holdMinutes: number; // inventory hold while a sponsor completes payment
  renewalReminderDays: number[];
  maxOrdersPerHour: number; // fraud velocity limit per sponsor
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  commissionBps: 1000,
  platformFeeMinor: 0,
  taxRateBps: 1800,
  taxName: 'GST',
  fxRatesPerINR: { USD: 0.012, EUR: 0.011, GBP: 0.0094, AED: 0.044, SGD: 0.016, AUD: 0.018, CAD: 0.016 },
  prohibitedCategories: ['tobacco', 'gambling', 'betting', 'alcohol', 'weapons', 'adult', 'crypto-schemes'],
  sponsorApproval: 'auto',
  featuredFeeMinor: 500000,
  defaultProvider: process.env.PAYMENT_PROVIDER ?? 'sandbox',
  holdMinutes: 30,
  renewalReminderDays: [30, 14, 7, 1],
  maxOrdersPerHour: 10,
};

export function getPlatformSettings(db: DB): PlatformSettings {
  const rows = db.prepare('SELECT key, value FROM platform_settings').all() as any[];
  const out: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in out) out[r.key] = P(r.value);
  return out;
}

export function setPlatformSettings(db: DB, patch: Partial<PlatformSettings>) {
  const stmt = db.prepare('INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS && v !== undefined) stmt.run(k, J(v), now());
}

export interface OrgSettings {
  commissionBps: number;
  platformFeeMinor: number;
  taxRateBps: number;
  provider: string;
  providerConfig: Record<string, string>;
  invoicePrefix: string;
  gstin: string | null;
  legalName: string | null;
  address: string | null;
  state: string | null;
  marketplaceEnabled: boolean;
}

/** Effective commercial terms for an organizer: their override, else the platform default. */
export function getOrgSettings(db: DB, orgId: string): OrgSettings {
  const p = getPlatformSettings(db);
  const r = db.prepare('SELECT * FROM org_sponsorship_settings WHERE org_id = ?').get(orgId) as any;
  const org = db.prepare('SELECT name, slug FROM organizations WHERE id = ?').get(orgId) as any;
  let providerConfig: Record<string, string> = {};
  if (r?.payment_config_enc) {
    try {
      providerConfig = JSON.parse(open(r.payment_config_enc));
    } catch {
      providerConfig = {};
    }
  }
  return {
    commissionBps: r?.commission_bps ?? p.commissionBps,
    platformFeeMinor: r?.platform_fee_minor ?? p.platformFeeMinor,
    taxRateBps: p.taxRateBps,
    provider: r?.payment_provider ?? p.defaultProvider,
    providerConfig,
    invoicePrefix: r?.invoice_prefix ?? String(org?.slug ?? 'SD').slice(0, 10).toUpperCase(),
    gstin: r?.gstin ?? null,
    legalName: r?.legal_name ?? org?.name ?? null,
    address: r?.address ?? null,
    state: r?.state ?? null,
    marketplaceEnabled: r ? !!r.marketplace_enabled : true,
  };
}

export function saveOrgSettings(
  db: DB,
  orgId: string,
  patch: { commissionBps?: number | null; platformFeeMinor?: number | null; provider?: string; providerConfig?: Record<string, string>; invoicePrefix?: string; gstin?: string; legalName?: string; address?: string; state?: string; marketplaceEnabled?: boolean },
) {
  const cur = db.prepare('SELECT * FROM org_sponsorship_settings WHERE org_id = ?').get(orgId) as any;
  const row = {
    commission_bps: patch.commissionBps !== undefined ? patch.commissionBps : cur?.commission_bps ?? null,
    platform_fee_minor: patch.platformFeeMinor !== undefined ? patch.platformFeeMinor : cur?.platform_fee_minor ?? null,
    payment_provider: patch.provider ?? cur?.payment_provider ?? null,
    payment_config_enc: patch.providerConfig ? seal(JSON.stringify(patch.providerConfig)) : cur?.payment_config_enc ?? null,
    invoice_prefix: patch.invoicePrefix ?? cur?.invoice_prefix ?? null,
    gstin: patch.gstin ?? cur?.gstin ?? null,
    legal_name: patch.legalName ?? cur?.legal_name ?? null,
    address: patch.address ?? cur?.address ?? null,
    state: patch.state ?? cur?.state ?? null,
    marketplace_enabled: patch.marketplaceEnabled === undefined ? cur?.marketplace_enabled ?? 1 : patch.marketplaceEnabled ? 1 : 0,
  };
  db.prepare(`INSERT INTO org_sponsorship_settings (org_id, commission_bps, platform_fee_minor, payment_provider, payment_config_enc, invoice_prefix, gstin, legal_name, address, state, marketplace_enabled, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET commission_bps=excluded.commission_bps, platform_fee_minor=excluded.platform_fee_minor,
    payment_provider=excluded.payment_provider, payment_config_enc=excluded.payment_config_enc, invoice_prefix=excluded.invoice_prefix, gstin=excluded.gstin,
    legal_name=excluded.legal_name, address=excluded.address, state=excluded.state, marketplace_enabled=excluded.marketplace_enabled, updated_at=excluded.updated_at`).run(
    orgId, row.commission_bps, row.platform_fee_minor, row.payment_provider, row.payment_config_enc, row.invoice_prefix, row.gstin, row.legal_name, row.address, row.state, row.marketplace_enabled, now(),
  );
}
