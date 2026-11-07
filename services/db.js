// pg-primary: Pixel Mart's database. A real SQLite database behind a network API,
// so other services depend on it over the network and really break when it dies.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, createWindow, log, sleep, PORTS } from "./lib.js";

const NAME = "pg-primary";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, "pixelmart.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, item TEXT, gift_message TEXT, user_id TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, kind TEXT, payload TEXT, status TEXT DEFAULT 'queued', claimed_at INTEGER);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, revoked INTEGER DEFAULT 0);
`);
// Jobs claimed by a worker that died are re-queued on start-up.
db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'claimed'");

const window = createWindow();
const chaos = { delayMs: 0, leakMs: 0, leaking: false };

// A slow leak: every second the extra query time creeps up, like a table growing without an index.
setInterval(() => {
  if (chaos.leaking) chaos.leakMs = Math.min(2400, chaos.leakMs + 9 + chaos.leakMs * 0.08);
}, 1000);

async function q(fn) {
  const extra = chaos.delayMs + chaos.leakMs;
  if (extra) await sleep(extra * (0.85 + Math.random() * 0.3));
  if (extra > 200 && Math.random() < 0.3) log(NAME, "WARN", `slow query ${Math.round(extra)}ms on orders (seq scan)`);
  return fn();
}

const st = {
  insertOrder: db.prepare("INSERT INTO orders (item, gift_message, user_id, created_at) VALUES (?, ?, ?, ?)"),
  insertJob: db.prepare("INSERT INTO jobs (kind, payload) VALUES (?, ?)"),
  queued: db.prepare("SELECT id, kind, payload FROM jobs WHERE status = 'queued' ORDER BY id LIMIT ?"),
  claim: db.prepare("UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'queued'"),
  done: db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?"),
  depth: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
  orderCount: db.prepare("SELECT COUNT(*) AS n FROM orders"),
  session: db.prepare("SELECT user_id, revoked FROM sessions WHERE token = ?"),
  upsertSession: db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?) ON CONFLICT(token) DO NOTHING"),
};

serve({
  name: NAME,
  port: PORTS.db,
  window,
  routes: {
    "GET /health": () => ({ ok: true }),
    "GET /metrics": () => {
      const s = window.stats();
      return { query_p95_ms: s.p95_ms, queries: s.count, queue_depth: st.depth.get().n, orders: st.orderCount.get().n, chaos };
    },
    "POST /orders": (b) =>
      q(() => {
        const r = st.insertOrder.run(String(b.item), String(b.giftMessage || ""), String(b.userId || "guest"), Date.now());
        st.insertJob.run("send_receipt", JSON.stringify({ orderId: Number(r.lastInsertRowid) }));
        return { id: Number(r.lastInsertRowid) };
      }),
    "POST /jobs/claim": (b) =>
      q(() => {
        const rows = st.queued.all(Math.min(50, Number(b.n) || 10));
        const now = Date.now();
        const claimed = rows.filter((r) => st.claim.run(now, r.id).changes === 1);
        return { jobs: claimed, depth: st.depth.get().n };
      }),
    "POST /jobs/done": (b) => q(() => {
      for (const id of b.ids || []) st.done.run(id);
      return { ok: true };
    }),
    "POST /jobs/bulk": (b) => {
      const n = Math.min(20000, Number(b.n) || 1000);
      db.exec("BEGIN");
      for (let i = 0; i < n; i++) st.insertJob.run(String(b.kind || "marketing_email"), "{}");
      db.exec("COMMIT");
      log(NAME, "WARN", `bulk insert: ${n} ${b.kind || "marketing_email"} jobs enqueued`);
      return { enqueued: n };
    },
    "POST /sessions": (b) => q(() => {
      st.upsertSession.run(String(b.token), String(b.userId));
      return { ok: true };
    }),
    "POST /sessions/check": (b) => q(() => {
      const row = st.session.get(String(b.token));
      return { valid: !!row && !row.revoked, userId: row?.user_id || null };
    }),
    "POST /admin/chaos": (b) => {
      if (b.delayMs !== undefined) chaos.delayMs = Math.max(0, Number(b.delayMs));
      if (b.leak !== undefined) {
        chaos.leaking = !!b.leak;
        if (!b.leak) chaos.leakMs = 0;
      }
      if (b.heal) Object.assign(chaos, { delayMs: 0, leakMs: 0, leaking: false });
      log(NAME, "INFO", `chaos settings: ${JSON.stringify(chaos)}`);
      return chaos;
    },
  },
});
