/**
 * Commercial documents: sponsorship agreement, tax invoice, payment receipt, activation
 * confirmation, asset approval and renewal notice.
 *
 * Each document is built once as a structured model, stored with the order (immutable,
 * hashed), and rendered on demand as HTML (browser / print) or PDF (download, email).
 * The agreement hash is what the sponsor accepts, so later template changes never alter
 * a document someone already signed.
 */
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { id } from '../context.ts';
import type { DB } from '../db.ts';
import { J, P, now } from '../db.ts';

export type DocKind = 'agreement' | 'invoice' | 'receipt' | 'confirmation' | 'asset_approval' | 'renewal' | 'credit_note';

export interface DocModel {
  title: string;
  number?: string;
  date: string;
  parties?: { label: string; lines: string[] }[];
  table?: { cols: string[]; rows: string[][]; align?: ('l' | 'r')[] };
  totals?: [string, string, boolean?][];
  sections?: { heading: string; paragraphs: string[] }[];
  footer?: string[];
}

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Amounts in documents use the ISO code (renders in every PDF font, unambiguous for accounts teams). */
export const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Indian financial year label for a date: Apr–Mar ("2026-27"). */
export function financialYear(d = new Date()) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Gap-free sequence per scope (invoice series must not skip numbers). Call inside a transaction. */
export function nextNumber(db: DB, scope: string): number {
  db.prepare('INSERT INTO sp_counters (scope, value) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET value = value + 1').run(scope);
  return (db.prepare('SELECT value FROM sp_counters WHERE scope = ?').get(scope) as any).value;
}

export function renderHtml(m: DocModel): string {
  const table = m.table
    ? `<table class="items"><thead><tr>${m.table.cols.map((c, i) => `<th class="${m.table!.align?.[i] === 'r' ? 'r' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${m.table.rows
        .map((r) => `<tr>${r.map((c, i) => `<td class="${m.table!.align?.[i] === 'r' ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '';
  const totals = m.totals ? `<table class="totals">${m.totals.map(([k, v, strong]) => `<tr class="${strong ? 'strong' : ''}"><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join('')}</table>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.title)}${m.number ? ' ' + esc(m.number) : ''}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0b1b2b;max-width:820px;margin:32px auto;padding:0 20px}
header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #062547;padding-bottom:12px;margin-bottom:20px}
h1{font-size:22px;margin:0;color:#062547}.meta{text-align:right;color:#475569;font-size:13px}.brand{color:#64C225;font-weight:800;letter-spacing:.02em}
.parties{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:20px}.parties h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin:0 0 4px}
.parties p{margin:0}table{width:100%;border-collapse:collapse}.items th{background:#062547;color:#fff;text-align:left;padding:8px;font-size:12px}.items td{border-bottom:1px solid #e2e8f0;padding:8px}
.r{text-align:right}.totals{width:auto;margin:12px 0 0 auto}.totals td{padding:4px 8px}.totals .strong td{font-weight:800;border-top:2px solid #062547;font-size:16px}
section h2{font-size:15px;color:#062547;margin:20px 0 6px}section p{margin:0 0 8px}footer{margin-top:28px;color:#64748b;font-size:12px;border-top:1px solid #e2e8f0;padding-top:10px}
@media print{body{margin:0}}
</style></head><body>
<header><div><div class="brand">SPORTS DIARY</div><h1>${esc(m.title)}</h1></div><div class="meta">${m.number ? `<div><b>${esc(m.number)}</b></div>` : ''}<div>${esc(m.date)}</div></div></header>
${m.parties ? `<div class="parties">${m.parties.map((p) => `<div><h3>${esc(p.label)}</h3>${p.lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('')}</div>`).join('')}</div>` : ''}
${table}${totals}
${(m.sections ?? []).map((s) => `<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</section>`).join('')}
${m.footer ? `<footer>${m.footer.map((f) => `<div>${esc(f)}</div>`).join('')}</footer>` : ''}
</body></html>`;
}

export function renderPdf(m: DocModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${m.title}${m.number ? ' ' + m.number : ''}`, Author: 'Sports Diary' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 96;
    const navy = '#062547';
    doc.fillColor('#64C225').font('Helvetica-Bold').fontSize(10).text('SPORTS DIARY', 48, 48);
    doc.fillColor(navy).fontSize(18).text(m.title, 48, 62);
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text([m.number, m.date].filter(Boolean).join('\n'), 48, 50, { width: W, align: 'right' });
    doc.moveTo(48, 92).lineTo(48 + W, 92).lineWidth(2).strokeColor(navy).stroke();
    let y = 104;
    if (m.parties?.length) {
      const colW = W / m.parties.length;
      let maxH = 0;
      m.parties.forEach((p, i) => {
        const x = 48 + i * colW;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text(p.label.toUpperCase(), x, y, { width: colW - 10 });
        doc.font('Helvetica').fontSize(9.5).fillColor('#0b1b2b').text(p.lines.filter(Boolean).join('\n'), x, y + 12, { width: colW - 10 });
        maxH = Math.max(maxH, doc.y - y);
      });
      y += maxH + 14;
    }
    if (m.table) {
      const n = m.table.cols.length;
      const widths = m.table.cols.map((_, i) => (i === 0 ? W * 0.46 : (W * 0.54) / (n - 1)));
      const xs = widths.map((_, i) => 48 + widths.slice(0, i).reduce((a, b) => a + b, 0));
      doc.rect(48, y, W, 18).fill(navy);
      m.table.cols.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff').text(c, xs[i] + 4, y + 5, { width: widths[i] - 8, align: m.table!.align?.[i] === 'r' ? 'right' : 'left' }));
      y += 22;
      for (const r of m.table.rows) {
        let h = 0;
        r.forEach((c, i) => {
          doc.font('Helvetica').fontSize(9).fillColor('#0b1b2b').text(c, xs[i] + 4, y, { width: widths[i] - 8, align: m.table!.align?.[i] === 'r' ? 'right' : 'left' });
          h = Math.max(h, doc.y - y);
        });
        y += h + 6;
        doc.moveTo(48, y - 3).lineTo(48 + W, y - 3).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
        if (y > doc.page.height - 120) (doc.addPage(), (y = 48));
      }
    }
    if (m.totals) {
      y += 4;
      for (const [k, v, strong] of m.totals) {
        doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11 : 9.5).fillColor('#0b1b2b');
        doc.text(k, 48 + W * 0.45, y, { width: W * 0.3, align: 'right' });
        doc.text(v, 48 + W * 0.75, y, { width: W * 0.25, align: 'right' });
        y = doc.y + 3;
      }
    }
    doc.x = 48;
    doc.y = y + 10;
    for (const s of m.sections ?? []) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).fillColor(navy).text(s.heading, 48, doc.y + 6, { width: W });
      for (const p of s.paragraphs) doc.font('Helvetica').fontSize(9.5).fillColor('#0b1b2b').text(p, { width: W, paragraphGap: 4 });
    }
    if (m.footer) {
      doc.moveDown();
      doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(m.footer.join('\n'), 48, doc.y + 8, { width: W });
    }
    doc.end();
  });
}

export class Documents {
  constructor(private db: DB) {}

  /** Store an immutable document for an order. Returns its id and hash. */
  store(orderId: string, kind: DocKind, model: DocModel) {
    const html = renderHtml(model);
    const did = id();
    const version = ((this.db.prepare('SELECT MAX(version) AS v FROM sp_documents WHERE order_id = ? AND kind = ?').get(orderId, kind) as any)?.v ?? 0) + 1;
    this.db.prepare('INSERT INTO sp_documents (id, order_id, kind, version, body_html, sha256, model, created_at) VALUES (?,?,?,?,?,?,?,?)').run(did, orderId, kind, version, html, sha(html), J(model), now());
    return { id: did, sha256: sha(html), version };
  }

  list(orderId: string) {
    return (this.db.prepare('SELECT id, kind, version, sha256, accepted_by, accepted_at, created_at FROM sp_documents WHERE order_id = ? ORDER BY created_at').all(orderId) as any[]).map((d) => ({
      id: d.id, kind: d.kind, version: d.version, sha256: d.sha256, acceptedAt: d.accepted_at, createdAt: d.created_at,
    }));
  }

  get(orderId: string, docId: string) {
    const d = this.db.prepare('SELECT * FROM sp_documents WHERE id = ? AND order_id = ?').get(docId, orderId) as any;
    if (!d) return null;
    return { ...d, model: P<DocModel>(d.model, null as any) };
  }

  latest(orderId: string, kind: DocKind) {
    return this.db.prepare('SELECT * FROM sp_documents WHERE order_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(orderId, kind) as any;
  }

  /** Digital acceptance: who, when, from where, and exactly which bytes. */
  accept(orderId: string, userId: string, ip: string, sha256?: string) {
    const d = this.latest(orderId, 'agreement');
    if (!d) throw new Error('No agreement for order');
    if (sha256 && sha256 !== d.sha256) return { ok: false as const, reason: 'The agreement changed. Review it again.' };
    if (!d.accepted_at) this.db.prepare('UPDATE sp_documents SET accepted_by = ?, accepted_at = ?, accepted_ip = ? WHERE id = ?').run(userId, now(), ip.slice(0, 64), d.id);
    return { ok: true as const, sha256: d.sha256 };
  }
}

// ---------------------------------------------------------------- builders

export interface OrderDocContext {
  order: any; // sp_orders row
  opportunity: any;
  packageName: string;
  items: { label: string; quantity: number; scope: string; deliverable: boolean }[];
  seller: { legalName: string | null; gstin: string | null; address: string | null; state: string | null };
  buyer: { name: string; legalName?: string | null; taxId?: string | null; address?: string | null; state?: string | null; country?: string | null; email?: string | null };
  approvalMode: string;
}

const dateOnly = (iso: string) => iso.slice(0, 10);

export function agreementModel(c: OrderDocContext): DocModel {
  const o = c.order;
  return {
    title: 'Sponsorship Agreement',
    number: o.number,
    date: dateOnly(o.created_at),
    parties: [
      { label: 'Organizer', lines: [c.seller.legalName ?? '', c.seller.address ?? '', c.seller.gstin ? `GSTIN ${c.seller.gstin}` : ''] },
      { label: 'Sponsor', lines: [c.buyer.legalName ?? c.buyer.name, c.buyer.address ?? '', c.buyer.taxId ? `Tax ID ${c.buyer.taxId}` : '', c.buyer.email ?? ''] },
      { label: 'Platform', lines: ['Sports Diary marketplace', 'Facilitates listing, payment and delivery tracking'] },
    ],
    table: { cols: ['Benefit', 'Qty', 'Scope'], rows: c.items.map((i) => [`${i.label}${i.deliverable ? ' (delivered by organizer, with proof)' : ''}`, String(i.quantity), i.scope]), align: ['l', 'r', 'l'] },
    totals: [
      ['Sponsorship fee', money(o.subtotal_minor, o.currency)],
      ...(o.platform_fee_minor ? ([['Platform fee', money(o.platform_fee_minor, o.currency)]] as [string, string][]) : []),
      [o.tax_minor ? `Tax (${o.tax_rate_bps / 100}%)` : 'Tax', money(o.tax_minor, o.currency)],
      ['Total payable', money(o.total_minor, o.currency), true],
    ],
    sections: [
      { heading: '1. Sponsorship', paragraphs: [`The Organizer grants the Sponsor the "${c.packageName}" package for "${c.opportunity.title}" from ${o.starts_on} to ${o.ends_on}, comprising the benefits listed above.`] },
      { heading: '2. Payment', paragraphs: ['The sponsorship becomes effective only after the payment is confirmed by the payment provider to the platform (server-side verification). A payment shown as successful in a browser is not, by itself, confirmation.', `Inventory is held for the Sponsor until ${o.hold_expires_at ? o.hold_expires_at.replace('T', ' ').slice(0, 16) + ' UTC' : 'payment'}; after that it may be released to other sponsors.`] },
      { heading: '3. Approval and assets', paragraphs: [c.approvalMode === 'auto' ? 'This opportunity activates automatically once payment is confirmed, using assets that pass the platform checks.' : c.approvalMode === 'manual' ? 'The Organizer reviews and approves the sponsorship after payment. If it is declined, the full amount is refunded.' : 'The Organizer reviews every asset before it is displayed. Rejected assets must be replaced; if the sponsorship is declined, the full amount is refunded.', 'The Sponsor warrants that it owns or is licensed to use all logos, images, videos and copy it supplies, and that they do not promote prohibited products or contain unlawful content.'] },
      { heading: '4. Delivery', paragraphs: ['Digital placements (screens, live score pages, overlays, banners, QR) are activated automatically by the platform and measured by it. Physical and social media benefits are delivered by the Organizer, who records proof of delivery visible to the Sponsor.', 'Audience figures quoted by the Organizer are estimates. Exposure statistics reported by the platform are measured from screens and pages served by Sports Diary.'] },
      { heading: '5. Cancellation and refunds', paragraphs: ['Before activation the Sponsor may cancel for a full refund. After activation, refunds are at the Organizer\'s discretion and may be partial (pro-rated for the unused period). Refunds are returned to the original payment method through the payment provider.'] },
      { heading: '6. Renewal', paragraphs: [o.auto_renew ? 'Auto-renewal is ON: the platform will create a renewal at the then-current price before expiry and charge the saved payment method or send a payment link. Reminders are sent 30, 14, 7 and 1 day(s) before expiry. Auto-renewal can be turned off at any time before renewal.' : 'Auto-renewal is OFF. Renewal reminders are sent before expiry.'] },
      { heading: '7. Acceptance', paragraphs: ['This agreement is accepted electronically by an authorised member of the Sponsor account when proceeding to payment. The platform records the person, time, IP address and a SHA-256 hash of this document.'] },
    ],
    footer: [`Order ${o.number}`, 'Governing law: India, unless the parties agree otherwise in writing.'],
  };
}

/** GST split: intra-state → CGST + SGST; inter-state → IGST; export / non-INR → zero-rated. */
export function taxLines(o: any, sellerState: string | null, buyerState: string | null, buyerCountry: string | null): [string, number][] {
  if (!o.tax_minor) return [[buyerCountry && buyerCountry !== 'India' ? 'IGST 0% (zero-rated export of services)' : 'Tax', 0]];
  const rate = o.tax_rate_bps / 100;
  if (sellerState && buyerState && sellerState.trim().toLowerCase() === buyerState.trim().toLowerCase()) {
    const half = Math.floor(o.tax_minor / 2);
    return [[`CGST ${rate / 2}%`, half], [`SGST ${rate / 2}%`, o.tax_minor - half]];
  }
  return [[`IGST ${rate}%`, o.tax_minor]];
}

export function invoiceModel(c: OrderDocContext, number: string, payment: { provider: string; providerPaymentId: string | null; method: string | null; capturedAt: string }): DocModel {
  const o = c.order;
  const taxes = taxLines(o, c.seller.state, c.buyer.state ?? null, c.buyer.country ?? null);
  return {
    title: 'Tax Invoice',
    number,
    date: dateOnly(payment.capturedAt),
    parties: [
      { label: 'Supplier', lines: [c.seller.legalName ?? '', c.seller.address ?? '', c.seller.state ? `State: ${c.seller.state}` : '', c.seller.gstin ? `GSTIN ${c.seller.gstin}` : 'GSTIN not registered'] },
      { label: 'Recipient', lines: [c.buyer.legalName ?? c.buyer.name, c.buyer.address ?? '', c.buyer.state ? `State: ${c.buyer.state}` : '', c.buyer.country ?? '', c.buyer.taxId ? `GSTIN/Tax ID ${c.buyer.taxId}` : ''] },
    ],
    table: {
      cols: ['Description', 'SAC', 'Period', 'Amount'],
      rows: [
        [`${c.packageName} — ${c.opportunity.title}`, '998397', `${o.starts_on} to ${o.ends_on}`, money(o.subtotal_minor, o.currency)],
        ...(o.platform_fee_minor ? [['Platform service fee', '998399', '', money(o.platform_fee_minor, o.currency)]] : []),
      ],
      align: ['l', 'l', 'l', 'r'],
    },
    totals: [['Taxable value', money(o.subtotal_minor + o.platform_fee_minor, o.currency)], ...taxes.map(([k, v]) => [k, money(v, o.currency)] as [string, string]), ['Total', money(o.total_minor, o.currency), true]],
    sections: [{ heading: 'Payment', paragraphs: [`Paid ${money(o.total_minor, o.currency)} via ${payment.provider}${payment.method ? ` (${payment.method})` : ''} on ${payment.capturedAt.replace('T', ' ').slice(0, 16)} UTC. Reference ${payment.providerPaymentId ?? '—'}.`, `Order ${o.number}.`] }],
    footer: ['SAC 998397: Sponsorship services. This is a computer-generated invoice and does not require a signature.'],
  };
}

export function receiptModel(c: OrderDocContext, number: string, payment: { provider: string; providerPaymentId: string | null; method: string | null; capturedAt: string }): DocModel {
  const o = c.order;
  return {
    title: 'Payment Receipt',
    number,
    date: dateOnly(payment.capturedAt),
    parties: [{ label: 'Received from', lines: [c.buyer.legalName ?? c.buyer.name, c.buyer.email ?? ''] }, { label: 'On behalf of', lines: [c.seller.legalName ?? ''] }],
    totals: [['Amount received', money(o.total_minor, o.currency), true]],
    sections: [{ heading: 'Details', paragraphs: [`For ${c.packageName} — ${c.opportunity.title}. Order ${o.number}.`, `Method: ${payment.method ?? payment.provider}. Provider reference: ${payment.providerPaymentId ?? '—'}.`] }],
  };
}

export function confirmationModel(c: OrderDocContext, placements: { surface: string; scope: string }[], deliverables: string[]): DocModel {
  const o = c.order;
  return {
    title: 'Sponsorship Confirmation',
    number: o.number,
    date: dateOnly(now()),
    parties: [{ label: 'Sponsor', lines: [c.buyer.legalName ?? c.buyer.name] }, { label: 'Organizer', lines: [c.seller.legalName ?? ''] }],
    table: placements.length ? { cols: ['Live placement', 'Where'], rows: placements.map((p) => [p.surface, p.scope]) } : undefined,
    sections: [
      { heading: 'Status', paragraphs: [`${c.packageName} for "${c.opportunity.title}" is ACTIVE from ${o.starts_on} to ${o.ends_on}. Your branding is now shown automatically on the placements above.`] },
      ...(deliverables.length ? [{ heading: 'Organizer deliverables', paragraphs: [`These are delivered by the organizer and tracked with proof in your dashboard: ${deliverables.join(', ')}.`] }] : []),
    ],
  };
}

export function noticeModel(title: string, number: string, paragraphs: string[]): DocModel {
  return { title, number, date: dateOnly(now()), sections: [{ heading: title, paragraphs }] };
}

