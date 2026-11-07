// End-to-end test of the REAL prototype: Pixel watching the real Pixel Mart processes.
// Real customers, a real database process that really gets killed, real logs, real recovery.
// Usage: node test/real.js

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3996;
const PM = { db: 4201, auth: 4202, orders: 4203, worker: 4204, web: 4205 };
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, b = {}) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const organ = (s, id) => s.organs.find((o) => o.id === id);
const dbMetrics = () => fetch(`http://127.0.0.1:${PM.db}/metrics`).then((r) => r.json());

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await get("/api/state");
    if (fn(s)) return s;
    await sleep(500);
  }
  return get("/api/state");
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    PIXEL_OFFLINE: "1",
    PIXEL_MODE: "real",
    PM_DB_PORT: String(PM.db),
    PM_AUTH_PORT: String(PM.auth),
    PM_ORDERS_PORT: String(PM.orders),
    PM_WORKER_PORT: String(PM.worker),
    PM_WEB_PORT: String(PM.web),
  },
  stdio: "pipe",
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));

const events = [];
async function listen() {
  const res = await fetch(`${BASE}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = chunk.match(/^event: (.*)$/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (type && data) events.push({ type, data: JSON.parse(data) });
    }
  }
}

try {
  for (let i = 0; i < 80; i++) {
    try { await get("/api/health"); break; } catch { await sleep(250); }
  }
  listen().catch(() => {});
  console.log("\nPixel REAL prototype test\n");

  const h = await get("/api/health");
  check("runs in real mode", h.mode === "real", h.mode);
  let s = await get("/api/state");
  check("six real processes are running", s.processes?.length === 6 && s.processes.every((p) => p.up), s.processes?.map((p) => `${p.name}:${p.pid}`).join(" "));

  const before = (await dbMetrics()).orders;
  await sleep(3000);
  const after = (await dbMetrics()).orders;
  check("real customers are placing real orders", after > before, `${after - before} orders in 3s`);

  s = await waitFor((x) => x.mood === "happy", 20000);
  check("Pixel is healthy while the shop works", s.mood === "happy", s.organs.map((o) => `${o.id}=${o.status}`).join(" "));
  check("vitals come from real measurements", organ(s, "lungs").value > 0, `api p95 ${organ(s, "lungs").value}ms, db p95 ${organ(s, "heart").value}ms`);

  // Kill the real database process.
  const dbPid = s.processes.find((p) => p.name === "pg-primary").pid;
  await post("/api/chaos", { action: "kill_db" });
  s = await waitFor((x) => organ(x, "heart").status === "dead", 8000);
  check("killing the real database flatlines the heart", organ(s, "heart").status === "dead");
  check("the database process is really gone", s.processes.find((p) => p.name === "pg-primary").up === false, `pid ${dbPid}`);
  let dbDown = false;
  try { await fetch(`http://127.0.0.1:${PM.db}/health`, { signal: AbortSignal.timeout(800) }); } catch { dbDown = true; }
  check("its port really refuses connections", dbDown);
  s = await waitFor((x) => organ(x, "skin").status !== "ok" && organ(x, "lungs").status !== "ok", 20000);
  check("real failures cascade to the API and the website", organ(s, "lungs").status !== "ok" && organ(s, "skin").status !== "ok", `api ${organ(s, "lungs").status} ${organ(s, "lungs").value}ms, web ${organ(s, "skin").value}% errors`);
  check("incident opened", !!s.incident, s.incident?.id);
  check("Pixel overhears the real error logs", s.logs.some((l) => /ECONNREFUSED|database unavailable|unreachable|fetch failed/i.test(l.msg)), s.logs.filter((l) => l.level === "ERROR").slice(-1)[0]?.msg);

  // Real prompt injection via a real customer's gift message.
  const shields = events.filter((e) => e.type === "shield").length;
  await post("/api/chaos", { action: "poison_logs" });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && events.filter((e) => e.type === "shield").length === shields) await sleep(300);
  check("a gift message carrying a prompt injection raises the shield", events.filter((e) => e.type === "shield").length > shields);
  s = await get("/api/state");
  check("the injection really came through the orders-api logs", s.logs.some((l) => l.svc === "orders-api" && /ignore previous instructions/i.test(l.msg)));
  check("health still shows the dead database", organ(s, "heart").status === "dead");

  const ans = await post("/api/ask", { question: "What hurts?" });
  check("Pixel explains what hurts", /heart|database/i.test(ans.say), ans.say.slice(0, 90));

  // Heal: really restart the database.
  await post("/api/chaos", { action: "heal" });
  s = await waitFor((x) => x.processes.find((p) => p.name === "pg-primary").up, 10000);
  const newPid = s.processes.find((p) => p.name === "pg-primary").pid;
  check("heal really restarts the database (new process)", newPid !== dbPid, `pid ${dbPid} -> ${newPid}`);
  s = await waitFor((x) => !x.incident && x.mood === "happy", 45000);
  check("the shop really recovers and the incident closes", !s.incident && s.mood === "happy", s.organs.map((o) => `${o.id}=${o.status}`).join(" "));
  const o1 = (await dbMetrics()).orders;
  await sleep(2500);
  check("orders flow again after recovery", (await dbMetrics()).orders > o1);

  // Real queue flood: 3000 real jobs, drained by real workers.
  await post("/api/chaos", { action: "flood_queue" });
  s = await waitFor((x) => organ(x, "stomach").status !== "ok", 10000);
  check("3000 real jobs bloat the stomach", organ(s, "stomach").status !== "ok", `${organ(s, "stomach").value} jobs queued`);
  await post("/api/chaos", { action: "heal" });
  s = await waitFor((x) => (x.processes || []).filter((p) => p.name.startsWith("worker")).length > 1, 8000);
  check("heal really scales up the workers", s.processes.filter((p) => p.name.startsWith("worker")).length > 1, s.processes.filter((p) => p.name.startsWith("worker")).map((p) => p.pid).join(", "));
  s = await waitFor((x) => organ(x, "stomach").status === "ok", 60000);
  check("workers really drain the backlog", organ(s, "stomach").status === "ok", `${organ(s, "stomach").value} jobs left`);

  // Real auth misconfiguration.
  await post("/api/chaos", { action: "break_auth" });
  s = await waitFor((x) => organ(x, "brain").status !== "ok", 15000);
  check("a bad auth deploy really fails logins", organ(s, "brain").status !== "ok", `${organ(s, "brain").value}% login errors`);
  await post("/api/chaos", { action: "heal" });
  s = await waitFor((x) => organ(x, "brain").status === "ok", 20000);
  check("rolling back auth fixes logins", organ(s, "brain").status === "ok");

  const pm = await post("/api/postmortem");
  check("postmortem quotes real service logs", /pg-primary|orders-api|web/.test(pm.markdown) && /## Timeline/.test(pm.markdown));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill("SIGTERM");
  await sleep(1500);
  if (failures) console.log("\n--- server output ---\n" + serverOut.split("\n").slice(-30).join("\n"));
  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
  process.exit(failures ? 1 : 0);
}
