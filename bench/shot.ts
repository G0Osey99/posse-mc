// End-to-end screenshot check: a Posse bot joins the fake server, and what it sees is rendered
// from its live world into a PNG.
//
//   tsx bench/shot.ts <version> <out.png> [cacheDir]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startFakeServer } from './fakeServer.js';
import { createBot, buildScene } from '../src/index.js';
import { ViewRenderer } from '../src/view/index.js';
const version = process.argv[2] ?? '1.18.2';
const out = process.argv[3]!;
const cacheDir = process.argv[4] ?? path.resolve('data', 'posse');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the harness server handle
const server: any = await startFakeServer({ version, port: 0, chunkRadius: 5, entities: 6, tabExtra: 5 });
const bot = createBot({ host: '127.0.0.1', port: server.port, username: 'ShotBot', auth: 'offline', version, viewDistance: 'tiny' });
const renderer = new ViewRenderer({ cacheDir, workers: 1 });
bot.on('spawn', () => setTimeout(async () => {
  await bot.look(Math.PI * 0.75, -0.15, true);
  const scene = buildScene(bot, { caption: `ShotBot ${version}` })!;
  const r = await renderer.render(scene);
  writeFileSync(out, r.png);
  console.log(version, r.quality, Math.round(r.ms), 'ms', 'entities', scene.entities.length, 'world', JSON.stringify(bot.stats().world));
  await renderer.close(); bot.quit(); server.close?.(); process.exit(0);
}, 4000));
