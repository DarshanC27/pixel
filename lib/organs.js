// The body map: each organ is one part of the system.
// `curve` maps a raw metric value to health (0-100) by linear interpolation between points.

export const ORGANS = {
  heart: {
    name: "Heart",
    system: "Database",
    metric: "db_latency_ms",
    unit: "ms",
    label: "query latency",
    curve: [[0, 100], [60, 100], [300, 50], [1500, 10], [5000, 2]],
  },
  lungs: {
    name: "Lungs",
    system: "API / network",
    metric: "api_p95_ms",
    unit: "ms",
    label: "p95 latency",
    curve: [[0, 100], [250, 100], [800, 55], [2500, 15], [8000, 3]],
  },
  brain: {
    name: "Brain",
    system: "Auth service",
    metric: "auth_error_pct",
    unit: "%",
    label: "login errors",
    curve: [[0, 100], [2, 100], [10, 50], [40, 12], [100, 0]],
  },
  stomach: {
    name: "Stomach",
    system: "Job queue",
    metric: "queue_depth",
    unit: "jobs",
    label: "backlog",
    curve: [[0, 100], [50, 100], [400, 50], [1500, 12], [5000, 2]],
  },
  skin: {
    name: "Skin",
    system: "Front end",
    metric: "frontend_error_pct",
    unit: "%",
    label: "page errors",
    curve: [[0, 100], [1, 100], [8, 50], [30, 12], [100, 0]],
  },
};

// The herd: each organ is also a named service, with the services it depends on.
// Sickness flows from a dependency to the services that depend on it.
const SERVICE_MAP = {
  heart: { service: "pg-primary", dependsOn: [] },
  lungs: { service: "orders-api", dependsOn: ["heart"] },
  brain: { service: "auth", dependsOn: ["heart"] },
  stomach: { service: "worker", dependsOn: ["heart"] },
  skin: { service: "web", dependsOn: ["lungs", "brain"] },
};
for (const [id, s] of Object.entries(SERVICE_MAP)) Object.assign(ORGANS[id], s);

export const ORGAN_IDS = Object.keys(ORGANS);

export function healthFor(organId, value) {
  const organ = ORGANS[organId];
  if (!organ) return null;
  if (value === null || value === undefined || Number.isNaN(value)) return 0; // no reading = flatline
  const pts = organ.curve;
  if (value <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (value <= x1) return Math.round(y0 + ((value - x0) / (x1 - x0)) * (y1 - y0));
  }
  return pts[pts.length - 1][1];
}

export function statusFor(health) {
  if (health >= 75) return "ok";
  if (health >= 50) return "uneasy";
  if (health >= 20) return "sick";
  if (health > 0) return "critical";
  return "dead";
}

export const STATUS_RANK = { ok: 0, uneasy: 1, sick: 2, critical: 3, dead: 4 };
