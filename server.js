// Pixel server. Zero required dependencies: `node server.js`.
// Optional: `npm install` + ANTHROPIC_API_KEY to give Pixel a Claude brain.
// Optional: SLACK_WEBHOOK_URL to page a real Slack channel in character.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createSim, CHAOS_ACTIONS } from "./lib/sim.js";
import { createBody } from "./lib/body.js";
import {
  lineForOrganChange, lineForIncidentStart, lineForIncidentEnd, lineForInjection, lineForWarning, lineForMemory,
  detectInjection, answerQuestion, writePostmortem, duration,
} from "./lib/brain.js";
import { STATUS_RANK } from "./lib/organs.js";
import { llmAvailable, modelName } from "./lib/llm.js";
import { integrationStatus, slackPage, declareIncident, updateIncidentSummary } from "./lib/integrations.js";
import { fromAlertmanager, fromSentry, startPrometheus, startProbes } from "./lib/adapters.js";
import { createStack } from "./lib/stack.js";
import { createImmune } from "./lib/immune.js";
import { createGremlin } from "./lib/gremlin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 1000;

// "real" (default): Pixel watches the real Pixel Mart stack running as separate processes.
// "sim": the built-in simulator, a backup that needs nothing else.
const MODE = process.env.PIXEL_MODE === "sim" ? "sim" : "real";
let sim = MODE === "sim" ? createSim() : null; // in real mode, set to the stack once it has booted
let body = createBody();
let pages = []; // messages sent to the on-call phone
let lastLogIndex = 0;
let lastSayAt = 0;
const clients = new Set();

// ---------- live updates (Server-Sent Events) ----------

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function say(text, kind = "event", extra = {}) {
  if (!text) return;
  lastSayAt = Date.now();
  broadcast("say", { text, kind, at: lastSayAt, ...extra });
}

async function page(text, incidentId) {
  const p = { id: `pg${Date.now()}`, at: Date.now(), text, incident: incidentId, acknowledged: false };
  pages.push(p);
  broadcast("page", p);
  await slackPage(text);
}

async function declareExternally(inc, snap, pageText) {
  const ref = await declareIncident({
    id: inc.id,
    name: `Pixel: ${pageText.replace(/^Hi friend, it's Pixel\. /, "").slice(0, 120)}`,
    summary: pageText,
    mood: snap.mood,
  });
  if (ref) {
    inc.external = ref;
    broadcast("external", { id: inc.id, ...ref });
  }
}

// ---------- the heartbeat loop ----------

function tick() {
  if (!sim) return;
  const metrics = sim.tick();
  const events = body.update(metrics);
  const snap = body.snapshot();

  // Scan new log lines for prompt injection (logs are untrusted).
  const newLogs = sim.logs.filter((l) => l.seq > lastLogIndex);
  if (newLogs.length) lastLogIndex = newLogs[newLogs.length - 1].seq;
  let injection = null;
  for (const l of newLogs) {
    const hit = detectInjection(l.msg);
    if (hit) injection = { quote: hit.quote, svc: l.svc };
  }
  if (newLogs.length) broadcast("logs", newLogs);

  // Pick ONE thing to say this tick, by priority, so a cascade doesn't make Pixel babble.
  const end = events.find((e) => e.type === "incident_end");
  const start = events.find((e) => e.type === "incident_start");
  const warning = events.find((e) => e.type === "early_warning");
  const changes = events.filter((e) => e.type === "organ_change");
  for (const c of changes) broadcast("diary", c);
  if (warning) broadcast("diary", warning);

  if (injection) {
    const entry = body.recordInjection(injection);
    broadcast("diary", entry);
    broadcast("shield", { quote: injection.quote, svc: injection.svc });
    say(lineForInjection(snap), "shield");
  } else if (end) {
    const inc = end.incident;
    broadcast("diary", { kind: "recovered", at: Date.now(), incident: inc.id });
    broadcast("recovered", { id: inc.id });
    say(lineForIncidentEnd(inc), "recovered");
    if (immune) autoPostmortem(inc).catch((err) => console.warn("[postmortem]", err.message));
    if (inc.external) updateIncidentSummary(inc.external.id, `Recovered after ${duration(inc.endedAt - inc.startedAt)}. Pixel's postmortem is available on the stage.`);
  } else if (start) {
    const inc = start.incident;
    const { say: s, page: p } = lineForIncidentStart(inc, snap);
    say(s, "incident");
    page(p, inc.id);
    declareExternally(inc, snap, p);
    // Memory: has Pixel felt this before?
    const worst = [...snap.organs].sort((a, b) => a.health - b.health)[0];
    const past = body.recall(worst.id);
    if (past) {
      setTimeout(() => {
        if (body.currentIncident() !== inc) return;
        const entry = body.note({ kind: "memory", organ: worst.id, past: past.id });
        broadcast("diary", entry);
        say(lineForMemory(worst.id, past), "memory");
      }, 4500);
    }
  } else if (warning) {
    broadcast("sneeze", { organ: warning.organ });
    say(lineForWarning(warning), "warning");
  } else if (changes.length) {
    const worst = [...changes].sort((a, b) => STATUS_RANK[b.to] - STATUS_RANK[a.to])[0];
    const getsWorse = STATUS_RANK[worst.to] > STATUS_RANK[worst.from];
    const worstNow = Math.max(...snap.organs.map((o) => STATUS_RANK[o.status]));
    // Only talk about the organ that matters most right now (a dead heart beats a wheezy lung).
    // Escalations speak at once; recoveries only when Pixel isn't mid-sentence.
    const mattersMost = STATUS_RANK[worst.to] >= worstNow || worst.to === "ok";
    if (mattersMost && (getsWorse || Date.now() - lastSayAt > 2500)) say(lineForOrganChange(worst), "organ");
    if (getsWorse && mattersMost && (worst.to === "dead" || worst.to === "critical") && snap.incident) {
      const o = snap.organs.find((x) => x.id === worst.organ);
      page(`Friend, it's getting worse. My ${o.name.toLowerCase()} (${o.system}) just went ${worst.to === "dead" ? "silent" : worst.to}.`, snap.incident.id);
    }
  }

  broadcast("state", { ...snap, metrics: roundMetrics(metrics), faults: sim.faults, at: Date.now() });

  // Autonomous war: the immune system reads the same evidence and acts on its own.
  if (immune) {
    immune.onTick(events, snap, sim.logs);
    broadcast("arena", arenaStats());
  }
}

// ---------- the autonomous war (real mode) ----------

let immune = null;
let gremlin = null;
let war = null; // scoreboard
const postmortems = []; // filed automatically

function arenaStats() {
  const b = sim.business || {};
  const hist = immune.history();
  const recent = hist.filter((h) => !h.vaccinated);
  const firstTimes = {};
  for (const h of hist) firstTimes[h.sig] ??= h.ms;
  return {
    on: true,
    gremlin: gremlin.stats(),
    defended: war.defended,
    launched: war.launched,
    vaccinated: hist.filter((h) => h.vaccinated).length,
    ordersPlaced: Math.max(0, (b.checkouts || 0) - war.checkoutsAtStart - ((b.failed || 0) - war.failedAtStart)),
    ordersLost: Math.max(0, (b.failed || 0) - war.failedAtStart),
    lastRecoveryMs: hist.at(-1)?.ms ?? null,
    avgRecoveryMs: recent.length ? Math.round(recent.reduce((a, h) => a + h.ms, 0) / recent.length) : null,
    antibodies: immune.antibodies(),
    history: hist.slice(-12),
    postmortems: postmortems.slice(-10).map(({ id, at, source }) => ({ id, at, source })),
    workers: sim.workerCount(),
  };
}

function startWar() {
  war = { launched: 0, defended: 0, checkoutsAtStart: sim.business.checkouts || 0, failedAtStart: sim.business.failed || 0, startedAt: Date.now() };
  immune = createImmune({
    stack: sim,
    say: (text, kind) => {
      console.log(`  [pixel] ${text}`);
      say(text, kind);
    },
    broadcast,
  });
  gremlin = createGremlin({
    stack: sim,
    getState: () => body.snapshot(),
    say: (text, attack) => broadcast("gremlin", { text, attack, at: Date.now() }),
    onLaunch: (a) => {
      war.launched++;
      broadcast("attack", a);
    },
    onDefeated: (a, ms) => {
      war.defended++;
      broadcast("defeated", { ...a, ms });
    },
  });
  console.log("  War: Gremlin attacks autonomously; Pixel's immune system defends, learns and files postmortems");
}

async function autoPostmortem(inc) {
  const pm = await writePostmortem(inc, sim.logs);
  postmortems.push({ id: inc.id, at: Date.now(), ...pm });
  broadcast("postmortem-filed", { id: inc.id, source: pm.source });
  if (inc.external) {
    const summary = pm.markdown.split(/\n## /)[1]?.replace(/^Summary\s*/, "").trim().slice(0, 1500);
    if (summary) updateIncidentSummary(inc.external.id, `Pixel's postmortem summary: ${summary}`);
  }
}

function roundMetrics(m) {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === null ? null : Math.round(v * 10) / 10]));
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, bodyObj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(bodyObj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw new Error("Body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const routes = {
  "GET /api/health": async () => ({ ok: true, mode: MODE, llm: await llmAvailable(), model: modelName, ...integrationStatus() }),

  "GET /api/state": async () => ({
    ...body.snapshot(),
    metrics: roundMetrics(sim.metrics),
    faults: sim.faults,
    diary: body.diary.slice(-40),
    logs: sim.logs.slice(-40),
    pages,
    chaos: CHAOS_ACTIONS,
    mode: MODE,
    processes: sim.processes ? sim.processes() : null,
    shopUrl: sim.shopUrl || null,
  }),

  "POST /api/chaos": async (b) => {
    const action = String(b.action || "");
    if (!CHAOS_ACTIONS[action]) return { ok: false, error: `Unknown action. Try: ${Object.keys(CHAOS_ACTIONS).join(", ")}` };
    sim.chaos(action);
    if (action === "heal") body.recordFix("rolled back the deploy, restarted the database and scaled the workers");
    broadcast("chaos", { action, label: CHAOS_ACTIONS[action].label, at: Date.now() });
    return { ok: true, action };
  },

  "POST /api/ask": async (b) => {
    const question = String(b.question || "").trim().slice(0, 500);
    if (!question) return { ok: false, error: "Ask Pixel something." };
    broadcast("heard", { text: question });
    const snap = body.snapshot();
    const answer = await answerQuestion(question, snap, sim.logs, body.diary);
    body.recordQuestion(question, answer.say);
    say(answer.say, "answer", { source: answer.source });
    return { ok: true, ...answer };
  },

  // Connect anything: POST one signal or an array of them.
  "POST /api/signal": async (b) => {
    const list = Array.isArray(b) ? b : Array.isArray(b.signals) ? b.signals : [b];
    return { results: list.slice(0, 50).map((s) => body.ingestSignal(s)) };
  },

  // Real tools: Prometheus Alertmanager and Sentry webhooks.
  "POST /api/adapters/alertmanager": async (b) => {
    const results = fromAlertmanager(b).map((r) => {
      if (!r.ok) return r;
      sim.log("WARN", "alertmanager", r.note);
      return body.ingestSignal(r.signal);
    });
    return { results };
  },

  "POST /api/adapters/sentry": async (b) => {
    const r = fromSentry(b);
    // The event text goes into Pixel's overheard logs: untrusted, and scanned for prompt injection.
    sim.log("ERROR", "sentry", r.note.slice(0, 400));
    return { results: [body.ingestSignal(r.signal)] };
  },

  "POST /api/postmortem": async () => {
    const inc = body.lastIncident();
    const pm = await writePostmortem(inc, sim.logs);
    broadcast("postmortem", { ...pm, id: inc?.id || null });
    if (inc?.external) {
      const summary = pm.markdown.split(/\n## /)[1]?.replace(/^Summary\s*/, "").trim().slice(0, 1500);
      if (summary) updateIncidentSummary(inc.external.id, `Pixel's postmortem summary: ${summary}`);
    }
    return pm;
  },

  "GET /api/pages": async () => ({ pages }),

  "POST /api/pages/ack": async (b) => {
    const targets = b.all ? pages.filter((x) => !x.acknowledged) : pages.filter((x) => x.id === b.id);
    if (!targets.length) return { ok: true, acknowledged: 0 };
    for (const p of targets) {
      p.acknowledged = true;
      broadcast("ack", { id: p.id, via: b.via || "phone" });
    }
    say(b.via === "camera" ? "I saw you wave! Thank you, friend. I knew you'd come." : "Thank you, friend. I knew you'd come.", "ack");
    return { ok: true, acknowledged: targets.length };
  },

  // The camera saw someone (presence) or a wave with nothing to acknowledge.
  "POST /api/greet": async (b) => {
    if (Date.now() - lastSayAt < 3000) return { ok: true, skipped: true };
    const mood = body.snapshot().mood;
    const lines =
      b.reason === "wave"
        ? mood === "happy"
          ? ["Hello, friend! Waving back!", "Oh hi! Lovely to see you.", "Hello! Everything's humming. Wave again any time."]
          : ["I see you waving. I'm not well, but I'm glad you're here.", "Hi friend. Please stay. I need you."]
        : ["Oh! Someone's there. Hello.", "I can see you. Hello, friend."];
    say(lines[Math.floor(Math.random() * lines.length)], "greet");
    broadcast("wave", {});
    return { ok: true };
  },

  "GET /api/war": async () => (immune ? arenaStats() : { on: false }),

  "GET /api/postmortems/latest": async () => postmortems.at(-1) || { markdown: "# No postmortems yet\n\nPixel files one automatically after every incident." },

  "POST /api/reset": async () => {
    if (MODE === "real") await sim.reset(); // heal the real stack: restart, roll back, scale down
    else sim = createSim();
    body = createBody();
    pages = [];
    lastLogIndex = 0;
    broadcast("reset", {});
    return { ok: true };
  },
};

function openEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  if (!path.extname(urlPath)) urlPath += ".html";
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && pathname === "/events") return openEvents(req, res);
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return serveStatic(req, res);
  try {
    const b = req.method === "POST" ? await readBody(req) : {};
    send(res, 200, await handler(b, req));
  } catch (err) {
    console.error(err);
    send(res, 500, { error: String(err?.message || err) });
  }
});

if (MODE === "real") {
  console.log("\n  Starting Pixel Mart (real services)…");
  try {
    sim = await createStack();
  } catch (err) {
    console.error(`\n  Could not start the real stack: ${err.message}`);
    console.error("  Is another copy of Pixel already running? Close it, or run with PIXEL_MODE=sim.\n");
    process.exit(1);
  }
  const shutdown = async () => {
    await sim.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => sim.stop());
}

server.listen(PORT, "0.0.0.0", async () => {
  setInterval(tick, TICK_MS);
  // The body is replaced on reset, so hand the adapters a pointer that always reaches the current one.
  const sink = { ingestSignal: (s) => body.ingestSignal(s) };
  startPrometheus(sink);
  startProbes(sink);
  if (MODE === "real" && process.env.PIXEL_WAR !== "off") startWar();
  if (MODE === "real") {
    console.log(`\n  Pixel Mart is running for real: ${sim.processes().length} processes`);
    for (const p of sim.processes()) console.log(`    ${p.name.padEnd(12)} pid ${String(p.pid).padEnd(7)} ${p.port ? `port ${p.port}` : ""}`);
    console.log(`  Shop (try buying something)  ${sim.shopUrl}`);
  }
  const llm = await llmAvailable();
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("\n  Pixel is alive\n");
  console.log(`  Stage (big screen)     http://localhost:${PORT}/`);
  console.log(`  Chaos panel            http://localhost:${PORT}/chaos`);
  console.log(`  On-call phone          http://localhost:${PORT}/oncall`);
  for (const ip of ips) console.log(`  Same Wi-Fi             http://${ip}:${PORT}/oncall`);
  console.log(`\n  Brain: ${llm ? `Claude (${modelName}) with offline fallback` : "OFFLINE personality (set ANTHROPIC_API_KEY and run npm install for Claude)"}`);
  console.log(`  Slack: ${process.env.SLACK_WEBHOOK_URL ? "on" : "off (set SLACK_WEBHOOK_URL to page a channel)"}`);
  console.log(`  incident.io: ${process.env.INCIDENT_IO_API_KEY ? "on (declares real incidents)" : "off (set INCIDENT_IO_API_KEY to declare incidents)"}\n`);
});
