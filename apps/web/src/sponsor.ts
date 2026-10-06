/**
 * Sponsor portal (/sponsor) and public sponsor profiles (/sponsor/:slug).
 *
 * Sign-in: password, email code, mobile OTP, Google, Apple. Then: dashboard, sponsorships
 * (pay, creative, documents, renewals), assets, analytics, AI advisor, deals and bids,
 * QR codes, team, billing and profile. Payments open the provider's own checkout; the
 * page never decides that a payment succeeded — it asks the server, which asks the provider.
 */
import { logo } from './lib/brand.ts';
import {
  activeAccount, bars, date, dateTime, esc, exposureChips, formData, gauge, kpi, num, openDoc, session, sheet, spApi, statusPill, title, toast, uploadAsset, variant, STATUS_LABEL,
} from './lib/sp.ts';

const app = document.getElementById('app')!;
const path = location.pathname.split('/').filter(Boolean);
const params = new URLSearchParams(location.search);
let me: any = null;
let account: any = null;
let meta: any = null;
let providers: any = {};

const hashParams = () => new URLSearchParams(location.hash.slice(1));
const can = (perm: 'buy' | 'pay' | 'assets' | 'team' | 'profile' | 'finance') =>
  ({ buy: ['owner', 'admin', 'marketing'], assets: ['owner', 'admin', 'marketing'], pay: ['owner', 'admin', 'finance'], finance: ['owner', 'admin', 'finance'], team: ['owner', 'admin'], profile: ['owner', 'admin'] })[perm].includes(account?.role);

// ================================================================== boot
async function boot() {
  if (path[1]) return publicProfile(decodeURIComponent(path[1]));
  const h = hashParams();
  providers = await spApi('GET', '/api/auth/providers').catch(() => ({}));
  if (h.get('reset')) return renderReset(h.get('reset')!);
  if (!session.token) return renderAuth(location.hash === '#signup' || h.has('invite') ? 'signup' : 'login');
  me = await spApi('GET', '/api/sponsor/me', undefined, { quiet401: true }).catch(() => null);
  if (!me) {
    session.token = null;
    return renderAuth('login');
  }
  if (h.get('invite')) {
    try {
      const r = await spApi('POST', '/api/sponsor/invites/accept', { token: h.get('invite') });
      activeAccount.set(r.sponsorId);
      toast('Invitation accepted');
      me = await spApi('GET', '/api/sponsor/me');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    history.replaceState(null, '', '/sponsor');
  }
  if (!me.memberships.length) return renderCreateAccount();
  const want = activeAccount.get();
  if (!me.memberships.some((m: any) => m.account.id === want)) activeAccount.set(me.memberships[0].account.id);
  meta = await spApi('GET', '/api/sponsorship-meta');
  await loadAccount();
  const next = params.get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) return void (location.href = next);
  window.addEventListener('hashchange', route);
  route();
  pollBell();
}

async function loadAccount() {
  account = await spApi('GET', '/api/sponsor/account');
}

// ================================================================== auth
function authFrame(inner: string) {
  document.body.className = 'console auth sponsor-auth';
  app.innerHTML = `<main class="auth-wrap">
    <section class="auth-pitch">${logo()}
      <h1>Sponsor the games your customers watch.</h1>
      <p>Buy tournament, venue and broadcast sponsorships in minutes. Your logo goes live on venue screens and live score pages as soon as your payment is confirmed — with real exposure numbers, not guesses.</p>
      <p><a href="/sponsorships" class="btn">Browse sponsorships</a></p>
    </section>
    <div class="auth-card card" id="auth-card">${inner}</div></main>`;
}

function renderAuth(mode: 'login' | 'signup' | 'code' | 'sms' | 'forgot') {
  const sso = providers.google || providers.apple ? `<div class="sso">${providers.google ? '<div id="g-btn"></div>' : ''}${providers.apple ? '<button class="btn" type="button" id="apple-btn"> Continue with Apple</button>' : ''}</div><p class="or"><span>or</span></p>` : '';
  const tabs = `<nav class="auth-tabs"><button type="button" data-mode="login" class="${['login', 'code', 'sms'].includes(mode) ? 'on' : ''}">Sign in</button><button type="button" data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Create account</button></nav>`;
  let body = '';
  if (mode === 'login') body = `${sso}<form id="f"><label>Email<input name="email" type="email" required autocomplete="email"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button class="btn btn-primary">Sign in</button></form>
    <p class="muted"><button class="link" data-mode="code">Email me a code</button> · <button class="link" data-mode="sms">Use mobile OTP</button> · <button class="link" data-mode="forgot">Forgot password?</button></p>`;
  if (mode === 'code' || mode === 'sms') body = `<form id="f"><label>${mode === 'code' ? 'Email' : 'Mobile number with country code'}<input name="destination" ${mode === 'code' ? 'type="email" autocomplete="email"' : 'type="tel" placeholder="+91 98765 43210" autocomplete="tel"'} required></label>
    <div id="code-step" hidden><label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></label></div>
    <button class="btn btn-primary" id="code-btn">Send code</button></form><p class="muted"><button class="link" data-mode="login">Use password instead</button></p>`;
  if (mode === 'forgot') body = `<form id="f"><p>We'll email you a link to set a new password.</p><label>Email<input name="email" type="email" required></label><button class="btn btn-primary">Send reset link</button></form><p class="muted"><button class="link" data-mode="login">Back to sign in</button></p>`;
  if (mode === 'signup') body = `${sso}<form id="f" class="signup">
    <fieldset class="seg"><label><input type="radio" name="kind" value="organization" checked> Company / brand</label><label><input type="radio" name="kind" value="individual"> Individual</label></fieldset>
    <label>Your name<input name="personName" required autocomplete="name"></label>
    <label class="org-only">Company or brand name<input name="accountName" autocomplete="organization"></label>
    <label>Work email<input name="email" type="email" required autocomplete="email"></label>
    <label>Mobile (optional)<input name="phone" type="tel" placeholder="+91 98765 43210" autocomplete="tel"></label>
    <label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <div class="two"><label>City<input name="city" autocomplete="address-level2"></label><label>Country<input name="country" value="India" autocomplete="country-name"></label></div>
    <button class="btn btn-primary">Create sponsor account</button>
    <p class="muted small">By creating an account you agree to the marketplace terms. Organizers see your brand name and logo when you sponsor them.</p></form>`;
  authFrame(`${tabs}<h2>${({ login: 'Welcome back', signup: 'Start sponsoring', code: 'Sign in with an email code', sms: 'Sign in with mobile OTP', forgot: 'Reset your password' } as any)[mode]}</h2>${body}`);

  app.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode as any)));
  const f = app.querySelector<HTMLFormElement>('#f')!;
  const done = (token: string) => {
    session.token = token;
    const inviteHash = hashParams().get('invite');
    location.href = params.get('next') && !inviteHash ? params.get('next')! : `/sponsor${inviteHash ? `#invite=${inviteHash}` : ''}`;
    setTimeout(() => location.reload(), 50);
  };
  if (mode === 'signup') {
    const toggle = () => (app.querySelector('.org-only') as HTMLElement).toggleAttribute('hidden', (f.querySelector('input[name="kind"]:checked') as HTMLInputElement).value === 'individual');
    f.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', toggle));
  }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    try {
      if (mode === 'login') return done((await spApi('POST', '/api/auth/login', d)).token);
      if (mode === 'forgot') {
        await spApi('POST', '/api/auth/forgot', d);
        app.querySelector('#auth-card')!.innerHTML = '<h2>Check your email</h2><p>If an account exists for that address, a reset link is on its way. It expires in 30 minutes.</p><p><button class="link" data-mode="login">Back to sign in</button></p>';
        app.querySelector('[data-mode]')?.addEventListener('click', () => renderAuth('login'));
        return;
      }
      if (mode === 'code' || mode === 'sms') {
        const channel = mode === 'code' ? 'email' : 'sms';
        const step = app.querySelector('#code-step') as HTMLElement;
        if (step.hidden) {
          await spApi('POST', '/api/auth/otp/send', { channel, destination: d.destination, purpose: 'login' });
          step.hidden = false;
          (app.querySelector('#code-btn') as HTMLElement).textContent = 'Verify and sign in';
          (step.querySelector('input') as HTMLInputElement).focus();
          toast('If that account exists, a code is on its way');
          return;
        }
        return done((await spApi('POST', '/api/auth/otp/verify', { channel, destination: d.destination, code: d.code, purpose: 'login' })).token);
      }
      const r = await spApi('POST', '/api/auth/sponsor-signup', { ...d, name: d.kind === 'individual' ? d.personName : d.accountName || d.personName, accountName: d.kind === 'individual' ? d.personName : d.accountName });
      activeAccount.set(r.account.id);
      done(r.token);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  wireSso(done);
}

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

function wireSso(done: (t: string) => void) {
  if (providers.google && document.getElementById('g-btn')) {
    loadScript('https://accounts.google.com/gsi/client').then(() => {
      const g = (window as any).google?.accounts?.id;
      g?.initialize({ client_id: providers.google, callback: async (resp: any) => {
        try {
          done((await spApi('POST', '/api/auth/oauth/google', { idToken: resp.credential })).token);
        } catch (e: any) {
          toast(e.message, 'error');
        }
      } });
      g?.renderButton(document.getElementById('g-btn'), { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
    }).catch(() => {});
  }
  document.getElementById('apple-btn')?.addEventListener('click', async () => {
    try {
      await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
      const A = (window as any).AppleID;
      A.auth.init({ clientId: providers.apple, scope: 'name email', redirectURI: `${location.origin}/sponsor`, usePopup: true });
      const r = await A.auth.signIn();
      done((await spApi('POST', '/api/auth/oauth/apple', { idToken: r.authorization.id_token })).token);
    } catch (e: any) {
      if (e?.error !== 'popup_closed_by_user') toast(e.message ?? 'Apple sign-in failed', 'error');
    }
  });
}

function renderReset(token: string) {
  authFrame(`<h2>Choose a new password</h2><form id="f"><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn btn-primary">Save and sign in</button></form>`);
  app.querySelector('#f')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await spApi('POST', '/api/auth/reset', { token, password: formData(e.target as HTMLFormElement).password });
      session.token = r.token;
      location.href = '/sponsor';
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

function renderCreateAccount() {
  authFrame(`<h2>Create your sponsor account</h2><p class="muted">Signed in as ${esc(me.user.email)}.</p>
    <form id="f"><fieldset class="seg"><label><input type="radio" name="kind" value="organization" checked> Company / brand</label><label><input type="radio" name="kind" value="individual"> Individual</label></fieldset>
    <label>Name shown to organizers<input name="name" required></label><label>City<input name="city"></label><button class="btn btn-primary">Create</button></form>`);
  app.querySelector('#f')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const a = await spApi('POST', '/api/sponsors', formData(e.target as HTMLFormElement));
      activeAccount.set(a.id);
      location.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ================================================================== shell
const NAV: [string, string][] = [['', 'Dashboard'], ['orders', 'Sponsorships'], ['analytics', 'Analytics'], ['advisor', 'AI advisor'], ['deals', 'Offers & bids'], ['assets', 'Brand assets'], ['qr', 'QR codes'], ['billing', 'Billing'], ['team', 'Team'], ['profile', 'Profile']];

function shell(active: string, body: string) {
  document.body.className = 'console sponsor-portal';
  app.innerHTML = `<div class="shell">
    <aside class="nav">${logo()}
      ${me.memberships.length > 1 ? `<select class="acct-switch" aria-label="Sponsor account">${me.memberships.map((m: any) => `<option value="${esc(m.account.id)}" ${m.account.id === account.id ? 'selected' : ''}>${esc(m.account.name)}</option>`).join('')}</select>` : `<p class="org-name">${esc(account.name)}</p>`}
      ${account.status !== 'active' ? `<p class="acct-status">${esc(title(account.status))}${account.statusReason ? `: ${esc(account.statusReason)}` : ''}</p>` : ''}
      <nav>${NAV.map(([id, label]) => `<a href="#${id}" class="${id === active ? 'active' : ''}">${label}</a>`).join('')}<a href="/sponsorships">Find sponsorships ↗</a></nav>
      <div class="nav-foot"><span>${esc(me.user.name)}<small>${esc(account.role)}</small></span><button class="bell" data-cmd="bell" aria-label="Notifications">🔔<b id="bell-n" hidden></b></button><button class="link" data-cmd="logout">Sign out</button></div>
    </aside>
    <main class="main" id="main">${body}</main></div>`;
  app.querySelector('.acct-switch')?.addEventListener('change', (e) => {
    activeAccount.set((e.target as HTMLSelectElement).value);
    location.hash = '';
    location.reload();
  });
  app.querySelector('[data-cmd="logout"]')!.addEventListener('click', async () => {
    await spApi('POST', '/api/auth/logout').catch(() => {});
    session.token = null;
    activeAccount.set(null);
    location.href = '/sponsor';
  });
  app.querySelector('[data-cmd="bell"]')!.addEventListener('click', bell);
  updateBell();
}

let bellCount = 0;
async function updateBell() {
  const n = await spApi('GET', '/api/notifications').catch(() => null);
  if (!n) return;
  bellCount = n.unread;
  const b = document.getElementById('bell-n');
  if (b) (b.hidden = !n.unread), (b.textContent = String(n.unread));
}
function pollBell() {
  setInterval(() => document.visibilityState === 'visible' && updateBell(), 30_000);
}
async function bell() {
  const n = await spApi('GET', '/api/notifications');
  sheet(`<div class="sheet-body"><div class="sheet-head"><h2>Notifications</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    ${n.items.length ? `<ul class="notes">${n.items.map((x: any) => `<li class="${x.readAt ? '' : 'unread'}"><strong>${esc(x.title)}</strong><p>${esc(x.body)}</p><small>${dateTime(x.at)}${x.link ? ` · <a href="${esc(x.link)}" data-close>Open</a>` : ''}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>`);
  if (bellCount) await spApi('POST', '/api/notifications/read', {}).catch(() => {});
  updateBell();
}

async function route() {
  const h = hashParams();
  const page = location.hash.slice(1).split(/[=&/]/)[0];
  try {
    if (h.get('order')) return await orderPage(h.get('order')!, h.get('pay') === '1');
    if (h.get('deal')) return await dealPage(h.get('deal')!);
    if (page === 'orders') return await ordersPage();
    if (page === 'analytics') return await analyticsPage();
    if (page === 'advisor') return advisorPage();
    if (page === 'deals') return await dealsPage();
    if (page === 'assets') return await assetsPage();
    if (page === 'qr') return await qrPage();
    if (page === 'billing') return await billingPage();
    if (page === 'team') return await teamPage();
    if (page === 'profile') return await profilePage();
    if (page === 'create') return renderCreateAccount();
    return await dashboard();
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

// ================================================================== dashboard
async function dashboard() {
  const d = await spApi('GET', '/api/sponsor/dashboard');
  const t = d.analytics.totals;
  const active = d.orders.filter((o: any) => o.status === 'ACTIVE');
  shell('', `<header class="page-head"><div><h1>${esc(account.name)}</h1><p class="muted">${active.length} active sponsorship${active.length === 1 ? '' : 's'}${d.analytics.spend.length ? ` · ${d.analytics.spend.map((s: any) => s.amount).join(' + ')} invested` : ''}</p></div>
    <div class="head-actions"><a class="btn" href="#advisor">Ask the advisor</a><a class="btn btn-primary" href="/sponsorships">Find sponsorships</a></div></header>
    ${d.actions.length ? `<div class="card actions"><h2>Needs your attention</h2><ul>${d.actions.map((a: any) => `<li><a href="#order=${esc(a.orderId)}${a.kind === 'pay' ? '&pay=1' : ''}">${esc(a.text)}</a></li>`).join('')}</ul></div>` : ''}
    <div class="kpis">
      ${kpi('Exposure score', `${t.score}<small>/100</small>`, '<a href="#analytics">How it’s calculated</a>')}
      ${kpi('Estimated reach', num(t.estimatedReach), 'people')}
      ${kpi('Screen time', `${t.tvHours} h`, `${num(t.screens)} screen-days`)}
      ${kpi('Page impressions', num(t.live_impressions), `${num(t.unique_viewers)} unique viewers`)}
      ${kpi('QR scans', num(t.qr_scans), `${num(t.clicks)} clicks`)}
      ${kpi('Matches covered', num(d.analytics.matchesCovered))}
    </div>
    <div class="two-col">
      <div class="card"><h2>Last 30 days</h2>${bars(d.analytics.series.map((s: any) => ({ label: s.day.slice(5), value: s.impressions + s.tvMinutes })), { unit: ' impressions + screen-minutes' })}</div>
      <div class="card"><h2>Sponsorships</h2>${ordersTable(d.orders.slice(0, 8))}<p><a href="#orders">All sponsorships →</a></p></div>
    </div>
    ${d.bids.length ? `<div class="card"><h2>Your bids</h2>${bidsTable(d.bids)}</div>` : ''}`);
}

function ordersTable(list: any[]) {
  if (!list.length) return '<p class="muted">No sponsorships yet. <a href="/sponsorships">Browse the marketplace</a>.</p>';
  return `<table class="table"><thead><tr><th>Sponsorship</th><th>Status</th><th>Period</th><th class="r">Total</th></tr></thead><tbody>${list.map((o) => `<tr><td><a href="#order=${esc(o.id)}"><strong>${esc(o.opportunity)}</strong></a><br><small class="muted">${esc(o.package ?? '')} · ${esc(o.number)}</small></td><td>${statusPill(o.status)}</td><td>${date(o.startsOn)} – ${date(o.endsOn)}</td><td class="r">${esc(o.total)}</td></tr>`).join('')}</tbody></table>`;
}

function bidsTable(bids: any[]) {
  return `<table class="table"><thead><tr><th>Package</th><th>Your max</th><th>Current</th><th>Ends</th><th></th></tr></thead><tbody>${bids.map((b: any) => `<tr><td><a href="/sponsorships/${esc(b.opportunityId)}#pkg=${esc(b.packageId)}">${esc(b.package)}</a></td><td>${esc(b.yourMax)}</td><td>${esc(b.auction.current)}</td><td>${dateTime(b.auction.endsAt)}</td><td>${b.result === 'open' ? (b.leading ? '<span class="sp-status tone-ok">Leading</span>' : '<span class="sp-status tone-bad">Outbid</span>') : `<span class="sp-status tone-quiet">${esc(title(b.result))}</span>`}</td></tr>`).join('')}</tbody></table>`;
}

// ================================================================== sponsorships
async function ordersPage() {
  const status = hashParams().get('status') ?? '';
  const list = await spApi('GET', `/api/sponsorship-orders${status ? `?status=${status}` : ''}`);
  shell('orders', `<header class="page-head"><h1>Sponsorships</h1><a class="btn btn-primary" href="/sponsorships">Find more</a></header>
    <nav class="filter-tabs">${[['', 'All'], ['ACTIVE', 'Active'], ['PENDING_PAYMENT,DRAFT', 'To pay'], ['PAYMENT_RECEIVED,PENDING_APPROVAL,ASSET_REVIEW', 'In review'], ['EXPIRED', 'Ended'], ['CANCELLED,REFUNDED', 'Cancelled']].map(([v, l]) => `<a href="#orders${v ? `&status=${v}` : ''}" class="${status === v ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <div class="card">${ordersTable(list)}</div>`);
}

const STEPS = ['PENDING_PAYMENT', 'PAYMENT_RECEIVED', 'ACTIVE', 'EXPIRED'];
async function orderPage(id: string, openPay: boolean) {
  const o = await spApi('GET', `/api/sponsorship-orders/${id}`);
  const m = o.metrics;
  const step = o.status === 'PENDING_APPROVAL' || o.status === 'ASSET_REVIEW' ? 1 : Math.max(0, STEPS.indexOf(o.status === 'PAUSED' ? 'ACTIVE' : o.status));
  // a checkout opened in the last few minutes may still be completing at the provider
  const awaiting = !openPay && o.status === 'PENDING_PAYMENT' && o.payments.some((p: any) => p.status === 'created' && Date.now() - Date.parse(p.createdAt) < 3 * 60e3);
  shell('orders', `<a class="crumb" href="#orders">← Sponsorships</a>
    <header class="page-head"><div><h1>${esc(o.opportunity.title)}</h1><p class="muted">${esc(o.package?.name ?? '')} · ${esc(o.organizer)} · ${esc(o.number)}</p></div>
      <div class="head-actions">${statusPill(o.status)}
        ${['DRAFT', 'PENDING_PAYMENT'].includes(o.status) && can('pay') ? '<button class="btn btn-primary" data-cmd="pay">Pay now</button>' : ''}
        ${['ACTIVE', 'PAUSED', 'EXPIRED'].includes(o.status) && can('pay') ? '<button class="btn" data-cmd="renew">Renew</button>' : ''}
        ${['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_RECEIVED', 'PENDING_APPROVAL', 'ASSET_REVIEW'].includes(o.status) && can('buy') ? '<button class="btn btn-quiet" data-cmd="cancel">Cancel</button>' : ''}</div></header>
    <ol class="progress">${['Payment', 'Verified & reviewed', 'Live', 'Completed'].map((l, i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}">${l}</li>`).join('')}</ol>
    ${awaiting ? '<div class="card notice" id="awaiting"><strong>Waiting for confirmation from the payment provider…</strong> <span class="muted">This usually takes a few seconds. You can leave this page; we’ll email you.</span></div>' : ''}
    ${o.holdExpiresAt ? `<p class="muted">Your slot is held until ${dateTime(o.holdExpiresAt)}.</p>` : ''}
    <div class="two-col">
      <div class="card"><h2>Summary</h2><dl class="dl">
        <dt>Period</dt><dd>${date(o.startsOn)} – ${date(o.endsOn)}</dd>
        <dt>Sponsorship</dt><dd>${esc(o.amounts.subtotal)}</dd>${o.platformFeeMinor ? `<dt>Platform fee</dt><dd>${esc(o.amounts.platformFee)}</dd>` : ''}
        <dt>Tax</dt><dd>${esc(o.amounts.tax)}</dd><dt>Total</dt><dd><strong>${esc(o.amounts.total)}</strong></dd>
        <dt>Auto-renew</dt><dd><label class="switch"><input type="checkbox" data-cmd="autorenew" ${o.autoRenew ? 'checked' : ''} ${can('pay') ? '' : 'disabled'}> ${o.autoRenew ? 'On' : 'Off'}</label></dd>
        ${o.clickUrl ? `<dt>Click-through</dt><dd><a href="${esc(o.clickUrl)}" target="_blank" rel="noopener">${esc(o.clickUrl)}</a></dd>` : ''}
        ${o.qr ? `<dt>Tracked QR</dt><dd><a href="#qr">${esc(o.qr.code)}</a></dd>` : ''}</dl>
        <h3>Benefits</h3><ul class="mk-items">${o.items.map((i: any) => `<li>${esc(i.label)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}${i.deliverable ? ' <small>(delivered by organizer)</small>' : ' <small class="auto">auto</small>'}</li>`).join('')}</ul></div>
      <div class="card"><h2>Performance</h2>
        ${o.status === 'ACTIVE' || o.status === 'EXPIRED' || o.status === 'PAUSED' ? `<div class="score-row">${gauge(m.score)}<dl class="dl"><dt>Estimated reach</dt><dd>${num(m.estimatedReach)}</dd><dt>Screen time</dt><dd>${m.tvHours} h on ${num(m.screens)} screen-days</dd><dt>Page impressions</dt><dd>${num(m.live_impressions)} (${num(m.unique_viewers)} unique)</dd><dt>Clicks / QR scans</dt><dd>${num(m.clicks)} / ${num(m.qr_scans)}</dd><dt>Matches covered</dt><dd>${num(m.matchesCovered)}</dd>${m.costPerThousandReach ? `<dt>Cost per 1,000 reached</dt><dd>${esc(m.costPerThousandReach)}</dd>` : ''}</dl></div>` : '<p class="muted">Numbers appear here once your sponsorship is live.</p>'}
        <h3>Where you appear</h3>${o.placements.length ? `<ul class="chips">${[...new Set(o.placements.map((p: any) => p.surface))].map((s: any) => `<li>${esc(title(s))}</li>`).join('')}</ul>` : '<p class="muted">Placements are created automatically when the sponsorship activates.</p>'}</div>
    </div>
    <div class="card"><h2>Creative</h2><div class="creative">${o.assets.map((a: any) => `<figure class="${esc(a.status)}">${a.preview ? `<img src="${esc(a.preview)}" alt="">` : `<blockquote>${esc(a.text ?? '')}</blockquote>`}<figcaption><strong>${esc(title(a.role))}</strong> ${statusTag(a.status)}${a.note ? `<br><small>${esc(a.note)}</small>` : ''}${a.proposedAssetId ? '<br><small>Replacement awaiting organizer review</small>' : ''}</figcaption></figure>`).join('') || '<p class="muted">No creative attached yet.</p>'}</div>
      ${can('assets') && !['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status) ? '<button class="btn" data-cmd="assets">Change creative or link</button>' : ''}</div>
    ${o.deliverables.length ? `<div class="card"><h2>Organizer deliverables</h2><table class="table"><tbody>${o.deliverables.map((d: any) => `<tr><td>${esc(d.label)}</td><td>${statusTag(d.status)}</td><td>${d.proofUrl ? `<a href="${esc(d.proofUrl)}" target="_blank" rel="noopener noreferrer">Proof</a>` : ''}${d.note ? ` <small class="muted">${esc(d.note)}</small>` : ''}</td><td>${d.deliveredAt ? date(d.deliveredAt) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="two-col">
      <div class="card"><h2>Documents</h2><ul class="docs">${o.documents.map((d: any) => `<li><span>${esc(title(d.kind))}${d.version > 1 ? ` v${d.version}` : ''}<small class="muted"> · ${date(d.createdAt)}${d.kind === 'agreement' && d.acceptedAt ? ' · accepted' : ''}</small></span><span><button class="link" data-doc="${esc(d.id)}">View</button> · <button class="link" data-pdf="${esc(d.id)}">PDF</button></span></li>`).join('')}</ul></div>
      <div class="card"><h2>Payments & history</h2>
        ${o.payments.length ? `<table class="table"><tbody>${o.payments.map((p: any) => `<tr><td>${esc(title(p.provider))}${p.method ? ` · ${esc(p.method)}` : ''}</td><td>${esc(p.amount)}</td><td>${statusTag(p.status)}</td><td>${dateTime(p.capturedAt ?? p.createdAt)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${o.refunds.length ? `<h3>Refunds</h3><table class="table"><tbody>${o.refunds.map((r: any) => `<tr><td>${esc(r.amount)}</td><td>${statusTag(r.status)}</td><td>${esc(r.reason ?? '')}</td></tr>`).join('')}</tbody></table>` : ''}
        <ol class="events">${o.events.map((e: any) => `<li><time>${dateTime(e.at)}</time> ${esc(STATUS_LABEL[e.to] ?? e.to)}${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('')}</ol></div>
    </div>`);

  const main = app.querySelector('#main')!;
  main.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const cmd = el.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    const doc = el.closest<HTMLElement>('[data-doc]')?.dataset.doc;
    const pdf = el.closest<HTMLElement>('[data-pdf]')?.dataset.pdf;
    if (doc) return openDoc(o.id, doc);
    if (pdf) return openDoc(o.id, pdf, true);
    try {
      if (cmd === 'pay') return payFlow(o);
      if (cmd === 'renew') {
        const r = await spApi('POST', `/api/sponsorships/${o.id}/renew`, {});
        location.hash = `order=${r.id}&pay=1`;
      }
      if (cmd === 'cancel' && confirm(o.status === 'PENDING_PAYMENT' || o.status === 'DRAFT' ? 'Cancel this order and release the slot?' : 'Cancel before activation? You will get a full refund.')) {
        await spApi('POST', `/api/sponsorship-orders/${o.id}/cancel`, {});
        toast('Cancelled');
        route();
      }
      if (cmd === 'assets') assetsSheet(o);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  main.querySelector('[data-cmd="autorenew"]')?.addEventListener('change', async (e) => {
    try {
      await spApi('PATCH', `/api/sponsorship-orders/${o.id}`, { autoRenew: (e.target as HTMLInputElement).checked });
      toast('Saved');
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  if (awaiting) pollPayment(o.id);
  if (openPay && ['DRAFT', 'PENDING_PAYMENT'].includes(o.status)) {
    history.replaceState(null, '', `#order=${o.id}`);
    payFlow(o);
  }
}

const statusTag = (s: string) => `<span class="sp-status tone-${({ approved: 'ok', delivered: 'ok', captured: 'ok', processed: 'ok', ready: 'ok', pending: 'warn', requested: 'warn', scheduled: 'info', created: 'warn', rejected: 'bad', failed: 'bad', missed: 'bad', refunded: 'quiet', partially_refunded: 'quiet', flagged: 'warn', blocked: 'bad' } as any)[s] ?? 'quiet'}">${esc(title(s))}</span>`;

let pollTimer: any = null;
function pollPayment(id: string, tries = 0) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!location.hash.includes(id)) return;
    const o = await spApi('POST', `/api/sponsorship-orders/${id}/confirm`, {}).catch(() => null);
    if (o && o.status !== 'PENDING_PAYMENT') {
      toast(o.status === 'ACTIVE' ? 'Payment confirmed — you’re live!' : 'Payment confirmed');
      return route();
    }
    if (tries < 20) pollPayment(id, tries + 1);
    else document.getElementById('awaiting')?.insertAdjacentHTML('beforeend', '<p class="muted">Still waiting. If money left your account, it will be matched automatically when the provider notifies us.</p>');
  }, tries < 5 ? 1500 : 4000);
}

async function payFlow(o: any) {
  const ag = await spApi('GET', `/api/sponsorship-orders/${o.id}/agreement`);
  const doc = new DOMParser().parseFromString(ag.html, 'text/html');
  doc.querySelectorAll('script, style, link').forEach((x) => x.remove());
  sheet(`<form class="sheet-body wide" id="pay">
    <div class="sheet-head"><h2>Review & pay</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="agreement">${doc.body.innerHTML}</div>
    <label class="mk-check"><input type="checkbox" name="accept" required> I have read the sponsorship agreement and accept it on behalf of ${esc(String(account.name).replace(/\.$/, ''))}.</label>
    <p class="muted small">Agreement fingerprint (SHA-256): <code>${esc(ag.sha256.slice(0, 16))}…</code>. We record who accepted it, when and from where.</p>
    <div class="sheet-actions"><button class="btn btn-primary">Pay ${esc(o.amounts.total)}</button></div></form>`, (dlg) => {
    dlg.querySelector('#pay')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = dlg.querySelector('button.btn-primary') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Opening secure checkout…';
      try {
        const r = await spApi('POST', `/api/sponsorship-orders/${o.id}/pay`, { acceptAgreement: true, agreementSha256: ag.sha256 });
        dlg.close();
        await openCheckout(r, o);
      } catch (err: any) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = `Pay ${o.amounts.total}`;
      }
    });
  });
}

async function openCheckout(r: any, o: any) {
  const c = r.client;
  if (c.redirectUrl) return void (location.href = c.redirectUrl); // sandbox, Stripe Checkout, payment links
  if (c.provider === 'razorpay') {
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    const rz = new (window as any).Razorpay({
      key: c.keyId, order_id: c.orderId, amount: c.amount, currency: c.currency, name: c.name ?? 'Sports Diary', description: c.description, prefill: c.prefill, theme: { color: '#062547' },
      handler: () => {
        // the handler's signature is only a hint; the order is confirmed server-side (webhook or provider API)
        location.hash = `order=${o.id}`;
        route();
      },
      modal: { ondismiss: () => route() },
    });
    rz.open();
    return;
  }
  if (c.provider === 'cashfree') {
    await loadScript('https://sdk.cashfree.com/js/v3/cashfree.js');
    (window as any).Cashfree({ mode: c.mode === 'production' ? 'production' : 'sandbox' }).checkout({ paymentSessionId: c.paymentSessionId, redirectTarget: '_self' });
    return;
  }
  toast('This payment method is not available in your browser', 'error');
}

async function assetsSheet(o: any) {
  const lib = await spApi('GET', '/api/sponsor/assets');
  const roles = [['logo', ['logo', 'logo_transparent', 'logo_white', 'logo_dark']], ['logo_dark', ['logo_dark', 'logo_white', 'logo_transparent', 'logo']], ['banner', ['banner', 'promo_image']], ['video', ['video']], ['copy', ['ad_copy']]] as [string, string[]][];
  sheet(`<form class="sheet-body wide" id="cr"><div class="sheet-head"><h2>Creative for ${esc(o.number)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    ${roles.map(([role, kinds]) => {
      const opts = lib.assets.filter((a: any) => kinds.includes(a.kind) && !['blocked', 'deleted'].includes(a.status));
      const cur = o.assets.find((x: any) => x.role === role);
      return `<label>${esc(title(role))}<select name="${role}"><option value="">${cur ? 'Keep current' : '— none —'}</option>${opts.map((a: any) => `<option value="${esc(a.id)}">${esc(a.name ?? a.kind)} · ${esc(title(a.kind))}${a.status !== 'ready' ? ` (${a.status})` : ''}</option>`).join('')}</select></label>`;
    }).join('')}
    <label>Click-through / QR link<input type="url" name="clickUrl" value="${esc(o.clickUrl ?? '')}" placeholder="https://"></label>
    <p class="muted small">Upload new files in <a href="#assets" data-close>Brand assets</a>. ${o.opportunity.approvalMode === 'auto' ? 'Changes to a live sponsorship apply immediately.' : 'The organizer reviews changes before they go live.'}</p>
    <div class="sheet-actions"><button class="btn btn-primary">Save</button></div></form>`, (dlg) => {
    dlg.querySelector('#cr')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(e.target as HTMLFormElement);
      const assetIds = Object.fromEntries(roles.map(([r]) => [r, d[r]]).filter(([, v]) => v));
      try {
        await spApi('POST', `/api/sponsorships/${o.id}/assets`, { assetIds, clickUrl: d.clickUrl ?? undefined });
        dlg.close();
        toast('Saved');
        route();
      } catch (err: any) {
        toast(err.message, 'error');
      }
    });
  });
}

// ================================================================== analytics
async function analyticsPage() {
  const a = await spApi('GET', `/api/sponsors/${account.id}/analytics`);
  const t = a.totals;
  const surf = new Map<string, any>();
  for (const r of a.bySurface) surf.set(r.surface, { ...(surf.get(r.surface) ?? {}), [r.metric]: r.v });
  shell('analytics', `<header class="page-head"><div><h1>Analytics</h1><p class="muted">Measured from screens and pages served by Sports Diary.</p></div><div class="head-actions"><button class="btn" data-cmd="csv">Export CSV</button></div></header>
    <div class="kpis">
      <div class="kpi kpi-gauge"><span>Exposure score</span>${gauge(t.score)}</div>
      ${kpi('Estimated reach', num(t.estimatedReach), 'unique online + in-venue + QR')}
      ${kpi('Screen time', `${t.tvHours} h`, `${num(t.audienceMinutes)} audience-minutes`)}
      ${kpi('Page impressions', num(t.live_impressions), `${num(t.unique_viewers)} unique viewers`)}
      ${kpi('Clicks', num(t.clicks), `${t.ctr}% CTR`)}
      ${kpi('QR scans', num(t.qr_scans), `${num(t.qr_unique)} unique`)}
    </div>
    <div class="card"><h2>Daily exposure</h2>${bars(a.series.map((s: any) => ({ label: s.day.slice(5), value: s.impressions })), { unit: ' page impressions', caption: 'Page impressions' })}${bars(a.series.map((s: any) => ({ label: s.day.slice(5), value: s.tvMinutes })), { height: 80, unit: ' screen-minutes', caption: 'Screen minutes' })}</div>
    <div class="two-col">
      <div class="card"><h2>By placement</h2><table class="table"><thead><tr><th>Surface</th><th class="r">Screen time</th><th class="r">Plays</th><th class="r">Impressions</th></tr></thead><tbody>${[...surf.entries()].map(([s, v]) => `<tr><td>${esc(title(s))}</td><td class="r">${v.tv_seconds ? `${(v.tv_seconds / 3600).toFixed(1)} h` : '—'}</td><td class="r">${num(v.tv_plays ?? 0)}</td><td class="r">${num(v.live_impressions ?? 0)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No exposure yet.</td></tr>'}</tbody></table></div>
      <div class="card"><h2>QR scans by tournament</h2>${a.qrByTournament.length ? `<table class="table"><tbody>${a.qrByTournament.map((q: any) => `<tr><td>${esc(q.tournament)}</td><td class="r">${num(q.n)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No scans yet.</p>'}
        <p class="muted small">Cities: ${a.cities.map(esc).join(', ') || '—'} · Sports: ${a.sports.map((s: string) => esc(title(s))).join(', ') || '—'} · Matches covered: ${num(a.matchesCovered)}</p></div>
    </div>
    <div class="card"><h2>Per sponsorship</h2><table class="table"><thead><tr><th>Sponsorship</th><th>Status</th><th class="r">Spend</th><th class="r">Score</th><th class="r">Reach*</th><th class="r">Cost / 1k reach</th><th class="r">Organizer audience est.</th></tr></thead><tbody>${a.orders.map((o: any) => `<tr><td><a href="#order=${esc(o.id)}">${esc(o.title)}</a><br><small class="muted">${esc(o.package ?? '')}</small></td><td>${statusPill(o.status)}</td><td class="r">${esc(o.spend)}</td><td class="r">${o.metrics.score}</td><td class="r">${num(o.metrics.estimatedReach)}</td><td class="r">${esc(o.metrics.costPerThousandReach ?? '—')}</td><td class="r">${num(o.organizerAudienceEstimate)}</td></tr>`).join('')}</tbody></table></div>
    <details class="card method"><summary>How these numbers are calculated</summary><p><strong>Exposure score:</strong> ${esc(a.method.score)}.</p><p><strong>Estimated reach:</strong> ${esc(a.method.reach)}</p><p><strong>Measurement:</strong> ${esc(a.method.measured)}</p></details>`);
  app.querySelector('[data-cmd="csv"]')!.addEventListener('click', async () => {
    const res = await fetch(`/api/sponsors/${account.id}/analytics?format=csv`, { headers: { authorization: `Bearer ${session.token}` } });
    const url = URL.createObjectURL(await res.blob());
    const a2 = document.createElement('a');
    a2.href = url;
    a2.download = 'sponsorship-analytics.csv';
    a2.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

// ================================================================== AI advisor
function advisorPage() {
  shell('advisor', `<header class="page-head"><div><h1>AI sponsorship advisor</h1><p class="muted">Describe your budget, audience and goals. The advisor searches every open package and builds a plan.</p></div></header>
    <form class="card advisor" id="ask"><textarea name="message" rows="3" required placeholder="I have ₹5 lakh and want maximum visibility among young cricket audiences in Gujarat."></textarea>
      <div class="examples">${['₹2 lakh for college students in Ahmedabad, mostly online', '$5,000 for padel and tennis in Mumbai, corporate audience', '₹50k for TV screens at football matches in Pune'].map((x) => `<button type="button" class="chip" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <button class="btn btn-primary">Build my plan</button></form>
    <div id="out"></div>`);
  const f = app.querySelector<HTMLFormElement>('#ask')!;
  f.addEventListener('click', (e) => {
    const ex = (e.target as HTMLElement).dataset.ex;
    if (ex) (f.querySelector('textarea') as HTMLTextAreaElement).value = ex;
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = app.querySelector('#out')!;
    out.innerHTML = '<p class="muted">Thinking…</p>';
    try {
      const r = await spApi('POST', '/api/sponsorships/agent', formData(f));
      out.innerHTML = `<div class="card"><p>${r.understood.map((u: string) => `<span class="chip">${esc(u)}</span>`).join(' ')}</p><div class="mk-answer">${esc(r.answer).replace(/\n/g, '<br>')}</div>
        ${r.plan?.picks?.length ? `<table class="table"><thead><tr><th>Opportunity</th><th>Package</th><th class="r">Price</th><th class="r">Match</th><th>Why</th><th></th></tr></thead><tbody>${r.plan.picks.map((p: any) => `<tr><td><strong>${esc(p.opportunity.title)}</strong><br><small class="muted">${esc([title(p.opportunity.sport ?? ''), p.opportunity.city].filter(Boolean).join(' · '))}</small></td><td>${esc(p.package.name)}<div class="mk-chips">${exposureChips(p.package.exposure)}</div></td><td class="r">${esc(p.package.price)}</td><td class="r">${p.score}</td><td><small>${p.reasons.map(esc).join('; ')}${p.cautions.length ? `<br><em>${p.cautions.map(esc).join('; ')}</em>` : ''}</small></td><td><a class="btn btn-small btn-primary" href="/sponsorships/${esc(p.opportunity.slug)}#buy=${esc(p.package.id)}">Buy</a></td></tr>`).join('')}</tbody></table>` : ''}
        <p class="muted small">${r.engine === 'rules' ? 'Rule-based advisor.' : `Explanation written by ${esc(r.engine)} from the computed plan.`} Prices exclude GST. Audience figures are organizer estimates.</p></div>`;
    } catch (err: any) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
}

// ================================================================== deals
async function dealsPage() {
  const [threads, bids] = await Promise.all([spApi('GET', '/api/sponsorship-threads'), spApi('GET', '/api/sponsor/bids')]);
  shell('deals', `<header class="page-head"><h1>Offers & bids</h1></header>
    <div class="card"><h2>Conversations with organizers</h2>${threads.length ? `<table class="table"><thead><tr><th>Opportunity</th><th>Type</th><th>Latest offer</th><th>Status</th><th>Updated</th></tr></thead><tbody>${threads.map((t: any) => `<tr><td><a href="#deal=${esc(t.id)}">${esc(t.opportunity)}</a>${t.package ? `<br><small class="muted">${esc(t.package)}</small>` : ''}</td><td>${esc(title(t.kind))}</td><td>${t.currentOffer ? `${esc(t.currentOffer.amount)} <small class="muted">from ${t.currentOffer.side === 'sponsor' ? 'you' : 'organizer'}</small>` : '—'}</td><td>${esc(title(t.status))}</td><td>${dateTime(t.updatedAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No conversations yet. Use “Make an offer” or “Request proposal” on any opportunity.</p>'}</div>
    <div class="card"><h2>Auction bids</h2>${bids.length ? bidsTable(bids) : '<p class="muted">No bids yet.</p>'}</div>`);
}

async function dealPage(id: string) {
  const t = await spApi('GET', `/api/sponsorship-threads/${id}`);
  const canAccept = t.status === 'open' && t.currentOffer && t.currentOffer.side === 'organizer';
  shell('deals', `<a class="crumb" href="#deals">← Offers & bids</a>
    <header class="page-head"><div><h1>${esc(t.opportunity)}</h1><p class="muted">${esc(t.package ?? 'General enquiry')}${t.listPrice ? ` · list price ${esc(t.listPrice)}` : ''} · ${esc(title(t.status))}</p></div>
      <div class="head-actions">${canAccept ? `<button class="btn btn-primary" data-cmd="accept">Accept ${esc(t.currentOffer.amount)}</button>` : ''}${t.orderId ? `<a class="btn btn-primary" href="#order=${esc(t.orderId)}&pay=1">Go to payment</a>` : ''}${t.status === 'open' ? '<button class="btn btn-quiet" data-cmd="decline">Close</button>' : ''}</div></header>
    <div class="card"><ol class="thread">${t.messages.map((m: any) => `<li class="from-${esc(m.side)}"><header><strong>${m.side === 'sponsor' ? 'You' : 'Organizer'}</strong> <small class="muted">${esc(m.author ?? '')} · ${dateTime(m.at)}</small></header><p>${esc(m.body)}</p>${m.offer ? `<p class="offer">${m.side === 'sponsor' ? 'Offer' : 'Proposal'}: <strong>${esc(m.offer)}</strong></p>` : ''}</li>`).join('')}</ol>
    ${t.status === 'open' && can('buy') ? `<form id="reply" class="reply"><textarea name="message" rows="3" placeholder="Write a reply"></textarea><div class="two">${t.packageId ? `<label>Counter-offer (${esc(t.currency)})<input name="offer" type="number" min="1" step="100"></label>` : '<span></span>'}<button class="btn btn-primary">Send</button></div></form>` : ''}</div>`);
  app.querySelector('#reply')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await spApi('POST', `/api/sponsorship-threads/${id}/messages`, formData(e.target as HTMLFormElement));
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  app.querySelector('[data-cmd="accept"]')?.addEventListener('click', async () => {
    try {
      const r = await spApi('POST', `/api/sponsorship-threads/${id}/accept`, {});
      location.hash = `order=${r.order.id}&pay=1`;
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  app.querySelector('[data-cmd="decline"]')?.addEventListener('click', async () => {
    if (!confirm('Close this conversation?')) return;
    await spApi('POST', `/api/sponsorship-threads/${id}/decline`, {}).catch((e) => toast(e.message, 'error'));
    route();
  });
}

// ================================================================== assets
async function assetsPage() {
  const lib = await spApi('GET', '/api/sponsor/assets');
  const rules = lib.rules;
  shell('assets', `<header class="page-head"><div><h1>Brand assets</h1><p class="muted">Files are checked by content, scanned, and re-encoded into optimized versions for screens. Originals are never shown publicly.</p></div></header>
    ${can('assets') ? `<form class="card form-grid" id="up">
      <label>Type<select name="kind">${meta.assetKinds.map((k: string) => `<option value="${k}">${esc(rules[k].label)}</option>`).join('')}</select></label>
      <label class="file-in">File<input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,video/mp4"></label>
      <label class="wide copy-in" hidden>Advertisement copy (max 280 characters)<textarea name="text" rows="2" maxlength="280"></textarea></label>
      <p class="wide muted small" id="rule"></p>
      <div class="form-actions"><button class="btn btn-primary">Upload</button></div></form>` : ''}
    <div class="asset-grid">${lib.assets.map((a: any) => `<figure class="asset ${esc(a.status)}">${a.kind === 'ad_copy' ? `<blockquote>${esc(a.text)}</blockquote>` : a.kind === 'video' ? `<div class="vid">▶ ${(a.durationMs / 1000).toFixed(1)} s video</div>` : `<img src="${esc(a.variants.thumb?.url ?? '')}" alt="${esc(a.name ?? '')}" loading="lazy">`}
      <figcaption><strong>${esc(rules[a.kind]?.label ?? a.kind)}</strong> ${statusTag(a.status)}<small>${esc(a.name ?? '')}${a.width ? ` · ${a.width}×${a.height}` : ''} · ${Math.round(a.bytes / 1024)} KB</small>${a.reviewNote ? `<small class="warn">${esc(a.reviewNote)}</small>` : ''}
      ${can('assets') ? `<button class="link" data-del="${esc(a.id)}">Delete</button>` : ''}${can('profile') && a.kind.startsWith('logo') && a.id !== account.logo?.split('/').pop()?.split('?')[0] ? ` · <button class="link" data-main="${esc(a.id)}">Use as profile logo</button>` : ''}</figcaption></figure>`).join('') || '<p class="muted">No assets yet. Upload your logo to get started.</p>'}</div>`);
  const f = app.querySelector<HTMLFormElement>('#up');
  const sync = () => {
    if (!f) return;
    const k = (f.querySelector('select') as HTMLSelectElement).value;
    const r = rules[k];
    (f.querySelector('.copy-in') as HTMLElement).hidden = k !== 'ad_copy';
    (f.querySelector('.file-in') as HTMLElement).hidden = k === 'ad_copy';
    (f.querySelector('#rule') as HTMLElement).textContent = k === 'ad_copy' ? 'Plain text. Copy promoting prohibited products is sent for review.' : `${r.mimes.map((m: string) => m.split('/')[1].replace('svg+xml', 'SVG').toUpperCase()).join(', ')} · up to ${Math.round(r.maxBytes / 1e6)} MB${r.minWidth ? ` · at least ${r.minWidth}×${r.minHeight} px` : ''}${r.alpha ? ' · transparent background' : ''}${r.maxDurationMs ? ` · up to ${r.maxDurationMs / 1000} s` : ''}`;
  };
  f?.querySelector('select')!.addEventListener('change', sync);
  sync();
  f?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const kind = String(d.get('kind'));
    const btn = f.querySelector('button') as HTMLButtonElement;
    btn.disabled = true;
    try {
      if (kind === 'ad_copy') await spApi('POST', '/api/sponsor/assets?kind=ad_copy', { kind, text: d.get('text') });
      else {
        const file = (f.querySelector('input[type="file"]') as HTMLInputElement).files?.[0];
        if (!file) throw new Error('Choose a file');
        await uploadAsset(kind, file);
      }
      toast('Uploaded');
      route();
    } catch (err: any) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    try {
      if (el.dataset.del && confirm('Delete this asset?')) {
        await spApi('DELETE', `/api/sponsor/assets/${el.dataset.del}`);
        route();
      }
      if (el.dataset.main) {
        await spApi('PATCH', '/api/sponsor/account', { logoAssetId: el.dataset.main });
        await loadAccount();
        toast('Profile logo updated');
        route();
      }
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ================================================================== QR
async function qrPage() {
  const list = await spApi('GET', '/api/sponsor/qr');
  shell('qr', `<header class="page-head"><div><h1>QR codes</h1><p class="muted">Every sponsorship gets a tracked QR code. It appears on screens and live pages; scans are counted by match and tournament.</p></div></header>
    <div class="qr-grid">${list.map((q: any) => `<figure class="card qr"><img src="${esc(q.image)}" alt="QR ${esc(q.code)}"><figcaption><strong>${esc(q.code)}</strong><small>${esc(q.order ?? '')}</small><span>${num(q.scans)} scans</span><a href="${esc(q.target)}" target="_blank" rel="noopener noreferrer">${esc(q.target)}</a></figcaption></figure>`).join('') || '<p class="muted">QR codes are created when a sponsorship goes live.</p>'}</div>`);
}

// ================================================================== billing
async function billingPage() {
  if (!can('finance')) return shell('billing', '<h1>Billing</h1><p class="muted">Ask an owner or finance manager for access.</p>');
  const [b, invoices] = await Promise.all([spApi('GET', '/api/sponsor/billing'), spApi('GET', '/api/sponsor/invoices')]);
  shell('billing', `<header class="page-head"><h1>Billing</h1></header>
    <form class="card form-grid" id="bill"><h2 class="wide">Billing details</h2>
      <label>Legal name<input name="legalName" value="${esc(b.legalName ?? '')}"></label>
      <label>GSTIN / VAT number<input name="taxId" value="${esc(b.taxId ?? '')}" placeholder="27AAPFU0939F1ZV"></label>
      <label>Billing email<input name="email" type="email" value="${esc(b.email ?? '')}"></label>
      <label>State (for GST place of supply)<input name="state" value="${esc(b.state ?? '')}"></label>
      <label>Country<input name="country" value="${esc(b.country ?? 'India')}"></label>
      <label class="wide">Address<textarea name="address" rows="2">${esc(b.address ?? '')}</textarea></label>
      <label>Preferred payment method<select name="preferredMethod"><option value="">No preference</option>${['upi', 'card', 'netbanking', 'wallet', 'international_card'].map((m) => `<option value="${m}" ${b.preferredMethod === m ? 'selected' : ''}>${esc(title(m))}</option>`).join('')}</select></label>
      <p class="wide muted small">Card and bank details are never stored by Sports Diary — they stay with the payment provider. ${Object.keys(b.providerCustomers ?? {}).length ? `Saved for auto-renewal with: ${Object.entries(b.providerCustomers).map(([k, v]) => `${esc(title(k))} ${esc(String(v))}`).join(', ')}.` : ''}</p>
      <div class="form-actions"><button class="btn btn-primary">Save</button></div></form>
    <div class="card"><h2>Invoices, receipts & credit notes</h2>${invoices.length ? `<table class="table"><thead><tr><th>Number</th><th>Type</th><th>Order</th><th>Date</th><th class="r">Amount</th><th></th></tr></thead><tbody>${invoices.map((i: any) => `<tr><td>${esc(i.number)}</td><td>${esc(title(i.kind))}</td><td><a href="#order=${esc(i.orderId)}">${esc(i.orderNumber)}</a></td><td>${date(i.issuedAt)}</td><td class="r">${esc(i.amount)}</td><td>${i.documentId ? `<button class="link" data-o="${esc(i.orderId)}" data-pdf="${esc(i.documentId)}">PDF</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Invoices appear here after your first payment.</p>'}</div>`);
  app.querySelector('#bill')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await spApi('PUT', '/api/sponsor/billing', formData(e.target as HTMLFormElement));
      toast('Saved');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  app.querySelector('#main')!.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pdf]');
    if (el) openDoc(el.dataset.o!, el.dataset.pdf!, true);
  });
}

// ================================================================== team
async function teamPage() {
  const t = await spApi('GET', '/api/sponsor/team');
  const ROLE_HELP: Record<string, string> = { owner: 'Everything, including owners', admin: 'Everything except owners', marketing: 'Buy, creative, analytics', finance: 'Pay, billing, invoices, renewals', viewer: 'View only' };
  shell('team', `<header class="page-head"><h1>Team</h1></header>
    <div class="card"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${t.members.map((m: any) => `<tr><td>${esc(m.name)}${m.id === t.you.id ? ' <small class="muted">(you)</small>' : ''}</td><td>${esc(m.email)}</td><td>${can('team') && m.id !== t.you.id ? `<select data-role="${esc(m.id)}">${t.roles.map((r: string) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(m.role)}</td><td>${can('team') && m.id !== t.you.id ? `<button class="link" data-remove="${esc(m.id)}">Remove</button>` : ''}</td></tr>`).join('')}
    ${t.invites.map((i: any) => `<tr class="muted"><td>Invited</td><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>expires ${date(i.expires_at)}</td></tr>`).join('')}</tbody></table></div>
    ${can('team') ? `<form class="card form-grid" id="inv"><h2 class="wide">Invite a teammate</h2><label>Email<input name="email" type="email" required></label><label>Role<select name="role">${t.roles.filter((r: string) => r !== 'owner' || t.you.role === 'owner').map((r: string) => `<option value="${r}" ${r === 'marketing' ? 'selected' : ''}>${title(r)} — ${ROLE_HELP[r]}</option>`).join('')}</select></label><div class="form-actions"><button class="btn btn-primary">Send invite</button></div></form>` : ''}`);
  app.querySelector('#inv')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await spApi('POST', '/api/sponsor/team/invite', formData(e.target as HTMLFormElement));
      toast('Invitation sent');
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
  app.querySelector('#main')!.addEventListener('change', async (e) => {
    const el = e.target as HTMLSelectElement;
    if (!el.dataset.role) return;
    try {
      await spApi('PATCH', `/api/sponsor/team/${el.dataset.role}`, { role: el.value });
      toast('Role updated');
    } catch (err: any) {
      toast(err.message, 'error');
      route();
    }
  });
  app.querySelector('#main')!.addEventListener('click', async (e) => {
    const id = (e.target as HTMLElement).dataset.remove;
    if (!id || !confirm('Remove this person from the account?')) return;
    try {
      await spApi('DELETE', `/api/sponsor/team/${id}`);
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ================================================================== profile
async function profilePage() {
  const a = account;
  const ro = can('profile') ? '' : 'disabled';
  shell('profile', `<header class="page-head"><div><h1>Profile</h1><p class="muted">${a.publicProfile ? `Public at <a href="/sponsor/${esc(a.slug)}" target="_blank" rel="noopener">/sponsor/${esc(a.slug)}</a>` : 'Your profile is private.'}</p></div></header>
    <form class="card form-grid" id="prof"><fieldset class="wide" ${ro}>
      <div class="form-grid">
      <label>Name<input name="name" value="${esc(a.name)}" required></label>
      <label>Type<select name="kind"><option value="organization" ${a.kind === 'organization' ? 'selected' : ''}>Organization</option><option value="individual" ${a.kind === 'individual' ? 'selected' : ''}>Individual</option></select></label>
      <label>Category<select name="category">${meta.sponsorCategories.map((c: string) => `<option ${c === a.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Industry<select name="industry"><option value="">—</option>${meta.industries.map((c: string) => `<option value="${c}" ${c === a.industry ? 'selected' : ''}>${esc(title(c))}</option>`).join('')}</select></label>
      <label>Website<input name="website" type="url" value="${esc(a.website ?? '')}" placeholder="https://"></label>
      <label>Contact person<input name="contactPerson" value="${esc(a.contactPerson ?? '')}"></label>
      <label>Email<input name="email" type="email" value="${esc(a.email ?? '')}"></label>
      <label>Phone<input name="phone" type="tel" value="${esc(a.phone ?? '')}" placeholder="+91 …"></label>
      <label>City<input name="city" value="${esc(a.city ?? '')}"></label>
      <label>Country<input name="country" value="${esc(a.country ?? '')}"></label>
      <label>GSTIN / tax ID<input name="taxId" value="${esc(a.taxId ?? '')}"></label>
      <label>Company registration no.<input name="registrationNo" value="${esc(a.registrationNo ?? '')}"></label>
      <label class="wide">Address<input name="address" value="${esc(a.address ?? '')}"></label>
      <label class="wide">About<textarea name="description" rows="3">${esc(a.description ?? '')}</textarea></label>
      <label>Brand colour<input name="brandColor" type="color" value="${esc(a.brandColors?.[0] ?? '#062547')}"></label>
      ${['instagram', 'facebook', 'linkedin', 'youtube', 'x'].map((s) => `<label>${title(s)}<input name="social_${s}" type="url" value="${esc(a.social?.[s] ?? '')}" placeholder="https://"></label>`).join('')}
      <label class="mk-check wide"><input type="checkbox" name="publicProfile" value="1" ${a.publicProfile ? 'checked' : ''}> Show a public sponsor profile with my sponsorships</label>
      </div></fieldset>
      ${can('profile') ? '<div class="form-actions"><button class="btn btn-primary">Save profile</button></div>' : ''}</form>`);
  app.querySelector('#prof')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target as HTMLFormElement);
    const social = Object.fromEntries(Object.entries(d).filter(([k, v]) => k.startsWith('social_') && v).map(([k, v]) => [k.slice(7), v]));
    const body: any = { ...Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('social_') && k !== 'brandColor' && k !== 'publicProfile')), social, brandColors: [d.brandColor], publicProfile: !!d.publicProfile };
    for (const k of ['website', 'email', 'phone', 'taxId', 'industry']) if (!body[k]) body[k] = null;
    try {
      account = { ...(await spApi('PATCH', '/api/sponsor/account', body)), role: account.role };
      toast('Profile saved');
      route();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  });
}

// ================================================================== public profile (/sponsor/:slug)
async function publicProfile(slug: string) {
  document.body.className = 'market';
  try {
    const p = await spApi('GET', `/api/sponsors/${encodeURIComponent(slug)}`, undefined, { quiet401: true });
    document.title = `${p.name} — sponsor profile`;
    app.innerHTML = `<header class="mk-top"><a class="logo-link" href="/">${logo()}</a><nav><a href="/sponsorships">Sponsorships</a><a href="/sponsors" class="on">Sponsors</a></nav><div class="mk-me"></div></header>
      <section class="mk-detail-hero sp-profile">${p.logo ? `<img class="sp-logo" src="${esc(variant(p.logo, 'screen'))}" alt="">` : ''}<div><p class="eyebrow">${esc(p.category ?? 'Sponsor')}${p.industry ? ` · ${esc(title(p.industry))}` : ''}</p><h1>${esc(p.name)}</h1><p class="mk-sub">${esc([p.city, p.country].filter(Boolean).join(', '))}${p.website ? ` · <a href="${esc(p.website)}" target="_blank" rel="noopener nofollow">${esc(p.website.replace(/^https?:\/\//, ''))}</a>` : ''}</p>
        <p class="socials">${Object.entries(p.social ?? {}).map(([k, v]) => `<a href="${esc(String(v))}" target="_blank" rel="noopener nofollow">${esc(title(k))}</a>`).join('')}</p></div></section>
      <div class="mk-detail"><section class="mk-main">${p.description ? `<div class="card"><h2>About</h2><p class="pre">${esc(p.description)}</p></div>` : ''}
        <div class="card"><h2>Sponsorships</h2>${p.campaigns.length ? `<ul class="campaigns">${p.campaigns.map((c: any) => `<li><strong>${esc(c.title)}</strong><span>${esc(c.package ?? '')}${c.sport ? ` · ${esc(title(c.sport))}` : ''}${c.city ? ` · ${esc(c.city)}` : ''}</span><small>${c.status === 'active' ? '<span class="sp-status tone-ok">Live now</span>' : `${date(c.startsOn)} – ${date(c.endsOn)}`}${c.tournament ? ` · <a href="/t/${esc(c.tournament)}">Watch</a>` : ''}</small></li>`).join('')}</ul>` : '<p class="muted">No public sponsorships yet.</p>'}</div></section>
        <aside class="mk-side card"><h2>Sports</h2><p>${p.sports?.map((s: string) => `<span class="chip">${esc(title(s))}</span>`).join(' ') || '—'}</p></aside></div>`;
  } catch (e: any) {
    app.innerHTML = `<div class="empty"><h1>Sponsor not found</h1><p>${esc(e.message)}</p><p><a href="/sponsors">All sponsors</a></p></div>`;
  }
}

boot().catch((e) => {
  app.innerHTML = `<div class="empty"><h1>Something went wrong</h1><p>${esc(e.message)}</p></div>`;
});
