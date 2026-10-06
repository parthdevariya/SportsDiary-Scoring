/**
 * Notification engine (platform infrastructure, not sponsor-specific).
 *
 * Channels: in-app (always), email, SMS, WhatsApp. Each external channel goes through a
 * provider selected by environment:
 *   email    RESEND_API_KEY (+ EMAIL_FROM)                    → Resend HTTP API
 *   sms      TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
 *   whatsapp TWILIO_* + TWILIO_WHATSAPP_FROM
 * With no provider configured the message is written to notification_outbox with status
 * 'logged' (visible to platform admins) — nothing pretends to have been delivered.
 */
import type { DB } from '../db.ts';
import { now } from '../db.ts';
import { id } from '../context.ts';

export type Channel = 'email' | 'sms' | 'whatsapp';

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  event?: string;
}

interface Transport {
  name: string;
  send(m: OutboundMessage): Promise<void>;
}

const resend: Transport | null = process.env.RESEND_API_KEY
  ? {
      name: 'resend',
      async send(m) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: process.env.EMAIL_FROM ?? 'Sports Diary <no-reply@sportsdiary.app>', to: [m.to], subject: m.subject ?? 'Sports Diary', text: m.body }),
        });
        if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      },
    }
  : null;

function twilio(channel: 'sms' | 'whatsapp'): Transport | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = channel === 'sms' ? process.env.TWILIO_FROM : process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return null;
  return {
    name: `twilio-${channel}`,
    async send(m) {
      const body = new URLSearchParams({ From: channel === 'whatsapp' ? `whatsapp:${from}` : from, To: channel === 'whatsapp' ? `whatsapp:${m.to}` : m.to, Body: m.body });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  };
}

const TRANSPORTS: Record<Channel, Transport | null> = { email: resend, sms: twilio('sms'), whatsapp: twilio('whatsapp') };

export class Notifier {
  constructor(private db: DB) {}

  /** External message. Always recorded; delivered when a provider is configured. */
  async send(m: OutboundMessage): Promise<{ id: string; status: string }> {
    const t = TRANSPORTS[m.channel];
    const oid = id();
    this.db.prepare('INSERT INTO notification_outbox (id, channel, destination, subject, body, event, provider, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      oid, m.channel, m.to, m.subject ?? null, m.body, m.event ?? null, t?.name ?? 'outbox', t ? 'sending' : 'logged', now(),
    );
    if (!t) return { id: oid, status: 'logged' };
    try {
      await t.send(m);
      this.db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), oid);
      return { id: oid, status: 'sent' };
    } catch (e: any) {
      this.db.prepare("UPDATE notification_outbox SET status = 'failed', error = ? WHERE id = ?").run(String(e?.message ?? e).slice(0, 500), oid);
      return { id: oid, status: 'failed' };
    }
  }

  /** In-app notification (the bell in the sponsor portal and organizer console). */
  inApp(n: { userId?: string | null; sponsorId?: string | null; orgId?: string | null; event: string; title: string; body: string; link?: string }) {
    this.db.prepare('INSERT INTO notifications (id, user_id, sponsor_id, org_id, event, title, body, link, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id(), n.userId ?? null, n.sponsorId ?? null, n.orgId ?? null, n.event, n.title, n.body, n.link ?? null, now(),
    );
  }

  /**
   * Fan an event out to a sponsor account's members (in-app + email + SMS/WhatsApp to the
   * account phone when present) and/or an organizer's admins.
   */
  async event(e: { event: string; title: string; body: string; link?: string; sponsorId?: string; orgId?: string; channels?: Channel[] }) {
    const channels = e.channels ?? ['email'];
    const jobs: Promise<any>[] = [];
    if (e.sponsorId) {
      this.inApp({ sponsorId: e.sponsorId, event: e.event, title: e.title, body: e.body, link: e.link });
      const members = this.db.prepare("SELECT u.email, u.phone FROM sponsor_members m JOIN users u ON u.id = m.user_id WHERE m.sponsor_id = ? AND m.role IN ('owner','admin','finance','marketing')").all(e.sponsorId) as any[];
      const acct = this.db.prepare('SELECT phone FROM sponsor_accounts WHERE id = ?').get(e.sponsorId) as any;
      for (const m of members) if (channels.includes('email') && m.email) jobs.push(this.send({ channel: 'email', to: m.email, subject: e.title, body: `${e.body}${e.link ? `\n\n${e.link}` : ''}`, event: e.event }));
      if (acct?.phone && channels.includes('sms')) jobs.push(this.send({ channel: 'sms', to: acct.phone, body: `${e.title}: ${e.body}`, event: e.event }));
      if (acct?.phone && channels.includes('whatsapp')) jobs.push(this.send({ channel: 'whatsapp', to: acct.phone, body: `${e.title}\n${e.body}`, event: e.event }));
    }
    if (e.orgId) {
      this.inApp({ orgId: e.orgId, event: e.event, title: e.title, body: e.body, link: e.link });
      const admins = this.db.prepare("SELECT email FROM users WHERE org_id = ? AND role IN ('org_admin','tournament_admin')").all(e.orgId) as any[];
      for (const a of admins) if (channels.includes('email')) jobs.push(this.send({ channel: 'email', to: a.email, subject: e.title, body: e.body, event: e.event }));
    }
    await Promise.all(jobs);
  }
}
