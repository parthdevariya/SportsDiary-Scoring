import { build } from 'esbuild';
// IIFE + ES2017 so the TV bundle runs on older smart-TV browsers (Tizen / webOS / Android TV WebView).
await build({
  entryPoints: { console: 'apps/web/src/console.ts', tv: 'apps/web/src/tv.ts', score: 'apps/web/src/score.ts', live: 'apps/web/src/live.ts' },
  bundle: true,
  format: 'iife',
  target: ['es2017'],
  minify: true,
  sourcemap: true,
  outdir: 'apps/web/public/js',
  logLevel: 'info',
});
