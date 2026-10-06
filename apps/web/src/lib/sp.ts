/** Shared helpers for the sponsorship pages (portal, marketplace, console tab, admin). */
import { session, toast } from './api.ts';
import { esc } from './board.ts';

export { esc, toast, session };

const ACCOUNT_KEY = 'sd.sponsor.account';
export const activeAccount = {
  get(): string | null {
    try { return localStorage.getItem(ACCOUNT_KEY); } catch { return null; }
  },
  set(v: string | null) {
    try { v ? localStorage.setItem(ACCOUNT_KEY, v) : localStorage.removeItem(ACCOUNT_KEY); } catch { /* ignore */ }
  },
};

export class SpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) {
    super(message);
  }
}

/** API call carrying the session and the selected sponsor account. 401 → sign-in page. */
export async function spApi<T = any>(method: string, path: string, body?: any, opts: { raw?: Blob | ArrayBuffer; type?: string; loginPath?: string; quiet401?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const acct = activeAccount.get();
  if (acct) headers['x-sponsor-account'] = acct;
  let payload: any;
  if (opts.raw !== undefined) {
    headers['content-type'] = opts.type || 'application/octet-stream';
    payload = opts.raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401 && !path.startsWith('/api/auth/')) {
      session.token = null;
      location.href = `${opts.loginPath ?? '/sponsor'}?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    }
    throw new SpError(res.status, json?.error?.message ?? `Request failed (${res.status})`, json?.error?.code, json?.error?.details);
  }
  return json as T;
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_PAYMENT: 'Payment pending', PAYMENT_RECEIVED: 'Paid', PENDING_APPROVAL: 'Awaiting approval', ASSET_REVIEW: 'Creative review',
  ACTIVE: 'Active', PAUSED: 'Paused', EXPIRED: 'Ended', CANCELLED: 'Cancelled', REFUNDED: 'Refunded',
};
const TONE: Record<string, string> = { ACTIVE: 'ok', PAUSED: 'warn', PENDING_PAYMENT: 'warn', DRAFT: 'quiet', PAYMENT_RECEIVED: 'info', PENDING_APPROVAL: 'info', ASSET_REVIEW: 'info', EXPIRED: 'quiet', CANCELLED: 'bad', REFUNDED: 'quiet' };
export const statusPill = (s: string) => `<span class="sp-status tone-${TONE[s] ?? 'quiet'}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

export const money = (minor: number | null | undefined, currency = 'INR') =>
  minor == null ? '—' : new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
export const num = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
export const date = (d?: string | null) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const title = (s: string) => String(s ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const formData = (f: HTMLFormElement) => Object.fromEntries(new FormData(f).entries()) as Record<string, string>;

/** Add ?v=thumb|screen to a (possibly signed) media URL. */
export const variant = (url: string, v: string) => (url.includes('v=') ? url : `${url}${url.includes('?') ? '&' : '?'}v=${v}`);

export const kpi = (label: string, value: string, hint = '') => `<div class="kpi"><span>${esc(label)}</span><strong>${value}</strong>${hint ? `<small>${hint}</small>` : ''}</div>`;

/** Inline SVG bar chart (no library). */
export function bars(series: { label: string; value: number }[], opts: { height?: number; unit?: string; caption?: string } = {}) {
  if (!series.length) return '<p class="muted">No data yet.</p>';
  const every = Math.max(1, Math.ceil(series.length / 8));
  const h = opts.height ?? 140;
  const max = Math.max(1, ...series.map((s) => s.value));
  const w = Math.max(320, series.length * 26);
  const bw = Math.min(w / series.length, 64);
  const x0 = (w - bw * series.length) / 2;
  return `${opts.caption ? `<p class="chart-cap">${esc(opts.caption)}</p>` : ''}<svg class="chart" viewBox="0 0 ${w} ${h + 22}" role="img" aria-label="${esc(opts.caption ?? 'Chart')}">${series.map((s, i) => {
    const bh = Math.max(1, (s.value / max) * h);
    return `<g><rect x="${x0 + i * bw + 3}" y="${h - bh}" width="${bw - 6}" height="${bh}" rx="3"><title>${esc(s.label)}: ${num(s.value)}${opts.unit ?? ''}</title></rect>${i % every === 0 ? `<text x="${x0 + i * bw + bw / 2}" y="${h + 16}" text-anchor="middle">${esc(s.label)}</text>` : ''}</g>`;
  }).join('')}</svg>`;
}

/** Semicircle gauge for the 0–100 exposure score. */
export function gauge(score: number) {
  const a = Math.PI * (1 - Math.max(0, Math.min(100, score)) / 100);
  const x = 60 + 50 * Math.cos(a);
  const y = 60 - 50 * Math.sin(a);
  return `<svg class="gauge" viewBox="0 0 120 70" role="img" aria-label="Score ${score} of 100"><path d="M10 60 A50 50 0 0 1 110 60" class="g-track"/><path d="M10 60 A50 50 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" class="g-val"/><text x="60" y="58" text-anchor="middle">${score}</text></svg>`;
}

/** Open a stored document (agreement, invoice…) — fetched with auth, shown as HTML or downloaded as PDF. */
export async function openDoc(orderId: string, docId: string, pdf = false) {
  const res = await fetch(`/api/sponsorships/${orderId}/documents/${docId}${pdf ? '?format=pdf' : ''}`, { headers: { authorization: `Bearer ${session.token ?? ''}` } });
  if (!res.ok) return toast('Could not open the document', 'error');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (pdf) {
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]) ?? 'document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Read a file into an ArrayBuffer and upload it as an asset. */
export async function uploadAsset(kind: string, file: File) {
  const buf = await file.arrayBuffer();
  return spApi('POST', `/api/sponsor/assets?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`, undefined, { raw: buf, type: file.type || 'application/octet-stream' });
}

/** A modal sheet built from HTML; resolves when closed. */
export function sheet(html: string, onMount?: (dlg: HTMLDialogElement) => void) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet sp-sheet';
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-close]')) dlg.close();
  });
  onMount?.(dlg);
  dlg.showModal();
  return dlg;
}

/** Stable anonymous id for de-duplicating impressions (no personal data). */
export function viewerId(): string {
  try {
    let v = localStorage.getItem('sd.viewer');
    if (!v) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('sd.viewer', v);
    }
    return v;
  } catch {
    return 'anon' + Math.random().toString(16).slice(2, 14);
  }
}

/** Report which sponsor placements a public page showed (deduplicated server-side). */
export function beacon(ids: string[], page: string) {
  const placements = ids.filter((x) => x && !x.startsWith('legacy:'));
  if (!placements.length) return;
  fetch('/api/sx/impressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ placements, viewer: viewerId(), page }), keepalive: true }).catch(() => {});
}

export const EXPOSURE_LABEL: Record<string, string> = { tv: 'Venue TV', liveScore: 'Live score', broadcast: 'Broadcast', social: 'Social', onsite: 'On-ground', online: 'Online' };
export const exposureChips = (e: Record<string, boolean>) => Object.entries(EXPOSURE_LABEL).filter(([k]) => e?.[k]).map(([, v]) => `<span class="chip">${v}</span>`).join('');
