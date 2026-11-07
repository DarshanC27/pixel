// worker: drains the job queue (receipts, marketing emails). Several can run at once.
// Each job really takes time, so a flood of jobs really backs up.

import { serve, call, log, sleep, url, PORTS } from "./lib.js";

const ID = Number(process.env.WORKER_ID || 1);
const NAME = ID === 1 ? "worker" : `worker-${ID}`;
const JOB_MS = Number(process.env.WORKER_JOB_MS || 25);
let depth = 0;
let processed = 0;
let lastRate = 0;
let healthy = true;

setInterval(() => {
  lastRate = processed;
  processed = 0;
}, 1000);

async function loop() {
  for (;;) {
    try {
      const { data } = await call(url("db", "/jobs/claim"), { method: "POST", body: { n: 20 }, timeoutMs: 3000 });
      depth = data.depth;
      if (!healthy) log(NAME, "INFO", "reconnected to pg-primary, resuming jobs");
      healthy = true;
      if (!data.jobs.length) {
        await sleep(300);
        continue;
      }
      for (const job of data.jobs) {
        await sleep(JOB_MS); // the actual work: rendering and sending an email
        processed++;
      }
      await call(url("db", "/jobs/done"), { method: "POST", body: { ids: data.jobs.map((j) => j.id) }, timeoutMs: 3000 });
      if (depth > 500 && Math.random() < 0.1) log(NAME, "WARN", `queue backlog ${depth} jobs, consumers saturated`);
    } catch (err) {
      if (healthy) log(NAME, "ERROR", `cannot reach job queue: ${err.cause?.code || err.message}`);
      healthy = false;
      await sleep(1000);
    }
  }
}

// Only the first worker exposes metrics; extra workers just add capacity.
if (ID === 1) {
  serve({
    name: NAME,
    port: PORTS.worker,
    routes: {
      "GET /health": () => ({ ok: true }),
      "GET /metrics": () => ({ queue_depth: depth, jobs_per_s: lastRate, connected: healthy }),
    },
  });
} else {
  log(NAME, "INFO", "extra worker started");
  process.on("SIGTERM", () => process.exit(0));
}
loop();
