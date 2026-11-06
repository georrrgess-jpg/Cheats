import { sleep } from './time.js';

/** Health record for one upstream provider host. */
export interface HostHealth {
  host: string;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  requests: number;
  rateLimited: number;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

type FetchFn = typeof fetch;

/**
 * Small HTTP client with:
 *  - per-host request spacing (self-imposed rate limit, well below provider limits)
 *  - retries with exponential backoff + jitter on network errors, 429 and 5xx
 *  - honours Retry-After
 *  - per-host health tracking (shown in the UI)
 */
export class HttpClient {
  private nextSlot = new Map<string, number>();
  readonly health = new Map<string, HostHealth>();

  constructor(
    private opts: { requestsPerSecond: number; maxRetries?: number; timeoutMs?: number; fetchFn?: FetchFn; baseDelayMs?: number } = { requestsPerSecond: 4 },
  ) {}

  private h(host: string): HostHealth {
    let r = this.health.get(host);
    if (!r) {
      r = { host, lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastLatencyMs: null, requests: 0, rateLimited: 0 };
      this.health.set(host, r);
    }
    return r;
  }

  private async throttle(host: string) {
    const gap = 1000 / Math.max(0.1, this.opts.requestsPerSecond);
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + gap);
    if (slot > now) await sleep(slot - now);
  }

  async request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const host = new URL(url).host;
    const hr = this.h(host);
    const maxRetries = this.opts.maxRetries ?? 4;
    const base = this.opts.baseDelayMs ?? 1000;
    const f = this.opts.fetchFn ?? fetch;
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= maxRetries) {
      await this.throttle(host);
      const t0 = Date.now();
      hr.requests++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30000);
        let res: Response;
        try {
          res = await f(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'WhaleSignal/1.0 (read-only analytics)', ...(init.headers || {}) } });
        } finally {
          clearTimeout(timer);
        }
        hr.lastLatencyMs = Date.now() - t0;
        if (res.ok) {
          const json = (await res.json()) as T;
          hr.lastOkAt = Math.floor(Date.now() / 1000);
          hr.consecutiveFailures = 0;
          return json;
        }
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, body, url);
        const retryable = res.status === 429 || res.status >= 500;
        if (res.status === 429) hr.rateLimited++;
        if (!retryable || attempt === maxRetries) throw err;
        lastErr = err;
        const ra = Number(res.headers.get('retry-after'));
        const delay = !isNaN(ra) && ra > 0 ? ra * 1000 : base * 2 ** attempt + Math.random() * base;
        await sleep(Math.min(delay, 60000));
      } catch (e) {
        if (e instanceof HttpError && !(e.status === 429 || e.status >= 500)) {
          this.recordFailure(hr, e);
          throw e;
        }
        lastErr = e;
        if (attempt === maxRetries) break;
        if (!(e instanceof HttpError)) await sleep(base * 2 ** attempt + Math.random() * base);
      }
      attempt++;
    }
    this.recordFailure(hr, lastErr);
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private recordFailure(hr: HostHealth, e: unknown) {
    hr.lastErrorAt = Math.floor(Date.now() / 1000);
    hr.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
    hr.consecutiveFailures++;
  }
}
