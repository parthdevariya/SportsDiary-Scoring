# Sports Diary

Sports Diary — universal multi-sport scoring, tournaments, live scores and big-screen displays.
Football, cricket, badminton, table tennis, tennis, padel, pickleball, volleyball, basketball, snooker and billiards — one engine.
Plus a **sponsorship marketplace**: sponsors buy tournament, venue, match and broadcast sponsorships online, and their branding goes live on screens and live pages automatically, with measured exposure. See [SPONSORSHIP.md](SPONSORSHIP.md).

## Run it

```bash
npm install
npm run seed      # demo data: 21 orgs, 60 tournaments, 1,200+ players, live matches, 18 sponsorship listings, 6 sponsors
npm start         # http://localhost:8080
npm test          # 134 tests: every sport, offline sync, TV sync, security, sponsorship payments/webhooks/RBAC
```

Requires Node 22.5+ (uses the built-in `node:sqlite`).

**Demo logins** (password `diary-demo-2026`): `demo@sportsdiary.app` (organization admin → `/console`), `scorer@sportsdiary.app` (scorer), `sponsor@sportsdiary.app` (sponsor → `/sponsor`), `admin@sportsdiary.app` (platform admin → `/admin`). Run with `PLATFORM_ADMIN_EMAILS=admin@sportsdiary.app` in production-like setups.

## Try the big screen

1. Open `http://localhost:8080/tv` on any TV, smart-TV browser, or laptop connected by HDMI. It shows a 6-digit code.
2. In the console, go to **Screens → Pair a screen** and enter the code. Or open any match and choose **Cast to TV**.
3. Score from a phone at `/score/<match>`. The screen updates in real time, keeps showing the last score if the network drops, and catches up by itself when it returns.

Other display URLs (no login needed for public matches):
`/tv/m/<code>` one match · `/tv/t/<code>` tournament board · `/overlay/m/<code>` OBS lower-third · `/live/<code>` spectator page · `/t/<code>` tournament page

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data model and roadmap.

## Brand

The logo and colours come from the Sports Diary brand sheet (`FINAL SD LOGO`). The logo was extracted from the original vector artwork, not traced.

| Asset | Use |
|---|---|
| `apps/web/public/brand/sports-diary.svg` | Logo for light backgrounds (navy icon and "DIARY") |
| `apps/web/public/brand/sports-diary-on-dark.svg` | Logo for navy/dark backgrounds (white icon and "DIARY"). Used across the app |
| `apps/web/public/brand/mark.svg` | Circular S mark on its own |
| `icon.svg`, `icon-maskable.svg`, `icon-*.png`, `favicon-32.png` | App, home-screen and browser icons |

Screen colours (RGB values from the brand sheet): navy `#062547` for surfaces and green `#64C225` for scores and accents. They are defined once as CSS variables at the top of `apps/web/public/styles.css`.
