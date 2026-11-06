# Deployment

WhaleSignal is one Node.js process + one SQLite file. Tracking runs only while the process runs.

## Option A — your own computer (free)
`npm start` and leave the window open. Good for evaluation; tracking pauses when the machine sleeps.
On restart it resumes from stored cursors and backfills missed activity as history.

## Option B — a small always-on VM (recommended for 24/7, ≈ $4–6 / month)
Any 1 vCPU / 1 GB RAM Linux VM works (e.g. Hetzner CX22 ≈ €4/mo, DigitalOcean/Lightsail basic ≈ $5–6/mo).
Disk use is modest (a few hundred MB per month with 50 active wallets; prune `activity` if needed).
No Polymarket costs. No paid services are required.

```bash
# on the VM (Ubuntu), after installing Node 22 LTS
git clone <your repo> whalesignal && cd whalesignal
npm ci && npm run build
cp .env.example .env    # set DASHBOARD_PASSWORD; keep HOST=127.0.0.1 if using a tunnel/reverse proxy
```

Keep it running with systemd (`/etc/systemd/system/whalesignal.service`):
```ini
[Unit]
Description=WhaleSignal
After=network-online.target
[Service]
WorkingDirectory=/home/ubuntu/whalesignal
ExecStart=/usr/bin/npx tsx server/src/index.ts
Restart=always
User=ubuntu
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now whalesignal
```

### Protecting the dashboard
* Simplest private access: keep `HOST=127.0.0.1` and use an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 ubuntu@vm`, then open http://127.0.0.1:8787.
* Or a private network such as Tailscale (free tier) and bind to the tailnet address.
* If you expose it publicly, set `DASHBOARD_PASSWORD` (HTTP Basic auth on every page and API call) **and** put it behind
  HTTPS (e.g. Caddy reverse proxy with automatic certificates). The server warns at startup if bound publicly without a password.

### Backups
Copy `data/whalesignal.db` (stop the service first, or use `sqlite3 data/whalesignal.db ".backup backup.db"`).

## What is not included (by design)
No real-money execution, no wallet connection, no key/seed handling, no billing or multi-user accounts.
