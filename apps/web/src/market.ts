/**
 * Public sponsorship marketplace.
 *   /sponsorships        discovery with filters + AI advisor
 *   /sponsorships/:id    opportunity detail, packages, buy / bid / make an offer
 *   /sponsors            public sponsor directory
 */
import { logo } from './lib/brand.ts';
import { activeAccount, date, esc, exposureChips, formData, num, session, sheet, spApi, title, toast, uploadAsset, variant } from './lib/sp.ts';

const app = document.getElementById('app')!;
const parts = location.pathname.split('/').filter(Boolean);
let meta: any = null;
let me: any = null; // { user, memberships } when signed in

async function boot() {
  meta = await spApi('GET', '/api/sponsorship-meta');
  if (session.token) me = await spApi('GET', '/api/sponsor/me', undefined, { quiet401: true }).catch(() => null);
  if (me && !activeAccount.get() && me.memberships[0]) activeAccount.set(me.memberships[0].account.id);
  if (parts[0] === 'sponsors') return directory();
  if (parts[1]) return detail(decodeURIComponent(parts[1]));
  return discover();
}

function header(active: string) {
  const acct = me?.memberships?.find((m: any) => m.account.id === activeAccount.get())?.account ?? me?.memberships?.[0]?.account;
  return `<header class="mk-top">
    <a class="logo-link" href="/">${logo()}</a>
    <nav><a href="/sponsorships" class="${active === 'discover' ? 'on' : ''}">Sponsorships</a><a href="/sponsors" class="${active === 'sponsors' ? 'on' : ''}">Sponsors</a><a href="/console#sponsorships">For organizers</a></nav>
    <div class="mk-me">${me ? `<a class="btn btn-small" href="/sponsor">${esc(acct?.name ?? me.user.name)} · Dashboard</a>` : `<a class="btn btn-small btn-quiet" href="/sponsor?next=${encodeURIComponent(location.pathname)}">Sign in</a><a class="btn btn-small btn-primary" href="/sponsor#signup">Become a sponsor</a>`}</div>
  </header>`;
}

// ------------------------------------------------------------------ discover
async function discover() {
  const q = new URLSearchParams(location.search);
  document.title = 'Sponsor sports events — Sports Diary';
  app.innerHTML = `${header('discover')}
  <section class="mk-hero">
    <div class="mk-hero-copy">
      <p class="eyebrow">Sponsorship marketplace</p>
      <h1>Put your brand on the scoreboard.</h1>
      <p>Buy tournament, venue, match and broadcast sponsorships in minutes. Your logo goes live on venue screens, live score pages and stream overlays the moment payment clears — and you see every impression.</p>
    </div>
    <form class="mk-agent" id="agent">
      <label for="agent-q">Ask the sponsorship advisor</label>
      <textarea id="agent-q" name="message" rows="3" placeholder="I have ₹5 lakh and want maximum visibility among young cricket audiences in Gujarat.">${esc(q.get('ask') ?? '')}</textarea>
      <button class="btn btn-primary">Find my best plan</button>
      <div id="agent-out" aria-live="polite"></div>
    </form>
  </section>
  <div class="mk-body">
    <form class="mk-filters" id="filters">
      <label>Search<input name="q" value="${esc(q.get('q') ?? '')}" placeholder="Tournament, city, organizer"></label>
      <label>Sport<select name="sport"><option value="">Any sport</option>${meta.sports.map((s: any) => `<option value="${s.id}" ${q.get('sport') === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>City<input name="city" value="${esc(q.get('city') ?? '')}" list="mk-cities"></label><datalist id="mk-cities"></datalist>
      <label>State<input name="state" value="${esc(q.get('state') ?? '')}" list="mk-states"></label><datalist id="mk-states"></datalist>
      <label>Country<input name="country" value="${esc(q.get('country') ?? '')}" placeholder="India"></label>
      <label>Event level<select name="level"><option value="">Any level</option>${meta.levels.map((l: string) => `<option ${q.get('level') === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <fieldset><legend>Budget (₹)</legend><div class="mk-range"><input name="minBudget" type="number" min="0" step="1000" placeholder="Min" value="${esc(q.get('minBudget') ?? '')}"><input name="maxBudget" type="number" min="0" step="1000" placeholder="Max" value="${esc(q.get('maxBudget') ?? '')}"></div></fieldset>
      <fieldset><legend>Audience size</legend><div class="mk-range"><input name="minAudience" type="number" min="0" step="100" placeholder="Min" value="${esc(q.get('minAudience') ?? '')}"><input name="maxAudience" type="number" min="0" step="100" placeholder="Max" value="${esc(q.get('maxAudience') ?? '')}"></div></fieldset>
      <fieldset><legend>Dates</legend><div class="mk-range"><input name="from" type="date" value="${esc(q.get('from') ?? '')}"><input name="to" type="date" value="${esc(q.get('to') ?? '')}"></div></fieldset>
      <label>Sponsorship type<select name="category"><option value="">Any</option>${['tournament', 'venue', 'match', 'digital', 'broadcast', 'social'].map((c) => `<option value="${c}" ${q.get('category') === c ? 'selected' : ''}>${title(c)}</option>`).join('')}</select></label>
      <fieldset><legend>Visibility</legend><div class="checks">${[['tv', 'Venue TV'], ['stream', 'Live stream'], ['social', 'Social media']].map(([k, l]) => `<label><input type="checkbox" name="${k}" value="1" ${q.get(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div></fieldset>
      <label>Online / offline<select name="mode"><option value="">Both</option><option value="online" ${q.get('mode') === 'online' ? 'selected' : ''}>Online</option><option value="offline" ${q.get('mode') === 'offline' ? 'selected' : ''}>On-ground</option></select></label>
      <label>Max duration (days)<input name="maxDuration" type="number" min="1" value="${esc(q.get('maxDuration') ?? '')}"></label>
      <label>How it's sold<select name="saleModel"><option value="">Any</option>${meta.saleModels.map((s: string) => `<option value="${s}" ${q.get('saleModel') === s ? 'selected' : ''}>${({ fixed: 'Fixed price', fcfs: 'First come, first served', rfp: 'Request for proposal', negotiated: 'Open to offers', auction: 'Auction' } as any)[s]}</option>`).join('')}</select></label>
      <label class="mk-check"><input type="checkbox" name="available" value="1" ${q.get('available') ? 'checked' : ''}> Only with slots left</label>
      <div class="mk-filter-actions"><button class="btn btn-primary">Apply</button><a class="btn btn-quiet" href="/sponsorships">Reset</a></div>
    </form>
    <section class="mk-results">
      <div class="mk-results-head"><p id="count" class="muted">Loading…</p>
        <label class="mk-sort">Sort <select id="sort">${[['featured', 'Featured'], ['price', 'Price: low to high'], ['audience', 'Biggest audience'], ['value', 'Best value per viewer'], ['date', 'Soonest']].map(([v, l]) => `<option value="${v}" ${q.get('sort') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="mk-sort">Show prices in <select id="cur">${meta.currencies.map((c: string) => `<option ${(q.get('currency') ?? 'INR') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="mk-grid" id="grid"></div>
    </section>
  </div>`;

  const res = await spApi('GET', `/api/sponsorship-opportunities?${q.toString()}`);
  (app.querySelector('#mk-cities') as HTMLElement).innerHTML = res.facets.cities.map((c: string) => `<option value="${esc(c)}">`).join('');
  (app.querySelector('#mk-states') as HTMLElement).innerHTML = res.facets.states.map((c: string) => `<option value="${esc(c)}">`).join('');
  app.querySelector('#count')!.textContent = `${res.total} sponsorship${res.total === 1 ? '' : 's'} available`;
  app.querySelector('#grid')!.innerHTML = res.results.length ? res.results.map(card).join('') : `<div class="empty-inline"><p>Nothing matches these filters yet. Try a wider area, or ask the advisor above to suggest alternatives.</p></div>`;

  const apply = (extra: Record<string, string> = {}) => {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...formData(app.querySelector('#filters') as HTMLFormElement), sort: (app.querySelector('#sort') as HTMLSelectElement).value, currency: (app.querySelector('#cur') as HTMLSelectElement).value, ...extra })) if (v && !(k === 'sort' && v === 'featured') && !(k === 'currency' && v === 'INR')) f.set(k, v);
    location.search = f.toString();
  };
  app.querySelector('#filters')!.addEventListener('submit', (e) => (e.preventDefault(), apply()));
  app.querySelector('#sort')!.addEventListener('change', () => apply());
  app.querySelector('#cur')!.addEventListener('change', () => apply());
  app.querySelector('#agent')!.addEventListener('submit', (e) => (e.preventDefault(), ask()));
  if (q.get('ask')) ask();
}

function card(c: any) {
  return `<a class="mk-card ${c.featured ? 'is-featured' : ''}" href="/sponsorships/${esc(c.slug)}">
    <div class="mk-card-top"><span class="mk-sport">${esc(title(c.sport ?? 'Multi-sport'))}</span>${c.featured ? '<span class="mk-flag">Featured</span>' : ''}${c.saleModel === 'auction' ? '<span class="mk-flag auction">Auction</span>' : c.saleModel === 'negotiated' ? '<span class="mk-flag">Open to offers</span>' : ''}</div>
    <h3>${esc(c.title)}</h3>
    <p class="muted">${esc(c.organizer ?? '')}${c.city ? ` · ${esc(c.city)}` : ''}${c.startsOn ? ` · ${date(c.startsOn)}` : ''}</p>
    <div class="mk-chips">${exposureChips(c.exposure)}</div>
    <dl class="mk-facts"><div><dt>From</dt><dd>${esc(c.from ?? 'On request')}</dd></div><div><dt>Audience*</dt><dd>${c.audienceEstimate ? num(c.audienceEstimate) : '—'}</dd></div><div><dt>Packages</dt><dd>${c.packages}${c.available ? '' : ' · sold out'}</dd></div></dl>
  </a>`;
}

async function ask() {
  const out = app.querySelector('#agent-out') as HTMLElement;
  const msg = (app.querySelector('#agent-q') as HTMLTextAreaElement).value.trim();
  if (!msg) return;
  out.innerHTML = '<p class="muted">Working out the best plan…</p>';
  try {
    const r = await spApi('POST', '/api/sponsorships/agent', { message: msg });
    out.innerHTML = `${r.understood?.length ? `<p class="mk-understood">${r.understood.map((u: string) => `<span class="chip">${esc(u)}</span>`).join('')}</p>` : ''}
      <div class="mk-answer">${esc(r.answer).replace(/\n/g, '<br>')}</div>
      ${r.plan?.picks?.length ? `<ul class="mk-plan">${r.plan.picks.map((p: any) => `<li><a href="/sponsorships/${esc(p.opportunity.slug)}#pkg=${esc(p.package.id)}"><strong>${esc(p.opportunity.title)}</strong><span>${esc(p.package.name)} · ${esc(p.package.price)}</span><em>Match ${p.score}/100</em></a></li>`).join('')}</ul>` : ''}
      <p class="muted small">${r.engine === 'rules' ? 'Rule-based advisor' : `AI explanation (${esc(r.engine)})`} · prices exclude GST · audience figures are organizer estimates</p>`;
  } catch (e: any) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ------------------------------------------------------------------ detail
async function detail(idOrSlug: string) {
  const cur = new URLSearchParams(location.search).get('currency') ?? '';
  const o = await spApi('GET', `/api/sponsorship-opportunities/${encodeURIComponent(idOrSlug)}${cur ? `?currency=${cur}` : ''}`).catch((e) => {
    app.innerHTML = `${header('discover')}<div class="empty"><h1>Not found</h1><p>${esc(e.message)}</p><p><a href="/sponsorships">Browse sponsorships</a></p></div>`;
    return null;
  });
  if (!o) return;
  document.title = `${o.title} — sponsorship`;
  const dates = o.startsOn ? `${date(o.startsOn)}${o.endsOn ? ` – ${date(o.endsOn)}` : ''}` : 'Dates to be confirmed';
  app.innerHTML = `${header('discover')}
  <section class="mk-detail-hero">
    <a class="crumb" href="/sponsorships">← All sponsorships</a>
    <p class="eyebrow">${esc(title(o.sport ?? 'Multi-sport'))} · ${esc(title(o.level))} level</p>
    <h1>${esc(o.title)}</h1>
    <p class="mk-sub">${esc(o.organizer)}${o.city ? ` · ${esc(o.city)}${o.state ? `, ${esc(o.state)}` : ''}` : ''} · ${dates}</p>
    <div class="mk-chips">${exposureChips(o.exposure)}</div>
  </section>
  <div class="mk-detail">
    <section class="mk-main">
      ${o.description ? `<div class="card"><h2>About</h2><p class="pre">${esc(o.description)}</p></div>` : ''}
      <div class="card mk-factsheet"><h2>What the platform knows</h2>
        <dl class="mk-facts big">
          <div><dt>Matches scheduled</dt><dd>${num(o.facts.matches)}</dd></div>
          <div><dt>Venues</dt><dd>${o.facts.venues.length ? o.facts.venues.map(esc).join(', ') : '—'}</dd></div>
          <div><dt>Paired screens</dt><dd>${num(o.facts.screens)}</dd></div>
          <div><dt>Audience (organizer estimate)</dt><dd>${o.audienceEstimate ? num(o.audienceEstimate) : '—'}</dd></div>
          ${o.audienceProfile?.ageGroups?.length ? `<div><dt>Audience age</dt><dd>${o.audienceProfile.ageGroups.map(esc).join(', ')}</dd></div>` : ''}
          ${o.tournamentCode ? `<div><dt>Live page</dt><dd><a href="/t/${esc(o.tournamentCode)}" target="_blank" rel="noopener">See it live</a></dd></div>` : ''}
        </dl>
        <p class="muted small">Screens, live pages and overlays are served by Sports Diary, so your exposure is measured, not estimated. Audience size is the organizer's estimate.</p>
      </div>
      <h2 class="section">Packages</h2>
      <div class="mk-packages">${o.packages.map((p: any) => pkgCard(o, p)).join('') || '<p class="muted">This opportunity is open to proposals. Send an enquiry.</p>'}</div>
      <p class="muted small">Prices exclude ${o.terms.taxRateBps / 100}% GST${o.terms.platformFeeMinor ? ` and a ${esc(o.terms.platformFee)} platform fee` : ''}. International sponsors billed in foreign currency are zero-rated.</p>
    </section>
    <aside class="mk-side card">
      <h2>How it works</h2>
      <ol class="mk-steps"><li>Pick a package and upload your logo</li><li>Accept the agreement and pay by UPI, card, net banking or wallet</li><li>Payment is verified with the payment provider — then your branding goes live automatically</li><li>Track screen time, impressions, QR scans and clicks in your dashboard</li></ol>
      ${o.saleModel === 'rfp' || o.saleModel === 'negotiated' ? '<button class="btn btn-primary" data-enquire="">Send an enquiry</button>' : ''}
      <p class="muted small">Questions? <button class="link" data-enquire="">Message the organizer</button></p>
    </aside>
  </div>`;

  app.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const buy = el.closest<HTMLElement>('[data-buy]');
    const bid = el.closest<HTMLElement>('[data-bid]');
    const enq = el.closest<HTMLElement>('[data-enquire]');
    if (buy) return needSponsor() && buySheet(o, o.packages.find((p: any) => p.id === buy.dataset.buy));
    if (bid) return needSponsor() && bidSheet(o, o.packages.find((p: any) => p.id === bid.dataset.bid));
    if (enq) return needSponsor() && enquirySheet(o, enq.dataset.enquire ? o.packages.find((p: any) => p.id === enq.dataset.enquire) : null);
  });
  const want = location.hash.match(/(?:buy|pkg)=([\w-]+)/)?.[1];
  if (want) {
    document.getElementById(`pkg-${want}`)?.scrollIntoView({ block: 'center' });
    if (location.hash.startsWith('#buy') && me) {
      const p = o.packages.find((x: any) => x.id === want);
      if (p) buySheet(o, p);
    }
  }
}

function pkgCard(o: any, p: any) {
  const model = p.saleModel ?? o.saleModel;
  const soldOut = p.remaining <= 0;
  const a = p.auction;
  return `<article class="mk-pkg tier-${esc(p.tier ?? 'custom')}" id="pkg-${esc(p.id)}">
    <header><h3>${esc(p.name)}</h3>${p.tier ? `<span class="mk-tier">${esc(title(p.tier))}</span>` : ''}</header>
    ${model === 'auction' && a ? `<p class="mk-price">${esc(a.current)}<small> current bid · ${a.bids} bid${a.bids === 1 ? '' : 's'}</small></p><p class="muted small">Ends ${new Date(a.endsAt).toLocaleString('en-IN')}${a.status !== 'open' ? ` · ${esc(a.status)}` : ''}</p>`
      : `<p class="mk-price">${esc(p.price ?? 'On request')}${p.approxPrice ? `<small> ${esc(p.approxPrice)}</small>` : ''}</p>`}
    ${p.description ? `<p>${esc(p.description)}</p>` : ''}
    <ul class="mk-items">${p.items.map((i: any) => `<li>${esc(i.label)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}${i.deliverable ? ' <small>(delivered by organizer)</small>' : ' <small class="auto">auto</small>'}</li>`).join('')}</ul>
    <div class="mk-chips">${exposureChips(p.exposure)}</div>
    <footer><span class="muted small">${soldOut ? 'Sold out' : `${p.remaining} of ${p.maxSponsors} slot${p.maxSponsors === 1 ? '' : 's'} left`}${p.durationDays ? ` · ${p.durationDays} days` : ''}</span>
      ${soldOut ? '' : model === 'auction' ? (a?.status === 'open' ? `<button class="btn btn-primary" data-bid="${esc(p.id)}">Place a bid</button>` : '') : model === 'rfp' || p.priceMinor == null ? `<button class="btn btn-primary" data-enquire="${esc(p.id)}">Request proposal</button>`
        : `<span class="mk-buy">${model === 'negotiated' ? `<button class="btn" data-enquire="${esc(p.id)}">Make an offer</button>` : ''}<button class="btn btn-primary" data-buy="${esc(p.id)}">Sponsor now</button></span>`}
    </footer></article>`;
}

function needSponsor() {
  if (!me) {
    location.href = `/sponsor?next=${encodeURIComponent(location.pathname + location.hash)}#signup`;
    return false;
  }
  if (!me.memberships.length) {
    location.href = `/sponsor#create`;
    return false;
  }
  return true;
}

async function buySheet(o: any, p: any) {
  const [assets, quote, acct] = await Promise.all([
    spApi('GET', '/api/sponsor/assets'),
    spApi('POST', '/api/sponsorship-orders/quote', { opportunityId: o.id, packageId: p.id }),
    spApi('GET', '/api/sponsor/account'),
  ]).catch((e) => (toast(e.message, 'error'), [null, null, null]));
  if (!assets) return;
  const logos = assets.assets.filter((a: any) => ['logo', 'logo_transparent', 'logo_white', 'logo_dark'].includes(a.kind) && ['ready', 'flagged'].includes(a.status));
  const start = o.startsOn && o.startsOn > new Date().toISOString().slice(0, 10) ? o.startsOn : new Date().toISOString().slice(0, 10);
  const needs = new Set(p.items.flatMap((i: any) => i.assets));
  sheet(`<form class="sheet-body" id="buy">
    <div class="sheet-head"><h2>${esc(p.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="muted">${esc(o.title)} · ${esc(o.organizer)}</p>
    <label>Start date<input type="date" name="startsOn" value="${start}" min="${new Date().toISOString().slice(0, 10)}" ${o.endsOn ? `max="${o.endsOn}"` : ''} required></label>
    <fieldset><legend>Logo shown on screens and pages</legend>
      <div class="pick-logos">${logos.map((a: any, i: number) => `<label class="pick"><input type="radio" name="logo" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}><img src="${esc(a.variants.thumb?.url ?? '')}" alt="${esc(a.name ?? a.kind)}"></label>`).join('')}</div>
      <label class="upload">Upload a new logo (PNG, SVG, JPG or WebP, at least 300 px wide)<input type="file" name="file" accept="image/png,image/svg+xml,image/jpeg,image/webp"></label>
    </fieldset>
    ${needs.has('url') || needs.has('banner') ? `<label>Where should clicks and QR scans go?<input type="url" name="clickUrl" placeholder="https://" value="${esc(acct.website ?? '')}"></label>` : ''}
    <label class="mk-check"><input type="checkbox" name="autoRenew" value="1"> Renew automatically (reminders 30, 14, 7 and 1 day before)</label>
    <table class="quote"><tr><td>Sponsorship</td><td>${esc(quote.display.subtotal)}</td></tr>${quote.platformFee ? `<tr><td>Platform fee</td><td>${esc(quote.display.platformFee)}</td></tr>` : ''}<tr><td>${esc(quote.display.taxLabel)}</td><td>${esc(quote.display.tax)}</td></tr><tr class="total"><td>Total</td><td>${esc(quote.display.total)}</td></tr></table>
    <p class="muted small">We hold this slot for ${quote.holdMinutes} minutes while you pay. Your sponsorship activates only after the payment provider confirms the payment to us.</p>
    <div class="sheet-actions"><button class="btn btn-primary">Continue to payment</button></div>
  </form>`, (dlg) => {
    dlg.querySelector('#buy')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const btn = f.querySelector('button.btn-primary') as HTMLButtonElement;
      btn.disabled = true;
      try {
        let logoId = (f.querySelector('input[name="logo"]:checked') as HTMLInputElement | null)?.value;
        const file = (f.querySelector('input[type="file"]') as HTMLInputElement).files?.[0];
        if (file) logoId = (await uploadAsset('logo', file)).id;
        const d = formData(f);
        const order = await spApi('POST', '/api/sponsorship-orders', {
          opportunityId: o.id, packageId: p.id, startsOn: d.startsOn, assetIds: logoId ? { logo: logoId } : {}, clickUrl: d.clickUrl || undefined, autoRenew: !!d.autoRenew,
          idempotencyKey: `${p.id}:${Date.now().toString(36)}`,
        });
        location.href = `/sponsor#order=${order.id}&pay=1`;
      } catch (err: any) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

function bidSheet(o: any, p: any) {
  const a = p.auction;
  sheet(`<form class="sheet-body" id="bid">
    <div class="sheet-head"><h2>Bid · ${esc(p.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p>Current price <strong>${esc(a.current)}</strong>. Enter the most you're willing to pay — we bid for you only as much as needed to stay ahead${a.reserveMet ? '' : ' (reserve not yet met)'}.</p>
    <label>Your maximum (${esc(p.currency)})<input name="maxAmount" type="number" min="${a.nextMinimumMinor / 100}" step="100" value="${a.nextMinimumMinor / 100}" required></label>
    <p class="muted small">A bid in the last two minutes extends the auction by two minutes. If you win, you'll have 48 hours to pay.</p>
    <div class="sheet-actions"><button class="btn btn-primary">Place bid</button></div></form>`, (dlg) => {
    dlg.querySelector('#bid')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await spApi('POST', `/api/sponsorship-packages/${p.id}/bids`, { maxAmount: formData(e.target as HTMLFormElement).maxAmount });
        toast(r.leading ? `You're the highest bidder at ${r.auction.current}` : `Outbid: current price ${r.auction.current}`, r.leading ? 'ok' : 'error');
        dlg.close();
        detail(parts[1]);
      } catch (err: any) {
        toast(err.message, 'error');
      }
    });
  });
}

function enquirySheet(o: any, p: any | null) {
  const pkgs = o.packages;
  sheet(`<form class="sheet-body" id="enq">
    <div class="sheet-head"><h2>${p ? 'Make an offer' : 'Message the organizer'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <label>Package<select name="packageId"><option value="">General enquiry</option>${pkgs.map((x: any) => `<option value="${esc(x.id)}" ${p?.id === x.id ? 'selected' : ''}>${esc(x.name)}${x.price ? ` (${esc(x.price)})` : ''}</option>`).join('')}</select></label>
    <label>Your offer (${esc(o.currency)}, optional)<input name="offer" type="number" min="1" step="100"></label>
    <label>Message<textarea name="message" rows="4" required minlength="5" placeholder="Tell the organizer about your brand and what you're looking for."></textarea></label>
    <div class="sheet-actions"><button class="btn btn-primary">Send</button></div></form>`, (dlg) => {
    dlg.querySelector('#enq')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(e.target as HTMLFormElement);
      try {
        const t = await spApi('POST', '/api/sponsorship-threads', { opportunityId: o.id, packageId: d.packageId || undefined, offer: d.offer || undefined, message: d.message });
        location.href = `/sponsor#deal=${t.id}`;
      } catch (err: any) {
        toast(err.message, 'error');
      }
    });
  });
}

// ------------------------------------------------------------------ sponsor directory
async function directory() {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const list = await spApi('GET', `/api/sponsors${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  document.title = 'Sponsors — Sports Diary';
  app.innerHTML = `${header('sponsors')}
    <section class="mk-detail-hero"><p class="eyebrow">Sponsor directory</p><h1>Brands backing grassroots sport</h1>
      <form class="mk-inline-search"><input name="q" value="${esc(q)}" placeholder="Search sponsors by name, industry or city"><button class="btn btn-primary">Search</button></form></section>
    <div class="mk-dir">${list.length ? list.map((s: any) => `<a class="mk-sponsor" href="/sponsor/${esc(s.slug)}">${s.logo ? `<img src="${esc(variant(s.logo, 'thumb'))}" alt="">` : `<span class="mk-mono">${esc(s.name.slice(0, 2))}</span>`}<strong>${esc(s.name)}</strong><small>${esc([title(s.industry ?? ''), s.city].filter(Boolean).join(' · '))}</small></a>`).join('') : '<p class="muted">No public sponsor profiles yet.</p>'}</div>`;
}

boot().catch((e) => {
  app.innerHTML = `<div class="empty"><h1>Something went wrong</h1><p>${esc(e.message)}</p></div>`;
});
