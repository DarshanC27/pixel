// Inbound adapters: real monitoring tools that can make Pixel sick.
// Each one converts the tool's format into Pixel's standard signal and calls body.ingestSignal().
//
//   Prometheus (pull)      PROMETHEUS_URL + PIXEL_PROM_QUERIES='{"heart":"<promql>", ...}'
//   Alertmanager (push)    POST /api/adapters/alertmanager   (Alertmanager webhook_config)
//   Sentry (push)          POST /api/adapters/sentry         (Sentry webhook / internal integration)

import { ORGANS, ORGAN_IDS } from "./organs.js";

const SEVERITY_HEALTH = { critical: 10, page: 10, fatal: 10, error: 25, high: 25, warning: 50, warn: 50, medium: 50, info: 70, low: 70 };

/** Work out which organ a tool is talking about, from explicit labels, service names or keywords. */
export function organFor(hints) {
  const text = hints.filter(Boolean).map((h) => String(h).toLowerCase());
  for (const t of text) if (ORGANS[t]) return t; // explicit organ name
  for (const t of text) {
    const byService = ORGAN_IDS.find((id) => t === ORGANS[id].service || t.includes(ORGANS[id].service));
    if (byService) return byService;
  }
  const joined = text.join(" ");
  if (/postgres|pg-|database|\bdb\b|mysql|sql/.test(joined)) return "heart";
  if (/auth|login|token|session|sso/.test(joined)) return "brain";
  if (/queue|worker|job|backlog|kafka|sqs|rabbit/.test(joined)) return "stomach";
  if (/frontend|front-end|web|browser|javascript|react|page/.test(joined)) return "skin";
  if (/api|latency|gateway|network|timeout|http/.test(joined)) return "lungs";
  return null;
}

// ---------- Alertmanager ----------

export function fromAlertmanager(payload) {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  return alerts.map((a) => {
    const labels = a.labels || {};
    const organ = organFor([labels.pixel_organ, labels.service, labels.job, labels.alertname, a.annotations?.summary]);
    if (!organ) return { ok: false, error: `Could not map alert "${labels.alertname || "?"}" to an organ. Add a pixel_organ label.` };
    const health = a.status === "resolved" ? 100 : SEVERITY_HEALTH[String(labels.severity || "").toLowerCase()] ?? 35;
    return { ok: true, signal: { source: "alertmanager", organ, health }, note: `${a.status || "firing"} ${labels.alertname || "alert"}: ${a.annotations?.summary || ""}`.trim() };
  });
}

// ---------- Sentry ----------

export function fromSentry(payload) {
  // Supports the legacy webhook plugin and the integration-platform event_alert / issue payloads.
  const ev = payload?.data?.event || payload?.event || {};
  const issue = payload?.data?.issue || {};
  const tags = Object.fromEntries((ev.tags || []).map((t) => (Array.isArray(t) ? t : [t.key, t.value])));
  const level = String(ev.level || payload?.level || issue.level || "error").toLowerCase();
  const title = ev.title || payload?.message || issue.title || "Sentry event";
  const project = payload?.project_name || payload?.project || issue.project?.slug || tags.service || "";
  const organ = organFor([tags.pixel_organ, tags.service, project, title, ev.culprit || payload?.culprit]) || "skin";
  const resolved = payload?.action === "resolved";
  return {
    ok: true,
    signal: { source: "sentry", organ, health: resolved ? 100 : SEVERITY_HEALTH[level] ?? 30 },
    note: `${resolved ? "resolved" : level} ${project ? `[${project}] ` : ""}${title}`,
  };
}

// ---------- HTTP probes: watch any website or API ----------
// PIXEL_PROBES='{"skin":"https://example.com","lungs":"https://api.example.com/health"}'
// Latency organs (ms) get the real response time; percentage organs get 0% or 100% errors;
// a site that doesn't answer flatlines its organ.

export function startProbes(body) {
  let probes;
  try {
    probes = JSON.parse(process.env.PIXEL_PROBES || "{}");
  } catch {
    console.warn("[probes] PIXEL_PROBES is not valid JSON; probes disabled");
    return null;
  }
  const entries = Object.entries(probes).filter(([organ, target]) => ORGANS[organ] && /^https?:\/\//.test(String(target)));
  if (!entries.length) return null;
  const every = Number(process.env.PIXEL_PROBE_INTERVAL_MS || 5000);

  async function probe([organ, target]) {
    const unit = ORGANS[organ].unit;
    const t0 = performance.now();
    let ok = false;
    try {
      const res = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
      ok = res.status < 500;
    } catch {
      ok = false;
    }
    const ms = Math.round(performance.now() - t0);
    if (unit === "ms") body.ingestSignal({ source: `probe ${new URL(target).host}`, organ, value: ok ? ms : null });
    else if (unit === "%") body.ingestSignal({ source: `probe ${new URL(target).host}`, organ, value: ok ? 0 : 100 });
    else body.ingestSignal({ source: `probe ${new URL(target).host}`, organ, health: ok ? 100 : 0 });
  }
  const run = () => entries.forEach((e) => probe(e));
  run();
  const timer = setInterval(run, every);
  console.log(`  Probes: watching ${entries.map(([o, t]) => `${t} (${o})`).join(", ")}`);
  return { stop: () => clearInterval(timer) };
}

// ---------- Prometheus (polling) ----------

export function startPrometheus(body, { onError } = {}) {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return null;
  let queries;
  try {
    queries = JSON.parse(process.env.PIXEL_PROM_QUERIES || "{}");
  } catch {
    console.warn("[prometheus] PIXEL_PROM_QUERIES is not valid JSON; adapter disabled");
    return null;
  }
  const entries = Object.entries(queries).filter(([organ]) => ORGANS[organ]);
  if (!entries.length) {
    console.warn('[prometheus] no queries configured. Example: PIXEL_PROM_QUERIES=\'{"heart":"histogram_quantile(0.95, rate(pg_query_duration_seconds_bucket[1m]))*1000"}\'');
    return null;
  }
  const every = Number(process.env.PIXEL_PROM_INTERVAL_MS || 5000);
  let lastErrorAt = 0;

  async function poll() {
    for (const [organ, query] of entries) {
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(4000) });
        const json = await res.json();
        if (json.status !== "success") throw new Error(json.error || `HTTP ${res.status}`);
        const sample = json.data?.result?.[0]?.value?.[1];
        const value = sample === undefined ? null : Number(sample);
        if (value === null || Number.isNaN(value)) continue; // no data: don't invent a flatline
        body.ingestSignal({ source: "prometheus", organ, value });
      } catch (err) {
        if (Date.now() - lastErrorAt > 60_000) {
          lastErrorAt = Date.now();
          console.warn(`[prometheus] ${organ} query failed: ${err?.message || err}`);
          onError?.(err);
        }
      }
    }
  }
  poll();
  const timer = setInterval(poll, every);
  console.log(`  Prometheus: polling ${entries.length} quer${entries.length === 1 ? "y" : "ies"} every ${every / 1000}s`);
  return { stop: () => clearInterval(timer), poll };
}
