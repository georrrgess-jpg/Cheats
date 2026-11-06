import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import type { MarketDataProvider } from './providers/types.js';
import type { HttpClient } from './util/http.js';
import type { Worker } from './worker/scheduler.js';
import { getActiveSettings, updateSettings, snapshotWatchlist, DEFAULT_SETTINGS } from './settings.js';
import { nowSec } from './util/time.js';
import { runConsensusFromDb } from './core/consensusService.js';
import { computeConsensus } from './core/consensus.js';
import { getMarket, getMarkets, storeMarkets } from './worker/marketSync.js';
import { getQuotes } from './worker/quoteSync.js';
import { discoveryState, evaluateAndStore, runDiscovery } from './core/discovery.js';
import { ensureDefaultAccount, holdings, placeOrder, snapshotOf } from './core/paper.js';
import { CATEGORIES } from './core/categories.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function registerApi(app: FastifyInstance, ctx: { db: DB; provider: MarketDataProvider; http: HttpClient | null; worker: Worker | null; demo: boolean }) {
  const { db, provider } = ctx;
  const priceCache = new Map<string, { at: number; data: any }>();

  const signalFor = (tokenId: string) => db.prepare('SELECT * FROM signals WHERE token_id=? AND ended_at IS NULL').get(tokenId) as any;

  const decorate = (r: any) => {
    const sig = signalFor(r.tokenId);
    const priceMove = sig?.first_price != null && r.quote?.mid != null ? r.quote.mid - sig.first_price : null;
    return {
      ...r,
      signal: sig ? { id: sig.id, state: sig.state, firstDetectedAt: sig.first_detected_at, firstPrice: sig.first_price, lastChangeAt: sig.last_change_at, peakSupport: sig.peak_support, baseline: !!sig.baseline, reasons: sig.last_result ? JSON.parse(sig.last_result).reasons : [] } : null,
      priceMoveSinceFirst: priceMove,
      liquidity: getMarket(db, r.conditionId)?.liquidity ?? null,
    };
  };

  const consensusWith = (q: any) => {
    const { settings } = getActiveSettings(db);
    const S = structuredClone(settings);
    if (q.minSupport) S.consensus.minSupport = Math.max(1, Number(q.minSupport));
    if (q.minQuality) S.consensus.minQualityScore = Number(q.minQuality);
    if (q.minPosition) S.consensus.minPositionUsd = Number(q.minPosition);
    const win = q.window ? Number(q.window) : undefined;
    const out = runConsensusFromDb(db, S, nowSec(), win);
    let rows = out.results.map(decorate);
    if (q.category && q.category !== 'All') rows = rows.filter((r) => r.category === q.category);
    if (q.minLiquidity) rows = rows.filter((r) => r.liquidity !== null && r.liquidity >= Number(q.minLiquidity));
    if (q.state && q.state !== 'All') rows = rows.filter((r) => r.signal?.state === q.state);
    const sort = q.sort || 'score';
    const key: Record<string, (r: any) => number> = {
      score: (r) => r.score.total, support: (r) => r.supportCount, value: (r) => r.supportValue ?? -1,
      inflow: (r) => r.flows.inflowUsd - r.flows.outflowUsd, recent: (r) => r.signal?.lastChangeAt ?? 0, move: (r) => Math.abs(r.priceMoveSinceFirst ?? 0),
    };
    rows.sort((a, b) => (key[sort] ?? key.score)(b) - (key[sort] ?? key.score)(a));
    return { ...out, results: rows, settings: S };
  };

  const healthSummary = () => {
    const { settings: S } = getActiveSettings(db);
    const now = nowSec();
    const ws = db.prepare(`SELECT w.address, w.label, s.* FROM wallets w LEFT JOIN wallet_sync s ON s.address=w.address WHERE w.followed=1`).all() as any[];
    const stale = ws.filter((w) => !w.positions_synced_at || now - w.positions_synced_at > S.tracking.staleAfterSec).length;
    const lag = db.prepare('SELECT AVG(observed_at - ts) a, COUNT(*) n FROM (SELECT observed_at, ts FROM activity WHERE is_backfill=0 ORDER BY observed_at DESC LIMIT 200)').get() as any;
    return {
      now, demo: ctx.demo, platform: provider.platform,
      worker: ctx.worker ? ctx.worker.status : { running: false, note: 'Worker disabled (DISABLE_WORKER=1). No tracking is happening.' },
      hosts: ctx.http ? [...ctx.http.health.values()] : [],
      wallets: { followed: ws.length, stale, fresh: ws.length - stale },
      lastPositionsSync: Math.max(0, ...ws.map((w) => w.positions_synced_at ?? 0)) || null,
      lastActivitySync: Math.max(0, ...ws.map((w) => w.activity_synced_at ?? 0)) || null,
      observedLagSec: lag?.n ? lag.a : null, observedLagSample: lag?.n ?? 0,
      staleAfterSec: S.tracking.staleAfterSec,
    };
  };

  app.get('/api/health', async () => ({
    ...healthSummary(),
    walletSync: db.prepare(`SELECT w.address, w.label, s.* FROM wallets w LEFT JOIN wallet_sync s ON s.address=w.address WHERE w.followed=1 ORDER BY w.label, w.address`).all(),
  }));

  app.get('/api/overview', async () => {
    const c = consensusWith({});
    const changes = db.prepare('SELECT * FROM signals ORDER BY last_change_at DESC LIMIT 12').all() as any[];
    const ms = getMarkets(db, changes.map((s) => s.condition_id));
    return {
      health: healthSummary(),
      top: c.results.slice(0, 6),
      totals: { results: c.results.length, eligibleWallets: c.eligibleWallets, staleWallets: c.staleWallets.length },
      changes: changes.map((s) => {
        const m = ms.get(s.condition_id);
        const idx = m ? m.tokenIds.indexOf(s.token_id) : -1;
        const pos = m ? null : (db.prepare('SELECT title, outcome FROM positions WHERE token_id=? LIMIT 1').get(s.token_id) as any);
        return { ...s, title: m?.question ?? pos?.title ?? null, outcome: idx >= 0 ? m!.outcomes[idx] : pos?.outcome ?? null, reasons: s.last_result ? JSON.parse(s.last_result).reasons : [] };
      }),
      alerts: db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5').all(),
      unread: (db.prepare('SELECT COUNT(*) n FROM alerts WHERE read_at IS NULL').get() as any).n,
      activity24h: (db.prepare('SELECT COUNT(*) n FROM activity WHERE ts >= ?').get(nowSec() - 86400) as any).n,
    };
  });

  // ---------- wallets ----------
  app.get('/api/wallets', async () => {
    const rows = db.prepare(`SELECT w.*, s.positions_synced_at, s.activity_synced_at, s.positions_error, s.activity_error, s.backfill_done, s.backfill_from, s.positions_truncated,
      m.json AS metrics, m.computed_at AS metrics_at,
      (SELECT COUNT(*) FROM positions p WHERE p.wallet=w.address AND p.redeemable=0) AS open_positions,
      (SELECT SUM(current_value) FROM positions p WHERE p.wallet=w.address AND p.redeemable=0) AS open_value,
      (SELECT MAX(ts) FROM activity a WHERE a.wallet=w.address) AS last_activity
      FROM wallets w LEFT JOIN wallet_sync s ON s.address=w.address LEFT JOIN wallet_metrics m ON m.address=w.address WHERE w.followed=1 ORDER BY w.added_at`).all() as any[];
    return rows.map((r) => ({ ...r, metrics: r.metrics ? slimMetrics(JSON.parse(r.metrics)) : null }));
  });

  app.post('/api/wallets', async (req, reply) => {
    const b = (req.body || {}) as any;
    const address = String(b.address || '').trim().toLowerCase();
    if (!ADDR.test(address)) return reply.code(400).send({ error: 'Enter a 0x… wallet address (42 characters). Use the Polymarket proxy wallet shown on the profile page.' });
    const count = (db.prepare('SELECT COUNT(*) n FROM wallets WHERE followed=1').get() as any).n;
    if (count >= 100) return reply.code(400).send({ error: 'Watchlist limit (100) reached.' });
    const cand = db.prepare('SELECT * FROM candidates WHERE address=?').get(address) as any;
    db.prepare(`INSERT INTO wallets(address,label,notes,cluster,source,followed,added_at,user_name,x_username) VALUES(?,?,?,?,?,1,?,?,?)
      ON CONFLICT(address) DO UPDATE SET followed=1, removed_at=NULL, added_at=excluded.added_at, label=COALESCE(excluded.label, wallets.label), cluster=COALESCE(excluded.cluster, wallets.cluster)`)
      .run(address, b.label || cand?.user_name || null, b.notes || null, b.cluster || null, b.source || (cand ? 'discovery' : 'manual'), nowSec(), cand?.user_name ?? null, cand?.x_username ?? null);
    snapshotWatchlist(db, `Added ${address}`);
    ctx.worker?.bump(address);
    // evaluation is queued by the worker (one wallet per cycle) to stay well inside rate limits
    return { ok: true };
  });

  app.patch('/api/wallets/:address', async (req, reply) => {
    const a = String((req.params as any).address).toLowerCase();
    const b = (req.body || {}) as any;
    const w = db.prepare('SELECT * FROM wallets WHERE address=?').get(a);
    if (!w) return reply.code(404).send({ error: 'Not found' });
    for (const k of ['label', 'notes', 'cluster'] as const) if (k in b) db.prepare(`UPDATE wallets SET ${k}=? WHERE address=?`).run(b[k] === '' ? null : b[k], a);
    if ('cluster' in b) snapshotWatchlist(db, `Cluster change ${a}`);
    return { ok: true };
  });

  app.delete('/api/wallets/:address', async (req) => {
    const a = String((req.params as any).address).toLowerCase();
    db.prepare('UPDATE wallets SET followed=0, removed_at=? WHERE address=?').run(nowSec(), a);
    snapshotWatchlist(db, `Removed ${a}`);
    return { ok: true };
  });

  app.get('/api/wallets/:address', async (req, reply) => {
    const a = String((req.params as any).address).toLowerCase();
    const w = db.prepare('SELECT * FROM wallets WHERE address=?').get(a) as any;
    const cand = db.prepare('SELECT * FROM candidates WHERE address=?').get(a) as any;
    if (!w && !cand && !db.prepare('SELECT 1 FROM wallet_metrics WHERE address=?').get(a)) return reply.code(404).send({ error: 'Wallet not tracked or evaluated yet.' });
    const m = db.prepare('SELECT * FROM wallet_metrics WHERE address=?').get(a) as any;
    return {
      wallet: w ?? null, candidate: cand ? { ...cand, boards: JSON.parse(cand.boards) } : null,
      metrics: m ? JSON.parse(m.json) : null, metricsAt: m?.computed_at ?? null, metricsSettingsVersion: m?.settings_version ?? null,
      sync: db.prepare('SELECT * FROM wallet_sync WHERE address=?').get(a) ?? null,
      positions: db.prepare('SELECT * FROM positions WHERE wallet=? ORDER BY redeemable, current_value DESC LIMIT 300').all(a),
      activity: db.prepare('SELECT * FROM activity WHERE wallet=? ORDER BY ts DESC LIMIT 100').all(a),
      links: { profile: provider.walletUrl(a) },
    };
  });

  app.post('/api/wallets/:address/evaluate', async (req, reply) => {
    const a = String((req.params as any).address).toLowerCase();
    if (!ADDR.test(a)) return reply.code(400).send({ error: 'Bad address' });
    try { return { ok: true, metrics: await evaluateAndStore(db, provider, a) }; }
    catch (e: any) { return reply.code(502).send({ error: `Evaluation failed: ${e.message}` }); }
  });

  // ---------- discovery ----------
  app.get('/api/discovery', async () => {
    const rows = db.prepare(`SELECT c.*, m.json AS metrics, m.computed_at AS metrics_at, w.followed FROM candidates c LEFT JOIN wallet_metrics m ON m.address=c.address LEFT JOIN wallets w ON w.address=c.address ORDER BY c.discovered_at DESC`).all() as any[];
    const run = db.prepare('SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 1').get() as any;
    const { settings } = getActiveSettings(db);
    return {
      state: discoveryState, lastRun: run ?? null,
      coverage: `Candidates come only from Polymarket's public PnL leaderboards: ${settings.discovery.boards.map((b) => `${b.period} / ${b.category} top ${b.limit}`).join('; ')}. The ${settings.discovery.evaluateTop} wallets appearing on the most boards are evaluated on their own position history. Profitable wallets outside these boards are not discovered — add them manually.`,
      candidates: rows.map((r) => ({ address: r.address, userName: r.user_name, xUsername: r.x_username, boards: JSON.parse(r.boards), followed: !!r.followed, metricsAt: r.metrics_at, metrics: r.metrics ? slimMetrics(JSON.parse(r.metrics)) : null })),
    };
  });
  app.post('/api/discovery/run', async () => { runDiscovery(db, provider).catch(() => {}); return { ok: true }; });

  // ---------- activity ----------
  app.get('/api/activity', async (req) => {
    const q = req.query as any;
    const where: string[] = ['w.followed=1'];
    const args: any[] = [];
    if (q.wallet) { where.push('a.wallet=?'); args.push(String(q.wallet).toLowerCase()); }
    if (q.type && q.type !== 'All') { where.push('a.type=?'); args.push(q.type); }
    if (q.side && q.side !== 'All') { where.push('a.side=?'); args.push(q.side); }
    if (q.condition) { where.push('a.condition_id=?'); args.push(q.condition); }
    if (q.q) { where.push('(a.title LIKE ? OR w.label LIKE ? OR a.wallet LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
    if (q.minUsd) { where.push('a.usdc_size >= ?'); args.push(Number(q.minUsd)); }
    if (q.live === '1') where.push('a.is_backfill=0');
    if (q.before) { where.push('a.ts < ?'); args.push(Number(q.before)); }
    const limit = Math.min(500, Number(q.limit) || 100);
    const rows = db.prepare(`SELECT a.*, w.label FROM activity a JOIN wallets w ON w.address=a.wallet WHERE ${where.join(' AND ')} ORDER BY a.ts DESC, a.id LIMIT ?`).all(...args, limit) as any[];
    const ms = getMarkets(db, rows.map((r) => r.condition_id).filter(Boolean));
    return { rows: rows.map((r) => ({ ...r, url: ms.get(r.condition_id)?.url ?? provider.marketUrl(r.event_slug, r.slug), txUrl: r.tx_hash ? provider.txUrl(r.tx_hash) : null, category: ms.get(r.condition_id)?.category ?? null })) };
  });

  // ---------- consensus ----------
  app.get('/api/consensus', async (req) => {
    const out = consensusWith(req.query);
    return { results: out.results, suspectedLinks: out.suspectedLinks, eligibleWallets: out.eligibleWallets, staleWallets: out.staleWallets, categories: ['All', ...CATEGORIES, 'Unknown'], settings: out.settings.consensus };
  });

  app.get('/api/markets/:conditionId', async (req, reply) => {
    const cid = String((req.params as any).conditionId).toLowerCase();
    let m = getMarket(db, cid);
    if (!m) { try { const ms = await provider.getMarkets([cid]); storeMarkets(db, ms, nowSec()); m = ms[0] ?? null; } catch { /* show without metadata */ } }
    const { settings } = getActiveSettings(db);
    const S = structuredClone(settings); S.consensus.minSupport = 1;
    const now = nowSec();
    const all = runConsensusFromDb(db, S, now);
    const outcomes = all.results.filter((r) => r.conditionId.toLowerCase() === cid).map(decorate);
    const tokens = m?.tokenIds ?? [...new Set(outcomes.map((o) => o.tokenId))];
    const quotes = getQuotes(db, tokens);
    const signals = db.prepare('SELECT * FROM signals WHERE condition_id=? ORDER BY first_detected_at DESC').all(m?.conditionId ?? cid) as any[];
    const snaps = signals.length ? db.prepare(`SELECT * FROM signal_snapshots WHERE signal_id IN (${signals.map(() => '?').join(',')}) ORDER BY ts`).all(...signals.map((s) => s.id)) : [];
    const holders = db.prepare(`SELECT p.*, w.label FROM positions p JOIN wallets w ON w.address=p.wallet AND w.followed=1 WHERE p.condition_id=? ORDER BY p.current_value DESC`).all(m?.conditionId ?? cid);
    const changes = db.prepare(`SELECT c.*, w.label FROM position_changes c LEFT JOIN wallets w ON w.address=c.wallet WHERE c.condition_id=? ORDER BY c.ts DESC LIMIT 100`).all(m?.conditionId ?? cid);
    const activity = db.prepare(`SELECT a.*, w.label FROM activity a JOIN wallets w ON w.address=a.wallet WHERE a.condition_id=? ORDER BY a.ts DESC LIMIT 100`).all(m?.conditionId ?? cid);
    const history: Record<string, any> = {};
    for (const t of tokens.slice(0, 2)) {
      const c = priceCache.get(t);
      if (c && now - c.at < 300) { history[t] = c.data; continue; }
      try { const d = await provider.getPriceHistory(t, '1m'); priceCache.set(t, { at: now, data: d }); history[t] = d; } catch { history[t] = null; }
    }
    if (!m && !holders.length) return reply.code(404).send({ error: 'Unknown market' });
    return { market: m, outcomes, quotes: Object.fromEntries(quotes), signals, snapshots: snaps, holders, changes, activity, history };
  });

  // ---------- alerts ----------
  app.get('/api/alerts', async () => ({ alerts: db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200').all(), unread: (db.prepare('SELECT COUNT(*) n FROM alerts WHERE read_at IS NULL').get() as any).n }));
  app.post('/api/alerts/read', async (req) => {
    const b = (req.body || {}) as any;
    if (b.id) db.prepare('UPDATE alerts SET read_at=? WHERE id=?').run(nowSec(), b.id); else db.prepare('UPDATE alerts SET read_at=? WHERE read_at IS NULL').run(nowSec());
    return { ok: true };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => {
    const a = getActiveSettings(db);
    return { ...a, defaults: DEFAULT_SETTINGS, versions: db.prepare('SELECT id, created_at, note FROM settings_versions ORDER BY id DESC LIMIT 50').all(),
      watchlistVersions: db.prepare('SELECT id, created_at, reason, json_array_length(addresses) n FROM watchlist_versions ORDER BY id DESC LIMIT 50').all() };
  });
  app.put('/api/settings', async (req, reply) => {
    const b = (req.body || {}) as any;
    try { return updateSettings(db, b.patch || {}, b.note); } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  });

  // ---------- paper ----------
  app.get('/api/paper', async () => {
    ensureDefaultAccount(db);
    const accounts = db.prepare('SELECT * FROM paper_accounts ORDER BY id').all() as any[];
    return {
      accounts: accounts.map((a) => {
        const hs = holdings(db, a.id);
        const q = getQuotes(db, hs.map((h) => h.token_id));
        const ms = getMarkets(db, hs.map((h) => h.condition_id));
        const rows = hs.map((h) => {
          const qq = q.get(h.token_id);
          const bid = qq?.bestBid ?? null, ask = qq?.bestAsk ?? null;
          const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
          const m = ms.get(h.condition_id);
          return { ...h, bid, mid, quoteAt: qq?.fetchedAt ?? null, liquidationValue: bid !== null ? h.shares * bid : null, markValue: mid !== null ? h.shares * mid : null,
            unrealized: bid !== null && h.avgCost !== null ? h.shares * (bid - h.avgCost) : null, closed: !!m?.closed, url: m?.url ?? null };
        });
        const open = rows.filter((r) => r.shares > 1e-9);
        const liq = open.every((r) => r.liquidationValue !== null) ? open.reduce((s, r) => s + r.liquidationValue!, 0) : null;
        const orders = db.prepare('SELECT * FROM paper_orders WHERE account_id=? ORDER BY id DESC LIMIT 300').all(a.id) as any[];
        const byVersion = db.prepare(`SELECT settings_version, COUNT(*) n, SUM(CASE WHEN side='BUY' THEN notional+fees ELSE 0 END) bought, SUM(CASE WHEN side='SELL' THEN notional-fees ELSE 0 END) sold FROM paper_orders WHERE account_id=? AND filled_shares>0 GROUP BY settings_version`).all(a.id);
        return { ...a, holdings: rows, open: open.length, liquidationValue: liq, equity: liq !== null ? a.cash + liq : null,
          realized: rows.reduce((s, r) => s + r.realized, 0), orders, byVersion,
          unpricedPositions: open.filter((r) => r.liquidationValue === null).length };
      }),
      autoRule: getActiveSettings(db).settings.paper.autoRule,
    };
  });

  app.post('/api/paper/accounts', async (req) => {
    const b = (req.body || {}) as any;
    const cash = Math.max(100, Number(b.startingCash) || 10000);
    const id = db.prepare('INSERT INTO paper_accounts(name,created_at,starting_cash,cash) VALUES(?,?,?,?)').run(String(b.name || 'Account'), nowSec(), cash, cash).lastInsertRowid;
    return { id };
  });
  app.patch('/api/paper/accounts/:id', async (req) => {
    const b = (req.body || {}) as any;
    if ('autoEnabled' in b) db.prepare('UPDATE paper_accounts SET auto_enabled=? WHERE id=?').run(b.autoEnabled ? 1 : 0, Number((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/paper/orders', async (req, reply) => {
    const b = (req.body || {}) as any;
    const accountId = Number(b.accountId) || ensureDefaultAccount(db);
    try {
      // Snapshot the signal exactly as computed at decision time.
      let snapshot: any = null, signalId: number | null = null, outcome = b.outcome ?? null, title = b.title ?? null, conditionId = b.conditionId;
      if (b.side === 'BUY') {
        const c = consensusWith({ minSupport: 1 });
        const r = c.results.find((x: any) => x.tokenId === b.tokenId);
        if (r) { snapshot = snapshotOf(r, r.signal?.state ?? 'n/a'); signalId = r.signal?.id ?? null; outcome = r.outcome; title = r.title; conditionId = r.conditionId; }
      }
      if (!conditionId) return reply.code(400).send({ error: 'conditionId required' });
      const id = placeOrder(db, { accountId, side: b.side === 'SELL' ? 'SELL' : 'BUY', tokenId: String(b.tokenId), conditionId, usd: b.usd ? Number(b.usd) : undefined, shares: b.shares ? Number(b.shares) : undefined,
        origin: 'manual', signalId, signalSnapshot: snapshot ?? { note: 'No consensus result for this outcome at decision time.' }, outcome, title }, nowSec());
      return { id, status: 'pending', note: 'Order recorded. It will be filled against the next order book fetched after the simulated latency (a few seconds).' };
    } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  });
}

function slimMetrics(m: any) {
  return { score: m.score.total, components: Object.fromEntries(Object.entries(m.score.components).map(([k, v]: any) => [k, { score: v.score, available: v.available }])),
    flags: m.flags.map((f: any) => f.code), resolved: m.sample.resolved, winRate: m.winRate, realized: m.realized, maxDrawdown: m.series.maxDrawdown,
    historyDays: m.series.days, daysSince: m.recency.daysSince, top1Share: m.concentration.top1Share, topCategory: m.categories[0]?.category ?? null, pnl30d: m.series.pnl30d };
}
