import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* ignore malformed .env */ }
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

export const isDemo = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 8787),
  // Demo mode ALWAYS uses a separate database file so demo rows can never mix with live data.
  dbPath: isDemo ? path.resolve('./data/whalesignal-DEMO.db') : path.resolve(process.env.DB_PATH || './data/whalesignal.db'),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  requestsPerSecond: num(process.env.REQUESTS_PER_SECOND, 4),
  disableWorker: process.env.DISABLE_WORKER === '1',
  demo: isDemo,
};
