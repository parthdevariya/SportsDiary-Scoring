# ArenaOS

Universal multi-sport scoring, tournaments, live scores and big-screen displays.
Football, cricket, badminton, table tennis, tennis, padel, pickleball, volleyball, basketball, snooker and billiards — one engine.

## Run it

```bash
npm install
npm run seed      # demo data: 21 orgs, 60 tournaments, 1,200+ players, live matches in every sport
npm start         # http://localhost:8080
npm test          # 118 tests: every sport, offline sync, TV sync/reconnect, 10 TVs x 10 matches, security
```

Requires Node 22.5+ (uses the built-in `node:sqlite`).

**Demo logins** (password `arena-demo-2026`): `demo@arenaos.app` (organization admin), `scorer@arenaos.app` (scorer).

## Try the big screen

1. Open `http://localhost:8080/tv` on any TV, smart-TV browser, or laptop connected by HDMI. It shows a 6-digit code.
2. In the console, go to **Screens → Pair a screen** and enter the code. Or open any match and choose **Cast to TV**.
3. Score from a phone at `/score/<match>`. The screen updates in real time, keeps showing the last score if the network drops, and catches up by itself when it returns.

Other display URLs (no login needed for public matches):
`/tv/m/<code>` one match · `/tv/t/<code>` tournament board · `/overlay/m/<code>` OBS lower-third · `/live/<code>` spectator page · `/t/<code>` tournament page

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data model and roadmap.
