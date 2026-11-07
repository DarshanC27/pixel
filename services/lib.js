// Shared toolkit for the Pixel Mart services: a tiny JSON HTTP server,
// rolling request metrics, structured log lines and a network client with timeouts and retries.

import http from "node:http";

// If Pixel (the parent) dies without cleaning up, don't linger holding ports.
const parentPid = Number(process.env.PIXEL_PARENT_PID || 0);
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}

export function log(svc, level, msg) {
  // One line per event, "LEVEL service: message". Pixel's supervisor reads these from stdout.
  process.stdout.write(`${level} ${svc}: ${String(msg).replace(/\s+/g, " ").trim()}\n`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rolling window of request outcomes: p95 latency and error rate over the last few seconds. */
export function createWindow(ms = 5000) {
  const samples = [];
  const prune = () => {
    const cut = Date.now() - ms;
    while (samples.length && samples[0].t < cut) samples.shift();
  };
  return {
    record(durationMs, ok) {
      samples.push({ t: Date.now(), ms: durationMs, ok });
      prune();
    },
    stats() {
      prune();
      if (!samples.length) return { count: 0, p95_ms: 0, error_pct: 0 };
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      const errors = samples.filter((s) => !s.ok).length;
      return { count: samples.length, p95_ms: Math.round(p95), error_pct: Math.round((errors / samples.length) * 1000) / 10 };
    },
  };
}

/** JSON-over-HTTP client with a timeout and retries with backoff, like a real service mesh client. */
export async function call(url, { method = "GET", body, timeoutMs = 800, retries = 0, backoffMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status >= 500) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
      return { status: res.status, data };
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500) throw err;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Start a JSON service. `routes` maps "METHOD /path" to async (body, req, url) => [status, json] | json.
 * Every request is timed into `window` unless the route is in `untimed`.
 */
export function serve({ name, port, routes, window, untimed = ["GET /health", "GET /metrics"], html = {}, okBelow = 500 }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const key = `${req.method} ${url.pathname}`;
    if (req.method === "GET" && html[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html[url.pathname]);
    }
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"error":"not found"}');
    }
    const t0 = performance.now();
    let status = 200;
    let payload;
    try {
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const out = await handler(body, req, url);
      [status, payload] = Array.isArray(out) ? out : [200, out];
    } catch (err) {
      status = err.status && err.status < 500 ? err.status : 500;
      payload = { error: err.message };
    }
    if (window && !untimed.includes(key)) window.record(performance.now() - t0, status < okBelow);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  server.listen(port, "127.0.0.1", () => log(name, "INFO", `listening on :${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

export const PORTS = {
  db: Number(process.env.PM_DB_PORT || 4101),
  auth: Number(process.env.PM_AUTH_PORT || 4102),
  orders: Number(process.env.PM_ORDERS_PORT || 4103),
  worker: Number(process.env.PM_WORKER_PORT || 4104),
  web: Number(process.env.PM_WEB_PORT || 4105),
};
export const url = (svc, path = "") => `http://127.0.0.1:${PORTS[svc]}${path}`;
