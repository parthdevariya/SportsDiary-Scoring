/** Money is integer minor units + ISO 4217 code. Never floats in storage or arithmetic. */

export const CURRENCIES: Record<string, { minor: number; symbol: string; locale: string }> = {
  INR: { minor: 2, symbol: '₹', locale: 'en-IN' },
  USD: { minor: 2, symbol: '$', locale: 'en-US' },
  EUR: { minor: 2, symbol: '€', locale: 'de-DE' },
  GBP: { minor: 2, symbol: '£', locale: 'en-GB' },
  AED: { minor: 2, symbol: 'AED ', locale: 'en-AE' },
  SGD: { minor: 2, symbol: 'S$', locale: 'en-SG' },
  AUD: { minor: 2, symbol: 'A$', locale: 'en-AU' },
  CAD: { minor: 2, symbol: 'C$', locale: 'en-CA' },
};

export const isCurrency = (c: string) => Object.hasOwn(CURRENCIES, c);

export function format(minor: number, currency: string): string {
  const c = CURRENCIES[currency] ?? CURRENCIES.INR;
  const major = minor / 10 ** c.minor;
  return new Intl.NumberFormat(c.locale, { style: 'currency', currency, maximumFractionDigits: minor % 10 ** c.minor === 0 ? 0 : 2 }).format(major);
}

/** Rupees → paise etc. Accepts numbers or numeric strings; rejects anything fractional beyond the minor unit. */
export function toMinor(major: number | string, currency: string): number {
  const c = CURRENCIES[currency] ?? CURRENCIES.INR;
  const n = typeof major === 'string' ? Number(major.replace(/[,\s]/g, '')) : major;
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid amount');
  return Math.round(n * 10 ** c.minor);
}

/** Basis-point share, rounded half-up to the minor unit. */
export const bps = (amount: number, basisPoints: number) => Math.round((amount * basisPoints) / 10000);

/**
 * Indicative conversion for display only. Sponsors are always charged in the opportunity's
 * own currency; rates are configured by the platform admin and labelled as approximate.
 */
export function convert(minor: number, from: string, to: string, ratesPerINR: Record<string, number>): number | null {
  if (from === to) return minor;
  const fromRate = from === 'INR' ? 1 : ratesPerINR[from];
  const toRate = to === 'INR' ? 1 : ratesPerINR[to];
  if (!fromRate || !toRate) return null;
  return Math.round((minor / fromRate) * toRate);
}

export interface PriceBreakdown {
  subtotal: number;
  platformFee: number;
  taxable: number;
  tax: number;
  total: number;
  commission: number;
  organizerNet: number;
  taxRateBps: number;
  commissionBps: number;
}

/**
 * Sponsor pays: subtotal + platform fee + tax on (subtotal + fee).
 * Organizer receives: subtotal − commission (+ the tax they must remit, tracked separately).
 * Platform keeps: commission + platform fee.
 */
export function price(subtotal: number, o: { platformFee: number; taxRateBps: number; commissionBps: number }): PriceBreakdown {
  const taxable = subtotal + o.platformFee;
  const tax = bps(taxable, o.taxRateBps);
  const commission = bps(subtotal, o.commissionBps);
  return {
    subtotal,
    platformFee: o.platformFee,
    taxable,
    tax,
    total: taxable + tax,
    commission,
    organizerNet: subtotal - commission,
    taxRateBps: o.taxRateBps,
    commissionBps: o.commissionBps,
  };
}

/** Parse "₹5 lakh", "2.5L", "10 lakhs", "1 crore", "50k", "200000" → INR minor units. */
export function parseInrAmount(text: string): number | null {
  const m = text.toLowerCase().replace(/,/g, '').match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|l\b|k\b|thousand)?/);
  if (!m) return null;
  let n = Number(m[1]);
  const unit = m[2] ?? '';
  if (/^(crore|crores|cr)$/.test(unit)) n *= 1e7;
  else if (/^(lakh|lakhs|lac|lacs|l)$/.test(unit)) n *= 1e5;
  else if (/^(k|thousand)$/.test(unit)) n *= 1e3;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------- tax identifiers

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Indian GSTIN: 15 chars, state code + PAN + entity + 'Z' + checksum (mod-36 Luhn variant). */
export function validGstin(v: string): boolean {
  const s = v.toUpperCase().trim();
  if (!/^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const val = GSTIN_CHARS.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(val / 36) + (val % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return check === s[14];
}

export const validPhone = (p: string) => /^\+[1-9]\d{7,14}$/.test(p.replace(/[\s-]/g, ''));
export const normalizePhone = (p: string) => p.replace(/[\s-()]/g, '');
export const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
