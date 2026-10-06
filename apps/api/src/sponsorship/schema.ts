/**
 * Sponsorship domain schema. Money is always stored as integer minor units (paise, cents)
 * with an explicit ISO currency code. Every tenant-owned row carries org_id (the organizer
 * selling the inventory); sponsor-owned rows carry sponsor_id.
 *
 * Spec entity → table:
 *   Sponsor / SponsorOrganization / SponsorProfile → sponsor_accounts (kind = individual | organization)
 *   SponsorUser            → sponsor_members (+ users)
 *   SponsorAsset           → sponsor_assets (+ asset_variants)
 *   SponsorshipOpportunity → sp_opportunities
 *   SponsorshipPackage     → sp_packages (+ sp_package_items)
 *   SponsorshipInventory   → sp_inventory
 *   SponsorshipOrder       → sp_orders (+ sp_order_items, sp_order_events)
 *   SponsorshipPayment     → sp_payments (+ sp_webhook_events, sp_refunds)
 *   SponsorshipInvoice     → sp_invoices
 *   SponsorshipCampaign    → sp_placements (what an active order shows, and where)
 *   SponsorshipAgreement   → sp_documents (agreement, receipt, confirmation, renewal)
 *   SponsorshipApproval    → sp_order_events + asset moderation log
 *   SponsorshipExposure    → sp_exposure_daily (+ sp_unique_viewers)
 *   SponsorshipAnalytics   → derived from exposure + qr tables
 *   SponsorshipRenewal     → sp_orders.renewal_of + sp_reminders
 *   SponsorshipBid         → sp_bids
 *   SponsorshipMessage     → sp_threads + sp_messages (offers, RFP, negotiation)
 *   SponsorNotification    → notifications + notification_outbox (platform-wide)
 *   SponsorQRCode          → sp_qr_codes + sp_qr_scans
 */
import type { DB } from '../db.ts';
import { ensureColumn } from '../db.ts';

export const SPONSORSHIP_SCHEMA = `
-- ---------------------------------------------------------------- platform infrastructure
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, destination TEXT NOT NULL, purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_codes_dest ON auth_codes(destination, purpose, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT, sponsor_id TEXT, org_id TEXT, event TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, link TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, destination TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  event TEXT, provider TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS org_sponsorship_settings (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id), commission_bps INTEGER, platform_fee_minor INTEGER,
  payment_provider TEXT, payment_config_enc TEXT, invoice_prefix TEXT, gstin TEXT, legal_name TEXT, address TEXT,
  marketplace_enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- sponsors
CREATE TABLE IF NOT EXISTS sponsor_accounts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, category TEXT NOT NULL,
  industry TEXT, description TEXT, website TEXT, email TEXT, phone TEXT, country TEXT, city TEXT, address TEXT,
  tax_id TEXT, tax_id_type TEXT, registration_no TEXT, contact_person TEXT, logo_asset_id TEXT, social TEXT NOT NULL DEFAULT '{}',
  brand_colors TEXT NOT NULL DEFAULT '[]', billing TEXT NOT NULL DEFAULT '{}', public_profile INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', status_reason TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sponsor_members (
  sponsor_id TEXT NOT NULL REFERENCES sponsor_accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (sponsor_id, user_id)
);
CREATE TABLE IF NOT EXISTS sponsor_invites (
  token_hash TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL REFERENCES sponsor_accounts(id) ON DELETE CASCADE, email TEXT NOT NULL,
  role TEXT NOT NULL, invited_by TEXT, expires_at TEXT NOT NULL, accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS sponsor_assets (
  id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL REFERENCES sponsor_accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER, duration_ms INTEGER, sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL, original_name TEXT, text TEXT, status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT, reviewed_by TEXT, reviewed_at TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_variants (
  asset_id TEXT NOT NULL REFERENCES sponsor_assets(id) ON DELETE CASCADE, variant TEXT NOT NULL, mime TEXT NOT NULL,
  width INTEGER, height INTEGER, bytes INTEGER NOT NULL, storage_key TEXT NOT NULL, PRIMARY KEY (asset_id, variant)
);
CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, action TEXT NOT NULL,
  reason TEXT, note TEXT, actor_id TEXT, org_id TEXT, at TEXT NOT NULL
);

-- ---------------------------------------------------------------- inventory & opportunities
CREATE TABLE IF NOT EXISTS sp_inventory (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), type TEXT NOT NULL, name TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_id TEXT, quantity INTEGER NOT NULL DEFAULT 1, unit_price_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR', options TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_opportunities (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), title TEXT NOT NULL, slug TEXT NOT NULL,
  description TEXT, sport TEXT, tournament_id TEXT, venue_id TEXT, match_id TEXT, country TEXT NOT NULL DEFAULT 'India',
  state TEXT, city TEXT, level TEXT NOT NULL DEFAULT 'local', audience_estimate INTEGER NOT NULL DEFAULT 0,
  audience_profile TEXT NOT NULL DEFAULT '{}', starts_on TEXT, ends_on TEXT, sale_model TEXT NOT NULL DEFAULT 'fixed',
  approval_mode TEXT NOT NULL DEFAULT 'auto', currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL DEFAULT 'draft',
  featured_until TEXT, cover_asset TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS sp_opp_status ON sp_opportunities(status, sport, city);
CREATE TABLE IF NOT EXISTS sp_packages (
  id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES sp_opportunities(id) ON DELETE CASCADE, name TEXT NOT NULL,
  tier TEXT, description TEXT, price_minor INTEGER, currency TEXT NOT NULL DEFAULT 'INR', duration_days INTEGER,
  max_sponsors INTEGER NOT NULL DEFAULT 1, sold INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
  sale_model TEXT, auction TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_package_items (
  package_id TEXT NOT NULL REFERENCES sp_packages(id) ON DELETE CASCADE, inventory_id TEXT NOT NULL REFERENCES sp_inventory(id),
  quantity INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (package_id, inventory_id)
);

-- ---------------------------------------------------------------- orders & money
CREATE TABLE IF NOT EXISTS sp_orders (
  id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id),
  sponsor_id TEXT NOT NULL REFERENCES sponsor_accounts(id), opportunity_id TEXT NOT NULL REFERENCES sp_opportunities(id),
  package_id TEXT, status TEXT NOT NULL, currency TEXT NOT NULL, subtotal_minor INTEGER NOT NULL, platform_fee_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL, tax_rate_bps INTEGER NOT NULL, commission_bps INTEGER NOT NULL,
  starts_on TEXT, ends_on TEXT, auto_renew INTEGER NOT NULL DEFAULT 0, renewal_of TEXT, source TEXT NOT NULL DEFAULT 'checkout',
  billing TEXT NOT NULL DEFAULT '{}', asset_ids TEXT NOT NULL DEFAULT '[]', risk TEXT NOT NULL DEFAULT '[]',
  hold_expires_at TEXT, agreement_accepted_at TEXT, idempotency_key TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (sponsor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS sp_orders_org ON sp_orders(org_id, status);
CREATE INDEX IF NOT EXISTS sp_orders_sponsor ON sp_orders(sponsor_id, status);
CREATE TABLE IF NOT EXISTS sp_order_items (
  order_id TEXT NOT NULL REFERENCES sp_orders(id) ON DELETE CASCADE, inventory_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_id TEXT, quantity INTEGER NOT NULL, unit_price_minor INTEGER NOT NULL, PRIMARY KEY (order_id, inventory_id)
);
CREATE TABLE IF NOT EXISTS sp_order_assets (
  order_id TEXT NOT NULL REFERENCES sp_orders(id) ON DELETE CASCADE, asset_id TEXT NOT NULL REFERENCES sponsor_assets(id),
  role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, reviewed_by TEXT, reviewed_at TEXT, PRIMARY KEY (order_id, role)
);
CREATE TABLE IF NOT EXISTS sp_deliverables (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sp_orders(id) ON DELETE CASCADE, type TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', proof_url TEXT, note TEXT, delivered_at TEXT, delivered_by TEXT
);
CREATE TABLE IF NOT EXISTS sp_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor_id TEXT,
  actor_kind TEXT NOT NULL, note TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_payments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sp_orders(id), provider TEXT NOT NULL, provider_order_id TEXT NOT NULL,
  provider_payment_id TEXT, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, method TEXT,
  captured_at TEXT, raw TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (provider, provider_order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sp_payments_pid ON sp_payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sp_webhook_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, result TEXT,
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE IF NOT EXISTS sp_refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payment_id TEXT NOT NULL, provider TEXT NOT NULL, provider_refund_id TEXT,
  amount_minor INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL, requested_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, org_id TEXT NOT NULL, kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, note TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_settlements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL,
  provider TEXT NOT NULL, reference TEXT, order_ids TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS sp_invoices (
  id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, order_id TEXT NOT NULL, org_id TEXT NOT NULL, sponsor_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'invoice', currency TEXT NOT NULL, total_minor INTEGER NOT NULL, data TEXT NOT NULL, issued_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_counters ( scope TEXT PRIMARY KEY, value INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS sp_documents (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, body_html TEXT NOT NULL,
  sha256 TEXT NOT NULL, accepted_by TEXT, accepted_at TEXT, accepted_ip TEXT, created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- activation & exposure
CREATE TABLE IF NOT EXISTS sp_placements (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sp_orders(id) ON DELETE CASCADE, org_id TEXT NOT NULL, sponsor_id TEXT NOT NULL,
  surface TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT, weight INTEGER NOT NULL DEFAULT 1, options TEXT NOT NULL DEFAULT '{}',
  starts_on TEXT, ends_on TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sp_placements_scope ON sp_placements(org_id, active, surface);
CREATE TABLE IF NOT EXISTS sp_exposure_daily (
  order_id TEXT NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '', value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, day, metric, dim)
);
CREATE TABLE IF NOT EXISTS sp_unique_viewers (
  order_id TEXT NOT NULL, day TEXT NOT NULL, viewer TEXT NOT NULL, PRIMARY KEY (order_id, day, viewer)
);
CREATE TABLE IF NOT EXISTS sp_qr_codes (
  code TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL, order_id TEXT, label TEXT, target_url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_qr_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, order_id TEXT, viewer TEXT NOT NULL, city TEXT, country TEXT,
  tournament_id TEXT, venue_id TEXT, match_id TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_reminders ( order_id TEXT NOT NULL, kind TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (order_id, kind) );

-- ---------------------------------------------------------------- offers, negotiation, auctions
CREATE TABLE IF NOT EXISTS sp_threads (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, sponsor_id TEXT NOT NULL, opportunity_id TEXT NOT NULL, package_id TEXT,
  kind TEXT NOT NULL, status TEXT NOT NULL, offer_minor INTEGER, currency TEXT NOT NULL, order_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES sp_threads(id) ON DELETE CASCADE, author_id TEXT NOT NULL,
  author_side TEXT NOT NULL, body TEXT NOT NULL, offer_minor INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sp_bids (
  id TEXT PRIMARY KEY, package_id TEXT NOT NULL, sponsor_id TEXT NOT NULL, max_minor INTEGER NOT NULL, created_by TEXT,
  created_at TEXT NOT NULL, withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS sp_bids_pkg ON sp_bids(package_id, max_minor);
`;

export function migrateSponsorship(db: DB) {
  db.exec(SPONSORSHIP_SCHEMA);
  // additive migrations (safe to run on every start)
  ensureColumn(db, 'sp_orders', 'click_url', 'TEXT');
  ensureColumn(db, 'sp_orders', 'notes', 'TEXT');
  ensureColumn(db, 'sp_payments', 'scope_org', 'TEXT'); // set when the organizer's own gateway keys took the payment
  ensureColumn(db, 'sp_payments', 'failure_reason', 'TEXT');
  ensureColumn(db, 'sp_payments', 'booked', 'INTEGER NOT NULL DEFAULT 0'); // the payment whose money was split into the ledger
  ensureColumn(db, 'sp_ledger', 'settlement_id', 'TEXT');
  ensureColumn(db, 'sp_order_assets', 'proposed_asset_id', 'TEXT'); // replacement awaiting review on a live sponsorship
  ensureColumn(db, 'org_sponsorship_settings', 'state', 'TEXT');
  ensureColumn(db, 'sp_documents', 'model', 'TEXT'); // structured source for PDF rendering
  ensureColumn(db, 'display_devices', 'audience_estimate', 'INTEGER NOT NULL DEFAULT 50');
  db.exec('CREATE INDEX IF NOT EXISTS sp_payments_order ON sp_payments(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_refunds_order ON sp_refunds(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_ledger_org ON sp_ledger(org_id, kind)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_exposure_order ON sp_exposure_daily(order_id, day)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_threads_org ON sp_threads(org_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_threads_sponsor ON sp_threads(sponsor_id, status)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sp_refunds_provider ON sp_refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL');
}
