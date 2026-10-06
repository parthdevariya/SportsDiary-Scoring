/**
 * Demo data: 21 organizations, 50+ tournaments, 100+ teams, 500+ players, venues with
 * courts/tables/fields, live matches in every sport, paired screens, completed results
 * (so standings, player stats and ratings are real), all produced through the same
 * services and rule engines the product uses — no hand-written scores.
 *
 *   npm run seed            (writes sportsdiary.db; DB_FILE overrides)
 * Demo login:  demo@sportsdiary.app / diary-demo-2026
 */
import { existsSync, rmSync } from 'node:fs';
import { createApp } from '../apps/api/src/app.ts';
import { hashPassword, type AuthUser } from '../apps/api/src/auth.ts';
import { id } from '../apps/api/src/context.ts';
import { J, now } from '../apps/api/src/db.ts';
import { saveOrgSettings } from '../apps/api/src/sponsorship/settings.ts';
import sharp from 'sharp';
import { MatchAggregate } from '../packages/engine/src/index.ts';
import { simulate, rng } from '../packages/engine/src/sim.ts';

const file = process.env.DB_FILE ?? 'sportsdiary.db';
for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
const app = createApp({ dbFile: file });
const { db } = app.ctx;
const R = rng(2026);
const pick = <T>(a: T[]) => a[Math.floor(R() * a.length)];

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Kabir', 'Rohan', 'Dhruv', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Myra', 'Isha', 'Kavya', 'Meera', 'Riya', 'Tara', 'Nisha', 'Pooja', 'Rahul', 'Karan', 'Siddharth', 'Yash', 'Neha', 'Priya', 'Harsh', 'Jay', 'Hetal', 'Dev', 'Mihir', 'Parth', 'Kunal', 'Zara', 'Imran', 'Farhan', 'Gurpreet', 'Simran', 'Anjali', 'Varun', 'Nikhil', 'Tanvi', 'Om', 'Rudra', 'Shreya'];
const LAST = ['Shah', 'Patel', 'Mehta', 'Desai', 'Joshi', 'Iyer', 'Rao', 'Nair', 'Reddy', 'Kapoor', 'Malhotra', 'Singh', 'Gill', 'Chopra', 'Bose', 'Das', 'Banerjee', 'Kulkarni', 'Pandya', 'Trivedi', 'Bhatt', 'Parikh', 'Khan', 'Sheikh', 'Menon', 'Pillai', 'Verma', 'Gupta', 'Agarwal', 'Jain'];
const CITIES = ['Ahmedabad', 'Sanand', 'Gandhinagar', 'Vadodara', 'Surat', 'Rajkot', 'Mumbai', 'Pune', 'Bengaluru', 'Hyderabad', 'Chennai', 'Delhi', 'Jaipur', 'Kochi', 'Kolkata'];
const TEAM_WORDS = ['Strikers', 'Titans', 'Falcons', 'Royals', 'Warriors', 'Panthers', 'Chargers', 'Lions', 'Riders', 'Blasters', 'Kings', 'Rangers', 'Stallions', 'Sharks', 'Hawks', 'Tuskers'];
const COLORS = ['#E5484D', '#2F7FE0', '#9B5DE5', '#00B8D9', '#F2711C', '#E83E8C', '#F4F6F8', '#14A3A3'];
const ORG_NAMES = [
  'Riverside Sports Club', 'Sabarmati Sports Academy', 'Sanand Smashers Academy', 'Navrangpura Gymkhana', 'Gujarat University Athletics', 'Ahmedabad Corporate League',
  'Surat Shuttle Centre', 'Vadodara Table Tennis Hub', 'Baroda Cue Club', 'Rajkot Cricket Association', 'Pune Padel Club', 'Bengaluru Pickleball Collective',
  'Mumbai Hoops League', 'Kochi Volleyball Federation', 'Hyderabad Racquet Club', 'Delhi Schools Sports Board', 'Jaipur Polo & Sports Club', 'Chennai Corporate Games',
  'Kolkata Football Academy', 'Gandhinagar IT Park League', 'Lakeside Resort & Sports',
];

let personSeq = 0;
const person = () => `${pick(FIRST)} ${pick(LAST)}`;

function makeOrg(name: string, email?: string): AuthUser {
  const orgId = id();
  const userId = id();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  db.prepare('INSERT INTO organizations (id, name, slug, plan, branding, created_at) VALUES (?,?,?,?,?,?)').run(orgId, name, slug, pick(['free', 'starter', 'pro', 'enterprise']), J({}), now());
  db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)').run(
    userId, orgId, email ?? `admin@${slug}.example`, `${pick(FIRST)} ${pick(LAST)}`, hashPassword(email ? 'diary-demo-2026' : id()), 'org_admin', now());
  return { id: userId, orgId, email: email ?? '', name: 'Admin', role: 'org_admin' };
}

function venue(u: AuthUser, name: string, courts: [string, string][]) {
  const vid = id();
  db.prepare('INSERT INTO venues (id, org_id, name, address, capacity, facilities, created_at) VALUES (?,?,?,?,?,?,?)').run(vid, u.orgId, name, `${pick(CITIES)}, India`, 200 + Math.floor(R() * 3000), J(['Changing rooms', 'Parking', 'Floodlights']), now());
  const surfaces = courts.map(([n, kind], i) => {
    const sid = id();
    db.prepare('INSERT INTO surfaces (id, org_id, venue_id, name, kind, sports, sort) VALUES (?,?,?,?,?,?,?)').run(sid, u.orgId, vid, n, kind, '[]', i);
    return sid;
  });
  return { id: vid, surfaces };
}

function players(u: AuthUser, n: number, sport: string) {
  return Array.from({ length: n }, () => {
    const pid = id();
    personSeq++;
    db.prepare('INSERT INTO players (id, org_id, name, gender, city, country, sports, created_at) VALUES (?,?,?,?,?,?,?,?)').run(pid, u.orgId, person(), pick(['M', 'F']), pick(CITIES), 'India', J([sport]), now());
    return pid;
  });
}

function team(u: AuthUser, sport: string, size: number, city: string) {
  const tid = id();
  const name = `${city} ${pick(TEAM_WORDS)}`;
  db.prepare('INSERT INTO teams (id, org_id, name, short, color, sport, coach, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    tid, u.orgId, name, name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase() + String(Math.floor(R() * 9)), pick(COLORS), sport, person(), now());
  players(u, size, sport).forEach((pid, i) => db.prepare('INSERT INTO team_players (team_id, player_id, number) VALUES (?,?,?)').run(tid, pid, String(i + 1)));
  return tid;
}

/** Play a stored match through the real service: simulate locally, then one batched append. */
function play(u: AuthUser, matchId: string, opts: { seed: number; stopAfter?: number; bias?: number; startAt?: number }) {
  const r = app.matches.row(matchId)!;
  const agg = new MatchAggregate(app.matches.definition(r));
  simulate(agg, { seed: opts.seed, stopAfter: opts.stopAfter, bias: opts.bias ?? 0.4 + R() * 0.2, startAt: opts.startAt });
  const inputs = agg.events.map((e) => ({ id: e.id, clientEventId: e.clientEventId, type: e.type, payload: e.payload, deviceTime: e.deviceTime }));
  if (inputs.length) app.matches.appendEvents(u, matchId, inputs);
}

const TEAM_SPORTS: Record<string, { discipline: string; size: number; cfg?: any }> = {
  football: { discipline: '7-a-side', size: 10 },
  cricket: { discipline: 't10', size: 11, cfg: { oversPerInnings: 6 } },
  basketball: { discipline: '3x3', size: 4 },
  volleyball: { discipline: 'indoor-best-of-3', size: 8 },
};
const INDIV: Record<string, { discipline: string; cfg?: any }> = {
  badminton: { discipline: 'singles' },
  'table-tennis': { discipline: 'best-of-3' },
  tennis: { discipline: 'fast4' },
  pickleball: { discipline: 'singles' },
  padel: { discipline: 'doubles' },
  snooker: { discipline: 'six-red', cfg: { bestOf: 3 } },
  billiards: { discipline: 'pool-9-ball' },
};
const ALL_SPORTS = [...Object.keys(TEAM_SPORTS), ...Object.keys(INDIV)];
const t0 = Date.now();
let seedN = 1;
let tournamentsMade = 0;
const pastStart = Date.parse('2026-10-03T04:30:00Z');

// ------------------------------------------------------------------ the demo club
const demo = makeOrg(ORG_NAMES[0], 'demo@sportsdiary.app');
db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run('pro', demo.orgId);
const arena = venue(demo, 'Riverside Arena', [
  ['Badminton Court 1', 'court'], ['Badminton Court 2', 'court'], ['Badminton Court 3', 'court'], ['Badminton Court 4', 'court'],
  ['Centre Court', 'court'], ['Padel Court 1', 'court'], ['Pickleball Court 1', 'court'], ['Basketball Court', 'court'],
  ['Volleyball Court', 'court'], ['TT Table 1', 'table'], ['Snooker Table 1', 'table'], ['Pool Table 1', 'table'],
]);
const ground = venue(demo, 'Riverside Ground', [['Pitch A', 'field'], ['Cricket Oval', 'field']]);
const s = (name: string) => {
  const all = [...arena.surfaces, ...ground.surfaces];
  const row = db.prepare('SELECT id FROM surfaces WHERE name = ? AND org_id = ?').get(name, demo.orgId) as any;
  return row?.id ?? all[0];
};
// scorer account for the demo
db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)').run(id(), demo.orgId, 'scorer@sportsdiary.app', 'Court Scorer', hashPassword('diary-demo-2026'), 'scorer', now());

// Badminton round robin across the 4 courts: two rounds done, round 3 live
const bp = players(demo, 8, 'badminton');
const bt = app.tournaments.create(demo, { name: 'Riverside Badminton Open', sport: 'badminton', discipline: 'singles', format: 'round_robin', venueId: arena.id, entrants: bp.map((p) => ({ playerIds: [p] })), matchConfig: {} });
const bms = app.tournaments.generate(demo, bt.id, { startAt: new Date(Date.now() - 3 * 3600e3).toISOString(), slotMinutes: 45, surfaceIds: arena.surfaces.slice(0, 4) });
tournamentsMade++;
bms.forEach((m) => {
  if ((m.round ?? 0) <= 2) play(demo, m.id, { seed: seedN++ });
  else if (m.round === 3) play(demo, m.id, { seed: seedN++, stopAfter: 20 + Math.floor(R() * 30) });
});

// Football league with full squads
const fteams = ['Ahmedabad', 'Sanand', 'Gandhinagar', 'Vadodara'].map((c) => team(demo, 'football', 11, c));
const ft = app.tournaments.create(demo, { name: 'Riverside 7s League', sport: 'football', discipline: '7-a-side', format: 'round_robin', venueId: ground.id, entrants: fteams.map((teamId) => ({ teamId })) });
const fms = app.tournaments.generate(demo, ft.id, { startAt: new Date(Date.now() - 2 * 864e5).toISOString(), slotMinutes: 60, surfaceIds: [s('Pitch A')] });
tournamentsMade++;
fms.forEach((m, i) => (i < 4 ? play(demo, m.id, { seed: seedN++ }) : i === 4 ? play(demo, m.id, { seed: seedN++, stopAfter: 14, startAt: Date.now() - 30 * 60e3 }) : null));

// One live match in every other sport, each on its own court/table/field
const live: [string, string, string, string, any?][] = [
  ['cricket', 't20', 'Cricket Oval', 'team'],
  ['basketball', '5x5', 'Basketball Court', 'team'],
  ['volleyball', 'indoor', 'Volleyball Court', 'team'],
  ['tennis', 'singles', 'Centre Court', 'single'],
  ['padel', 'doubles', 'Padel Court 1', 'double'],
  ['pickleball', 'doubles', 'Pickleball Court 1', 'double'],
  ['table-tennis', 'singles', 'TT Table 1', 'single'],
  ['snooker', 'best-of-7', 'Snooker Table 1', 'single'],
  ['billiards', 'pool-8-ball', 'Pool Table 1', 'single'],
];
const stopFor: Record<string, number> = { cricket: 150, basketball: 60, volleyball: 70, tennis: 70, padel: 45, pickleball: 30, 'table-tennis': 40, snooker: 40, billiards: 5 };
const liveIds: Record<string, string> = {};
for (const [sport, discipline, court, kind] of live) {
  const parts =
    kind === 'team'
      ? [0, 1].map(() => app.tournaments.participantFor(demo.orgId, { teamId: team(demo, sport, sport === 'cricket' ? 11 : sport === 'volleyball' ? 8 : 8, pick(CITIES)) }))
      : [0, 1].map(() => app.tournaments.participantFor(demo.orgId, { playerIds: players(demo, kind === 'double' ? 2 : 1, sport) }));
  const m = app.matches.create(demo, { sport, discipline, participants: parts, surfaceId: s(court), scheduledAt: new Date(Date.now() - 40 * 60e3).toISOString(), config: sport === 'cricket' ? { oversPerInnings: 20 } : {} });
  play(demo, m.id, { seed: seedN++, stopAfter: stopFor[sport], startAt: Date.now() - 45 * 60e3, bias: 0.5 });
  liveIds[sport] = m.id;
}

// Screens: a master venue board, a cricket screen, and a lobby playlist
const sponsorIns = db.prepare('INSERT INTO sponsors (id, org_id, name, tier, created_at) VALUES (?,?,?,?,?)');
for (const sp of ['Sabarmati Mills', 'Narmada Dairy', 'Kite Fintech', 'Lakeside Motors']) sponsorIns.run(id(), demo.orgId, sp, 'partner', now());
const dev = (name: string, assignment: any, aspect = '16:9', orientation = 'landscape') =>
  db.prepare('INSERT INTO display_devices (id, org_id, name, venue_id, secret_hash, assignment, orientation, aspect, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id(), demo.orgId, name, arena.id, id(), J(assignment), orientation, aspect, now());
dev('Arena Master Board', { mode: 'venue', venueId: arena.id });
dev('Cricket Oval LED', { mode: 'match', matchId: liveIds.cricket });
dev('Lobby Totem', { mode: 'playlist', items: [{ kind: 'venue', venueId: arena.id, seconds: 20 }, { kind: 'standings', tournamentId: ft.id, seconds: 12 }, { kind: 'upcoming', seconds: 10 }, { kind: 'sponsor', seconds: 6 }] }, '9:16', 'portrait');

// ------------------------------------------------------------------ 20 more organizations
for (const orgName of ORG_NAMES.slice(1)) {
  const u = makeOrg(orgName);
  const sports = [pick(ALL_SPORTS), pick(ALL_SPORTS), pick(ALL_SPORTS)].filter((x, i, a) => a.indexOf(x) === i);
  const v = venue(u, `${orgName.split(' ')[0]} Sports Centre`, [1, 2, 3, 4].map((n) => [`Court ${n}`, 'court'] as [string, string]));
  for (const sport of sports) {
    const team = TEAM_SPORTS[sport];
    const entrants = team
      ? Array.from({ length: 5 }, () => ({ teamId: makeTeam(u, sport, team.size) }))
      : players(u, 6, sport).map((p) => ({ playerIds: [p] }));
    const format = R() < 0.75 ? 'round_robin' : 'knockout';
    const tn = app.tournaments.create(u, {
      name: `${orgName.split(' ')[0]} ${pick(['Winter', 'Monsoon', 'Diwali', 'Founders', 'Champions'])} ${sportLabel(sport)} ${format === 'knockout' ? 'Cup' : 'League'}`,
      sport, discipline: team?.discipline ?? INDIV[sport].discipline, format: format as any, venueId: v.id, entrants, matchConfig: (team ? team.cfg : INDIV[sport].cfg) ?? {},
    });
    tournamentsMade++;
    const ms = app.tournaments.generate(u, tn.id, { startAt: new Date(pastStart).toISOString(), slotMinutes: 40, surfaceIds: v.surfaces });
    // Most fixtures finished; a couple in progress so every org has live data.
    let liveLeft = 1;
    for (const m of ms) {
      const fresh = app.matches.row(m.id)!;
      if (JSON.parse(fresh.participants).some((p: any) => p.id === 'tbd')) continue;
      if (R() < 0.8) play(u, m.id, { seed: seedN++ });
      else if (liveLeft-- > 0) play(u, m.id, { seed: seedN++, stopAfter: 15 });
    }
    // knockouts: keep playing rounds as winners advance
    if (format === 'knockout')
      for (let round = 2; round <= 4; round++)
        for (const m of app.matches.list(u.orgId, { tournamentId: tn.id }).filter((x) => x.round === round && x.status === 'scheduled'))
          if (!JSON.parse(m.participants).some((p: any) => p.id === 'tbd') && R() < 0.7) play(u, m.id, { seed: seedN++ });
  }
}

function makeTeam(u: AuthUser, sport: string, size: number) {
  return team(u, sport, size, pick(CITIES));
}
function sportLabel(id: string) {
  return ({ 'table-tennis': 'Table Tennis' } as any)[id] ?? id[0].toUpperCase() + id.slice(1);
}

// ------------------------------------------------------------------ sponsorship marketplace
// Everything below goes through the marketplace services: real orders, real (sandbox) payments
// confirmed by signed webhooks, real activation. Only the historical exposure is simulated.
const SP = app.sponsorship;
const GST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (state: string, pan: string) => {
  const b = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST.indexOf(b[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return b + GST[(36 - (sum % 36)) % 36];
};
const member = (email: string, name: string, admin = false): AuthUser => {
  const uid = id();
  db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, email_verified, platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid, null, email, name, hashPassword('diary-demo-2026'), 'member', 1, admin ? 1 : 0, now());
  return { id: uid, orgId: '', email, name, role: 'member' };
};
member('admin@sportsdiary.app', 'Platform Ops', true);
saveOrgSettings(db, demo.orgId, { legalName: 'Riverside Sports Club LLP', gstin: gstin('24', 'AAQFR4821K'), state: 'Gujarat', invoicePrefix: 'RSC', address: 'Riverfront Road, Ahmedabad 380009' });

const logoPng = (name: string, bg: string) => {
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" rx="36" fill="${bg}"/><circle cx="150" cy="150" r="96" fill="#fff" opacity=".95"/><text x="150" y="176" font-family="DejaVu Sans, Arial" font-size="78" font-weight="700" text-anchor="middle" fill="${bg}">${initials}</text><text x="285" y="178" font-family="DejaVu Sans, Arial" font-size="${name.length > 16 ? 58 : 72}" font-weight="700" fill="#fff">${name}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};
const BRANDS: [string, string, string, string, string][] = [
  ['Kesar Chai Co.', 'food-beverage', 'Restaurant / Hotel', '#B4441E', 'Ahmedabad'], ['Narmada Dairy', 'fmcg', 'Brand', '#1F6FB2', 'Vadodara'],
  ['Kite Fintech', 'finance', 'Startup', '#5B2DBA', 'Bengaluru'], ['Sprint Sportswear', 'sportswear', 'Sports Brand', '#111827', 'Mumbai'],
  ['Lakeside Motors', 'automotive', 'Local Business', '#0F766E', 'Ahmedabad'], ['Saffron Care Hospital', 'healthcare', 'Healthcare Organization', '#C2410C', 'Surat'],
];
const sponsors: { user: AuthUser; id: string; logo: string; name: string }[] = [];
for (const [i, [name, industry, category, color, city]] of BRANDS.entries()) {
  const user = member(i === 0 ? 'sponsor@sportsdiary.app' : `owner@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, i === 0 ? 'Neha Kapoor' : person());
  const acct = SP.sponsors.createAccount(user, { name, kind: 'organization', industry, category, city, country: 'India', website: `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, publicProfile: true, description: `${name} backs grassroots sport across ${city}.` });
  const asset = await SP.assets.upload(acct.id, user.id, 'logo', await logoPng(name, color), 'logo.png');
  SP.sponsors.updateProfile(acct.id, { logoAssetId: asset.id, brandColors: [color] });
  SP.sponsors.updateBilling(acct.id, { legalName: `${name} Pvt Ltd`, state: i === 0 ? 'Gujarat' : 'Maharashtra', country: 'India', email: user.email });
  sponsors.push({ user, id: acct.id, logo: asset.id, name });
}
// a finance teammate for the demo sponsor
db.prepare('INSERT INTO sponsor_members (sponsor_id, user_id, role, created_at) VALUES (?,?,?,?)').run(sponsors[0].id, member('finance@kesarchai.example', 'Arjun Mehta').id, 'finance', now());

const today = new Date().toISOString().slice(0, 10);
const plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const opp = (u: AuthUser, b: any) => SP.market.createOpportunity(u, { publish: true, country: 'India', ...b });
const badmintonOpp = opp(demo, { title: 'Riverside Badminton Open 2026', tournamentId: bt.id, city: 'Ahmedabad', state: 'Gujarat', level: 'state', audienceEstimate: 6500, audienceProfile: { ageGroups: ['18-24', '25-34'] }, startsOn: plus(-3), endsOn: plus(27), description: 'Eight of Gujarat’s best singles players across four courts at Riverside Arena, with every point on the arena’s LED boards and streamed live.', packages: [{ template: 'gold' }, { template: 'silver', maxSponsors: 2 }, { template: 'bronze', maxSponsors: 6 }] });
const leagueOpp = opp(demo, { title: 'Riverside 7s Football League', tournamentId: ft.id, city: 'Ahmedabad', state: 'Gujarat', level: 'local', audienceEstimate: 4200, audienceProfile: { ageGroups: ['18-24', '25-34', '35-44'] }, startsOn: plus(-2), endsOn: plus(40), approvalMode: 'asset_review', packages: [{ name: 'Match Sponsor (season)', price: 75000, items: [{ type: 'match_sponsor' }, { type: 'player_of_match' }, { type: 'qr_ad' }] }, { template: 'silver', maxSponsors: 2 }, { template: 'bronze', maxSponsors: 4 }] });
opp(demo, { title: 'Riverside Arena — LED screens & venue branding', venueId: arena.id, city: 'Ahmedabad', state: 'Gujarat', level: 'local', audienceEstimate: 9000, audienceProfile: { ageGroups: ['13-17', '18-24', '25-34', '35-44'] }, startsOn: today, endsOn: plus(90), packages: [{ name: 'Venue Partner (90 days)', price: 150000, maxSponsors: 1, items: [{ type: 'venue_sponsor' }, { type: 'led_screen', quantity: 4 }, { type: 'court_branding' }, { type: 'wall_branding' }] }, { name: 'Timeout & break slots', price: 30000, maxSponsors: 3, items: [{ type: 'timeout_sponsor' }, { type: 'break_sponsor' }] }] });
opp(demo, { title: 'Badminton Open — Finals naming rights', tournamentId: bt.id, city: 'Ahmedabad', state: 'Gujarat', level: 'state', audienceEstimate: 3000, saleModel: 'auction', packages: [{ name: 'Finals presented by', items: [{ type: 'title_sponsor' }], auction: { startPrice: 60000, increment: 5000, reserve: 80000, endsAt: new Date(Date.now() + 5 * 864e5).toISOString() } }] });
opp(demo, { title: 'Riverside T20 Cricket Bash', sport: 'cricket', city: 'Ahmedabad', state: 'Gujarat', level: 'state', audienceEstimate: 15000, audienceProfile: { ageGroups: ['18-24', '25-34'] }, startsOn: plus(5), endsOn: plus(35), description: 'Floodlit T20 nights at the Cricket Oval with ball-by-ball scoring on the LED board and live stream.', packages: [{ template: 'gold' }, { template: 'silver', maxSponsors: 3 }, { template: 'bronze', maxSponsors: 8 }, { name: 'Six & wicket moments', price: 120000, items: [{ type: 'tv_fullscreen_ad', quantity: 10 }, { type: 'stream_overlay' }, { type: 'qr_ad' }] }] });
opp(demo, { title: 'Corporate Padel Nights', sport: 'padel', city: 'Ahmedabad', state: 'Gujarat', level: 'corporate', audienceEstimate: 1200, audienceProfile: { ageGroups: ['25-34', '35-44'] }, saleModel: 'negotiated', startsOn: plus(7), endsOn: plus(60), packages: [{ name: 'Court partner', price: 40000, maxSponsors: 2, items: [{ type: 'venue_sponsor' }, { type: 'linkedin_post', quantity: 2 }, { type: 'instagram_story', quantity: 2 }] }] });
// other organizers list too, so the marketplace has range
const others = db.prepare("SELECT o.id AS orgId, u.id, u.email, t.id AS tid, t.name AS tname, t.sport FROM organizations o JOIN users u ON u.org_id = o.id AND u.role = 'org_admin' JOIN tournaments t ON t.org_id = o.id WHERE o.id != ? GROUP BY o.id LIMIT 12").all(demo.orgId) as any[];
const STATE_OF: Record<string, string> = { Ahmedabad: 'Gujarat', Sanand: 'Gujarat', Gandhinagar: 'Gujarat', Vadodara: 'Gujarat', Surat: 'Gujarat', Rajkot: 'Gujarat', Mumbai: 'Maharashtra', Pune: 'Maharashtra', Bengaluru: 'Karnataka', Hyderabad: 'Telangana', Chennai: 'Tamil Nadu', Delhi: 'Delhi', Jaipur: 'Rajasthan', Kochi: 'Kerala', Kolkata: 'West Bengal' };
for (const [i, o] of others.entries()) {
  const first = o.tname.split(' ')[0];
  const city = CITIES.includes(first) ? first : ({ Baroda: 'Vadodara', Sabarmati: 'Ahmedabad', Navrangpura: 'Ahmedabad', Gujarat: 'Ahmedabad', Lakeside: 'Sanand' } as Record<string, string>)[first] ?? CITIES[i % CITIES.length];
  opp({ id: o.id, orgId: o.orgId, email: o.email, name: 'Admin', role: 'org_admin' }, {
    title: `${o.tname} — sponsorship`, tournamentId: o.tid, city, state: STATE_OF[city], level: pick(['local', 'state', 'college', 'corporate', 'national']), audienceEstimate: 800 + Math.floor(R() * 18000),
    audienceProfile: { ageGroups: [pick(['13-17', '18-24']), pick(['25-34', '35-44'])] }, startsOn: plus(Math.floor(R() * 20) - 5), endsOn: plus(30 + Math.floor(R() * 60)),
    packages: R() < 0.5 ? [{ template: 'gold' }, { template: 'silver', maxSponsors: 2 }, { template: 'bronze', maxSponsors: 5 }] : [{ template: 'silver', maxSponsors: 3 }, { template: 'bronze', maxSponsors: 8 }],
  });
}
db.prepare('UPDATE sp_opportunities SET featured_until = ? WHERE id IN (?, ?)').run(new Date(Date.now() + 30 * 864e5).toISOString(), badmintonOpp.id, leagueOpp.id);

const pkgOf = (o: any, tier: string) => o.packages.find((p: any) => p.tier === tier || p.name === tier);
const buy = async (s: (typeof sponsors)[number], o: any, pkg: any, pay = true, startsOn?: string) => {
  const order = SP.orders.createOrder(s.user, s.id, { opportunityId: o.id, packageId: pkg.id, assetIds: { logo: s.logo }, startsOn: startsOn ?? today, clickUrl: `https://${s.name.toLowerCase().replace(/[^a-z]+/g, '')}.example/offer` });
  if (!pay) return order;
  const r = await SP.orders.pay(s.user, s.id, order.id, { acceptAgreement: true }, '127.0.0.1');
  const ev = SP.registry.sandbox.complete(r.client.redirectUrl.split('/').pop(), 'success', pick(['upi', 'card', 'netbanking']));
  await SP.orders.webhook('sandbox', null, Buffer.from(ev.body), ev.headers);
  return SP.orders.view(SP.orders.row(order.id), 'sponsor');
};
const gold = await buy(sponsors[0], badmintonOpp, pkgOf(badmintonOpp, 'gold'));
await buy(sponsors[1], badmintonOpp, pkgOf(badmintonOpp, 'silver'));
await buy(sponsors[2], badmintonOpp, pkgOf(badmintonOpp, 'bronze'));
await buy(sponsors[4], badmintonOpp, pkgOf(badmintonOpp, 'bronze'));
const league = await buy(sponsors[3], leagueOpp, pkgOf(leagueOpp, 'Match Sponsor (season)')); // asset review → organizer approves
SP.orders.approve(demo, league.id, {});
await buy(sponsors[5], leagueOpp, pkgOf(leagueOpp, 'silver')); // left in creative review for the demo
await buy(sponsors[0], leagueOpp, pkgOf(leagueOpp, 'bronze'), false); // awaiting payment
// a negotiation in progress and two auction bids
const padel = db.prepare("SELECT id FROM sp_opportunities WHERE title = 'Corporate Padel Nights'").get() as any;
const padelPkg = db.prepare('SELECT id FROM sp_packages WHERE opportunity_id = ?').get(padel.id) as any;
const th = SP.deals.startThread(sponsors[2].user, sponsors[2].id, { opportunityId: padel.id, packageId: padelPkg.id, message: 'We would love to back the corporate nights. Could you do ₹32,000 for both months?', offer: 32000 });
SP.deals.reply(demo, th.id, 'organizer', { orgId: demo.orgId }, { message: 'We can do ₹36,000 including two extra LinkedIn posts.', offer: 36000 });
const finals = db.prepare("SELECT p.id FROM sp_packages p JOIN sp_opportunities o ON o.id = p.opportunity_id WHERE o.title LIKE 'Badminton Open — Finals%'").get() as any;
SP.deals.bid(sponsors[3].user, sponsors[3].id, finals.id, 70000);
SP.deals.bid(sponsors[0].user, sponsors[0].id, finals.id, 90000);
// two deliverables already done for the Gold sponsor
for (const d of (db.prepare("SELECT id FROM sp_deliverables WHERE order_id = ? AND type = 'instagram_post'").all(gold.id) as any[]).slice(0, 1)) SP.orders.markDeliverable(demo, d.id, { status: 'delivered', proofUrl: 'https://instagram.com/p/riverside-open-kesar' });

// demo orders were bought when each event opened
db.prepare("UPDATE sp_orders SET starts_on = (SELECT starts_on FROM sp_opportunities op WHERE op.id = sp_orders.opportunity_id) WHERE status = 'ACTIVE' AND (SELECT starts_on FROM sp_opportunities op WHERE op.id = sp_orders.opportunity_id) < starts_on").run();
db.prepare('UPDATE sp_placements SET starts_on = (SELECT starts_on FROM sp_orders o WHERE o.id = sp_placements.order_id)').run();
// simulated historical exposure for live sponsorships (demo only; production numbers come from screens and pages)
const bump = db.prepare('INSERT INTO sp_exposure_daily (order_id, day, metric, dim, value) VALUES (?,?,?,?,?) ON CONFLICT(order_id, day, metric, dim) DO UPDATE SET value = value + excluded.value');
const uniq = db.prepare('INSERT OR IGNORE INTO sp_unique_viewers (order_id, day, viewer) VALUES (?,?,?)');
for (const o of db.prepare("SELECT o.*, p.tier FROM sp_orders o LEFT JOIN sp_packages p ON p.id = o.package_id WHERE o.status = 'ACTIVE'").all() as any[]) {
  const w = o.tier === 'gold' ? 3 : o.tier === 'silver' ? 1.8 : 1;
  for (let back = 13; back >= 1; back--) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    const matchDay = R() < 0.7;
    const screens = matchDay ? 3 + Math.floor(R() * 3) : 1;
    bump.run(o.id, day, 'tv_seconds', 'tv_logo', Math.round(screens * 3600 * (matchDay ? 6 : 2) * (0.6 + R() * 0.4)));
    bump.run(o.id, day, 'tv_plays', 'tv_fullscreen', Math.round((matchDay ? 40 : 8) * w));
    bump.run(o.id, day, 'tv_audience_seconds', '', Math.round(screens * 3600 * 4 * 60 * w));
    bump.run(o.id, day, 'screens', '', screens);
    bump.run(o.id, day, 'venue_audience', '', screens * 50);
    const views = Math.round((matchDay ? 900 : 180) * w * (0.7 + R() * 0.6));
    bump.run(o.id, day, 'live_impressions', 'live_page', views);
    bump.run(o.id, day, 'unique_viewers', '', Math.round(views * 0.42));
    for (let v = 0; v < Math.min(50, Math.round(views * 0.05)); v++) uniq.run(o.id, day, `v:demo-${day}-${v}`);
    bump.run(o.id, day, 'clicks', '', Math.round(views * 0.012));
    bump.run(o.id, day, 'qr_scans', '', Math.round((matchDay ? 22 : 4) * w));
    bump.run(o.id, day, 'qr_unique', '', Math.round((matchDay ? 18 : 3) * w));
  }
}
const qr = db.prepare('SELECT code FROM sp_qr_codes WHERE order_id = ?').get(gold.id) as any;
const btMatch = db.prepare("SELECT id, tournament_id, venue_id FROM matches WHERE tournament_id = ? LIMIT 1").get(bt.id) as any;
for (let k = 0; k < 64; k++) db.prepare('INSERT INTO sp_qr_scans (code, order_id, viewer, tournament_id, venue_id, match_id, at) VALUES (?,?,?,?,?,?,?)').run(qr.code, gold.id, `demo${k}`, btMatch.tournament_id, btMatch.venue_id, btMatch.id, new Date(Date.now() - R() * 10 * 864e5).toISOString());

const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
console.log(`  organizations ${count('organizations')}, tournaments ${count('tournaments')}, teams ${count('teams')}, players ${count('players')}`);
console.log(`  venues ${count('venues')}, courts/tables/fields ${count('surfaces')}, matches ${count('matches')} (${(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status='live'").get() as any).n} live), events ${count('match_events')}, screens ${count('display_devices')}`);
console.log(`  sponsorship: ${count('sp_opportunities')} opportunities, ${count('sponsor_accounts')} sponsors, ${count('sp_orders')} orders (${(db.prepare("SELECT COUNT(*) AS n FROM sp_orders WHERE status='ACTIVE'").get() as any).n} live), ${count('sp_invoices')} invoices`);
console.log('\nDemo logins (password diary-demo-2026):');
console.log('  organizer  demo@sportsdiary.app      → /console   (scorer: scorer@sportsdiary.app)');
console.log('  sponsor    sponsor@sportsdiary.app   → /sponsor');
console.log('  platform   admin@sportsdiary.app     → /admin');
void tournamentsMade;
await app.close();
