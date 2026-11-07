// Outbound integrations. Each one is optional and switched on by an environment variable.
// Failures are logged and never break the demo.

const INCIDENT_IO_BASE = process.env.INCIDENT_IO_BASE_URL || "https://api.incident.io";

export function integrationStatus() {
  return {
    slack: !!process.env.SLACK_WEBHOOK_URL,
    incidentIo: !!process.env.INCIDENT_IO_API_KEY,
    prometheus: !!process.env.PROMETHEUS_URL,
  };
}

// ---------- Slack (incoming webhook) ----------

export async function slackPage(text) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `:rotating_light: *Pixel* says: ${text}` }),
    });
    if (!res.ok) console.warn(`[slack] HTTP ${res.status}`);
  } catch (err) {
    console.warn("[slack] page failed:", err?.message || err);
  }
}

// ---------- incident.io ----------
// Docs: https://docs.incident.io/integrations/api-create-incident
// Needs an API key with "Create incidents" (and "Edit incidents" for updates).

let severities = null;

async function ioFetch(path, init = {}) {
  const res = await fetch(INCIDENT_IO_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.INCIDENT_IO_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`incident.io ${init.method || "GET"} ${path} -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function pickSeverity(level) {
  if (process.env.INCIDENT_IO_SEVERITY_ID) return process.env.INCIDENT_IO_SEVERITY_ID;
  if (!severities) severities = (await ioFetch("/v1/severities")).severities || [];
  if (!severities.length) throw new Error("incident.io returned no severities");
  const byRank = [...severities].sort((a, b) => a.rank - b.rank);
  // Pixel collapsing = the most severe; otherwise the least severe.
  return level === "collapsed" || level === "critical" ? byRank[byRank.length - 1].id : byRank[0].id;
}

/** Declare an incident. Returns the incident.io incident id, or null. */
export async function declareIncident({ id, name, summary, mood }) {
  if (!process.env.INCIDENT_IO_API_KEY) return null;
  try {
    const severity_id = await pickSeverity(mood);
    const body = await ioFetch("/v2/incidents", {
      method: "POST",
      body: JSON.stringify({
        name,
        summary,
        idempotency_key: `pixel-${id}-${Date.now()}`,
        severity_id,
        visibility: process.env.INCIDENT_IO_VISIBILITY || "public",
      }),
    });
    const inc = body.incident || {};
    console.log(`[incident.io] declared ${inc.reference || inc.id}`);
    return { id: inc.id, reference: inc.reference, url: inc.permalink };
  } catch (err) {
    console.warn("[incident.io] declare failed:", err?.message || err);
    return null;
  }
}

/** Update the incident's summary (used for recovery and the postmortem). */
export async function updateIncidentSummary(ioId, summary) {
  if (!process.env.INCIDENT_IO_API_KEY || !ioId) return false;
  try {
    await ioFetch(`/v2/incidents/${ioId}/actions/edit`, {
      method: "POST",
      body: JSON.stringify({ incident: { summary }, notify_incident_channel: true }),
    });
    return true;
  } catch (err) {
    console.warn("[incident.io] update failed:", err?.message || err);
    return false;
  }
}
