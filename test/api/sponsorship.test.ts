/**
 * Sponsorship marketplace: end-to-end flows and security properties.
 *
 *   sponsor signup → assets → browse → order → agreement → checkout → SIGNED webhook →
 *   invoice/ledger → activation → branding on TV/live/tournament → exposure → analytics
 * plus: forged/replayed webhooks, amount mismatch, duplicate payment, idempotency, stock holds,
 * approval workflows, refunds, RBAC, tenant isolation, OTP/OAuth, auctions, negotiation,
 * AI matching, renewals and reminders.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import sharp from 'sharp';
import { start, registerOrg, pairTv, type Harness } from './harness.ts';
import { razorpay } from '../../apps/api/src/sponsorship/payments/razorpay.ts';
import { stripe } from '../../apps/api/src/sponsorship/payments/stripe.ts';
import { cashfree } from '../../apps/api/src/sponsorship/payments/cashfree.ts';
import { setJwksFetcher } from '../../apps/api/src/sponsorship/oidc.ts';
import { validGstin, price } from '../../apps/api/src/sponsorship/money.ts';

let h: Harness;
before(async () => (h = await start()));
after(async () => h.close());

const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = () => h.app.ctx.db;

async function req(method: string, path: string, opts: { token?: string; body?: any; raw?: Buffer | string; type?: string; headers?: Record<string, string>; account?: string } = {}) {
  const res = await fetch(h.base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(opts.raw !== undefined ? { 'content-type': opts.type ?? 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.account ? { 'x-sponsor-account': opts.account } : {}),
      ...(opts.headers ?? {}),
    },
    body: (opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined) as any,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    /* binary */
  }
  return { status: res.status, json, buf, headers: res.headers };
}

const png = (w: number, h2: number, alpha = false) => (alpha ? sharp({ create: { width: w, height: h2, channels: 4, background: { r: 6, g: 37, b: 71, alpha: 0 } } }) : sharp({ create: { width: w, height: h2, channels: 3, background: { r: 6, g: 37, b: 71 } } })).png().toBuffer();

async function signupSponsor(name: string, extra: any = {}) {
  const email = `${name.toLowerCase().replace(/\W+/g, '')}+${Math.random().toString(36).slice(2, 7)}@brand.example`;
  const r = await h.api('POST', '/api/auth/sponsor-signup', { email, password: 'sponsor-pass-1', personName: `${name} Owner`, name, kind: 'organization', category: 'Brand', industry: 'food-beverage', city: 'Ahmedabad', ...extra });
  const logo = await req('POST', '/api/sponsor/assets?kind=logo&name=logo.png', { token: r.token, raw: await png(600, 200), type: 'image/png' });
  assert.equal(logo.status, 200, JSON.stringify(logo.json));
  return { token: r.token as string, account: r.account, email, logoId: logo.json.id as string };
}

function outboxCode(dest: string, event?: string) {
  const row = db().prepare(`SELECT body FROM notification_outbox WHERE destination = ? ${event ? 'AND event = ?' : ''} ORDER BY rowid DESC LIMIT 1`).get(dest, ...(event ? [event] : [])) as any;
  return row?.body as string | undefined;
}

async function sandboxPay(orderId: string, token: string, outcome: 'success' | 'failure' = 'success') {
  const pay = await h.api('POST', `/api/sponsorship-orders/${orderId}/pay`, { acceptAgreement: true }, token);
  const providerOrderId = pay.client.redirectUrl.split('/').pop();
  const done = await h.api('POST', `/api/pay/sandbox/${providerOrderId}/complete`, { outcome, method: 'upi' });
  return { pay, providerOrderId, done };
}

function signedSandbox(event: any) {
  const body = JSON.stringify(event);
  return { body, headers: h.app.sponsorship.registry.sandbox.sign(body) };
}

// ---------------------------------------------------------------- shared world
let org: string;
let orgB: string;
let tournament: any;
let matchCode: string;
let opp: any;
let cricketOpp: any;
let chai: Awaited<ReturnType<typeof signupSponsor>>;
let tv: Awaited<ReturnType<typeof pairTv>>;
let goldOrder: any;

test('organizer lists inventory: tournament opportunity with Gold / Silver / Bronze', async () => {
  org = await registerOrg(h, 'Ahmedabad Sports League');
  orgB = await registerOrg(h, 'Rival Club');
  const venue = await h.api('POST', '/api/venues', { name: 'Riverfront Arena', capacity: 2000, surfaces: [{ name: 'Court 1', kind: 'court', sports: ['badminton'] }, { name: 'Court 2', kind: 'court', sports: ['badminton'] }] }, org);
  const players: string[] = [];
  for (const n of ['Aarav', 'Diya', 'Kabir', 'Isha']) players.push((await h.api('POST', '/api/players', { name: n }, org)).id);
  tournament = await h.api('POST', '/api/tournaments', { name: 'Navratri Smash', sport: 'badminton', discipline: 'singles', format: 'round_robin', venueId: venue.id, entrants: players.map((p) => ({ playerIds: [p] })), matchConfig: { bestOf: 1, pointsToWin: 5, cap: 7 } }, org);
  const gen = await h.api('POST', `/api/tournaments/${tournament.id}/generate`, { startAt: new Date().toISOString(), slotMinutes: 20 }, org);
  matchCode = gen.matches[0].code;
  tournament = await h.api('GET', `/api/tournaments/${tournament.id}`, undefined, org);

  opp = await h.api('POST', '/api/sponsorship-opportunities', {
    title: 'Navratri Smash 2026', tournamentId: tournament.id, city: 'Ahmedabad', state: 'Gujarat', level: 'state', audienceEstimate: 5000,
    audienceProfile: { ageGroups: ['18-24', '25-34'] }, startsOn: day(0), endsOn: day(30), publish: true,
    packages: [{ template: 'gold' }, { template: 'silver', maxSponsors: 1 }, { template: 'bronze', maxSponsors: 5 }],
  }, org);
  assert.equal(opp.packages.length, 3);
  const gold = opp.packages.find((p: any) => p.tier === 'gold');
  assert.equal(gold.priceMinor, 100000_00);
  assert.equal(gold.price, '₹1,00,000');
  assert.ok(gold.items.some((i: any) => i.type === 'tv_scoreboard_logo'));
  assert.equal(gold.items.find((i: any) => i.type === 'instagram_post').quantity, 2, 'package quantity, not inventory stock');
  assert.equal(opp.sport, 'badminton');
  assert.deepEqual(opp.facts.venues, ['Riverfront Arena']);
  assert.equal(opp.facts.matches, 6);

  cricketOpp = await h.api('POST', '/api/sponsorship-opportunities', {
    title: 'Surat Premier Cricket League', sport: 'cricket', city: 'Surat', state: 'Gujarat', level: 'state', audienceEstimate: 20000,
    audienceProfile: { ageGroups: ['18-24', '25-34'] }, startsOn: day(1), endsOn: day(45), publish: true, packages: [{ template: 'silver' }, { template: 'bronze', maxSponsors: 4 }],
  }, org);

  // a draft can't be published without packages; another org can't edit it
  const draft = await h.api('POST', '/api/sponsorship-opportunities', { title: 'Empty draft', sport: 'tennis' }, org);
  await assert.rejects(h.api('PATCH', `/api/sponsorship-opportunities/${draft.id}`, { status: 'published' }, org), /at least one package/);
  await assert.rejects(h.api('PATCH', `/api/sponsorship-opportunities/${opp.id}`, { title: 'hijack' }, orgB), /not found/i);
  // drafts are invisible publicly
  const pub = await req('GET', `/api/sponsorship-opportunities/${draft.id}`);
  assert.equal(pub.status, 404);
});

test('public marketplace search with filters and facets', async () => {
  const all = await h.api('GET', '/api/sponsorship-opportunities');
  assert.equal(all.total, 2);
  assert.ok(all.facets.cities.includes('Surat'));
  assert.equal((await h.api('GET', '/api/sponsorship-opportunities?sport=cricket')).total, 1);
  assert.equal((await h.api('GET', '/api/sponsorship-opportunities?city=ahmedabad')).total, 1);
  assert.equal((await h.api('GET', '/api/sponsorship-opportunities?maxBudget=30000')).total, 2); // bronze ₹25,000 in both
  assert.equal((await h.api('GET', '/api/sponsorship-opportunities?minBudget=200000')).total, 0);
  assert.equal((await h.api('GET', '/api/sponsorship-opportunities?tv=1&social=1')).total, 2);
  assert.equal((await h.api('GET', `/api/sponsorship-opportunities?tournament=${tournament.public_code}`)).total, 1);
  const sorted = await h.api('GET', '/api/sponsorship-opportunities?sort=audience');
  assert.equal(sorted.results[0].title, 'Surat Premier Cricket League');
  const usd = await h.api('GET', `/api/sponsorship-opportunities/${opp.id}?currency=USD`);
  assert.match(usd.packages[0].approxPrice, /≈ \$/);
});

test('sponsor signup, profile validation and asset pipeline', async () => {
  chai = await signupSponsor('Chai Point');
  assert.equal(chai.account.status, 'active');
  const me = await h.api('GET', '/api/sponsor/me', undefined, chai.token);
  assert.equal(me.memberships[0].role, 'owner');
  assert.equal(me.user.organizer, false);

  // sponsor-only people have no organizer powers
  assert.equal((await req('GET', '/api/matches', { token: chai.token })).status, 403);
  assert.equal((await req('POST', '/api/sponsorship-opportunities', { token: chai.token, body: { title: 'x' } })).status, 403);

  // validation: GSTIN checksum, URL, colours
  assert.ok(validGstin('27AAPFU0939F1ZV'));
  assert.ok(!validGstin('27AAPFU0939F1ZX'));
  assert.equal((await req('PATCH', '/api/sponsor/account', { token: chai.token, body: { taxId: '27AAPFU0939F1ZX' } })).status, 400);
  assert.equal((await req('PATCH', '/api/sponsor/account', { token: chai.token, body: { website: 'javascript:alert(1)' } })).status, 400);
  const prof = await h.api('PATCH', '/api/sponsor/account', { taxId: '27AAPFU0939F1ZV', website: 'https://chaipoint.example', brandColors: ['#C8102E'], publicProfile: true, logoAssetId: chai.logoId }, chai.token);
  assert.equal(prof.publicProfile, true);

  // content sniffing, not names: a text file named .png is rejected
  const fake = await req('POST', '/api/sponsor/assets?kind=logo&name=evil.png', { token: chai.token, raw: 'hello', type: 'image/png' });
  assert.equal(fake.status, 415);
  // SVG with script
  const svg = await req('POST', '/api/sponsor/assets?kind=logo', { token: chai.token, raw: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><script>alert(1)</script></svg>', type: 'image/svg+xml' });
  assert.equal(svg.status, 422);
  // EICAR test signature
  const eicar = Buffer.concat([await png(600, 200), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
  assert.equal((await req('POST', '/api/sponsor/assets?kind=logo', { token: chai.token, raw: eicar, type: 'image/png' })).status, 422);
  // dimension / aspect checks
  const tiny = await req('POST', '/api/sponsor/assets?kind=logo', { token: chai.token, raw: await png(100, 40), type: 'image/png' });
  assert.equal(tiny.status, 422);
  assert.match(tiny.json.error.message, /at least 300px/);
  // transparent logo kinds need alpha
  assert.equal((await req('POST', '/api/sponsor/assets?kind=logo_transparent', { token: chai.token, raw: await png(600, 200, false), type: 'image/png' })).status, 422);
  // ad copy screening → flagged for review
  const copy = await req('POST', '/api/sponsor/assets?kind=ad_copy', { token: chai.token, body: { kind: 'ad_copy', text: 'Bet now and win a jackpot!' } });
  assert.equal(copy.json.status, 'flagged');

  // private assets: not public until live; signed preview URL works
  const list = await h.api('GET', '/api/sponsor/assets', undefined, chai.token);
  const logo = list.assets.find((a: any) => a.id === chai.logoId);
  assert.equal(logo.variants.screen.width, 800);
  assert.equal((await req('GET', `/media/${chai.logoId}?v=thumb`)).status, 200, 'logo on a public profile is public');
  const other = await signupSponsor('Hidden Brand');
  assert.equal((await req('GET', `/media/${other.logoId}?v=thumb`)).status, 404);
  const signed = (await h.api('GET', '/api/sponsor/assets', undefined, other.token)).assets[0].variants.thumb.url;
  const ok = await req('GET', signed);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  assert.equal((await req('GET', signed.replace(/sig=[^&]+/, 'sig=forged'))).status, 404);
});

test('checkout → signed webhook → activation, invoice, ledger, branding everywhere', async () => {
  const gold = opp.packages.find((p: any) => p.tier === 'gold');
  tv = await pairTv(h, org, 'Hall TV', { mode: 'tournament', tournamentId: tournament.id, view: 'standings' });

  const quote = await h.api('POST', '/api/sponsorship-orders/quote', { opportunityId: opp.id, packageId: gold.id });
  assert.equal(quote.total, 118000_00);
  assert.equal(quote.tax, 18000_00);

  // client-sent prices are ignored: the server prices the package
  goldOrder = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: gold.id, idempotencyKey: 'gold-1', totalMinor: 1, price: 1 }, chai.token);
  assert.equal(goldOrder.status, 'PENDING_PAYMENT');
  assert.equal(goldOrder.totalMinor, 118000_00);
  assert.ok(goldOrder.holdExpiresAt);
  const again = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: gold.id, idempotencyKey: 'gold-1' }, chai.token);
  assert.equal(again.id, goldOrder.id, 'same idempotency key → same order');

  // agreement must be accepted
  assert.equal((await req('POST', `/api/sponsorship-orders/${goldOrder.id}/pay`, { token: chai.token, body: {} })).status, 400);
  const pay = await h.api('POST', `/api/sponsorship-orders/${goldOrder.id}/pay`, { acceptAgreement: true }, chai.token);
  assert.equal(pay.provider, 'sandbox');
  assert.equal(pay.live, false);
  const providerOrderId = pay.client.redirectUrl.split('/').pop();
  const pay2 = await h.api('POST', `/api/sponsorship-orders/${goldOrder.id}/pay`, { acceptAgreement: true }, chai.token);
  assert.equal(pay2.paymentId, pay.paymentId, 'double click reuses the open checkout');

  // the browser saying "paid" changes nothing; neither does an unsigned/forged webhook
  const confirm = await h.api('POST', `/api/sponsorship-orders/${goldOrder.id}/confirm`, {}, chai.token);
  assert.equal(confirm.status, 'PENDING_PAYMENT');
  const forgedBody = JSON.stringify({ id: 'evt_forged', type: 'payment.captured', data: { order_id: providerOrderId, payment_id: 'p', amount: 118000_00, currency: 'INR' } });
  const forged = await req('POST', '/api/payments/webhook/sandbox', { raw: forgedBody, type: 'application/json', headers: { 'x-sandbox-signature': 'deadbeef', 'x-sandbox-timestamp': String(Math.floor(Date.now() / 1000)) } });
  assert.equal(forged.status, 400);
  const stale = signedSandbox({ id: 'evt_stale', type: 'payment.captured', data: { order_id: providerOrderId } });
  stale.headers['x-sandbox-timestamp'] = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await req('POST', '/api/payments/webhook/sandbox', { raw: stale.body, type: 'application/json', headers: stale.headers })).status, 400);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${goldOrder.id}`, undefined, chai.token)).status, 'PENDING_PAYMENT');

  const info = await h.api('GET', `/api/pay/sandbox/${providerOrderId}`);
  assert.equal(info.amount, '₹1,18,000');
  assert.equal(info.testMode, true);
  await h.api('POST', `/api/pay/sandbox/${providerOrderId}/complete`, { outcome: 'success', method: 'upi' });

  const o = await h.api('GET', `/api/sponsorship-orders/${goldOrder.id}`, undefined, chai.token);
  assert.equal(o.status, 'ACTIVE');
  assert.deepEqual(o.events.map((e: any) => e.to), ['PENDING_PAYMENT', 'PAYMENT_RECEIVED', 'ACTIVE']);
  assert.ok(o.agreement.acceptedAt);
  assert.deepEqual(o.documents.map((d: any) => d.kind).sort(), ['agreement', 'confirmation', 'invoice', 'receipt']);
  assert.equal(o.deliverables.length, 3, '2 Instagram posts + 1 email promotion tracked as deliverables');
  assert.ok(o.placements.some((p: any) => p.surface === 'tv_logo'));
  assert.ok(o.qr.code);
  assert.equal(o.risk, undefined, 'risk flags are not shown to sponsors');

  // invoice number series + PDF
  const inv = db().prepare("SELECT number FROM sp_invoices WHERE order_id = ? AND kind = 'invoice'").get(goldOrder.id) as any;
  assert.match(inv.number, /^AHMEDABAD-\/\d{4}-\d{2}\/0001$/);
  const invDoc = o.documents.find((d: any) => d.kind === 'invoice');
  const pdf = await req('GET', `/api/sponsorships/${goldOrder.id}/documents/${invDoc.id}?format=pdf`, { token: chai.token });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await req('GET', `/api/sponsorships/${goldOrder.id}/documents/${invDoc.id}`, { token: orgB })).status, 404, 'other tenants cannot read documents');

  // ledger: sponsor paid 1,18,000; platform 10% commission; organizer gets the rest + GST on its share
  const led = Object.fromEntries((db().prepare('SELECT kind, SUM(amount_minor) AS v FROM sp_ledger WHERE order_id = ? GROUP BY kind').all(goldOrder.id) as any[]).map((r) => [r.kind, r.v]));
  assert.equal(led.charge, 118000_00);
  assert.equal(led.commission, 10000_00);
  assert.equal(led.organizer_payable, 108000_00);
  const p = price(100000_00, { platformFee: 0, taxRateBps: 1800, commissionBps: 1000 });
  assert.equal(p.total, led.charge);

  // branding appears on the live match page, the tournament page and the TV — without anyone touching them
  const live = await h.api('GET', `/api/public/m/${matchCode}`);
  assert.equal(live.sponsorship.logos[0].sponsor, 'Chai Point');
  assert.ok(live.sponsorship.live.length > 0);
  assert.equal(live.sponsorship.moment, 'pre');
  const tpage = await h.api('GET', `/api/public/t/${tournament.public_code}`);
  assert.ok(tpage.sponsorship.wall.some((w: any) => w.sponsor === 'Chai Point'));
  assert.equal(tpage.matches[0].sponsorship, undefined, 'per-match branding is not repeated inside the tournament payload');
  const cfg = await tv.tv.next((m) => m.t === 'display.config' && m.branding?.logos?.length, 3000, true);
  assert.equal(cfg.branding.logos[0].sponsor, 'Chai Point');
  assert.ok(cfg.branding.fullscreen.length > 0);
  assert.ok(cfg.sponsors.some((s: any) => s.name === 'Chai Point'), 'older TV builds still get the sponsor list');

  // organizer sees money split + risk; dashboard updated
  const orgView = await h.api('GET', `/api/org/sponsorships/${goldOrder.id}`, undefined, org);
  assert.equal(orgView.commissionMinor, 10000_00);
  const dash = await h.api('GET', '/api/org/sponsorship-dashboard', undefined, org);
  assert.equal(dash.activeSponsors, 1);
  assert.equal(dash.revenue[0].gross, '₹1,18,000');
  assert.equal(dash.pipeline.find((s: any) => s.stage === 'Active').count, 1);
  assert.ok(dash.inventory.soldPct > 0);

  // the logo is now public (it's on screens)
  assert.equal((await req('GET', `/media/${chai.logoId}?v=screen`)).status, 200);
});

test('exposure is measured server-side: TV heartbeats, page beacons, clicks and QR scans', async () => {
  const cfg = tv.tv.messages.filter((m) => m.t === 'display.config').at(-1);
  const shown = [cfg.branding.logos[0].id, cfg.branding.fullscreen[0].id, 'forged-placement-id'];
  tv.tv.send({ t: 'display.hb', shown });
  await tv.tv.next((m) => m.t === 'display.hb.ack');
  const ex = Object.fromEntries((db().prepare("SELECT metric, SUM(value) AS v FROM sp_exposure_daily WHERE order_id = ? GROUP BY metric").all(goldOrder.id) as any[]).map((r) => [r.metric, r.v]));
  assert.equal(ex.tv_seconds, 30, '15 s for each of the two real placements; forged id ignored');
  assert.equal(ex.screens, 1);
  assert.equal(ex.tv_plays, 1);
  // heartbeat flood is ignored
  tv.tv.send({ t: 'display.hb', shown });
  await tv.tv.next((m) => m.t === 'display.hb.ack');
  assert.equal((db().prepare("SELECT SUM(value) AS v FROM sp_exposure_daily WHERE order_id = ? AND metric = 'tv_seconds'").get(goldOrder.id) as any).v, 30);

  const live = await h.api('GET', `/api/public/m/${matchCode}`);
  const ids = live.sponsorship.live.map((p: any) => p.id);
  const b1 = await h.api('POST', '/api/sx/impressions', { placements: ids, viewer: 'viewer-aaaa-1111', page: 'live' });
  assert.equal(b1.counted, ids.length);
  const b2 = await h.api('POST', '/api/sx/impressions', { placements: ids, viewer: 'viewer-aaaa-1111', page: 'live' });
  assert.equal(b2.counted, 0, 'same viewer within 5 minutes is not double counted');
  await h.api('POST', '/api/sx/impressions', { placements: ids, viewer: 'viewer-bbbb-2222', page: 'live' });

  const click = await req('GET', live.sponsorship.logos[0].link);
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://chaipoint.example');
  const qr = await req('GET', `${live.sponsorship.logos[0].qr}?m=${matchCode}`);
  assert.equal(qr.status, 302);

  const a = await h.api('GET', `/api/sponsors/${chai.account.id}/analytics`, undefined, chai.token);
  assert.equal(a.totals.unique_viewers, 2);
  assert.equal(a.totals.clicks, 1);
  assert.equal(a.totals.qr_scans, 1);
  assert.ok(a.totals.score > 0 && a.totals.score <= 100);
  assert.ok(a.totals.estimatedReach >= 2);
  assert.equal(a.orders[0].metrics.matchesCovered, 0, 'no match has been played yet');
  assert.equal(a.qrByTournament[0].tournament, 'Navratri Smash');
  const csv = await req('GET', `/api/sponsors/${chai.account.id}/analytics?format=csv`, { token: chai.token });
  assert.match(csv.buf.toString(), /^order,title,package/);
  // another sponsor can't read these analytics
  const other = await signupSponsor('Snoop Ltd');
  assert.equal((await req('GET', `/api/sponsors/${chai.account.id}/analytics`, { token: other.token })).status, 403);
});

test('webhook idempotency, amount mismatch and duplicate-payment protection', async () => {
  const bronze = opp.packages.find((p: any) => p.tier === 'bronze');
  const sp = await signupSponsor('Amul Fresh');
  // replayed event is processed once
  const o1 = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: bronze.id }, sp.token);
  const p1 = await h.api('POST', `/api/sponsorship-orders/${o1.id}/pay`, { acceptAgreement: true }, sp.token);
  const pid1 = p1.client.redirectUrl.split('/').pop();
  const ev = signedSandbox({ id: 'evt_replay_1', type: 'payment.captured', data: { order_id: pid1, payment_id: 'pay_A', amount: o1.totalMinor, currency: 'INR', method: 'card' } });
  const first = await req('POST', '/api/payments/webhook', { raw: ev.body, type: 'application/json', headers: ev.headers });
  assert.equal(first.json.result, 'captured');
  const replay = await req('POST', '/api/payments/webhook', { raw: ev.body, type: 'application/json', headers: ev.headers });
  assert.equal(replay.json.duplicate, true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM sp_ledger WHERE order_id = ? AND kind = 'charge'").get(o1.id) as any).n, 1);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${o1.id}`, undefined, sp.token)).status, 'ACTIVE');

  // a second, different payment for the same order is refunded automatically
  const dup = signedSandbox({ id: 'evt_dup_1', type: 'payment.captured', data: { order_id: pid1, payment_id: 'pay_B', amount: o1.totalMinor, currency: 'INR', method: 'card' } });
  const d = await req('POST', '/api/payments/webhook', { raw: dup.body, type: 'application/json', headers: dup.headers });
  assert.equal(d.json.result, 'duplicate_payment_refunded');
  await sleep(150); // sandbox delivers refund.processed asynchronously
  const refunds = db().prepare('SELECT status, amount_minor FROM sp_refunds WHERE order_id = ?').all(o1.id) as any[];
  assert.deepEqual(refunds.map((r) => r.status), ['processed']);
  const after = await h.api('GET', `/api/org/sponsorships/${o1.id}`, undefined, org);
  assert.equal(after.status, 'ACTIVE', 'the original sponsorship stays live');
  assert.ok(after.risk.includes('duplicate_payment'));
  assert.equal((db().prepare("SELECT SUM(amount_minor) AS v FROM sp_ledger WHERE order_id = ? AND kind = 'organizer_payable'").get(o1.id) as any).v, 25000_00 - 2500_00 + 4500_00, 'organizer payable untouched by the duplicate refund');

  // amount mismatch: money arrives but the sponsorship is NOT activated
  const o2 = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: bronze.id }, sp.token);
  const p2 = await h.api('POST', `/api/sponsorship-orders/${o2.id}/pay`, { acceptAgreement: true }, sp.token);
  const mm = signedSandbox({ id: 'evt_mm_1', type: 'payment.captured', data: { order_id: p2.client.redirectUrl.split('/').pop(), payment_id: 'pay_C', amount: 100, currency: 'INR' } });
  const r = await req('POST', '/api/payments/webhook/sandbox', { raw: mm.body, type: 'application/json', headers: mm.headers });
  assert.equal(r.json.result, 'amount_mismatch');
  const o2v = await h.api('GET', `/api/org/sponsorships/${o2.id}`, undefined, org);
  assert.equal(o2v.status, 'PENDING_PAYMENT');
  assert.ok(o2v.risk.includes('amount_mismatch'));
  assert.equal(o2v.placements.length, 0);

  // failed payment keeps the hold and tells the sponsor
  const o3 = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: bronze.id }, sp.token);
  await sandboxPay(o3.id, sp.token, 'failure');
  const o3v = await h.api('GET', `/api/sponsorship-orders/${o3.id}`, undefined, sp.token);
  assert.equal(o3v.status, 'PENDING_PAYMENT');
  assert.equal(o3v.payments[0].status, 'failed');
});

test('stock holds: sold-out package, hold expiry releases it, late payment is refunded', async () => {
  const silver = opp.packages.find((p: any) => p.tier === 'silver');
  const a = await signupSponsor('Hold Co');
  const b = await signupSponsor('Waiting Co');
  const oa = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: silver.id }, a.token);
  const pa = await h.api('POST', `/api/sponsorship-orders/${oa.id}/pay`, { acceptAgreement: true }, a.token);
  const sold = await req('POST', '/api/sponsorship-orders', { token: b.token, body: { opportunityId: opp.id, packageId: silver.id } });
  assert.equal(sold.status, 409);
  assert.equal(sold.json.error.code, 'SOLD_OUT');

  const jobs = await h.app.sponsorship.runJobs(new Date(Date.now() + 31 * 60e3));
  assert.ok(jobs.holdsReleased >= 1);
  const ob = await h.api('POST', '/api/sponsorship-orders', { opportunityId: opp.id, packageId: silver.id }, b.token);
  await sandboxPay(ob.id, b.token);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${ob.id}`, undefined, b.token)).status, 'ACTIVE');

  // A pays after its hold lapsed and the slot went to B → automatic refund, never double-sold
  await h.api('POST', `/api/pay/sandbox/${pa.client.redirectUrl.split('/').pop()}/complete`, { outcome: 'success' });
  await sleep(150);
  const av = await h.api('GET', `/api/sponsorship-orders/${oa.id}`, undefined, a.token);
  assert.equal(av.status, 'REFUNDED');
  assert.equal(av.refunds[0].status, 'processed');
  const pkg = db().prepare('SELECT sold FROM sp_packages WHERE id = ?').get(silver.id) as any;
  assert.equal(pkg.sold, 1);
});

test('approval workflows: manual approval and asset review with rejection + replacement', async () => {
  const reviewOpp = await h.api('POST', '/api/sponsorship-opportunities', { title: 'Reviewed Cup', sport: 'football', city: 'Vadodara', approvalMode: 'asset_review', publish: true, packages: [{ template: 'bronze', maxSponsors: 3 }] }, org);
  const sp = await signupSponsor('Careful Brand');
  const o = await h.api('POST', '/api/sponsorship-orders', { opportunityId: reviewOpp.id, packageId: reviewOpp.packages[0].id }, sp.token);
  await sandboxPay(o.id, sp.token);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${o.id}`, undefined, sp.token)).status, 'ASSET_REVIEW');

  const r1 = await h.api('POST', `/api/sponsorships/${o.id}/approve`, { assets: { logo: { decision: 'reject', note: 'Use the high-contrast version' } } }, org);
  assert.equal(r1.status, 'ASSET_REVIEW');
  const notes = await h.api('GET', '/api/notifications', undefined, sp.token);
  assert.ok(notes.items.some((n: any) => /replace your creative/i.test(n.title)));

  const newLogo = await req('POST', '/api/sponsor/assets?kind=logo', { token: sp.token, raw: await png(900, 300), type: 'image/png' });
  const replaced = await h.api('POST', `/api/sponsorships/${o.id}/assets`, { assetIds: { logo: newLogo.json.id }, clickUrl: 'https://careful.example/offer' }, sp.token);
  assert.equal(replaced.assets.find((a: any) => a.role === 'logo').status, 'pending');
  const r2 = await h.api('POST', `/api/sponsorships/${o.id}/approve`, {}, org);
  assert.equal(r2.status, 'ACTIVE');
  assert.equal(r2.clickUrl, 'https://careful.example/offer');
  assert.ok(r2.documents.some((d: any) => d.kind === 'confirmation'));

  // manual approval; reject → automatic full refund
  const manualOpp = await h.api('POST', '/api/sponsorship-opportunities', { title: 'Manual Masters', sport: 'tennis', city: 'Pune', approvalMode: 'manual', publish: true, packages: [{ template: 'bronze', maxSponsors: 3 }] }, org);
  const m1 = await h.api('POST', '/api/sponsorship-orders', { opportunityId: manualOpp.id, packageId: manualOpp.packages[0].id }, sp.token);
  await sandboxPay(m1.id, sp.token);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${m1.id}`, undefined, sp.token)).status, 'PENDING_APPROVAL');
  assert.equal((await req('POST', `/api/sponsorships/${m1.id}/approve`, { token: orgB, body: {} })).status, 404, 'other organizers cannot approve');
  assert.equal((await req('POST', `/api/sponsorships/${m1.id}/approve`, { token: sp.token, body: {} })).status, 403, 'sponsors cannot approve themselves');
  const rej = await h.api('POST', `/api/sponsorships/${m1.id}/reject`, { reason: 'Category conflict with title sponsor' }, org);
  assert.equal(rej.status, 'CANCELLED');
  await sleep(150);
  const m1v = await h.api('GET', `/api/sponsorship-orders/${m1.id}`, undefined, sp.token);
  assert.equal(m1v.status, 'REFUNDED');
  assert.equal(m1v.refunds[0].amountMinor, m1.totalMinor);
});

test('pause, partial refund, full refund (ledger reverses) and transfer', async () => {
  const bronze = cricketOpp.packages.find((p: any) => p.tier === 'bronze');
  const sp = await signupSponsor('Refund Me');
  const o = await h.api('POST', '/api/sponsorship-orders', { opportunityId: cricketOpp.id, packageId: bronze.id }, sp.token);
  await sandboxPay(o.id, sp.token);
  assert.equal((await h.api('POST', `/api/sponsorships/${o.id}/pause`, { reason: 'Venue maintenance' }, org)).status, 'PAUSED');
  const placements = db().prepare('SELECT active FROM sp_placements WHERE order_id = ?').all(o.id) as any[];
  assert.ok(placements.every((p) => p.active === 0));
  assert.equal((await h.api('POST', `/api/sponsorships/${o.id}/resume`, {}, org)).status, 'ACTIVE');

  assert.equal((await req('POST', `/api/sponsorships/${o.id}/refund`, { token: org, body: { amount: 999999, reason: 'too much' } })).status, 400);
  const part = await h.api('POST', `/api/sponsorships/${o.id}/refund`, { amount: 5000, reason: 'One match washed out' }, org);
  assert.equal(part.order.status, 'ACTIVE');
  await sleep(150);
  const full = await h.api('POST', `/api/sponsorships/${o.id}/refund`, { reason: 'League cancelled' }, org);
  assert.equal(full.order.status, 'CANCELLED');
  await sleep(150);
  const v = await h.api('GET', `/api/org/sponsorships/${o.id}`, undefined, org);
  assert.equal(v.status, 'REFUNDED');
  assert.equal(v.refundableMinor, 0);
  const payable = (db().prepare("SELECT SUM(amount_minor) AS v FROM sp_ledger WHERE order_id = ? AND kind = 'organizer_payable'").get(o.id) as any).v;
  const commission = (db().prepare("SELECT SUM(amount_minor) AS v FROM sp_ledger WHERE order_id = ? AND kind = 'commission'").get(o.id) as any).v;
  assert.ok(Math.abs(payable) <= 2 && Math.abs(commission) <= 2, 'ledger nets to zero after a full refund');
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM sp_invoices WHERE order_id = ? AND kind = 'credit_note'").get(o.id) as any).n, 2, 'one credit note per refund');

  // transfer a live sponsorship to another sponsor account
  const from = await signupSponsor('Old Owner');
  const to = await signupSponsor('New Owner');
  const t = await h.api('POST', '/api/sponsorship-orders', { opportunityId: cricketOpp.id, packageId: bronze.id }, from.token);
  await sandboxPay(t.id, from.token);
  const moved = await h.api('POST', `/api/sponsorships/${t.id}/transfer`, { toSponsor: to.account.slug }, org);
  assert.equal(moved.sponsor.slug, to.account.slug);
  assert.equal((await req('GET', `/api/sponsorship-orders/${t.id}`, { token: from.token })).status, 404);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${t.id}`, undefined, to.token)).status, 'ACTIVE');
});

test('sponsor team roles: invite, accept, role limits and account switching', async () => {
  const inviteeEmail = `finance+${Date.now()}@chai.example`;
  await h.api('POST', '/api/sponsor/team/invite', { email: inviteeEmail, role: 'viewer' }, chai.token);
  const mail = outboxCode(inviteeEmail, 'sponsor.invite')!;
  const token = mail.match(/invite=([A-Za-z0-9_-]+)/)![1];
  const invitee = await h.api('POST', '/api/auth/sponsor-signup', { email: inviteeEmail, password: 'viewer-pass-1', personName: 'Vee Ewer', name: 'Vee Personal', kind: 'individual' });
  await h.api('POST', '/api/sponsor/invites/accept', { token }, invitee.token);
  const me = await h.api('GET', '/api/sponsor/me', undefined, invitee.token);
  assert.equal(me.memberships.length, 2);

  const bronze = opp.packages.find((p: any) => p.tier === 'bronze');
  const asViewer = await req('POST', '/api/sponsorship-orders', { token: invitee.token, account: chai.account.id, body: { opportunityId: opp.id, packageId: bronze.id } });
  assert.equal(asViewer.status, 403);
  assert.match(asViewer.json.error.message, /viewer/);
  const dash = await req('GET', '/api/sponsor/dashboard', { token: invitee.token, account: chai.account.id });
  assert.equal(dash.status, 200);
  assert.equal(dash.json.account.name, 'Chai Point');
  // a non-member can't target an account by header
  const stranger = await signupSponsor('Stranger');
  assert.equal((await req('GET', '/api/sponsor/dashboard', { token: stranger.token, account: chai.account.id })).status, 403);
  // only an owner can make owners; the last owner can't be removed
  assert.equal((await req('DELETE', `/api/sponsor/team/${me.user.id}`, { token: chai.token })).status, 200);
  const ownerId = (await h.api('GET', '/api/sponsor/me', undefined, chai.token)).user.id;
  assert.equal((await req('DELETE', `/api/sponsor/team/${ownerId}`, { token: chai.token })).status, 409);
});

test('OTP login and Google sign-in (server-verified ID token)', async () => {
  const send = await h.api('POST', '/api/auth/otp/send', { channel: 'email', destination: chai.email, purpose: 'login' });
  assert.equal(send.sent, true);
  const code = outboxCode(chai.email, 'auth.login')!.match(/\b(\d{6})\b/)![1];
  await assert.rejects(h.api('POST', '/api/auth/otp/verify', { channel: 'email', destination: chai.email, code: code === '000000' ? '111111' : '000000' }), /incorrect/);
  const ok = await h.api('POST', '/api/auth/otp/verify', { channel: 'email', destination: chai.email, code });
  assert.ok(ok.token);
  await assert.rejects(h.api('POST', '/api/auth/otp/verify', { channel: 'email', destination: chai.email, code }), /incorrect|expired/, 'codes are single-use');
  // unknown emails get the same response (no account enumeration) and no code is sent
  const unknown = await h.api('POST', '/api/auth/otp/send', { channel: 'email', destination: 'nobody@nowhere.example', purpose: 'login' });
  assert.equal(unknown.sent, true);
  assert.equal(outboxCode('nobody@nowhere.example', 'auth.login'), undefined);

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  setJwksFetcher(async () => ({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as any), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  process.env.GOOGLE_CLIENT_ID = 'sd-test-client';
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mk = (claims: any) => {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: 'sd-test-client', sub: 'google-123', email: 'newbrand@gmail.example', email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims });
    return `${head}.${body}.${rsaSign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const g = await h.api('POST', '/api/auth/oauth/google', { idToken: mk({}) });
  assert.equal(g.created, true);
  const again = await h.api('POST', '/api/auth/oauth/google', { idToken: mk({}) });
  assert.equal(again.created, false);
  await assert.rejects(h.api('POST', '/api/auth/oauth/google', { idToken: mk({ aud: 'someone-else' }) }), /different app/);
  const tampered = mk({}).split('.');
  tampered[1] = b64({ iss: 'https://accounts.google.com', aud: 'sd-test-client', sub: 'admin', email: 'x@y.z', email_verified: true, exp: 9e9 });
  await assert.rejects(h.api('POST', '/api/auth/oauth/google', { idToken: tampered.join('.') }), /signature/);
  delete process.env.GOOGLE_CLIENT_ID;
});

test('AI matching: the brief\'s natural-language request becomes a budget plan', async () => {
  const r = await h.api('POST', '/api/sponsorships/agent', { message: 'I have ₹5 lakh and want maximum visibility among young cricket audiences in Gujarat.' });
  assert.equal(r.engine, 'rules');
  assert.ok(r.understood.includes('Budget ₹5,00,000'));
  assert.ok(r.understood.some((u: string) => /Cricket/.test(u)));
  assert.ok(r.understood.some((u: string) => /Gujarat/.test(u)));
  assert.ok(r.understood.some((u: string) => /18-24/.test(u)));
  assert.equal(r.plan.picks[0].opportunity.title, 'Surat Premier Cricket League');
  assert.ok(r.plan.picks.every((p: any) => p.opportunity.sport === 'cricket' && p.opportunity.state === 'Gujarat'), 'plan honours the requested sport and state');
  assert.ok(r.plan.totalMinor <= 5_00_000_00);
  assert.match(r.answer, /Surat Premier Cricket League/);
  const rec = await h.api('GET', '/api/sponsorships/recommendations?budget=30000&sports=cricket&states=Gujarat&ages=18-24');
  assert.equal(rec.recommendations[0].opportunity.sport, 'cricket');
  assert.ok(rec.recommendations[0].reasons.length >= 2);
  assert.ok(rec.recommendations.every((x: any) => x.package.priceMinor <= 30000_00), 'over-budget fixed-price packages excluded');
});

test('auction: proxy bidding, anti-sniping, close → winner order at second price + increment', async () => {
  const ends = new Date(Date.now() + 60_000).toISOString();
  const auc = await h.api('POST', '/api/sponsorship-opportunities', { title: 'Finals Title Rights', sport: 'football', city: 'Ahmedabad', saleModel: 'auction', publish: true, packages: [{ name: 'Finals naming rights', items: [{ type: 'tv_scoreboard_logo' }], auction: { startPrice: 20000, increment: 1000, endsAt: ends } }] }, org);
  const pkg = auc.packages[0];
  const a = await signupSponsor('Bidder A');
  const b = await signupSponsor('Bidder B');
  // auction packages can't be bought at a fixed price
  assert.equal((await req('POST', '/api/sponsorship-orders', { token: a.token, body: { opportunityId: auc.id, packageId: pkg.id } })).json?.error?.code, 'NO_PRICE');
  let r = await h.api('POST', `/api/sponsorship-packages/${pkg.id}/bids`, { maxAmount: 30000 }, a.token);
  assert.equal(r.leading, true);
  assert.equal(r.auction.currentMinor, 20000_00);
  r = await h.api('POST', `/api/sponsorship-packages/${pkg.id}/bids`, { maxAmount: 25000 }, b.token);
  assert.equal(r.leading, false);
  assert.equal(r.auction.currentMinor, 26000_00);
  await assert.rejects(h.api('POST', `/api/sponsorship-packages/${pkg.id}/bids`, { maxAmount: 26500 }, b.token), /at least/);
  r = await h.api('POST', `/api/sponsorship-packages/${pkg.id}/bids`, { maxAmount: 40000 }, b.token);
  assert.equal(r.leading, true);
  assert.equal(r.auction.currentMinor, 31000_00);
  assert.ok(Date.parse(r.auction.endsAt) >= Date.parse(ends), 'late bid extends the auction');
  const outbid = await h.api('GET', '/api/notifications', undefined, a.token);
  assert.ok(outbid.items.some((n: any) => /outbid/i.test(n.title)));

  const row = db().prepare('SELECT auction FROM sp_packages WHERE id = ?').get(pkg.id) as any;
  db().prepare('UPDATE sp_packages SET auction = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.auction), endsAt: new Date(Date.now() - 1000).toISOString() }), pkg.id);
  const jobs = await h.app.sponsorship.runJobs();
  assert.equal(jobs.auctionsClosed, 1);
  const won = await h.api('GET', '/api/sponsorship-orders', undefined, b.token);
  assert.equal(won[0].totalMinor, Math.round(31000_00 * 1.18));
  assert.equal(won[0].source, 'auction');
  await assert.rejects(h.api('POST', `/api/sponsorship-packages/${pkg.id}/bids`, { maxAmount: 90000 }, a.token), /closed/i);
});

test('negotiation: offer → counter-proposal → accept creates an order at the agreed price', async () => {
  const neg = await h.api('POST', '/api/sponsorship-opportunities', { title: 'Corporate Padel Night', sport: 'padel', city: 'Mumbai', saleModel: 'negotiated', publish: true, packages: [{ name: 'Court partner', price: 50000, items: [{ type: 'venue_sponsor' }, { type: 'instagram_post' }] }] }, org);
  const sp = await signupSponsor('Haggle Co');
  const t = await h.api('POST', '/api/sponsorship-threads', { opportunityId: neg.id, packageId: neg.packages[0].id, message: 'Would you take ₹40,000 for the season?', offer: 40000 }, sp.token);
  assert.equal(t.kind, 'offer');
  await assert.rejects(h.api('POST', `/api/sponsorship-threads/${t.id}/accept`, {}, sp.token), /other side/);
  const orgThreads = await h.api('GET', '/api/org/sponsorship-threads', undefined, org);
  assert.equal(orgThreads[0].id, t.id);
  assert.equal((await req('GET', `/api/org/sponsorship-threads/${t.id}`, { token: orgB })).status, 404);
  await h.api('POST', `/api/org/sponsorship-threads/${t.id}/messages`, { message: 'Meet us at ₹45,000 and we add a story', offer: 45000 }, org);
  const dash = await h.api('GET', '/api/org/sponsorship-dashboard', undefined, org);
  assert.equal(dash.pipeline.find((s: any) => s.stage === 'Proposal Sent').count, 1);
  const acc = await h.api('POST', `/api/sponsorship-threads/${t.id}/accept`, {}, sp.token);
  assert.equal(acc.order.subtotalMinor, 45000_00);
  assert.equal(acc.order.source, 'negotiated');
  assert.equal(acc.thread.status, 'accepted');
});

test('renewal, reminders, expiry and settlements', async () => {
  const renewal = await h.api('POST', `/api/sponsorships/${goldOrder.id}/renew`, {}, chai.token);
  assert.equal(renewal.status, 'PENDING_PAYMENT', 'the current holder can renew an exclusive package');
  assert.equal(renewal.renewalOf, goldOrder.id);
  assert.equal(renewal.startsOn, day(31));
  assert.ok(renewal.documents.some((d: any) => d.kind === 'renewal'));
  const again = await h.api('POST', `/api/sponsorships/${goldOrder.id}/renew`, {}, chai.token);
  assert.equal(again.id, renewal.id);

  const before = (db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE event = 'sponsorship.renewal_reminder' AND sponsor_id = ?").get(chai.account.id) as any).n;
  await h.app.sponsorship.runJobs(new Date(Date.now() + 25 * 864e5));
  await h.app.sponsorship.runJobs(new Date(Date.now() + 25 * 864e5));
  const afterN = (db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE event = 'sponsorship.renewal_reminder' AND sponsor_id = ?").get(chai.account.id) as any).n;
  assert.equal(afterN - before, 1, 'one reminder, not a burst, when several thresholds are crossed');

  // platform admin: settlements of organizer money held on the platform account
  const adminEmail = `ops+${Date.now()}@sportsdiary.example`;
  const admin = await h.api('POST', '/api/auth/sponsor-signup', { email: adminEmail, password: 'platform-pass-1', personName: 'Ops', name: 'Ops Personal', kind: 'individual' });
  assert.equal((await req('GET', '/api/admin/overview', { token: admin.token })).status, 403);
  db().prepare('UPDATE users SET platform_admin = 1 WHERE email = ?').run(adminEmail);
  const ov = await h.api('GET', '/api/admin/overview', undefined, admin.token);
  assert.ok(ov.gmv.length);
  const orgId = (await h.api('GET', '/api/me', undefined, org)).organization.id;
  const due = ov.settlements.find((s: any) => s.orgId === orgId);
  assert.ok(due.amountMinor > 0);
  const s = await h.api('POST', '/api/admin/settlements', { orgId, currency: 'INR' }, admin.token);
  assert.equal(s.amountMinor, due.amountMinor);
  await assert.rejects(h.api('POST', '/api/admin/settlements', { orgId, currency: 'INR' }, admin.token), /Nothing to settle/);
  await h.api('POST', `/api/admin/settlements/${s.id}/paid`, { reference: 'UTR123456789' }, admin.token);

  // suspending a sponsor removes their branding immediately
  await h.api('POST', `/api/admin/sponsors/${chai.account.id}/status`, { status: 'suspended', reason: 'Chargeback investigation' }, admin.token);
  const live = await h.api('GET', `/api/public/m/${matchCode}`);
  assert.ok(!JSON.stringify(live.sponsorship ?? {}).includes('Chai Point'));
  assert.equal((await req('GET', '/api/sponsor/dashboard', { token: chai.token })).status, 403);
  await h.api('POST', `/api/admin/sponsors/${chai.account.id}/status`, { status: 'active' }, admin.token);

  // expiry
  const res = await h.app.sponsorship.runJobs(new Date(Date.now() + 40 * 864e5));
  assert.ok(res.expired >= 1);
  assert.equal((await h.api('GET', `/api/sponsorship-orders/${goldOrder.id}`, undefined, chai.token)).status, 'EXPIRED');
});

test('provider webhook signatures: Razorpay, Stripe and Cashfree', () => {
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', created_at: 1, payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 500, currency: 'INR', method: 'upi' } } } }));
  const rz = razorpay({ keyId: 'rzp_test_x', keySecret: 's', webhookSecret: 'whsec_rz' });
  const ev = rz.verifyWebhook(body, { 'x-razorpay-signature': createHmac('sha256', 'whsec_rz').update(body).digest('hex'), 'x-razorpay-event-id': 'evt_1' });
  assert.equal(ev.type, 'payment.captured');
  assert.equal(ev.amountMinor, 500);
  assert.throws(() => rz.verifyWebhook(body, { 'x-razorpay-signature': 'a'.repeat(64) }), /Invalid/);
  assert.throws(() => rz.verifyWebhook(Buffer.from(body.toString().replace('500', '5')), { 'x-razorpay-signature': createHmac('sha256', 'whsec_rz').update(body).digest('hex') }), /Invalid/, 'any byte change breaks the signature');

  const sbody = Buffer.from(JSON.stringify({ id: 'evt_s', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 1200, currency: 'usd' } } }));
  const t = Math.floor(Date.now() / 1000);
  const st = stripe({ secretKey: 'sk_test_x', webhookSecret: 'whsec_st' });
  const sig = createHmac('sha256', 'whsec_st').update(`${t}.${sbody}`).digest('hex');
  const sev = st.verifyWebhook(sbody, { 'stripe-signature': `t=${t},v1=${sig}` });
  assert.equal(sev.currency, 'USD');
  assert.throws(() => st.verifyWebhook(sbody, { 'stripe-signature': `t=${t - 1000},v1=${createHmac('sha256', 'whsec_st').update(`${t - 1000}.${sbody}`).digest('hex')}` }), /tolerance/);

  const cbody = Buffer.from(JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'sd_1' }, payment: { cf_payment_id: 9, payment_amount: 25000.5, payment_currency: 'INR', payment_group: 'upi' } } }));
  const cf = cashfree({ appId: 'a', secretKey: 'cf_secret', environment: 'sandbox' });
  const cev = cf.verifyWebhook(cbody, { 'x-webhook-timestamp': '123', 'x-webhook-signature': createHmac('sha256', 'cf_secret').update('123' + cbody.toString()).digest('base64') });
  assert.equal(cev.amountMinor, 2500050);
  assert.throws(() => cf.verifyWebhook(cbody, { 'x-webhook-timestamp': '124', 'x-webhook-signature': createHmac('sha256', 'cf_secret').update('123' + cbody.toString()).digest('base64') }), /Invalid/);
});
