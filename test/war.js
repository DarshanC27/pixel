// The autonomous war, end to end, with ZERO human input.
// This test never presses a button or calls an action endpoint. It only watches.
// Gremlin attacks the real stack on its own; Pixel must detect, diagnose, fix, learn and document.
// Usage: node test/war.js

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const AB_FILE = path.join(os.tmpdir(), `pixel-antibodies-${Date.now()}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
// Read-only. There is deliberately no POST helper in this file.
const get = (p) => fetch(BASE + p).then((r) => r.json());

async function waitWar(fn, ms, label) {
  const end = Date.now() + ms;
  let w;
  while (Date.now() < end) {
    w = await get("/api/war");
    lastWar = w;
    if (fn(w)) return w;
    await sleep(1000);
  }
  console.log(`  …timed out waiting for: ${label}`);
  return w;
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    PIXEL_OFFLINE: "1",
    PIXEL_MODE: "real",
    PM_DB_PORT: "4301",
    PM_AUTH_PORT: "4302",
    PM_ORDERS_PORT: "4303",
    PM_WORKER_PORT: "4304",
    PM_WEB_PORT: "4305",
    PIXEL_ANTIBODIES_FILE: AB_FILE,
    PIXEL_GREMLIN_SEQUENCE: "assassin,assassin,slow_poison,slow_poison,bad_deploy,spam_cannon",
    GREMLIN_FIRST_DELAY_MS: "4000",
    GREMLIN_COOLDOWN_MS: "2500",
    IMMUNE_EVIDENCE_MS: "2500",
  },
  stdio: "pipe",
});
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));

const bySig = (w, sig) => w.history.filter((h) => h.sig === sig);
let lastWar = null;

try {
  for (let i = 0; i < 80; i++) {
    try { await get("/api/health"); break; } catch { await sleep(250); }
  }
  console.log("\nPixel vs Gremlin: autonomous war test (no human input)\n");
  let w = await get("/api/war");
  check("the war starts by itself", w.on === true && w.antibodies.length === 0);

  w = await waitWar((x) => bySig(x, "db-down").length >= 1, 90000, "first Assassin defended");
  const first = bySig(w, "db-down")[0];
  check("Gremlin killed the database and Pixel fixed it alone", !!first && first.fix === "restart_db", first && `${(first.ms / 1000).toFixed(1)}s, fix ${first.fix}`);
  check("Pixel stored an antibody for it", w.antibodies.some((a) => a.sig === "db-down"));

  w = await waitWar((x) => bySig(x, "db-down").length >= 2, 90000, "second Assassin defended");
  const second = bySig(w, "db-down")[1];
  check("the second identical attack is recognised from memory", !!second && second.known === true);
  check("and fixed faster than the first time", !!second && second.ms < first.ms, second && `${(first.ms / 1000).toFixed(1)}s -> ${(second.ms / 1000).toFixed(1)}s`);

  w = await waitWar((x) => bySig(x, "db-leak-deploy").length >= 1, 120000, "first Slow Poison defended");
  const leak1 = bySig(w, "db-leak-deploy")[0];
  check("a stealthy slow leak is diagnosed and rolled back", !!leak1, leak1 && `${(leak1.ms / 1000).toFixed(1)}s`);

  w = await waitWar((x) => bySig(x, "db-leak-deploy").length >= 2, 120000, "second Slow Poison");
  const leak2 = bySig(w, "db-leak-deploy")[1];
  check("the second slow leak is vaccinated before it becomes an incident", !!leak2 && leak2.vaccinated === true, leak2 && `${(leak2.ms / 1000).toFixed(1)}s, vaccinated=${leak2.vaccinated}`);

  // Let all six rounds play out (Gremlin counts a round as defeated only once everything is healthy again).
  w = await waitWar((x) => x.gremlin.attacks.spam_cannon.uses >= 1 && x.defended >= 6, 300000, "all six rounds defended");
  check("Gremlin's six attacks were all defended", w.defended >= 6, `${w.defended}/${w.launched}`);
  check("a bad website deploy is rolled back autonomously", bySig(w, "web-bad-deploy")[0]?.fix === "rollback_web");
  check("a queue flood is drained by autonomously scaled workers", bySig(w, "queue-flood").some((h) => h.fix === "scale_workers"));
  w = await waitWar((x) => x.workers === 1, 60000, "workers scaled back down");
  check("Pixel scales the workers back down when it's over", w.workers === 1, `${w.workers} worker(s)`);
  check("postmortems were filed automatically", w.postmortems.length >= 3, `${w.postmortems.length} filed`);
  const pm = await get("/api/postmortems/latest");
  check("the latest postmortem is a real document", /## Timeline/.test(pm.markdown || ""));
  check("real customers kept shopping through the war", w.ordersPlaced > 50, `${w.ordersPlaced} placed, ${w.ordersLost} lost`);
  const saved = JSON.parse(fs.readFileSync(AB_FILE, "utf8"));
  check("antibodies are saved to disk (they survive restarts)", Object.keys(saved).length >= 4, Object.keys(saved).join(", "));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill("SIGTERM");
  await sleep(1500);
  try { fs.unlinkSync(AB_FILE); } catch {}
  if (failures) {
    console.log("\n--- server output (tail) ---\n" + out.split("\n").slice(-40).join("\n"));
    try { console.log("\n--- history ---\n" + JSON.stringify(lastWar?.history, null, 1)); } catch {}
  }
  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
  process.exit(failures ? 1 : 0);
}
