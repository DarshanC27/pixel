// The Body: plain, deterministic code. It decides what is broken.
// The AI never touches these numbers, so a lying log line can't fake health.

import { ORGANS, ORGAN_IDS, healthFor, statusFor, STATUS_RANK } from "./organs.js";

const EXTERNAL_TTL_MS = 60_000;
const SETTLE_TICKS = 2; // a new status must hold this many ticks (no flapping)
const RECOVERY_TICKS = 4; // all organs ok for this many ticks ends the incident
const WARN_WINDOW = 6; // ticks of history used for trend detection
const WARN_COOLDOWN_MS = 45_000;

export function createBody() {
  const organs = Object.fromEntries(
    ORGAN_IDS.map((id) => [id, { id, ...ORGANS[id], value: null, health: 100, status: "ok", pending: null, pendingTicks: 0, source: "pixel-mart" }]),
  );
  const external = {}; // organ -> { value?, health?, source, expires }
  const history = Object.fromEntries(ORGAN_IDS.map((id) => [id, []])); // recent raw values, for early warnings
  const lastWarned = {};
  const diary = [];
  const incidents = [];
  let current = null; // active incident
  let okStreak = 0;

  function note(entry) {
    const e = { at: Date.now(), ...entry };
    diary.push(e);
    if (diary.length > 300) diary.shift();
    if (current) current.diary.push(e);
    return e;
  }

  /** Accept a signal from any connected tool. */
  function ingestSignal(sig) {
    const organ = ORGANS[sig.organ] ? sig.organ : ORGAN_IDS.find((id) => ORGANS[id].metric === sig.metric);
    if (!organ) return { ok: false, error: `Unknown organ/metric. Use organ in ${ORGAN_IDS.join(", ")}` };
    const value = sig.value === null ? null : Number(sig.value);
    const health = sig.health !== undefined ? Math.max(0, Math.min(100, Number(sig.health))) : healthFor(organ, value);
    external[organ] = { value, health, source: String(sig.source || "webhook").slice(0, 40), expires: Date.now() + EXTERNAL_TTL_MS };
    return { ok: true, organ, health };
  }

  function update(metrics) {
    const events = [];
    const now = Date.now();
    for (const id of ORGAN_IDS) {
      const o = organs[id];
      const raw = metrics[o.metric];
      let health = healthFor(id, raw);
      let value = raw;
      let source = "pixel-mart";
      const ext = external[id];
      if (ext && ext.expires > now && ext.health < health) {
        health = ext.health;
        value = ext.value;
        source = ext.source;
      } else if (ext && ext.expires <= now) delete external[id];

      o.value = value === null || value === undefined ? null : Math.round(value * 10) / 10;
      o.health = health;
      o.source = source;

      // Early warning ("sneeze"): a steady climb while the organ still looks fine.
      const h = history[id];
      h.push(o.value);
      if (h.length > WARN_WINDOW) h.shift();
      const warning = checkTrend(id, h, o.status, now);
      if (warning) {
        lastWarned[id] = now;
        const entry = note({ kind: "warning", organ: id, from: warning.from, to: warning.to, unit: o.unit });
        events.push({ type: "early_warning", ...entry });
      }
      let next = statusFor(health);
      // Hysteresis: to count as better, health must clear the threshold by a margin.
      if (STATUS_RANK[next] < STATUS_RANK[o.status] && STATUS_RANK[statusFor(Math.max(0, health - 6))] >= STATUS_RANK[o.status]) next = o.status;
      if (next === o.status) {
        o.pending = null;
        o.pendingTicks = 0;
        continue;
      }
      if (o.pending !== next) {
        o.pending = next;
        o.pendingTicks = 1;
      } else o.pendingTicks++;
      // Getting worse is reported fast; recovering needs to hold.
      const needed = STATUS_RANK[next] > STATUS_RANK[o.status] ? 1 : SETTLE_TICKS;
      if (o.pendingTicks >= needed) {
        const from = o.status;
        o.status = next;
        o.pending = null;
        o.pendingTicks = 0;
        const entry = note({ kind: "organ", organ: id, from, to: next, health, value: o.value, unit: o.unit, source });
        events.push({ type: "organ_change", ...entry });
        if (current) {
          const peak = current.peaks[id];
          if (!peak || STATUS_RANK[next] > STATUS_RANK[peak.status]) current.peaks[id] = { status: next, value: o.value, at: entry.at };
        }
      }
    }

    const worst = worstStatus();
    if (!current && STATUS_RANK[worst] >= STATUS_RANK.sick) {
      current = { id: `INC-${String(incidents.length + 1).padStart(3, "0")}`, startedAt: now, endedAt: null, diary: [], peaks: {}, injections: [], questions: [], fixes: [] };
      for (const id of ORGAN_IDS) {
        const o = organs[id];
        if (o.status !== "ok") current.peaks[id] = { status: o.status, value: o.value, at: now };
      }
      // Copy the diary entries that triggered it.
      current.diary.push(...diary.filter((d) => now - d.at < 5000));
      incidents.push(current);
      events.push({ type: "incident_start", incident: current });
      okStreak = 0;
    } else if (current) {
      okStreak = worst === "ok" ? okStreak + 1 : 0;
      if (okStreak >= RECOVERY_TICKS) {
        current.endedAt = now;
        events.push({ type: "incident_end", incident: current });
        note({ kind: "recovered", incident: current.id });
        current = null;
        okStreak = 0;
      }
    }
    return events;
  }

  function checkTrend(id, h, status, now) {
    if (h.length < WARN_WINDOW || h.some((v) => v === null)) return null;
    if (status !== "ok" && status !== "uneasy") return null; // already sick: no point warning
    if (current) return null;
    if (lastWarned[id] && now - lastWarned[id] < WARN_COOLDOWN_MS) return null;
    const first = h[0];
    const last = h[h.length - 1];
    let rises = 0;
    for (let i = 1; i < h.length; i++) if (h[i] > h[i - 1]) rises++;
    const minRise = { ms: 25, "%": 1.5, jobs: 80 }[ORGANS[id].unit] || 0;
    if (rises >= h.length - 2 && last >= first * 1.8 && last - first >= minRise) return { from: first, to: last };
    return null;
  }

  /** Has Pixel felt this before? Find the latest closed incident whose worst organ matches. */
  function recall(organId) {
    for (let i = incidents.length - 1; i >= 0; i--) {
      const inc = incidents[i];
      if (inc === current || !inc.endedAt) continue;
      const worst = Object.entries(inc.peaks).sort((a, b) => STATUS_RANK[b[1].status] - STATUS_RANK[a[1].status])[0];
      if (worst && worst[0] === organId) return inc;
    }
    return null;
  }

  function worstStatus() {
    return ORGAN_IDS.map((id) => organs[id].status).reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), "ok");
  }

  function mood() {
    const w = worstStatus();
    if (w === "dead") return "collapsed";
    if (w === "ok") return current ? "recovering" : "happy";
    return w; // uneasy | sick | critical
  }

  function snapshot() {
    return {
      mood: mood(),
      organs: ORGAN_IDS.map((id) => {
        const { name, system, unit, label, value, health, status, source } = organs[id];
        return { id, name, system, unit, label, value, health, status, source };
      }),
      incident: current ? { id: current.id, startedAt: current.startedAt, external: current.external || null } : null,
    };
  }

  function recordInjection(entry) {
    const e = note({ kind: "injection", ...entry });
    if (current) current.injections.push(e);
    return e;
  }

  function recordQuestion(q, a) {
    if (current) current.questions.push({ at: Date.now(), q, a });
  }

  function lastIncident() {
    return incidents[incidents.length - 1] || null;
  }

  function recordFix(text) {
    if (current) current.fixes.push({ at: Date.now(), text });
  }

  function current_() {
    return current;
  }

  return { update, ingestSignal, snapshot, recordInjection, recordQuestion, recordFix, recall, note, currentIncident: current_, lastIncident, diary, incidents, organs };
}
