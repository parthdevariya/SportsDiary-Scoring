/**
 * Sponsor identity: accounts (individual or organization), team membership with roles,
 * sign-in methods, invitations, profiles and public profiles.
 *
 * A person has ONE login (users table) and can be an organizer, a sponsor team member,
 * or both. Sponsor access is a membership row, so organizer permissions never leak into
 * sponsor accounts or the other way round.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { AuthUser } from '../auth.ts';
import { createSession, hashPassword, sha256, token as newToken, verifyPassword } from '../auth.ts';
import { HttpError, id } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now, tx } from '../db.ts';
import { SPONSOR_CATEGORIES, INDUSTRIES } from './catalog.ts';
import { normalizePhone, validEmail, validGstin, validPhone } from './money.ts';
import type { Notifier } from './notify.ts';
import { PROVIDERS, verifyIdToken } from './oidc.ts';
import { getPlatformSettings } from './settings.ts';

export const SPONSOR_ROLES = ['owner', 'admin', 'marketing', 'finance', 'viewer'] as const;
export type SponsorRole = (typeof SPONSOR_ROLES)[number];

/** What each sponsor role may do. 'view' and 'analytics' are open to every member. */
export const SPONSOR_PERMS: Record<string, SponsorRole[]> = {
  view: ['owner', 'admin', 'marketing', 'finance', 'viewer'],
  analytics: ['owner', 'admin', 'marketing', 'finance', 'viewer'],
  profile: ['owner', 'admin'],
  team: ['owner', 'admin'],
  buy: ['owner', 'admin', 'marketing'],
  assets: ['owner', 'admin', 'marketing'],
  pay: ['owner', 'admin', 'finance'],
  finance: ['owner', 'admin', 'finance'],
  renew: ['owner', 'admin', 'finance'],
};

/** Actions blocked while an account is pending platform approval or suspended. */
const COMMERCIAL = new Set(['buy', 'pay', 'renew']);

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'sponsor';
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export class SponsorService {
  constructor(private db: DB, private notify: Notifier) {}

  // ------------------------------------------------------------------ authorization
  authorize(user: AuthUser, perm: string, requested?: string | null): { accountId: string; role: string } {
    const allowed = SPONSOR_PERMS[perm];
    if (!allowed) throw new HttpError(500, `Unknown sponsor permission ${perm}`);
    const rows = this.db.prepare('SELECT m.sponsor_id, m.role, a.status FROM sponsor_members m JOIN sponsor_accounts a ON a.id = m.sponsor_id WHERE m.user_id = ? ORDER BY m.created_at').all(user.id) as any[];
    if (!rows.length) throw new HttpError(403, 'Create or join a sponsor account first', 'NO_SPONSOR_ACCOUNT');
    const m = requested ? rows.find((r) => r.sponsor_id === requested) : rows[0];
    if (!m) throw new HttpError(403, 'You are not a member of that sponsor account', 'FORBIDDEN');
    if (!allowed.includes(m.role)) throw new HttpError(403, `Your role (${m.role}) cannot do this`, 'FORBIDDEN');
    if (m.status === 'suspended') throw new HttpError(403, 'This sponsor account is suspended. Contact support.', 'SUSPENDED');
    if (m.status === 'pending' && COMMERCIAL.has(perm)) throw new HttpError(403, 'Your sponsor account is awaiting approval. You can browse and prepare assets meanwhile.', 'PENDING_APPROVAL');
    if (m.status === 'rejected' && COMMERCIAL.has(perm)) throw new HttpError(403, 'Your sponsor account was not approved.', 'REJECTED');
    return { accountId: m.sponsor_id, role: m.role };
  }

  // ------------------------------------------------------------------ accounts
  account(accountId: string) {
    const a = this.db.prepare('SELECT * FROM sponsor_accounts WHERE id = ?').get(accountId) as any;
    if (!a) throw new HttpError(404, 'Sponsor not found', 'NOT_FOUND');
    return a;
  }

  view(a: any) {
    const logo = a.logo_asset_id ? `/media/${a.logo_asset_id}` : null;
    return {
      id: a.id, kind: a.kind, name: a.name, slug: a.slug, category: a.category, industry: a.industry, description: a.description,
      website: a.website, email: a.email, phone: a.phone, country: a.country, city: a.city, address: a.address,
      taxId: a.tax_id, taxIdType: a.tax_id_type, registrationNo: a.registration_no, contactPerson: a.contact_person,
      logo, social: P(a.social, {}), brandColors: P(a.brand_colors, []), billing: P(a.billing, {}), publicProfile: !!a.public_profile,
      status: a.status, statusReason: a.status_reason, createdAt: a.created_at,
    };
  }

  private validateProfile(b: any, partial: boolean) {
    const need = (k: string) => !partial && (b[k] == null || String(b[k]).trim() === '');
    if (need('name')) throw new HttpError(400, 'Name is required', 'VALIDATION');
    if (b.kind != null && !['individual', 'organization'].includes(b.kind)) throw new HttpError(400, 'kind must be individual or organization', 'VALIDATION');
    if (b.category != null && !SPONSOR_CATEGORIES.includes(b.category)) throw new HttpError(400, 'Unknown sponsor category', 'VALIDATION', { allowed: SPONSOR_CATEGORIES });
    if (b.industry != null && b.industry !== '' && !INDUSTRIES.includes(b.industry)) throw new HttpError(400, 'Unknown industry', 'VALIDATION', { allowed: INDUSTRIES });
    if (b.email && !validEmail(b.email)) throw new HttpError(400, 'Enter a valid email', 'VALIDATION');
    if (b.phone && !validPhone(normalizePhone(b.phone))) throw new HttpError(400, 'Enter the phone with country code, e.g. +91 98765 43210', 'VALIDATION');
    if (b.website && !URL_RE.test(b.website)) throw new HttpError(400, 'Website must start with http:// or https://', 'VALIDATION');
    if (b.social) for (const [k, v] of Object.entries(b.social)) if (v && !URL_RE.test(String(v))) throw new HttpError(400, `${k} link must be a full URL`, 'VALIDATION');
    if (b.brandColors && (!Array.isArray(b.brandColors) || b.brandColors.some((c: any) => !/^#[0-9a-f]{6}$/i.test(c)))) throw new HttpError(400, 'Brand colours must be hex like #062547', 'VALIDATION');
    if (b.taxId) {
      const type = b.taxIdType ?? ((b.country ?? 'India') === 'India' ? 'GSTIN' : 'VAT');
      if (type === 'GSTIN' && !validGstin(b.taxId)) throw new HttpError(400, 'That GSTIN is not valid. Check the 15 characters.', 'VALIDATION');
    }
  }

  createAccount(user: AuthUser, b: any) {
    this.validateProfile({ ...b, kind: b.kind ?? 'organization', category: b.category ?? (b.kind === 'individual' ? 'Individual Sponsor' : 'Brand') }, false);
    const settings = getPlatformSettings(this.db);
    const aid = id();
    let slug = slugify(b.name);
    while (this.db.prepare('SELECT 1 FROM sponsor_accounts WHERE slug = ?').get(slug)) slug = `${slugify(b.name).slice(0, 40)}-${randomInt(1000, 9999)}`;
    const t = now();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO sponsor_accounts (id, kind, name, slug, category, industry, description, website, email, phone, country, city, address, tax_id, tax_id_type,
        registration_no, contact_person, social, brand_colors, billing, public_profile, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        aid, b.kind ?? 'organization', String(b.name).trim().slice(0, 120), slug, b.category ?? (b.kind === 'individual' ? 'Individual Sponsor' : 'Brand'), b.industry ?? null,
        b.description?.slice(0, 2000) ?? null, b.website ?? null, b.email ?? user.email, b.phone ? normalizePhone(b.phone) : null, b.country ?? 'India', b.city ?? null,
        b.address ?? null, b.taxId ? String(b.taxId).toUpperCase() : null, b.taxId ? b.taxIdType ?? ((b.country ?? 'India') === 'India' ? 'GSTIN' : 'VAT') : null,
        b.registrationNo ?? null, b.contactPerson ?? user.name, J(b.social ?? {}), J(b.brandColors ?? []), J(b.billing ?? {}), b.publicProfile ? 1 : 0,
        settings.sponsorApproval === 'manual' ? 'pending' : 'active', user.id, t, t,
      );
      this.db.prepare('INSERT INTO sponsor_members (sponsor_id, user_id, role, created_at) VALUES (?,?,?,?)').run(aid, user.id, 'owner', t);
    });
    void this.notify.event({ event: 'sponsor.registered', sponsorId: aid, title: 'Welcome to Sports Diary', body: `Your sponsor account ${b.name} is ${settings.sponsorApproval === 'manual' ? 'awaiting approval' : 'ready'}. Browse sponsorships at /sponsorships.` });
    return this.view(this.account(aid));
  }

  updateProfile(accountId: string, b: any) {
    this.validateProfile(b, true);
    const a = this.account(accountId);
    const v = (k: string, col: string, f = (x: any) => x) => (b[k] !== undefined ? f(b[k]) : a[col]);
    this.db.prepare(`UPDATE sponsor_accounts SET kind=?, name=?, category=?, industry=?, description=?, website=?, email=?, phone=?, country=?, city=?, address=?,
      tax_id=?, tax_id_type=?, registration_no=?, contact_person=?, social=?, brand_colors=?, public_profile=?, logo_asset_id=?, updated_at=? WHERE id = ?`).run(
      v('kind', 'kind'), v('name', 'name', (x) => String(x).trim().slice(0, 120)), v('category', 'category'), v('industry', 'industry'), v('description', 'description', (x) => x?.slice(0, 2000) ?? null),
      v('website', 'website'), v('email', 'email'), v('phone', 'phone', (x) => (x ? normalizePhone(x) : null)), v('country', 'country'), v('city', 'city'), v('address', 'address'),
      v('taxId', 'tax_id', (x) => (x ? String(x).toUpperCase() : null)), v('taxIdType', 'tax_id_type'), v('registrationNo', 'registration_no'), v('contactPerson', 'contact_person'),
      b.social !== undefined ? J(b.social) : a.social, b.brandColors !== undefined ? J(b.brandColors) : a.brand_colors,
      b.publicProfile !== undefined ? (b.publicProfile ? 1 : 0) : a.public_profile, this.ownedAsset(accountId, b.logoAssetId) ?? a.logo_asset_id, now(), accountId,
    );
    return this.view(this.account(accountId));
  }

  private ownedAsset(accountId: string, assetId?: string | null) {
    if (!assetId) return null;
    const asset = this.db.prepare('SELECT id FROM sponsor_assets WHERE id = ? AND sponsor_id = ?').get(assetId, accountId) as any;
    if (!asset) throw new HttpError(400, 'Unknown asset', 'VALIDATION');
    return asset.id;
  }

  updateBilling(accountId: string, b: any) {
    const cur = P(this.account(accountId).billing, {} as any);
    const next = {
      legalName: b.legalName ?? cur.legalName ?? null,
      address: b.address ?? cur.address ?? null,
      state: b.state ?? cur.state ?? null,
      country: b.country ?? cur.country ?? null,
      email: b.email ?? cur.email ?? null,
      taxId: b.taxId ? String(b.taxId).toUpperCase() : cur.taxId ?? null,
      preferredMethod: b.preferredMethod ?? cur.preferredMethod ?? null,
      providerCustomers: cur.providerCustomers ?? {},
    };
    if (next.email && !validEmail(next.email)) throw new HttpError(400, 'Enter a valid billing email', 'VALIDATION');
    if (next.taxId && (next.country ?? 'India') === 'India' && !validGstin(next.taxId)) throw new HttpError(400, 'That GSTIN is not valid', 'VALIDATION');
    if (next.preferredMethod && !['upi', 'card', 'netbanking', 'wallet', 'international_card'].includes(next.preferredMethod)) throw new HttpError(400, 'Unknown payment method', 'VALIDATION');
    this.db.prepare('UPDATE sponsor_accounts SET billing = ?, updated_at = ? WHERE id = ?').run(J(next), now(), accountId);
    return next;
  }

  memberships(userId: string) {
    return (this.db.prepare('SELECT m.role, a.* FROM sponsor_members m JOIN sponsor_accounts a ON a.id = m.sponsor_id WHERE m.user_id = ? ORDER BY m.created_at').all(userId) as any[]).map((r) => ({
      role: r.role, account: this.view(r),
    }));
  }

  // ------------------------------------------------------------------ team
  team(accountId: string) {
    const members = this.db.prepare('SELECT u.id, u.name, u.email, m.role, m.created_at FROM sponsor_members m JOIN users u ON u.id = m.user_id WHERE m.sponsor_id = ? ORDER BY m.created_at').all(accountId);
    const invites = this.db.prepare('SELECT email, role, expires_at FROM sponsor_invites WHERE sponsor_id = ? AND accepted_at IS NULL AND expires_at > ?').all(accountId, now());
    return { members, invites };
  }

  async invite(accountId: string, actor: AuthUser, actorRole: string, email: string, role: string, baseUrl: string) {
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email', 'VALIDATION');
    if (!(SPONSOR_ROLES as readonly string[]).includes(role)) throw new HttpError(400, 'Unknown role', 'VALIDATION');
    if (role === 'owner' && actorRole !== 'owner') throw new HttpError(403, 'Only an owner can invite another owner', 'FORBIDDEN');
    const t = newToken(24);
    this.db.prepare('INSERT INTO sponsor_invites (token_hash, sponsor_id, email, role, invited_by, expires_at) VALUES (?,?,?,?,?,?)').run(
      sha256(t), accountId, email.toLowerCase(), role, actor.id, new Date(Date.now() + 7 * 864e5).toISOString(),
    );
    const a = this.account(accountId);
    await this.notify.send({ channel: 'email', to: email, subject: `Join ${a.name} on Sports Diary`, body: `${actor.name} invited you to manage sponsorships for ${a.name} as ${role}.\n\nAccept: ${baseUrl}/sponsor#invite=${t}\n\nThis link expires in 7 days.`, event: 'sponsor.invite' });
    return { ok: true };
  }

  acceptInvite(user: AuthUser, t: string) {
    const inv = this.db.prepare('SELECT * FROM sponsor_invites WHERE token_hash = ?').get(sha256(String(t))) as any;
    if (!inv || inv.accepted_at || inv.expires_at < now()) throw new HttpError(404, 'This invitation is invalid or has expired', 'NOT_FOUND');
    if (inv.email !== user.email.toLowerCase()) throw new HttpError(403, `This invitation was sent to ${inv.email}. Sign in with that email to accept it.`, 'FORBIDDEN');
    tx(this.db, () => {
      this.db.prepare('INSERT INTO sponsor_members (sponsor_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT(sponsor_id, user_id) DO UPDATE SET role = excluded.role').run(inv.sponsor_id, user.id, inv.role, now());
      this.db.prepare('UPDATE sponsor_invites SET accepted_at = ? WHERE token_hash = ?').run(now(), inv.token_hash);
    });
    return { sponsorId: inv.sponsor_id, role: inv.role };
  }

  setRole(accountId: string, actorRole: string, userId: string, role: string) {
    if (!(SPONSOR_ROLES as readonly string[]).includes(role)) throw new HttpError(400, 'Unknown role', 'VALIDATION');
    const m = this.db.prepare('SELECT role FROM sponsor_members WHERE sponsor_id = ? AND user_id = ?').get(accountId, userId) as any;
    if (!m) throw new HttpError(404, 'Member not found', 'NOT_FOUND');
    if ((m.role === 'owner' || role === 'owner') && actorRole !== 'owner') throw new HttpError(403, 'Only an owner can change owners', 'FORBIDDEN');
    if (m.role === 'owner' && role !== 'owner') this.assertAnotherOwner(accountId, userId);
    this.db.prepare('UPDATE sponsor_members SET role = ? WHERE sponsor_id = ? AND user_id = ?').run(role, accountId, userId);
  }

  removeMember(accountId: string, actorRole: string, userId: string) {
    const m = this.db.prepare('SELECT role FROM sponsor_members WHERE sponsor_id = ? AND user_id = ?').get(accountId, userId) as any;
    if (!m) throw new HttpError(404, 'Member not found', 'NOT_FOUND');
    if (m.role === 'owner') {
      if (actorRole !== 'owner') throw new HttpError(403, 'Only an owner can remove an owner', 'FORBIDDEN');
      this.assertAnotherOwner(accountId, userId);
    }
    this.db.prepare('DELETE FROM sponsor_members WHERE sponsor_id = ? AND user_id = ?').run(accountId, userId);
  }

  private assertAnotherOwner(accountId: string, exceptUser: string) {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM sponsor_members WHERE sponsor_id = ? AND role = 'owner' AND user_id != ?").get(accountId, exceptUser) as any).n;
    if (!n) throw new HttpError(409, 'An account must keep at least one owner', 'CONFLICT');
  }

  // ------------------------------------------------------------------ sign-in methods
  /** Self-service sign-up: person + sponsor account in one step. */
  signup(b: any): { token: string; userId: string; account: any } {
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email', 'VALIDATION');
    if (!b.password || String(b.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters', 'VALIDATION');
    if (!b.personName && !b.name) throw new HttpError(400, 'Your name is required', 'VALIDATION');
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists. Sign in, then create your sponsor account.', 'CONFLICT');
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (phone && !validPhone(phone)) throw new HttpError(400, 'Enter the phone with country code, e.g. +91 98765 43210', 'VALIDATION');
    if (phone && this.db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw new HttpError(409, 'That mobile number is already registered', 'CONFLICT');
    const uid = id();
    const personName = String(b.personName ?? b.name).trim().slice(0, 80);
    this.db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, phone, created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid, null, email, personName, hashPassword(b.password), 'member', phone, now());
    const user: AuthUser = { id: uid, orgId: '', email, name: personName, role: 'member' };
    let account: any;
    try {
      account = this.createAccount(user, { ...b, name: b.kind === 'individual' ? b.accountName ?? personName : b.accountName ?? b.name, email: b.accountEmail ?? email, phone });
    } catch (e) {
      this.db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      throw e;
    }
    void this.sendCode('email', email, 'verify');
    return { token: createSession(this.db, uid), userId: uid, account };
  }

  /** One-time codes for login (email or SMS) and for verifying an email/phone. */
  async sendCode(channel: 'email' | 'sms', destinationRaw: string, purpose: 'login' | 'verify') {
    const destination = channel === 'email' ? destinationRaw.trim().toLowerCase() : normalizePhone(destinationRaw);
    if (channel === 'email' ? !validEmail(destination) : !validPhone(destination)) throw new HttpError(400, channel === 'email' ? 'Enter a valid email' : 'Enter the phone with country code', 'VALIDATION');
    const recent = this.db.prepare('SELECT created_at FROM auth_codes WHERE destination = ? AND purpose = ? ORDER BY created_at DESC LIMIT 6').all(destination, purpose) as any[];
    if (recent[0] && Date.now() - Date.parse(recent[0].created_at) < 45_000) throw new HttpError(429, 'Please wait a moment before requesting another code', 'RATE_LIMIT');
    if (recent.length >= 6 && Date.now() - Date.parse(recent[5].created_at) < 3600_000) throw new HttpError(429, 'Too many codes requested. Try again in an hour.', 'RATE_LIMIT');
    const user = this.db.prepare(`SELECT id FROM users WHERE ${channel === 'email' ? 'email' : 'phone'} = ?`).get(destination) as any;
    // Same response whether or not the account exists (no account enumeration).
    if (!user && purpose === 'login') return { sent: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const cid = id();
    this.db.prepare('INSERT INTO auth_codes (id, channel, destination, purpose, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)').run(
      cid, channel, destination, purpose, sha256(`${cid}:${code}`), new Date(Date.now() + 10 * 60_000).toISOString(), now(),
    );
    const body = `Your Sports Diary code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
    await this.notify.send({ channel, to: destination, subject: 'Your Sports Diary code', body, event: `auth.${purpose}` });
    return { sent: true };
  }

  verifyCode(channel: 'email' | 'sms', destinationRaw: string, code: string, purpose: 'login' | 'verify', user?: AuthUser | null) {
    const destination = channel === 'email' ? destinationRaw.trim().toLowerCase() : normalizePhone(destinationRaw);
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE destination = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(destination, purpose) as any;
    const fail = () => new HttpError(400, 'That code is incorrect or has expired', 'INVALID_CODE');
    if (!row || row.expires_at < now()) throw fail();
    if (row.attempts >= 5) {
      this.db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
      throw new HttpError(429, 'Too many attempts. Request a new code.', 'RATE_LIMIT');
    }
    const ok = createHash('sha256').update(`${row.id}:${String(code).trim()}`).digest('hex') === row.code_hash;
    if (!ok) {
      this.db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      throw fail();
    }
    this.db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
    const col = channel === 'email' ? 'email' : 'phone';
    if (purpose === 'verify') {
      if (!user) throw new HttpError(401, 'Sign in required', 'UNAUTHORIZED');
      const me = this.db.prepare('SELECT email, phone FROM users WHERE id = ?').get(user.id) as any;
      if (channel === 'sms' && !me.phone) {
        if (this.db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(destination, user.id)) throw new HttpError(409, 'That mobile number belongs to another account', 'CONFLICT');
        this.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(destination, user.id);
      } else if (me[col] !== destination) throw new HttpError(403, 'That code was sent to a different address', 'FORBIDDEN');
      this.db.prepare(`UPDATE users SET ${channel === 'email' ? 'email_verified' : 'phone_verified'} = 1 WHERE id = ?`).run(user.id);
      return { verified: true };
    }
    const u = this.db.prepare(`SELECT id, status FROM users WHERE ${col} = ?`).get(destination) as any;
    if (!u) throw fail();
    if (u.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'SUSPENDED');
    this.db.prepare(`UPDATE users SET ${channel === 'email' ? 'email_verified' : 'phone_verified'} = 1 WHERE id = ?`).run(u.id);
    return { token: createSession(this.db, u.id) };
  }

  async forgotPassword(emailRaw: string, baseUrl: string) {
    const email = String(emailRaw ?? '').trim().toLowerCase();
    const u = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
    if (u) {
      const t = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO auth_codes (id, channel, destination, purpose, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)').run(
        id(), 'email', email, 'reset', sha256(t), new Date(Date.now() + 30 * 60_000).toISOString(), now(),
      );
      await this.notify.send({ channel: 'email', to: email, subject: 'Reset your Sports Diary password', body: `Reset your password (valid for 30 minutes):\n${baseUrl}/sponsor#reset=${t}\n\nIf you didn't ask for this, ignore this email.`, event: 'auth.reset' });
    }
    return { sent: true }; // identical response either way
  }

  resetPassword(t: string, password: string) {
    if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters', 'VALIDATION');
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE purpose = 'reset' AND code_hash = ? AND consumed_at IS NULL").get(sha256(String(t))) as any;
    if (!row || row.expires_at < now()) throw new HttpError(400, 'This reset link is invalid or has expired', 'INVALID_CODE');
    const u = this.db.prepare('SELECT id FROM users WHERE email = ?').get(row.destination) as any;
    if (!u) throw new HttpError(400, 'This reset link is invalid or has expired', 'INVALID_CODE');
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(password), u.id);
      this.db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // sign out everywhere
    });
    return { token: createSession(this.db, u.id) };
  }

  async oauth(providerName: string, idToken: string) {
    const p = PROVIDERS[providerName as 'google' | 'apple'];
    if (!p) throw new HttpError(404, 'Unknown sign-in provider', 'NOT_FOUND');
    if (!p.clientId()) throw new HttpError(501, `${providerName === 'google' ? 'Google' : 'Apple'} sign-in is not configured on this server`, 'NOT_CONFIGURED');
    let ident;
    try {
      ident = await verifyIdToken(p, idToken);
    } catch (e: any) {
      throw new HttpError(401, `Sign-in failed: ${e.message}`, 'UNAUTHORIZED');
    }
    const col = p.name === 'google' ? 'google_sub' : 'apple_sub';
    let u = this.db.prepare(`SELECT id, status FROM users WHERE ${col} = ?`).get(ident.sub) as any;
    if (!u && ident.email && ident.emailVerified) {
      u = this.db.prepare('SELECT id, status FROM users WHERE email = ?').get(ident.email.toLowerCase()) as any;
      if (u) this.db.prepare(`UPDATE users SET ${col} = ?, email_verified = 1 WHERE id = ?`).run(ident.sub, u.id);
    }
    let created = false;
    if (!u) {
      if (!ident.email) throw new HttpError(400, 'Your provider did not share an email address', 'VALIDATION');
      const uid = id();
      this.db.prepare(`INSERT INTO users (id, org_id, email, name, password_hash, role, ${col}, email_verified, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        uid, null, ident.email.toLowerCase(), ident.name ?? ident.email.split('@')[0], hashPassword(randomBytes(24).toString('hex')), 'member', ident.sub, ident.emailVerified ? 1 : 0, now(),
      );
      u = { id: uid, status: 'active' };
      created = true;
    }
    if (u.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'SUSPENDED');
    return { token: createSession(this.db, u.id), created };
  }

  verifyPasswordFor(email: string, password: string) {
    const u = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as any;
    return !!u && verifyPassword(password, u.password_hash);
  }

  // ------------------------------------------------------------------ public profiles
  publicDirectory(q?: string) {
    const rows = this.db.prepare(`SELECT * FROM sponsor_accounts WHERE public_profile = 1 AND status = 'active' ${q ? 'AND (name LIKE ? OR industry LIKE ? OR city LIKE ?)' : ''} ORDER BY name LIMIT 200`)
      .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])) as any[];
    return rows.map((a) => {
      const v = this.view(a);
      return { slug: v.slug, name: v.name, logo: v.logo, industry: v.industry, city: v.city, category: v.category, description: v.description?.slice(0, 200) };
    });
  }

  publicProfile(slug: string) {
    const a = this.db.prepare("SELECT * FROM sponsor_accounts WHERE slug = ? AND public_profile = 1 AND status = 'active'").get(slug) as any;
    if (!a) throw new HttpError(404, 'Sponsor not found', 'NOT_FOUND');
    const v = this.view(a);
    const campaigns = this.db.prepare(`SELECT o.status, o.starts_on, o.ends_on, op.title, op.sport, op.city, p.name AS package, t.public_code
      FROM sp_orders o JOIN sp_opportunities op ON op.id = o.opportunity_id LEFT JOIN sp_packages p ON p.id = o.package_id LEFT JOIN tournaments t ON t.id = op.tournament_id
      WHERE o.sponsor_id = ? AND o.status IN ('ACTIVE','EXPIRED','PAUSED') ORDER BY o.starts_on DESC LIMIT 50`).all(a.id) as any[];
    return {
      slug: v.slug, name: v.name, logo: v.logo, category: v.category, industry: v.industry, description: v.description, website: v.website,
      city: v.city, country: v.country, social: v.social,
      sports: [...new Set(campaigns.map((c) => c.sport).filter(Boolean))],
      campaigns: campaigns.map((c) => ({ title: c.title, package: c.package, sport: c.sport, city: c.city, status: c.status === 'ACTIVE' ? 'active' : 'past', startsOn: c.starts_on, endsOn: c.ends_on, tournament: c.public_code })),
    };
  }
}
