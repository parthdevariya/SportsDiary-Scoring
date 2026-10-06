/** Platform administration (/admin): sponsors, orders & risk, moderation, settings, payouts, webhooks, outbox, audit. */
import { logo } from './lib/brand.ts';
import { date, dateTime, esc, formData, kpi, num, session, spApi, statusPill, title, toast } from './lib/sp.ts';

const app = document.getElementById('app')!;
const NAV: [string, string][] = [['', 'Overview'], ['sponsors', 'Sponsors'], ['orders', 'Orders & risk'], ['moderation', 'Moderation'], ['payouts', 'Payouts'], ['settings', 'Settings'], ['organizers', 'Organizer terms'], ['webhooks', 'Webhooks'], ['outbox', 'Messages'], ['audit', 'Audit log']];
const api = (m: string, p: string, b?: any) => spApi(m, p, b, { loginPath: '/sponsor' });

function shell(active: string, body: string) {
  document.body.className = 'console admin';
  app.innerHTML = `<div class="shell"><aside class="nav">${logo()}<p class="org-name">Platform admin</p>
    <nav>${NAV.map(([id, l]) => `<a href="#${id}" class="${id === active ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div class="nav-foot"><button class="link" id="logout">Sign out</button></div></aside><main class="main" id="main">${body}</main></div>`;
  document.getElementById('logout')!.addEventListener('click', () => ((session.token = null), (location.href = '/')));
}

async function route() {
  const [page, id] = location.hash.slice(1).split('?')[0].split('/');
  try {
    if (page === 'sponsors') return await sponsors();
    if (page === 'orders') return id ? await order(id) : await orders();
    if (page === 'moderation') return await moderation();
    if (page === 'payouts') return await payouts();
    if (page === 'settings') return await settings();
    if (page === 'organizers') return await organizers();
    if (page === 'webhooks') return await webhooks();
    if (page === 'outbox') return await outbox();
    if (page === 'audit') return await audit();
    return await overview();
  } catch (e: any) {
    if (e.status === 403) {
      app.innerHTML = `<div class="empty"><h1>Platform administrators only</h1><p>This account isn't a platform administrator. Admins are configured with <code>PLATFORM_ADMIN_EMAILS</code>.</p><p><a href="/">Home</a></p></div>`;
      return;
    }
    toast(e.message, 'error');
  }
}

const counts = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `<span class="chip">${esc(title(k))}: ${num(v)}</span>`).join(' ') || '—';

async function overview() {
  const o = await api('GET', '/api/admin/overview');
  shell('', `<header class="page-head"><h1>Marketplace overview</h1><button class="btn" id="jobs">Run scheduled jobs now</button></header>
    <div class="kpis">${kpi('GMV', o.gmv.map((g: any) => esc(g.amount)).join('<br>') || '—')}${kpi('Platform revenue', o.platformRevenue.map((g: any) => esc(g.amount)).join('<br>') || '—', 'commission + fees')}${kpi('Live opportunities', num(o.opportunities))}${kpi('Flagged creative', num(o.flaggedAssets), '<a href="#moderation">Review</a>')}${kpi('Risk-flagged orders', num(o.riskOrders), '<a href="#orders">Review</a>')}${kpi('Rejected webhooks (24h)', num(o.webhooksRejected24h), '<a href="#webhooks">Inspect</a>')}</div>
    <div class="two-col"><div class="card"><h2>Sponsors</h2><p>${counts(o.sponsors)}</p><h2>Orders</h2><p>${counts(o.orders)}</p><h2>Messages</h2><p>${counts(o.outbox)}</p></div>
    <div class="card"><h2>Payment providers</h2><table class="table"><tbody>${o.providers.map((p: any) => `<tr><td>${esc(title(p.id))}</td><td>${p.configured ? '<span class="sp-status tone-ok">Configured</span>' : '<span class="sp-status tone-quiet">Not configured</span>'}</td><td>${p.id === 'sandbox' ? (p.configured ? 'Test mode (disabled in production)' : '') : p.live ? 'Live keys' : p.configured ? 'Test keys' : ''}</td></tr>`).join('')}</tbody></table>
      <h2>Payouts due</h2>${o.settlements.length ? `<ul>${o.settlements.map((s: any) => `<li>${esc(s.organizer)} — ${esc(s.amount)} (${s.orders} orders)</li>`).join('')}</ul><a href="#payouts">Settle →</a>` : '<p class="muted">Nothing due.</p>'}</div></div>`);
  document.getElementById('jobs')!.addEventListener('click', async () => {
    const r = await api('POST', '/api/admin/jobs/run', {});
    toast(`Holds released ${r.holdsReleased} · expired ${r.expired} · reminders ${r.reminders} · renewals ${r.renewals} · auctions closed ${r.auctionsClosed}`);
  });
}

async function sponsors() {
  const status = new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') ?? '';
  const list = await api('GET', `/api/admin/sponsors${status ? `?status=${status}` : ''}`);
  shell('sponsors', `<header class="page-head"><h1>Sponsors</h1></header>
    <nav class="filter-tabs">${['', 'pending', 'active', 'suspended', 'rejected'].map((s) => `<a href="#sponsors${s ? `?status=${s}` : ''}" class="${s === status ? 'on' : ''}">${s ? title(s) : 'All'}</a>`).join('')}</nav>
    <div class="card"><table class="table"><thead><tr><th>Sponsor</th><th>Category</th><th>Contact</th><th>Orders</th><th>Status</th><th></th></tr></thead><tbody>${list.map((s: any) => `<tr><td><strong>${esc(s.name)}</strong><br><small class="muted">${esc(s.kind)} · since ${date(s.createdAt)}${s.taxId ? ` · ${esc(s.taxId)}` : ''}</small></td><td>${esc(s.category)}${s.industry ? `<br><small>${esc(title(s.industry))}</small>` : ''}</td><td>${esc(s.email ?? '')}<br><small>${esc(s.phone ?? '')}</small></td><td>${s.orders} · ${s.members} member${s.members === 1 ? '' : 's'}</td><td>${esc(title(s.status))}${s.statusReason ? `<br><small class="muted">${esc(s.statusReason)}</small>` : ''}</td>
      <td class="row-actions">${s.status !== 'active' ? `<button class="btn btn-small" data-st="active" data-id="${esc(s.id)}">Approve</button>` : `<button class="btn btn-small btn-danger" data-st="suspended" data-id="${esc(s.id)}">Suspend</button>`}${s.status === 'pending' ? `<button class="btn btn-small" data-st="rejected" data-id="${esc(s.id)}">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-st]');
    if (!b) return;
    const reason = b.dataset.st === 'active' ? '' : prompt('Reason (shown to the sponsor)') ?? '';
    if (b.dataset.st !== 'active' && !reason) return;
    await api('POST', `/api/admin/sponsors/${b.dataset.id}/status`, { status: b.dataset.st, reason }).catch((x) => toast(x.message, 'error'));
    route();
  });
}

async function orders() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const list = await api('GET', `/api/admin/orders?${q.toString()}`);
  shell('orders', `<header class="page-head"><h1>Orders</h1></header>
    <nav class="filter-tabs"><a href="#orders" class="${!q.toString() ? 'on' : ''}">All</a><a href="#orders?risk=1" class="${q.get('risk') ? 'on' : ''}">Risk flags</a>${['PENDING_PAYMENT', 'PENDING_APPROVAL', 'ACTIVE', 'CANCELLED', 'REFUNDED'].map((s) => `<a href="#orders?status=${s}" class="${q.get('status') === s ? 'on' : ''}">${title(s.toLowerCase())}</a>`).join('')}</nav>
    <div class="card"><table class="table"><thead><tr><th>Order</th><th>Sponsor → Organizer</th><th>Status</th><th>Risk</th><th class="r">Total</th></tr></thead><tbody>${list.map((o: any) => `<tr><td><a href="#orders/${esc(o.id)}">${esc(o.number)}</a><br><small class="muted">${esc(o.opportunity)} · ${dateTime(o.createdAt)}</small></td><td>${esc(o.sponsor)}<br><small class="muted">${esc(o.organizer)}</small></td><td>${statusPill(o.status)}</td><td>${o.risk.map((r: string) => `<span class="sp-status tone-bad">${esc(title(r))}</span>`).join(' ')}</td><td class="r">${esc(o.total)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>'}</tbody></table></div>`);
}

async function order(id: string) {
  const o = await api('GET', `/api/admin/orders/${id}`);
  shell('orders', `<a class="crumb" href="#orders">← Orders</a><header class="page-head"><div><h1>${esc(o.number)}</h1><p class="muted">${esc(o.sponsor.name)} → ${esc(o.organizer)} · ${esc(o.opportunity.title)}</p></div><div class="head-actions">${statusPill(o.status)}</div></header>
    ${o.risk.length ? `<div class="card notice bad"><strong>Risk flags:</strong> ${o.risk.map((r: string) => esc(title(r))).join(', ')} <button class="btn btn-small" data-a="clear-risk">Clear after review</button></div>` : ''}
    <div class="two-col"><div class="card"><h2>Money</h2><dl class="dl"><dt>Total</dt><dd>${esc(o.amounts.total)}</dd><dt>Commission</dt><dd>${(o.commissionBps / 100).toFixed(2)}% = ${esc(new Intl.NumberFormat('en-IN', { style: 'currency', currency: o.currency }).format(o.commissionMinor / 100))}</dd><dt>Refundable</dt><dd>${esc(new Intl.NumberFormat('en-IN', { style: 'currency', currency: o.currency }).format(o.refundableMinor / 100))}</dd></dl>
      <table class="table"><tbody>${o.payments.map((p: any) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.amount)}</td><td>${esc(p.status)}</td><td><code>${esc(p.reference ?? '')}</code></td></tr>`).join('')}</tbody></table>
      <div class="row-actions">${o.refundableMinor ? '<button class="btn" data-a="refund">Refund…</button>' : ''}${o.status === 'ACTIVE' ? '<button class="btn" data-a="pause">Pause</button>' : ''}${o.status === 'PAUSED' ? '<button class="btn" data-a="resume">Resume</button>' : ''}${!['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status) ? '<button class="btn btn-danger" data-a="cancel">Cancel</button>' : ''}</div></div>
    <div class="card"><h2>Timeline</h2><ol class="events">${o.events.map((e: any) => `<li><time>${dateTime(e.at)}</time> ${esc(e.to)} <small class="muted">(${esc(e.actor)})</small>${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('')}</ol></div></div>`);
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      if (a === 'clear-risk') await api('POST', `/api/admin/sponsorships/${id}/clear-risk`, { note: prompt('Review note') ?? '' });
      if (a === 'refund') {
        const amount = prompt('Amount to refund (blank = everything refundable)') ?? null;
        if (amount === null) return;
        await api('POST', `/api/admin/sponsorships/${id}/refund`, { amount: amount || undefined, reason: prompt('Reason') || 'Platform refund' });
      }
      if (a === 'pause' || a === 'resume') await api('POST', `/api/admin/sponsorships/${id}/${a}`, { reason: 'Platform action' });
      if (a === 'cancel' && confirm('Cancel this sponsorship? Paid orders are refunded pro-rata.')) await api('POST', `/api/admin/sponsorships/${id}/cancel`, { reason: prompt('Reason') || 'Cancelled by platform' });
      toast('Done');
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function moderation() {
  const m = await api('GET', '/api/admin/moderation');
  shell('moderation', `<header class="page-head"><h1>Moderation</h1></header>
    <div class="card"><h2>Flagged creative</h2>${m.flagged.length ? `<div class="asset-grid">${m.flagged.map((a: any) => `<figure class="asset flagged">${a.kind === 'ad_copy' ? `<blockquote>${esc(a.text)}</blockquote>` : `<img src="${esc(a.variants.thumb?.url ?? '')}" alt="">`}<figcaption><strong>${esc(a.sponsor)}</strong><small>${esc(a.reviewNote ?? '')}</small><span><button class="btn btn-small" data-mod="clear" data-id="${esc(a.id)}">Allow</button> <button class="btn btn-small btn-danger" data-mod="block" data-id="${esc(a.id)}">Block</button></span></figcaption></figure>`).join('')}</div>` : '<p class="muted">Nothing waiting.</p>'}</div>
    <div class="card"><h2>Compliance log</h2><table class="table"><thead><tr><th>When</th><th>Subject</th><th>Action</th><th>Reason / note</th></tr></thead><tbody>${m.log.map((l: any) => `<tr><td>${dateTime(l.at)}</td><td>${esc(l.subject_type)} <code>${esc(l.subject_id.slice(0, 12))}</code></td><td>${esc(l.action)}</td><td>${esc(l.reason ?? '')} ${esc(l.note ?? '')}</td></tr>`).join('')}</tbody></table></div>`);
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mod]');
    if (!b) return;
    await api('POST', `/api/admin/assets/${b.dataset.id}/moderate`, { action: b.dataset.mod, reason: b.dataset.mod === 'block' ? prompt('Policy reason', 'prohibited content') ?? 'policy' : 'reviewed' }).catch((x) => toast(x.message, 'error'));
    route();
  });
}

async function payouts() {
  const s = await api('GET', '/api/admin/settlements');
  shell('payouts', `<header class="page-head"><div><h1>Organizer payouts</h1><p class="muted">Money collected on the platform's gateway account, owed to organizers after commission. Organizers using their own gateway keys are paid directly by the gateway.</p></div></header>
    <div class="card"><h2>Due</h2>${s.due.length ? `<table class="table"><tbody>${s.due.map((d: any) => `<tr><td>${esc(d.organizer)}</td><td>${d.orders} orders</td><td class="r">${esc(d.amount)}</td><td><button class="btn btn-small btn-primary" data-settle="${esc(d.orgId)}" data-cur="${esc(d.currency)}">Create payout</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing due.</p>'}</div>
    <div class="card"><h2>History</h2><table class="table"><thead><tr><th>Created</th><th>Organizer</th><th class="r">Amount</th><th>Status</th><th>Reference</th><th></th></tr></thead><tbody>${s.history.map((h: any) => `<tr><td>${dateTime(h.created_at)}</td><td>${esc(h.organizer)}</td><td class="r">${esc(h.amount)}</td><td>${esc(h.status)}</td><td>${esc(h.reference ?? '')}</td><td>${h.status !== 'paid' ? `<button class="btn btn-small" data-paid="${esc(h.id)}">Mark paid</button>` : dateTime(h.paid_at)}</td></tr>`).join('')}</tbody></table></div>`);
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    try {
      if (el.dataset.settle) await api('POST', '/api/admin/settlements', { orgId: el.dataset.settle, currency: el.dataset.cur });
      if (el.dataset.paid) {
        const ref = prompt('Bank / UTR reference of the transfer');
        if (!ref) return;
        await api('POST', `/api/admin/settlements/${el.dataset.paid}/paid`, { reference: ref });
      }
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function settings() {
  const { settings: s } = await api('GET', '/api/admin/settings');
  shell('settings', `<header class="page-head"><h1>Marketplace settings</h1></header>
    <form class="card form-grid" id="f">
      <label>Commission (%)<input name="commission" type="number" step="0.01" min="0" max="50" value="${s.commissionBps / 100}"></label>
      <label>Platform fee per order (₹)<input name="platformFee" type="number" step="1" min="0" value="${s.platformFeeMinor / 100}"></label>
      <label>GST / tax rate (%)<input name="taxRate" type="number" step="0.01" min="0" max="50" value="${s.taxRateBps / 100}"></label>
      <label>Featured listing fee (₹)<input name="featuredFee" type="number" step="1" min="0" value="${s.featuredFeeMinor / 100}"></label>
      <label>New sponsor accounts<select name="sponsorApproval"><option value="auto" ${s.sponsorApproval === 'auto' ? 'selected' : ''}>Active immediately</option><option value="manual" ${s.sponsorApproval === 'manual' ? 'selected' : ''}>Need platform approval</option></select></label>
      <label>Default payment provider<select name="defaultProvider">${['sandbox', 'razorpay', 'cashfree', 'stripe'].map((p) => `<option ${s.defaultProvider === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label>Inventory hold while paying (minutes)<input name="holdMinutes" type="number" min="5" max="1440" value="${s.holdMinutes}"></label>
      <label>Max orders per sponsor per hour<input name="maxOrdersPerHour" type="number" min="1" value="${s.maxOrdersPerHour}"></label>
      <label class="wide">Renewal reminder days<input name="renewalReminderDays" value="${esc(s.renewalReminderDays.join(', '))}"></label>
      <label class="wide">Prohibited sponsor categories<input name="prohibitedCategories" value="${esc(s.prohibitedCategories.join(', '))}"></label>
      <fieldset class="wide"><legend>Indicative exchange rates (1 INR =) — display only, sponsors are charged in the listing currency</legend><div class="form-grid">${Object.entries(s.fxRatesPerINR).map(([c, v]) => `<label>${c}<input name="fx_${c}" type="number" step="0.00001" value="${v}"></label>`).join('')}</div></fieldset>
      <div class="form-actions"><button class="btn btn-primary">Save settings</button></div></form>`);
  app.querySelector('#f')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target as HTMLFormElement);
    const fx = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('fx_')).map(([k, v]) => [k.slice(3), Number(v)]));
    try {
      await api('PATCH', '/api/admin/settings', {
        commissionBps: Math.round(Number(d.commission) * 100), platformFeeMinor: Math.round(Number(d.platformFee) * 100), taxRateBps: Math.round(Number(d.taxRate) * 100), featuredFeeMinor: Math.round(Number(d.featuredFee) * 100),
        sponsorApproval: d.sponsorApproval, defaultProvider: d.defaultProvider, holdMinutes: Number(d.holdMinutes), maxOrdersPerHour: Number(d.maxOrdersPerHour), renewalReminderDays: d.renewalReminderDays, prohibitedCategories: d.prohibitedCategories, fxRatesPerINR: fx,
      });
      toast('Saved');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function organizers() {
  const list = await api('GET', '/api/admin/orgs');
  shell('organizers', `<header class="page-head"><div><h1>Organizer terms</h1><p class="muted">Override commission or fees for a specific organizer (white-label partners, early adopters). Blank = platform default.</p></div></header>
    <div class="card"><table class="table"><thead><tr><th>Organizer</th><th>Listings</th><th>Provider</th><th>Commission %</th><th>Fee ₹</th><th>Marketplace</th><th></th></tr></thead><tbody>${list.map((o: any) => `<tr data-org="${esc(o.id)}"><td>${esc(o.name)}</td><td>${o.opportunities}</td><td>${esc(o.provider)}</td><td><input name="c" type="number" step="0.01" value="${o.commissionBps / 100}" style="width:7em"></td><td><input name="f" type="number" value="${o.platformFeeMinor / 100}" style="width:7em"></td><td><input name="m" type="checkbox" ${o.marketplaceEnabled ? 'checked' : ''}></td><td><button class="btn btn-small" data-save>Save</button></td></tr>`).join('')}</tbody></table></div>`);
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-save]')?.closest('tr') as HTMLElement | null;
    if (!tr) return;
    const v = (n: string) => tr.querySelector<HTMLInputElement>(`input[name="${n}"]`)!;
    try {
      await api('PUT', `/api/admin/orgs/${tr.dataset.org}/sponsorship-settings`, { commissionBps: v('c').value === '' ? null : Math.round(Number(v('c').value) * 100), platformFeeMinor: v('f').value === '' ? null : Math.round(Number(v('f').value) * 100), marketplaceEnabled: v('m').checked });
      toast('Saved');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function webhooks() {
  const w = await api('GET', '/api/admin/webhooks');
  shell('webhooks', `<header class="page-head"><h1>Payment webhooks</h1></header>
    <div class="card"><h2>Rejected (bad signature or payload)</h2>${w.rejected.length ? `<table class="table"><tbody>${w.rejected.map((r: any) => `<tr><td>${dateTime(r.at)}</td><td>${esc(r.provider)}</td><td><code>${esc(r.data)}</code></td></tr>`).join('')}</tbody></table>` : '<p class="muted">None.</p>'}</div>
    <div class="card"><h2>Processed events</h2><table class="table"><thead><tr><th>Received</th><th>Provider</th><th>Event</th><th>Type</th><th>Result</th></tr></thead><tbody>${w.events.map((e: any) => `<tr><td>${dateTime(e.received_at)}</td><td>${esc(e.provider)}</td><td><code>${esc(e.event_id.slice(0, 28))}</code></td><td>${esc(e.type)}</td><td>${esc(e.result ?? 'processing')}</td></tr>`).join('')}</tbody></table></div>`);
}

async function outbox() {
  const list = await api('GET', '/api/admin/outbox');
  shell('outbox', `<header class="page-head"><div><h1>Messages</h1><p class="muted">Every email, SMS and WhatsApp message. “Logged” means no provider is configured for that channel (set RESEND_API_KEY / TWILIO_*).</p></div></header>
    <div class="card"><table class="table"><thead><tr><th>When</th><th>Channel</th><th>To</th><th>Subject / body</th><th>Status</th></tr></thead><tbody>${list.map((m: any) => `<tr><td>${dateTime(m.created_at)}</td><td>${esc(m.channel)}</td><td>${esc(m.destination)}</td><td><strong>${esc(m.subject ?? m.event ?? '')}</strong><br><small class="muted">${esc(String(m.body).replace(/\b\d{6}\b/g, '••••••').slice(0, 160))}</small></td><td>${esc(m.status)}${m.error ? `<br><small class="muted">${esc(m.error)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
}

async function audit() {
  const list = await api('GET', '/api/admin/audit');
  shell('audit', `<header class="page-head"><h1>Audit log</h1></header><div class="card"><table class="table"><tbody>${list.map((a: any) => `<tr><td>${dateTime(a.at)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.entity ?? '')} ${esc((a.entity_id ?? '').slice(0, 12))}</td><td><small class="muted">${esc((a.data ?? '').slice(0, 160))}</small></td></tr>`).join('')}</tbody></table></div>`);
}

if (!session.token) location.href = '/sponsor?next=/admin';
else {
  window.addEventListener('hashchange', route);
  route();
}
