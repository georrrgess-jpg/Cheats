import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { HttpClient } from './util/http.js';
import { PolymarketProvider } from './providers/polymarket.js';
import { FixtureProvider } from './providers/fixture.js';
import { registerApi } from './api.js';
import { Worker } from './worker/scheduler.js';
import { getActiveSettings, snapshotWatchlist } from './settings.js';
import { ensureDefaultAccount } from './core/paper.js';
import type { MarketDataProvider } from './providers/types.js';

async function main() {
  const db = openDb(config.dbPath);
  getActiveSettings(db);
  ensureDefaultAccount(db);
  snapshotWatchlist(db, 'Startup');

  let provider: MarketDataProvider;
  let http: HttpClient | null = null;
  if (config.demo) {
    const { seedDemo } = await import('./demo.js');
    provider = seedDemo(db);
  } else {
    http = new HttpClient({ requestsPerSecond: config.requestsPerSecond });
    provider = new PolymarketProvider(http);
  }

  const worker = config.disableWorker ? null : new Worker(db, provider, http);
  const app = Fastify({ logger: false });

  if (config.dashboardPassword) {
    const expected = 'Basic ' + Buffer.from(`${config.dashboardUser}:${config.dashboardPassword}`).toString('base64');
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers.authorization !== expected) reply.header('www-authenticate', 'Basic realm="WhaleSignal"').code(401).send('Authentication required');
    });
  } else if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('\n⚠  WARNING: HOST is not localhost and DASHBOARD_PASSWORD is not set. Anyone on your network can open the dashboard.\n');
  }

  registerApi(app, { db, provider, http, worker, demo: config.demo });

  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  }

  await app.listen({ host: config.host, port: config.port });
  worker?.start();
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`\n  WhaleSignal ${config.demo ? '(DEMO DATA — not live)' : '(live Polymarket data)'} running at ${url}`);
  console.log(`  Database: ${config.dbPath}`);
  console.log(worker ? '  Background tracking is ON. Keep this window open — tracking stops when this process stops.\n' : '  Background tracking is OFF (DISABLE_WORKER=1).\n');

  const shutdown = async () => { worker?.stop(); await app.close(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
