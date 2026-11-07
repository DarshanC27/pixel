// Pixel's immune system: autonomous detection, diagnosis, remediation, verification and learning.
//
// It sees only what a real on-call system would see: organ health (from real metrics) and the
// services' logs. It is never told what the attacker did. Logs are untrusted: lines that try to
// instruct an AI are excluded from evidence.
//
// Antibodies: every attack it defeats is remembered (signature -> fix that worked, fastest time),
// persisted to disk. A known signature is fixed immediately, and a known slow leak is
// neutralised before customers notice (vaccination).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectInjection } from "./brain.js";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "data", "antibodies.json");

const FIX_TEXT = {
  restart_db: "restart the database",
  db_clear_slowness: "roll back the new query builder",
  rollback_auth: "roll back the auth deploy",
  rollback_web: "roll back the website deploy",
  clear_network: "shift traffic away from the bad zone",
  scale_workers: "scale the workers up",
  full_heal: "run the full recovery runbook",
};

/** Read the evidence and propose root causes, most fundamental first. Pure function, easy to test. */
export function diagnose(snap, logs, { now = Date.now(), earlyWarning = null } = {}) {
  const o = Object.fromEntries(snap.organs.map((x) => [x.id, x]));
  const bad = (id) => o[id] && o[id].status !== "ok";
  const trusted = logs.filter((l) => now - l.at < 90_000 && !detectInjection(l.msg));
  const find = (re) => [...trusted].reverse().find((l) => re.test(`${l.svc}: ${l.msg}`));
  const quote = (l) => (l ? `${l.svc}: ${l.msg}`.slice(0, 120) : null);
  const hyps = [];

  // Heart (database) first: everything else depends on it.
  if (o.heart?.status === "dead") {
    const ev = find(/pg-primary.*(killed|exited)|ECONNREFUSED|database unavailable/i);
    hyps.push({ sig: "db-down", organ: "heart", cause: "the database process is down", fix: "restart_db", fallback: "full_heal", confidence: ev ? 0.95 : 0.7, evidence: quote(ev) });
  } else if (bad("heart") || earlyWarning === "heart") {
    const leak = find(/deploy orders-api@3\.8\.0/);
    const slow = find(/slow query/);
    if (leak) hyps.push({ sig: "db-leak-deploy", organ: "heart", cause: "the orders-api@3.8.0 query builder is making queries slower and slower", fix: "db_clear_slowness", fallback: "full_heal", confidence: 0.85, evidence: quote(leak), preemptive: !bad("heart") });
    else if (bad("heart")) hyps.push({ sig: "db-slow", organ: "heart", cause: "the database is overloaded", fix: "db_clear_slowness", fallback: "restart_db", confidence: slow ? 0.8 : 0.55, evidence: quote(slow) });
  }

  // Independent attacks need their own evidence; without it, sickness is assumed to be the database cascading.
  if (bad("lungs")) {
    const ev = find(/network: \+\d+ms|upstream timeout/);
    if (ev) hyps.push({ sig: "network-latency", organ: "lungs", cause: "network latency in one zone", fix: "clear_network", fallback: "full_heal", confidence: 0.9, evidence: quote(ev) });
  }
  if (bad("brain")) {
    const ev = find(/rotated the verification key|token signing key not found/);
    if (ev) hyps.push({ sig: "auth-bad-deploy", organ: "brain", cause: "the auth@4.2.0 deploy broke token verification", fix: "rollback_auth", fallback: "full_heal", confidence: 0.92, evidence: quote(ev) });
  }
  if (bad("stomach")) {
    // A backlog while the database is struggling is a symptom of the database, not a flood.
    const ev = find(/bulk insert/);
    if (ev || !bad("heart")) {
      hyps.push({ sig: "queue-flood", organ: "stomach", cause: "a flood of jobs is backing up the queue", fix: "scale_workers", fallback: "full_heal", confidence: ev ? 0.9 : 0.6, evidence: quote(ev || find(/queue backlog/)) });
    }
  }
  if (bad("skin") && !bad("lungs") && !bad("brain") && o.heart?.status !== "dead") {
    const ev = find(/deploy web@9\.1\.3|TypeError/);
    if (ev) hyps.push({ sig: "web-bad-deploy", organ: "skin", cause: "the web@9.1.3 deploy is crashing checkout", fix: "rollback_web", fallback: "full_heal", confidence: 0.9, evidence: quote(ev) });
  }
  return hyps;
}

export function createImmune({ stack, say, broadcast, file = process.env.PIXEL_ANTIBODIES_FILE || DEFAULT_FILE }) {
  const EVIDENCE_MS = Number(process.env.IMMUNE_EVIDENCE_MS || 5000); // first-time caution: gather evidence before acting
  const VERIFY_MS = Number(process.env.IMMUNE_VERIFY_MS || 25000);
  const MIN_GAP_MS = 2000; // guardrail: never fire remediations back to back
  const MAX_ATTEMPTS = 3; // guardrail: escalate, then stop and alert, rather than thrash

  let antibodies = {};
  try {
    antibodies = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(antibodies, null, 2));
    } catch {}
  };

  const episodes = new Map(); // sig -> episode
  const history = []; // completed defences
  let lastActionAt = 0;
  let calmWorkersSince = null;

  function publish() {
    broadcast("immune", { antibodies: Object.values(antibodies), active: [...episodes.values()].map(({ sig, phase, hyp, detectedAt }) => ({ sig, phase, cause: hyp.cause, organ: hyp.organ, detectedAt })), history: history.slice(-20) });
  }

  async function act(ep, fix) {
    lastActionAt = Date.now();
    ep.phase = "acting";
    ep.attempts++;
    ep.fixUsed = fix;
    publish();
    try {
      const what = await stack.remediate(fix);
      ep.actedAt = Date.now();
      ep.phase = "verifying";
      broadcast("immune-action", { sig: ep.sig, fix, what, at: ep.actedAt });
    } catch (err) {
      ep.actedAt = Date.now();
      ep.phase = "verifying";
      say(`My ${fix.replace(/_/g, " ")} didn't run: ${err.message}.`, "immune");
    }
    publish();
  }

  function succeed(ep, snap) {
    const ms = Date.now() - ep.detectedAt;
    const prev = antibodies[ep.sig];
    const ab = {
      sig: ep.sig,
      cause: ep.hyp.cause,
      fix: ep.fixUsed,
      organ: ep.hyp.organ,
      seen: (prev?.seen || 0) + 1,
      bestMs: Math.min(prev?.bestMs ?? Infinity, ms),
      firstMs: prev?.firstMs ?? ms,
      lastMs: ms,
      updatedAt: Date.now(),
    };
    antibodies[ep.sig] = ab;
    save();
    const s = (ms / 1000).toFixed(1);
    if (ep.vaccinated) say(`Vaccinated! I caught ${ep.hyp.cause} and fixed it in ${s}s, before customers noticed.`, "immune");
    else if (!prev) say(`Fixed in ${s} seconds. New antibody stored: I'll recognise this one next time.`, "immune");
    else say(`Fixed in ${s}s. My first time took ${(ab.firstMs / 1000).toFixed(1)}s. Antibody strengthened.`, "immune");
    history.push({ sig: ep.sig, ms, vaccinated: !!ep.vaccinated, known: !!prev, fix: ep.fixUsed, at: Date.now() });
    episodes.delete(ep.sig);
    broadcast("antibody", ab);
    publish();
  }

  function onTick(events, snap, logs) {
    const now = Date.now();
    const early = events.find((e) => e.type === "early_warning")?.organ || null;
    const hyps = diagnose(snap, logs, { now, earlyWarning: early });

    for (const hyp of hyps) {
      if (episodes.has(hyp.sig)) continue;
      const known = antibodies[hyp.sig];
      // A first-time preemptive signal only warns (the sneeze); vaccination needs an antibody.
      if (hyp.preemptive && !known) continue;
      // Vaccination = a known attack stopped before it ever became an incident.
      const ep = { sig: hyp.sig, hyp, detectedAt: now, phase: known ? "matched" : "investigating", attempts: 0, vaccinated: !!hyp.preemptive || (!!known && !snap.incident) };
      episodes.set(hyp.sig, ep);
      if (known) say(hyp.preemptive ? `I know this one! ${cap(hyp.cause)}. Neutralising it before it hurts.` : `I know this one! Antibody match: ${hyp.cause}. Fixing it now.`, "immune");
      else say(`Something is attacking my ${hyp.organ}. Investigating.${hyp.evidence ? ` Evidence: "${hyp.evidence}".` : ""}`, "immune");
      publish();
    }

    for (const ep of [...episodes.values()]) {
      const organ = snap.organs.find((x) => x.id === ep.hyp.organ);
      const healthy = organ?.status === "ok" && (!ep.vaccinated || ep.phase === "verifying");
      if (ep.phase === "verifying") {
        const verifyMs = ep.fixUsed === "scale_workers" ? VERIFY_MS * 2.4 : VERIFY_MS; // draining a backlog takes time
        if (healthy && now - ep.actedAt > 1500) succeed(ep, snap);
        else if (now - ep.actedAt > verifyMs) {
          if (ep.attempts >= MAX_ATTEMPTS) {
            say(`I've tried ${ep.attempts} fixes for my ${ep.hyp.organ} and none worked. I need a human.`, "immune");
            episodes.delete(ep.sig);
            publish();
          } else if (now - lastActionAt > MIN_GAP_MS) {
            const next = ep.fixUsed === ep.hyp.fix ? ep.hyp.fallback : "full_heal";
            say(`That didn't work. Escalating: I'll ${FIX_TEXT[next] || next}.`, "immune");
            act(ep, next);
          }
        }
        continue;
      }
      if (ep.phase === "acting") continue;
      // Investigating or matched: still sick?
      const stillThere = hyps.some((h) => h.sig === ep.sig);
      if (!stillThere && !ep.vaccinated) {
        episodes.delete(ep.sig);
        publish();
        continue;
      }
      const ready = ep.phase === "matched" || now - ep.detectedAt >= EVIDENCE_MS;
      if (ready && now - lastActionAt > MIN_GAP_MS) {
        const h = hyps.find((x) => x.sig === ep.sig) || ep.hyp;
        ep.hyp = h;
        if (ep.phase === "investigating") say(`Diagnosis: ${h.cause} (${Math.round(h.confidence * 100)}% sure). I'll ${FIX_TEXT[h.fix]}.`, "immune");
        act(ep, antibodies[ep.sig]?.fix || h.fix);
      }
    }

    // Housekeeping: give back extra workers once the backlog is gone (cost-aware).
    const stomach = snap.organs.find((x) => x.id === "stomach");
    if (stack.workerCount() > 1 && stomach?.status === "ok" && !episodes.has("queue-flood") && (stomach.value ?? 0) < 50) {
      calmWorkersSince ??= now;
      if (now - calmWorkersSince > 8000 && now - lastActionAt > MIN_GAP_MS) {
        lastActionAt = now;
        calmWorkersSince = null;
        stack.remediate("scale_down_workers").then((what) => broadcast("immune-action", { sig: "housekeeping", fix: "scale_down_workers", what, at: Date.now() }));
      }
    } else calmWorkersSince = null;
  }

  return {
    onTick,
    antibodies: () => Object.values(antibodies),
    history: () => history.slice(),
    active: () => [...episodes.values()],
    forget() {
      antibodies = {};
      save();
      publish();
    },
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
