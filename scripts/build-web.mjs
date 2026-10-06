import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// IIFE + ES2017 so the TV bundle runs on older smart-TV browsers (Tizen / webOS / Android TV WebView).
await build({
  entryPoints: { console: 'apps/web/src/console.ts', tv: 'apps/web/src/tv.ts', score: 'apps/web/src/score.ts', live: 'apps/web/src/live.ts', home: 'apps/web/src/home.ts', sponsor: 'apps/web/src/sponsor.ts', market: 'apps/web/src/market.ts', admin: 'apps/web/src/admin.ts', pay: 'apps/web/src/pay.ts' },
  bundle: true,
  format: 'iife',
  target: ['es2017'],
  minify: true,
  sourcemap: true,
  outdir: 'apps/web/public/js',
  logLevel: 'info',
});

// ---- homepage: one body partial, two outputs
const body = readFileSync('apps/web/src/home.body.html', 'utf8');
const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700;800&display=swap';
const head = (extra) => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sports Diary</title>
<meta name="description" content="Score eleven sports from one phone and put every point on every screen in the venue, live.">
<meta name="theme-color" content="#062547">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
${extra}`;

// 1) served by the app at "/"
writeFileSync('apps/web/public/home.html', `<!doctype html>
<html lang="en">
<head>
${head(`<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/home.css">`)}
</head>
<body class="home">
${body}
<script src="/js/home.js" defer></script>
<script src="/sw-register.js" defer></script>
</body>
</html>
`);

// 2) self-contained preview (everything inlined) for sharing outside the app
const b64 = (p) => `data:image/svg+xml;base64,${readFileSync(p).toString('base64')}`;
const logo = b64('apps/web/public/brand/sports-diary-on-dark.svg');
const css = readFileSync('apps/web/public/styles.css', 'utf8') + '\n' + readFileSync('apps/web/public/home.css', 'utf8');
const js = readFileSync('apps/web/public/js/home.js', 'utf8').replaceAll('/brand/sports-diary-on-dark.svg', logo).replace(/<\/script/gi, '<\\/script').replace(/\/\/# sourceMappingURL=.*$/m, '');
let previewBody = body.replaceAll('/brand/sports-diary-on-dark.svg', logo).replace(/href="\/console[^"]*"/g, 'href="#start"').replace('href="/"', 'href="#"');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/sports-diary-home.html', `${head('')}
<style>
${css}
</style>
<script>document.body.classList.add('home');</script>
<div class="home-root">
${previewBody}
</div>
<script>
${js}
</script>
`);
console.log('homepage written: apps/web/public/home.html, dist/sports-diary-home.html');
