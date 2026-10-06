/**
 * Demo data: 21 organizations, 50+ tournaments, 100+ teams, 500+ players, venues with
 * courts/tables/fields, live matches in every sport, paired screens, completed results
 * (so standings, player stats and ratings are real), all produced through the same
 * services and rule engines the product uses — no hand-written scores.
 *
 *   npm run seed            (writes arenaos.db; DB_FILE overrides)
 * Demo login:  demo@arenaos.app / arena-demo-2026
 */
import { existsSync, rmSync } from 'node:fs';
import { createApp } from '../apps/api/src/app.ts';
import { hashPassword, type AuthUser } from '../apps/api/src/auth.ts';
import { id } from '../apps/api/src/context.ts';
import { J, now } from '../apps/api/src/db.ts';
import { MatchAggregate } from '../packages/engine/src/index.ts';
import { simulate, rng } from '../packages/engine/src/sim.ts';

const file = process.env.DB_FILE ?? 'arenaos.db';
for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
const app = createApp({ dbFile: file });
const { db } = app.ctx;
const R = rng(2026);
const pick = <T>(a: T[]) => a[Math.floor(R() * a.length)];

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Kabir', 'Rohan', 'Dhruv', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Myra', 'Isha', 'Kavya', 'Meera', 'Riya', 'Tara', 'Nisha', 'Pooja', 'Rahul', 'Karan', 'Siddharth', 'Yash', 'Neha', 'Priya', 'Harsh', 'Jay', 'Hetal', 'Dev', 'Mihir', 'Parth', 'Kunal', 'Zara', 'Imran', 'Farhan', 'Gurpreet', 'Simran', 'Anjali', 'Varun', 'Nikhil', 'Tanvi', 'Om', 'Rudra', 'Shreya'];
const LAST = ['Shah', 'Patel', 'Mehta', 'Desai', 'Joshi', 'Iyer', 'Rao', 'Nair', 'Reddy', 'Kapoor', 'Malhotra', 'Singh', 'Gill', 'Chopra', 'Bose', 'Das', 'Banerjee', 'Kulkarni', 'Pandya', 'Trivedi', 'Bhatt', 'Parikh', 'Khan', 'Sheikh', 'Menon', 'Pillai', 'Verma', 'Gupta', 'Agarwal', 'Jain'];
const CITIES = ['Ahmedabad', 'Sanand', 'Gandhinagar', 'Vadodara', 'Surat', 'Rajkot', 'Mumbai', 'Pune', 'Bengaluru', 'Hyderabad', 'Chennai', 'Delhi', 'Jaipur', 'Kochi', 'Kolkata'];
const TEAM_WORDS = ['Strikers', 'Titans', 'Falcons', 'Royals', 'Warriors', 'Panthers', 'Chargers', 'Lions', 'Riders', 'Blasters', 'Kings', 'Rangers', 'Stallions', 'Sharks', 'Hawks', 'Tuskers'];
const COLORS = ['#E5484D', '#2F7FE0', '#3FBF7F', '#FFB020', '#9B5DE5', '#00B8D9', '#F2711C', '#E83E8C'];
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
    userId, orgId, email ?? `admin@${slug}.example`, `${pick(FIRST)} ${pick(LAST)}`, hashPassword(email ? 'arena-demo-2026' : id()), 'org_admin', now());
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
const demo = makeOrg(ORG_NAMES[0], 'demo@arenaos.app');
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
db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)').run(id(), demo.orgId, 'scorer@arenaos.app', 'Court Scorer', hashPassword('arena-demo-2026'), 'scorer', now());

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

const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
console.log(`  organizations ${count('organizations')}, tournaments ${count('tournaments')}, teams ${count('teams')}, players ${count('players')}`);
console.log(`  venues ${count('venues')}, courts/tables/fields ${count('surfaces')}, matches ${count('matches')} (${(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status='live'").get() as any).n} live), events ${count('match_events')}, screens ${count('display_devices')}`);
console.log('\nDemo login: demo@arenaos.app / arena-demo-2026   (scorer: scorer@arenaos.app / arena-demo-2026)');
void tournamentsMade;
await app.close();
