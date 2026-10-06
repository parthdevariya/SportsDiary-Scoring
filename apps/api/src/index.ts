import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const app = createApp({ dbFile: process.env.DB_FILE });
app.server.listen(port, () => {
  console.log(`ArenaOS listening on http://localhost:${port}`);
  console.log(`  Console   http://localhost:${port}/`);
  console.log(`  TV screen http://localhost:${port}/tv`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
