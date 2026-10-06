/**
 * Organizer console → Sponsorships: revenue dashboard and pipeline, opportunities and
 * packages, orders (approval, creative review, deliverables, refunds), offers/RFPs,
 * inventory and payment settings.
 */
import { bars, date, dateTime, esc, exposureChips, formData, kpi, money, num, openDoc, sheet, spApi, statusPill, title, toast, STATUS_LABEL } from './lib/sp.ts';

type Shell = (active: string, body: string) => void;
let shell: Shell;
let meta: any = null;
const api = (m: string, p: string, b?: any) => spApi(m, p, b, { loginPath: '/console' });
const KEYWORDS = new Set(['opps', 'opp', 'orders', 'inventory', 'settings', 'new']);

const subnav = (active: string) => `<nav class="filter-tabs sub">${[['', 'Overview'], ['opps', 'Opportunities'], ['orders', 'Sponsorships'], ['deals', 'Offers & RFPs'], ['inventory', 'Inventory'], ['settings', 'Payments & invoicing']].map(([id, l]) => `<a href="#${id === 'deals' ? 'deals' : `sponsorships${id ? `/${id}` : ''}`}" class="${active === id ? 'on' : ''}">${l}</a>`).join('')}</nav>`;

export async function pageSponsorships(sh: Shell, hash: string) {
  shell = sh;
  meta ??= await api('GET', '/api/sponsorship-meta');
  const [page, a, b] = hash.split('?')[0].split('/');
  if (page === 'deals') return a ? deal(a) : deals();
  if (!a) return overview();
  if (a === 'opps') return opps();
  if (a === 'new') return newOpp();
  if (a === 'opp' && b) return opp(b);
  if (a === 'orders') return orders();
  if (a === 'inventory') return inventory();
  if (a === 'settings') return settings();
  if (!KEYWORDS.has(a)) return order(a);
}

// ------------------------------------------------------------------ overview
async function overview() {
  const d = await api('GET', '/api/org/sponsorship-dashboard');
  const r = d.revenue[0];
  const maxStage = Math.max(1, ...d.pipeline.map((p: any) => p.count));
  shell('sponsorships', `<header class="page-head"><div><h1>Sponsorships</h1><p class="muted">Sell sponsorship inventory, get paid online, and branding goes live on your screens automatically.</p></div><div class="head-actions"><a class="btn btn-primary" href="#sponsorships/new">New opportunity</a></div></header>
    ${subnav('')}
    <div class="kpis">
      ${kpi('Sponsorship revenue', r ? esc(r.gross) : '₹0', r ? `${esc(r.refunds)} refunded` : '')}
      ${kpi('Your earnings', r ? esc(r.earnings) : '₹0', r ? `after ${esc(r.commission)} platform commission & fees` : '')}
      ${kpi('Awaiting payout', r ? esc(r.awaitingPayout) : '₹0', r ? `${esc(r.paidOut)} paid out` : '')}
      ${kpi('Active sponsors', num(d.activeSponsors))}
      ${kpi('Pending payments', d.pendingPayments.map((p: any) => `${p.count} · ${esc(p.amount)}`).join('<br>') || '0')}
      ${kpi('Needs your approval', num(d.awaitingApproval), d.awaitingApproval ? '<a href="#sponsorships/orders">Review</a>' : '')}
      ${kpi('Inventory sold', `${d.inventory.soldPct}%`, `${num(d.inventory.available)} of ${num(d.inventory.units)} units available`)}
      ${kpi('Deliverables due', num(d.deliverablesPending), 'social posts, physical branding')}
    </div>
    <div class="two-col">
      <div class="card"><h2>Pipeline</h2><ul class="funnel">${d.pipeline.map((p: any) => `<li><span>${esc(p.stage)}</span><i style="--w:${Math.round((p.count / maxStage) * 100)}%"></i><strong>${p.count}</strong></li>`).join('')}</ul></div>
      <div class="card"><h2>Top sponsors</h2>${d.topSponsors.length ? `<table class="table"><tbody>${d.topSponsors.map((t: any) => `<tr><td>${esc(t.name)}</td><td>${t.orders} order${t.orders === 1 ? '' : 's'}</td><td class="r">${esc(t.spend)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No sponsors yet.</p>'}
        <h2>Exposure delivered</h2><p>${d.exposureDelivered.tvHours} screen-hours · ${num(d.exposureDelivered.pageImpressions)} page impressions · ${num(d.exposureDelivered.uniqueViewers)} viewers · ${num(d.exposureDelivered.qrScans)} QR scans</p></div>
    </div>
    <div class="card"><h2>Revenue by month</h2>${bars(d.monthly.map((m: any) => ({ label: m.month, value: Math.round(m.v / 100) })), { unit: ' (major units)' })}</div>
    <div class="card"><h2>Inventory</h2>${invTable(d.inventory.items.filter((i: any) => i.sold < i.quantity).slice(0, 8))}<p><a href="#sponsorships/inventory">All ${d.inventory.items.length} inventory items →</a></p></div>`);
}

const invTable = (items: any[]) =>
  items.length ? `<table class="table"><thead><tr><th>Item</th><th>Type</th><th>Scope</th><th class="r">Sold / total</th><th>Fulfilment</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.label)}</td><td>${esc(title(i.scopeType))}</td><td class="r">${num(i.sold)} / ${num(i.quantity)}</td><td>${i.deliverable ? 'You deliver (proof)' : `Automatic: ${i.surfaces.map(title).join(', ')}`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Inventory is created from your packages.</p>';

// ------------------------------------------------------------------ opportunities
async function opps() {
  const list = await api('GET', '/api/org/sponsorship-opportunities');
  shell('sponsorships', `<header class="page-head"><h1>Opportunities</h1><a class="btn btn-primary" href="#sponsorships/new">New opportunity</a></header>${subnav('opps')}
    ${list.length ? `<ul class="rows">${list.map((o: any) => `<li class="row"><a class="row-main" href="#sponsorships/opp/${esc(o.id)}"><strong>${esc(o.title)}</strong><small>${esc(title(o.sport ?? 'multi-sport'))}${o.city ? ` · ${esc(o.city)}` : ''} · ${o.packages} package${o.packages === 1 ? '' : 's'}${o.from ? ` · from ${esc(o.from)}` : ''}</small></a><span class="row-meta">${date(o.startsOn)}<small>${date(o.endsOn)}</small></span><span class="status status-${o.status === 'published' ? 'live' : 'draft'}">${esc(o.status)}</span><span></span><span class="row-actions">${o.status === 'published' ? `<a class="btn btn-small" href="/sponsorships/${esc(o.slug)}" target="_blank" rel="noopener">View listing</a>` : ''}</span></li>`).join('')}</ul>` : '<div class="empty-inline"><p>No opportunities yet. Create one for a tournament, venue or match — Gold / Silver / Bronze packages are one click.</p></div>'}`);
}

async function newOpp() {
  const [tours, venues] = await Promise.all([api('GET', '/api/tournaments'), api('GET', '/api/venues')]);
  const groups = ['tournament', 'venue', 'match', 'digital', 'broadcast', 'social'];
  shell('sponsorships', `<a class="crumb" href="#sponsorships/opps">← Opportunities</a><header class="page-head"><h1>New sponsorship opportunity</h1></header>
  <form class="card form-grid" id="f">
    <label class="wide">Title<input name="title" required minlength="4" placeholder="Navratri Smash 2026 — sponsorship"></label>
    <label>Tournament<select name="tournamentId"><option value="">— none —</option>${tours.map((t: any) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
    <label>Venue<select name="venueId"><option value="">— from tournament / none —</option>${venues.map((v: any) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
    <label>Sport<select name="sport"><option value="">— from tournament —</option>${meta.sports.map((s: any) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>Level<select name="level">${meta.levels.map((l: string) => `<option ${l === 'local' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>City<input name="city"></label><label>State<input name="state"></label><label>Country<input name="country" value="India"></label>
    <label>Starts<input name="startsOn" type="date"></label><label>Ends<input name="endsOn" type="date"></label>
    <label>Expected audience (your estimate)<input name="audienceEstimate" type="number" min="0" step="50"></label>
    <fieldset><legend>Audience age</legend><div class="checks">${meta.ageGroups.map((a: string) => `<label><input type="checkbox" name="age" value="${a}"> ${a}</label>`).join('')}</div></fieldset>
    <label>How it's sold<select name="saleModel">${meta.saleModels.map((s: string) => `<option value="${s}">${esc(({ fixed: 'Fixed price', fcfs: 'First come, first served', rfp: 'Request for proposal', negotiated: 'Fixed price, open to offers', auction: 'Auction' } as any)[s])}</option>`).join('')}</select></label>
    <label>Approval<select name="approvalMode"><option value="auto">Automatic — live as soon as paid</option><option value="asset_review">Review creative first</option><option value="manual">Approve every sponsor</option></select></label>
    <label>Currency<select name="currency">${meta.currencies.map((c: string) => `<option>${c}</option>`).join('')}</select></label>
    <label class="wide">Description<textarea name="description" rows="3" placeholder="Who attends, how many matches, streaming, what sponsors get."></textarea></label>
    <fieldset class="wide"><legend>Packages</legend>
      <div class="checks">${meta.templates.map((t: any) => `<label><input type="checkbox" name="tpl" value="${t.id}" checked> ${esc(t.name)} — ₹${num(t.price)}</label>`).join('')}</div>
      <details class="custom-pkg"><summary>Add a custom package</summary><div class="form-grid">
        <label>Name<input name="cName" placeholder="Match of the Day partner"></label><label>Price<input name="cPrice" type="number" min="0" step="100"></label><label>Slots<input name="cMax" type="number" min="1" value="1"></label><label>Duration (days)<input name="cDays" type="number" min="1"></label>
        <div class="wide">${groups.map((g) => `<p class="muted small">${title(g)}</p><div class="checks">${meta.inventoryTypes.filter((t: any) => t.category === g).map((t: any) => `<label><input type="checkbox" name="cItem" value="${t.type}"> ${esc(t.label)}${t.deliverable ? ' <small>(you deliver)</small>' : ''}</label>`).join('')}</div>`).join('')}</div>
        <fieldset class="wide auction-only"><legend>Auction (when sold by auction)</legend><div class="form-grid"><label>Starting price<input name="aStart" type="number" min="1"></label><label>Increment<input name="aInc" type="number" min="1"></label><label>Reserve<input name="aRes" type="number" min="1"></label><label>Ends<input name="aEnds" type="datetime-local"></label></div></fieldset>
      </div></details></fieldset>
    <label class="mk-check wide"><input type="checkbox" name="publish" value="1" checked> Publish to the marketplace now</label>
    <div class="form-actions"><button class="btn btn-primary">Create opportunity</button></div></form>`);
  app().querySelector('#f')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const d = formData(f);
    const fd = new FormData(f);
    const packages: any[] = fd.getAll('tpl').map((t) => ({ template: t, maxSponsors: t === 'bronze' ? 5 : t === 'silver' ? 2 : 1 }));
    if (d.cName) {
      const items = fd.getAll('cItem').map((type) => ({ type }));
      const auction = d.saleModel === 'auction' ? { startPrice: Number(d.aStart), increment: d.aInc ? Number(d.aInc) : undefined, reserve: d.aRes ? Number(d.aRes) : undefined, endsAt: d.aEnds ? new Date(d.aEnds).toISOString() : undefined } : undefined;
      packages.push({ name: d.cName, price: d.cPrice ? Number(d.cPrice) : undefined, maxSponsors: Number(d.cMax || 1), durationDays: d.cDays ? Number(d.cDays) : undefined, items, auction });
    }
    const body: any = {
      title: d.title, tournamentId: d.tournamentId || undefined, venueId: d.venueId || undefined, sport: d.sport || undefined, level: d.level, city: d.city || undefined, state: d.state || undefined, country: d.country || undefined,
      startsOn: d.startsOn || undefined, endsOn: d.endsOn || undefined, audienceEstimate: Number(d.audienceEstimate || 0), audienceProfile: { ageGroups: fd.getAll('age') }, saleModel: d.saleModel, approvalMode: d.approvalMode,
      currency: d.currency, description: d.description || undefined, packages: d.saleModel === 'auction' ? packages.filter((p) => !p.template) : packages, publish: !!d.publish,
    };
    try {
      const o = await api('POST', '/api/sponsorship-opportunities', body);
      toast(o.status === 'published' ? 'Published to the marketplace' : 'Saved as draft');
      location.hash = `sponsorships/opp/${o.id}`;
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

async function opp(id: string) {
  const o = await api('GET', `/api/org/sponsorship-opportunities/${id}`);
  const orders = (await api('GET', '/api/org/sponsorships')).filter((x: any) => x.opportunity === o.title);
  shell('sponsorships', `<a class="crumb" href="#sponsorships/opps">← Opportunities</a>
    <header class="page-head"><div><h1>${esc(o.title)}</h1><p class="muted">${esc(title(o.sport ?? 'multi-sport'))} · ${esc(o.city ?? '')} · ${date(o.startsOn)} – ${date(o.endsOn)} · ${esc(title(o.approvalMode.replace('_', ' ')))} approval</p></div>
    <div class="head-actions"><span class="status status-${o.status === 'published' ? 'live' : 'draft'}">${esc(o.status)}</span>
      ${o.status !== 'published' ? '<button class="btn btn-primary" data-st="published">Publish</button>' : `<a class="btn" href="/sponsorships/${esc(o.slug)}" target="_blank" rel="noopener">View listing</a><button class="btn" data-st="closed">Close sales</button>`}${o.status === 'closed' ? '<button class="btn" data-st="draft">Back to draft</button>' : ''}</div></header>
    <div class="card"><h2>Facts shown to sponsors</h2><p>${num(o.facts.matches)} matches · venues: ${o.facts.venues.map(esc).join(', ') || '—'} · ${num(o.facts.screens)} paired screens · audience estimate ${num(o.audienceEstimate)}</p><div class="mk-chips">${exposureChips(o.exposure)}</div></div>
    <h2 class="section">Packages</h2>
    <div class="mk-packages">${o.packages.map((p: any) => `<article class="mk-pkg tier-${esc(p.tier ?? 'custom')}"><header><h3>${esc(p.name)}</h3>${p.active ? '' : '<span class="mk-tier">hidden</span>'}</header>
      <p class="mk-price">${esc(p.auction ? p.auction.current : p.price ?? 'On request')}</p><ul class="mk-items">${p.items.map((i: any) => `<li>${esc(i.label)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</li>`).join('')}</ul>
      <footer><span class="muted small">${p.sold} sold · ${p.remaining} of ${p.maxSponsors} left</span><button class="btn btn-small" data-edit="${esc(p.id)}">Edit</button></footer></article>`).join('')}</div>
    <details class="card create"><summary>Add a package</summary><form class="form-grid" id="addpkg"><label>Template<select name="template"><option value="">Custom</option>${meta.templates.map((t: any) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>Name<input name="name"></label><label>Price<input name="price" type="number" min="0"></label><label>Slots<input name="maxSponsors" type="number" min="1" value="1"></label>
      <label class="wide">Benefits (custom)<select name="items" multiple size="6">${meta.inventoryTypes.map((t: any) => `<option value="${t.type}">${esc(title(t.category))} · ${esc(t.label)}</option>`).join('')}</select></label><div class="form-actions"><button class="btn btn-primary">Add package</button></div></form></details>
    <h2 class="section">Sponsors</h2><div class="card">${orders.length ? ordersTable(orders) : '<p class="muted">No orders yet.</p>'}</div>`);
  const main = app().querySelector('#main')!;
  main.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    try {
      if (el.dataset.st) {
        await api('PATCH', `/api/sponsorship-opportunities/${id}`, { status: el.dataset.st });
        return opp(id);
      }
      if (el.dataset.edit) {
        const p = o.packages.find((x: any) => x.id === el.dataset.edit);
        sheet(`<form class="sheet-body" id="ep"><div class="sheet-head"><h2>${esc(p.name)}</h2><button type="button" class="icon-btn" data-close>✕</button></div>
          <label>Name<input name="name" value="${esc(p.name)}"></label>${p.priceMinor != null ? `<label>Price (${esc(p.currency)})<input name="price" type="number" min="1" value="${p.priceMinor / 100}"></label>` : ''}
          <label>Slots<input name="maxSponsors" type="number" min="${p.sold || 1}" value="${p.maxSponsors}"></label><label>Duration (days, blank = whole event)<input name="durationDays" type="number" min="1" value="${p.durationDays ?? ''}"></label>
          <label class="mk-check"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> Offered on the marketplace</label>
          <p class="muted small">Changes apply to new orders only. Existing sponsorships keep their agreed price.</p><div class="sheet-actions"><button class="btn btn-primary">Save</button></div></form>`, (dlg) => {
          dlg.querySelector('#ep')!.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const d = formData(ev.target as HTMLFormElement);
            try {
              await api('PATCH', `/api/sponsorship-packages/${p.id}`, { name: d.name, price: d.price, maxSponsors: Number(d.maxSponsors), durationDays: d.durationDays ? Number(d.durationDays) : null, active: !!d.active });
              dlg.close();
              opp(id);
            } catch (err: any) {
              toast(err.message, 'error');
            }
          });
        });
      }
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  main.querySelector('#addpkg')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const d = formData(f);
    const items = [...(f.querySelector('select[name="items"]') as HTMLSelectElement).selectedOptions].map((x) => ({ type: x.value }));
    try {
      await api('POST', `/api/sponsorship-opportunities/${id}/packages`, { template: d.template || undefined, name: d.name || undefined, price: d.price ? Number(d.price) : undefined, maxSponsors: Number(d.maxSponsors || 1), items: d.template && !items.length ? undefined : items });
      opp(id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ orders
function ordersTable(list: any[]) {
  return `<table class="table"><thead><tr><th>Sponsor</th><th>Package</th><th>Status</th><th>Period</th><th class="r">Total</th></tr></thead><tbody>${list.map((o) => `<tr><td><a href="#sponsorships/${esc(o.id)}"><strong>${esc(o.sponsor)}</strong></a><br><small class="muted">${esc(o.number)}${o.risk?.length ? ' · <span class="sp-status tone-bad">risk</span>' : ''}</small></td><td>${esc(o.package ?? '')}<br><small class="muted">${esc(o.opportunity)}</small></td><td>${statusPill(o.status)}</td><td>${date(o.startsOn)} – ${date(o.endsOn)}</td><td class="r">${esc(o.total)}</td></tr>`).join('')}</tbody></table>`;
}

async function orders() {
  const status = new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') ?? '';
  const list = await api('GET', `/api/org/sponsorships${status ? `?status=${status}` : ''}`);
  shell('sponsorships', `<header class="page-head"><h1>Sponsorships</h1></header>${subnav('orders')}
    <nav class="filter-tabs">${[['', 'All'], ['PENDING_APPROVAL,ASSET_REVIEW', 'Needs approval'], ['ACTIVE', 'Active'], ['PENDING_PAYMENT', 'Payment pending'], ['PAUSED', 'Paused'], ['EXPIRED', 'Ended'], ['CANCELLED,REFUNDED', 'Cancelled']].map(([v, l]) => `<a href="#sponsorships/orders${v ? `?status=${v}` : ''}" class="${status === v ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <div class="card">${list.length ? ordersTable(list) : '<p class="muted">Nothing here.</p>'}</div>`);
}

async function order(id: string) {
  const o = await api('GET', `/api/org/sponsorships/${id}`);
  const c = o.sponsorContact;
  const m = o.metrics;
  const review = ['PENDING_APPROVAL', 'ASSET_REVIEW'].includes(o.status) || o.assets.some((a: any) => a.proposedAssetId);
  shell('sponsorships', `<a class="crumb" href="#sponsorships/orders">← Sponsorships</a>
    <header class="page-head"><div><h1>${esc(o.sponsor.name)}</h1><p class="muted">${esc(o.package?.name ?? '')} · ${esc(o.opportunity.title)} · ${esc(o.number)}</p></div>
      <div class="head-actions">${statusPill(o.status)}
        ${['PENDING_APPROVAL', 'ASSET_REVIEW'].includes(o.status) ? '<button class="btn btn-primary" data-a="approve">Approve & go live</button><button class="btn" data-a="reject">Decline & refund</button>' : ''}
        ${o.status === 'ACTIVE' ? '<button class="btn" data-a="pause">Pause</button>' : ''}${o.status === 'PAUSED' ? '<button class="btn btn-primary" data-a="resume">Resume</button>' : ''}
        ${o.refundableMinor > 0 ? '<button class="btn" data-a="refund">Refund…</button>' : ''}
        ${['PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW', 'ACTIVE', 'PAUSED'].includes(o.status) ? '<button class="btn" data-a="transfer">Transfer…</button>' : ''}
        ${!['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status) ? '<button class="btn btn-quiet" data-a="cancel">Cancel…</button>' : ''}</div></header>
    ${o.risk.length ? `<div class="card notice bad"><strong>On hold for review:</strong> ${o.risk.map((r: string) => esc(title(r))).join(', ')}. The platform team has been notified.</div>` : ''}
    <div class="two-col">
      <div class="card"><h2>Deal</h2><dl class="dl"><dt>Period</dt><dd>${date(o.startsOn)} – ${date(o.endsOn)}</dd><dt>Sponsor paid</dt><dd>${esc(o.amounts.total)} <small class="muted">(incl. ${esc(o.amounts.tax)} tax)</small></dd>
        <dt>Platform commission</dt><dd>${money(o.commissionMinor, o.currency)} <small class="muted">(${o.commissionBps / 100}%)</small></dd><dt>Your share</dt><dd><strong>${money(o.organizerNetMinor, o.currency)}</strong> + GST collected</dd>
        <dt>Contact</dt><dd>${esc(c.contact_person ?? '')} · ${esc(c.email ?? '')} ${esc(c.phone ?? '')}</dd>${c.website ? `<dt>Website</dt><dd>${esc(c.website)}</dd>` : ''}<dt>Source</dt><dd>${esc(title(o.source))}</dd></dl></div>
      <div class="card"><h2>Exposure delivered</h2><dl class="dl"><dt>Score</dt><dd>${m.score}/100</dd><dt>Screen time</dt><dd>${m.tvHours} h · ${num(m.screens)} screen-days</dd><dt>Page impressions</dt><dd>${num(m.live_impressions)} (${num(m.unique_viewers)} unique)</dd><dt>Clicks / QR scans</dt><dd>${num(m.clicks)} / ${num(m.qr_scans)}</dd><dt>Matches covered</dt><dd>${num(m.matchesCovered)}</dd></dl>
        <h3>Live placements</h3><ul class="chips">${o.placements.map((p: any) => `<li class="${p.active ? '' : 'off'}">${esc(title(p.surface))} · ${esc(p.scopeType)}</li>`).join('') || '<li>None yet</li>'}</ul></div></div>
    <div class="card"><h2>Creative ${review ? '<small class="muted">— review each item</small>' : ''}</h2><div class="creative">${o.assets.map((a: any) => `<figure class="${esc(a.status)}">${a.preview ? `<img src="${esc(a.proposedPreview ?? a.preview)}" alt="">` : `<blockquote>${esc(a.text ?? '')}</blockquote>`}<figcaption><strong>${esc(title(a.role))}</strong> ${esc(a.proposedAssetId ? 'replacement submitted' : a.status)}${a.assetStatus === 'flagged' ? ' <span class="sp-status tone-warn">flagged by screening</span>' : ''}${a.note ? `<br><small>${esc(a.note)}</small>` : ''}
      ${review && (a.status !== 'approved' || a.proposedAssetId) ? `<span class="row-actions"><button class="btn btn-small" data-asset="${esc(a.role)}" data-d="approve">Approve</button><button class="btn btn-small" data-asset="${esc(a.role)}" data-d="reject">Request change</button></span>` : ''}</figcaption></figure>`).join('') || '<p class="muted">The sponsor hasn’t attached creative yet.</p>'}</div></div>
    ${o.deliverables.length ? `<div class="card"><h2>Deliverables you owe</h2><table class="table"><tbody>${o.deliverables.map((d: any) => `<tr><td>${esc(d.label)}</td><td>${esc(title(d.status))}</td><td>${d.proofUrl ? `<a href="${esc(d.proofUrl)}" target="_blank" rel="noopener noreferrer">Proof</a>` : ''}</td><td class="row-actions">${d.status !== 'delivered' ? `<button class="btn btn-small" data-deliver="${esc(d.id)}">Mark delivered…</button>` : date(d.deliveredAt)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="two-col"><div class="card"><h2>Documents</h2><ul class="docs">${o.documents.map((d: any) => `<li><span>${esc(title(d.kind))}<small class="muted"> · ${date(d.createdAt)}</small></span><span><button class="link" data-doc="${esc(d.id)}">View</button> · <button class="link" data-pdf="${esc(d.id)}">PDF</button></span></li>`).join('')}</ul></div>
      <div class="card"><h2>History</h2><ol class="events">${o.events.map((e: any) => `<li><time>${dateTime(e.at)}</time> ${esc(STATUS_LABEL[e.to] ?? e.to)} <small class="muted">${esc(e.actor)}</small>${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('')}</ol>
        ${o.refunds.length ? `<h3>Refunds</h3><ul>${o.refunds.map((r: any) => `<li>${esc(r.amount)} · ${esc(r.status)} · ${esc(r.reason ?? '')}</li>`).join('')}</ul>` : ''}</div></div>`);

  const main = app().querySelector('#main')!;
  main.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const btn = el.closest<HTMLElement>('[data-a],[data-asset],[data-deliver],[data-doc],[data-pdf]');
    if (!btn) return;
    try {
      if (btn.dataset.doc) return openDoc(o.id, btn.dataset.doc);
      if (btn.dataset.pdf) return openDoc(o.id, btn.dataset.pdf, true);
      if (btn.dataset.asset) {
        const note = btn.dataset.d === 'reject' ? prompt('What should the sponsor change?') : null;
        if (btn.dataset.d === 'reject' && !note) return;
        await api('POST', `/api/sponsorships/${o.id}/review-assets`, { assets: { [btn.dataset.asset]: { decision: btn.dataset.d, note } } });
        return order(id);
      }
      if (btn.dataset.deliver) {
        const proofUrl = prompt('Link to the post or a photo proving delivery (https://…)');
        if (!proofUrl) return;
        await api('PATCH', `/api/org/deliverables/${btn.dataset.deliver}`, { status: 'delivered', proofUrl });
        return order(id);
      }
      const a = btn.dataset.a;
      if (a === 'approve') await api('POST', `/api/sponsorships/${o.id}/approve`, {});
      if (a === 'reject') {
        const reason = prompt('Why are you declining? The sponsor is refunded in full.');
        if (!reason) return;
        await api('POST', `/api/sponsorships/${o.id}/reject`, { reason });
      }
      if (a === 'pause') await api('POST', `/api/sponsorships/${o.id}/pause`, { reason: prompt('Reason shown to the sponsor (optional)') ?? undefined });
      if (a === 'resume') await api('POST', `/api/sponsorships/${o.id}/resume`, {});
      if (a === 'refund') {
        const amount = prompt(`Refund amount in ${o.currency} (max ${money(o.refundableMinor, o.currency)}). Leave blank for everything.`);
        if (amount === null) return;
        const reason = prompt('Reason');
        if (!reason) return;
        await api('POST', `/api/sponsorships/${o.id}/refund`, { amount: amount || undefined, reason });
      }
      if (a === 'transfer') {
        const to = prompt('Transfer to which sponsor? (their profile slug or account id)');
        if (!to) return;
        await api('POST', `/api/sponsorships/${o.id}/transfer`, { toSponsor: to });
      }
      if (a === 'cancel') {
        const reason = prompt('Reason for cancelling. Paid sponsorships are refunded (pro-rata if already live).');
        if (!reason) return;
        await api('POST', `/api/sponsorships/${o.id}/cancel`, { reason });
      }
      toast('Done');
      order(id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ deals
async function deals() {
  const list = await api('GET', '/api/org/sponsorship-threads');
  shell('sponsorships', `<header class="page-head"><h1>Offers & RFPs</h1></header>${subnav('deals')}
    <div class="card">${list.length ? `<table class="table"><thead><tr><th>Sponsor</th><th>Opportunity</th><th>Type</th><th>Latest offer</th><th>Status</th><th>Updated</th></tr></thead><tbody>${list.map((t: any) => `<tr><td><a href="#deals/${esc(t.id)}"><strong>${esc(t.sponsor)}</strong></a></td><td>${esc(t.opportunity)}${t.package ? `<br><small class="muted">${esc(t.package)}</small>` : ''}</td><td>${esc(title(t.kind))}</td><td>${t.currentOffer ? `${esc(t.currentOffer.amount)} <small class="muted">${t.currentOffer.side === 'organizer' ? 'your proposal' : 'their offer'}</small>` : '—'}</td><td>${esc(title(t.status))}</td><td>${dateTime(t.updatedAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No enquiries yet.</p>'}</div>`);
}

async function deal(id: string) {
  const t = await api('GET', `/api/org/sponsorship-threads/${id}`);
  const canAccept = t.status === 'open' && t.currentOffer?.side === 'sponsor';
  shell('sponsorships', `<a class="crumb" href="#deals">← Offers & RFPs</a>
    <header class="page-head"><div><h1>${esc(t.sponsor)}</h1><p class="muted">${esc(t.opportunity)} · ${esc(t.package ?? 'General enquiry')}${t.listPrice ? ` · list ${esc(t.listPrice)}` : ''} · ${esc(title(t.status))}</p></div>
      <div class="head-actions">${canAccept ? `<button class="btn btn-primary" data-a="accept">Accept ${esc(t.currentOffer.amount)}</button>` : ''}${t.orderId ? `<a class="btn" href="#sponsorships/${esc(t.orderId)}">View order</a>` : ''}${t.status === 'open' ? '<button class="btn btn-quiet" data-a="decline">Decline</button>' : ''}</div></header>
    <div class="card"><ol class="thread">${t.messages.map((m: any) => `<li class="from-${m.side === 'organizer' ? 'sponsor' : 'organizer'}"><header><strong>${m.side === 'organizer' ? 'You' : esc(t.sponsor)}</strong> <small class="muted">${esc(m.author ?? '')} · ${dateTime(m.at)}</small></header><p>${esc(m.body)}</p>${m.offer ? `<p class="offer">${m.side === 'organizer' ? 'Proposal' : 'Offer'}: <strong>${esc(m.offer)}</strong></p>` : ''}</li>`).join('')}</ol>
    ${t.status === 'open' ? `<form id="reply" class="reply"><textarea name="message" rows="3" placeholder="Reply or send a proposal"></textarea><div class="two">${t.packageId ? `<label>Proposal (${esc(t.currency)})<input name="offer" type="number" min="1" step="100"></label>` : '<span></span>'}<button class="btn btn-primary">Send</button></div></form>` : ''}</div>`);
  const main = app().querySelector('#main')!;
  main.querySelector('#reply')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/org/sponsorship-threads/${id}/messages`, formData(e.target as HTMLFormElement));
      deal(id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  main.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      if (a === 'accept') {
        const r = await api('POST', `/api/org/sponsorship-threads/${id}/accept`, {});
        toast(`Order ${r.order.number} created — the sponsor has 72 hours to pay`);
      }
      if (a === 'decline') await api('POST', `/api/org/sponsorship-threads/${id}/decline`, { reason: prompt('Reason (optional)') ?? undefined });
      deal(id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ inventory
async function inventory() {
  const [items, tours, venues] = await Promise.all([api('GET', '/api/sponsorship-inventory'), api('GET', '/api/tournaments'), api('GET', '/api/venues')]);
  shell('sponsorships', `<header class="page-head"><div><h1>Inventory</h1><p class="muted">Everything you can sell. Digital items (screens, live pages, overlays, QR) activate automatically; physical and social items are delivered by you with proof.</p></div></header>${subnav('inventory')}
    <div class="card">${invTable(items)}</div>
    <form class="card form-grid" id="inv"><h2 class="wide">Add inventory</h2>
      <label>Type<select name="type">${meta.inventoryTypes.map((t: any) => `<option value="${t.type}">${esc(title(t.category))} · ${esc(t.label)}</option>`).join('')}</select></label>
      <label>Name<input name="name" placeholder="Court 1 LED board"></label>
      <label>Scope<select name="scope"><option value="org|">All my events</option>${tours.map((t: any) => `<option value="tournament|${esc(t.id)}">Tournament: ${esc(t.name)}</option>`).join('')}${venues.map((v: any) => `<option value="venue|${esc(v.id)}">Venue: ${esc(v.name)}</option>`).join('')}</select></label>
      <label>Units available<input name="quantity" type="number" min="1" value="1"></label>
      <div class="form-actions"><button class="btn btn-primary">Add</button></div></form>`);
  app().querySelector('#inv')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target as HTMLFormElement);
    const [scopeType, scopeId] = d.scope.split('|');
    try {
      await api('POST', '/api/sponsorship-inventory', { type: d.type, name: d.name || undefined, scopeType, scopeId: scopeId || undefined, quantity: Number(d.quantity) });
      inventory();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ settings
async function settings() {
  const s = await api('GET', '/api/org/sponsorship-settings');
  const fields = (p: string) => (s.providerFields[p] ?? []).map((f: string) => `<label>${esc(title(f))}<input name="cfg_${p}_${f}" value="${esc(s.provider === p ? s.providerConfig[f] ?? '' : '')}" ${f === 'environment' ? 'placeholder="sandbox or production"' : ''} autocomplete="off"></label>`).join('');
  shell('sponsorships', `<header class="page-head"><h1>Payments & invoicing</h1></header>${subnav('settings')}
    <form class="card form-grid" id="f">
      <h2 class="wide">How sponsors pay you</h2>
      <label class="wide">Payment provider<select name="provider">${['sandbox', 'razorpay', 'cashfree', 'stripe'].map((p) => `<option value="${p}" ${s.provider === p ? 'selected' : ''}>${p === 'sandbox' ? 'Platform account (default) / test mode' : `My own ${title(p)} account`}</option>`).join('')}</select></label>
      ${['razorpay', 'cashfree', 'stripe'].map((p) => `<div class="wide prov prov-${p}" ${s.provider === p ? '' : 'hidden'}><div class="form-grid">${fields(p)}</div><p class="muted small">Webhook URL to add in your ${title(p)} dashboard: <code>${esc(s.webhookUrl.replace(/\/webhook\/[^/]+\//, `/webhook/${p}/`))}</code>. Keys are encrypted at rest and never shown again in full.</p></div>`).join('')}
      <p class="wide muted small">With your own gateway, money settles straight to your bank and the platform invoices its ${esc(s.commission)} commission separately. Otherwise payments are collected on the platform account and paid out to you after activation.</p>
      <h2 class="wide">Invoices</h2>
      <label>Legal name<input name="legalName" value="${esc(s.legalName ?? '')}"></label>
      <label>GSTIN<input name="gstin" value="${esc(s.gstin ?? '')}"></label>
      <label>State (place of supply)<input name="state" value="${esc(s.state ?? '')}"></label>
      <label>Invoice prefix<input name="invoicePrefix" value="${esc(s.invoicePrefix)}" pattern="[A-Za-z0-9-]{2,10}"></label>
      <label class="wide">Registered address<input name="address" value="${esc(s.address ?? '')}"></label>
      <label class="mk-check wide"><input type="checkbox" name="marketplaceEnabled" value="1" ${s.marketplaceEnabled ? 'checked' : ''}> Accept sponsorships through the marketplace</label>
      <p class="wide muted small">Commission: ${esc(s.commission)} · platform fee per order: ${esc(s.platformFee)} · tax: ${s.taxRateBps / 100}%. Contact the platform team to change commercial terms.</p>
      <div class="form-actions"><button class="btn btn-primary">Save</button></div></form>
    <div class="card"><h2>Gateways available on this platform</h2><p>${s.providers.map((p: any) => `<span class="chip">${esc(title(p.id))}: ${p.configured ? (p.live ? 'live' : 'test') : 'not configured'}</span>`).join(' ')}</p></div>`);
  const f = app().querySelector<HTMLFormElement>('#f')!;
  f.querySelector('select[name="provider"]')!.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    f.querySelectorAll<HTMLElement>('.prov').forEach((el) => (el.hidden = !el.classList.contains(`prov-${v}`)));
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    const prefix = `cfg_${d.provider}_`;
    const providerConfig = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    try {
      await api('PUT', '/api/org/sponsorship-settings', { provider: d.provider, providerConfig: d.provider === 'sandbox' ? undefined : providerConfig, legalName: d.legalName, gstin: d.gstin, state: d.state, invoicePrefix: d.invoicePrefix, address: d.address, marketplaceEnabled: !!d.marketplaceEnabled });
      toast('Saved');
      settings();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

const app = () => document.getElementById('app')!;
