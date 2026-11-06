import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { usePoll, useHashRoute, post, ago, dt } from './lib';
import { Icon } from './components';
import Overview from './pages/Overview';
import Wallets from './pages/Wallets';
import WalletDetail from './pages/WalletDetail';
import Activity from './pages/Activity';
import Consensus from './pages/Consensus';
import Market from './pages/Market';
import Paper from './pages/Paper';
import Settings from './pages/Settings';

const NAV = [
  { p: '/overview', t: 'Overview', i: Icon.overview },
  { p: '/wallets', t: 'Wallets', i: Icon.wallets },
  { p: '/activity', t: 'Activity', i: Icon.activity },
  { p: '/consensus', t: 'Consensus', i: Icon.consensus },
  { p: '/paper', t: 'Paper', i: Icon.paper },
];

function Health({ h, error }: { h: any; error: string | null }) {
  if (error) return <span className="row small"><span className="pulse off" /> Backend unreachable</span>;
  if (!h) return <span className="row small faint">Connecting…</span>;
  const running = h.worker?.running;
  const stale = h.wallets.stale > 0;
  const bad = h.hosts.some((x: any) => x.consecutiveFailures >= 3);
  return (
    <a href="#/settings" className="row small" style={{ color: 'inherit' }} title="Tracking health — click for details">
      <span className={`pulse ${!running || bad ? 'off' : stale ? 'stale' : ''}`} />
      <span>{!running ? 'Tracking off' : bad ? 'Provider errors' : `${h.wallets.fresh}/${h.wallets.followed} wallets fresh`}</span>
      <span className="faint hide-sm">· positions {ago(h.lastPositionsSync) ?? 'never'}</span>
    </a>
  );
}

function AlertsDrawer({ onClose }: { onClose: () => void }) {
  const { data, reload } = usePoll<any>('/api/alerts', 20000);
  const sev: Record<string, string> = { info: 'b-accent', warning: 'b-warn', critical: 'b-crit' };
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="Alerts">
        <div className="card-head"><h2>Alerts</h2><div className="row"><button className="sm" onClick={async () => { await post('/api/alerts/read', {}); reload(); }}>Mark all read</button><button className="ghost sm" onClick={onClose}>Close</button></div></div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {!data ? null : !data.alerts.length ? <div className="empty"><h2>No alerts yet</h2><div className="small">Alerts fire on new convergence, rising agreement, multiple exits, and tracking problems. Signals present at first startup form a baseline and do not alert.</div></div> :
            data.alerts.map((a: any) => {
              const d = a.data ? JSON.parse(a.data) : null;
              return (
                <div key={a.id} className="card-pad" style={{ borderBottom: '1px solid var(--border)', opacity: a.read_at ? 0.65 : 1 }}>
                  <div className="spread"><span className={`badge ${sev[a.severity]}`}>{a.kind}</span><span className="tiny faint">{dt(a.created_at)}</span></div>
                  <div style={{ fontWeight: 600, marginTop: 6 }}>{a.title}</div>
                  <div className="small muted">{a.body}</div>
                  {d?.tokenId && <a className="small" href={`#/consensus?focus=${d.tokenId}`} onClick={onClose}>Inspect evidence →</a>}
                </div>
              );
            })}
        </div>
      </div>
    </>
  );
}

function App() {
  const route = useHashRoute();
  const [path, query] = route.split('?');
  const params = new URLSearchParams(query || '');
  const health = usePoll<any>('/api/health', 15000);
  const alerts = usePoll<any>('/api/alerts', 30000);
  const [showAlerts, setShowAlerts] = useState(false);
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem('theme') || ''; } catch { return ''; } });
  useEffect(() => { if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('theme', theme); } catch { /* ignore */ } }, [theme]);
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  const seg = path.split('/').filter(Boolean);
  let page: React.ReactNode;
  switch (seg[0]) {
    case 'wallets': page = seg[1] ? <WalletDetail address={seg[1]} /> : <Wallets tab={params.get('tab') || 'watchlist'} />; break;
    case 'activity': page = <Activity initialWallet={params.get('wallet') || ''} />; break;
    case 'consensus': page = <Consensus focus={params.get('focus')} />; break;
    case 'market': page = <Market conditionId={seg[1]} token={params.get('t')} />; break;
    case 'paper': page = <Paper />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Overview />;
  }
  const h = health.data;
  const workerOff = h && !h.worker?.running;
  const hostDown = h?.hosts?.find((x: any) => x.consecutiveFailures >= 3);
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="brand-mark"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 20c3-8 8-8 10-3s7 5 12-3" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" /></svg></span>WhaleSignal</div>
        <nav className="nav stack" style={{ gap: 2 }}>
          {NAV.map((n) => <a key={n.p} href={`#${n.p}`} className={path.startsWith(n.p) || (n.p === '/consensus' && path.startsWith('/market')) ? 'active' : ''}>{n.i}{n.t}</a>)}
        </nav>
        <div className="divider" />
        <nav className="nav"><a href="#/settings" className={path.startsWith('/settings') ? 'active' : ''}>{Icon.settings}Settings & health</a></nav>
        <div className="side-foot">Read-only analytics. Consensus is a signal to investigate, not a probability or a recommendation.</div>
      </aside>
      <div className="main">
        {h?.demo && <div className="banner demo">DEMO MODE — synthetic data from a separate database. Nothing here is live Polymarket data.</div>}
        {health.error && <div className="banner err">⚠ Cannot reach the WhaleSignal backend ({health.error}). Data shown may be outdated. Is the server window still open?</div>}
        {workerOff && <div className="banner warn">Background tracking is not running. Data will not update.</div>}
        {hostDown && <div className="banner err">⚠ {hostDown.host} is failing ({hostDown.consecutiveFailures} consecutive errors). Last error: {hostDown.lastError}. Showing last stored data — no demo substitution.</div>}
        <div className="topbar">
          <Health h={h} error={health.error} />
          <div style={{ marginLeft: 'auto' }} className="row">
            <button className="ghost sm" title="Theme: system → dark → light" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? '' : 'dark')}>{theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'} theme</button>
            <button className="ghost" onClick={() => setShowAlerts(true)} aria-label="Alerts">{Icon.bell}{alerts.data?.unread ? <span className="badge b-crit">{alerts.data.unread}</span> : null}</button>
          </div>
        </div>
        <div className="content">{page}</div>
      </div>
      <nav className="mobile-nav">{NAV.map((n) => <a key={n.p} href={`#${n.p}`} className={path.startsWith(n.p) ? 'active' : ''}>{n.i}{n.t}</a>)}</nav>
      {showAlerts && <AlertsDrawer onClose={() => { setShowAlerts(false); alerts.reload(); }} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
