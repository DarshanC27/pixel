# Pixel: your system, with a face

Pixel is a live creature that **is** your software system. When the system breaks, Pixel gets sick in the matching body part, tells you out loud where it hurts, pages the on-call engineer in character, blocks prompt-injection attacks hidden in logs, and writes the postmortem when it recovers.

Built for the incident.io challenge: *a live agent with personality that reacts in real time.* Read the full story in [SUBMISSION.md](SUBMISSION.md).

| Healthy | Database down, injection blocked | The herd during an outage |
|---|---|---|
| ![Healthy](docs/screenshots/1-healthy.jpg) | ![Collapsed with shield](docs/screenshots/2-collapsed-shield.jpg) | ![Herd](docs/screenshots/3-herd-outage.jpg) |

## Run it (30 seconds)

```bash
node server.js          # Node 22.5+ (uses the built-in SQLite). No install needed.
```

This starts **Pixel and a real online shop it watches**. Then open:

| Screen | URL | Put it on |
|---|---|---|
| Stage | http://localhost:3000/ | The projector / big screen |
| Chaos panel | http://localhost:3000/chaos | Presenter's laptop (keys 1-8, 0 to heal, R to reset) |
| On-call phone | http://localhost:3000/oncall | A real phone on the same Wi-Fi (the server prints the address) |
| **The real shop** | http://127.0.0.1:4105/ | Buy something yourself while you break things |

## It's real

Pixel isn't watching a simulation. `node server.js` starts **Pixel Mart**, a real online shop made of six separate programs talking over the network:

| Process | Port | What it really does |
|---|---|---|
| pg-primary | 4101 | A real SQL database (SQLite) with orders, a job queue and sessions |
| auth | 4102 | Issues and verifies signed login tokens, checking sessions in the database |
| orders-api | 4103 | Places orders: verifies the customer with auth, writes to the database |
| worker | 4104 | Drains the job queue (receipt emails); more can be started |
| web | 4105 | The storefront page and its checkout API |
| customers | – | Simulated shoppers placing a few orders a second |

Every second Pixel measures each service's **real** p95 latency, error rate and queue depth. The chaos buttons cause **real** failures:

| Button | What really happens |
|---|---|
| Kill the database | The database process is killed (SIGKILL). Its port refuses connections; orders fail; the API retries and slows; the website shows errors |
| Slow leak / Slow database | Real extra query time inside the database |
| Slow the network | Real added latency in orders-api |
| Break logins | A bad auth deploy: verification key rotated, signing key not. Every login really fails |
| Flood the job queue | 3,000 real jobs inserted into the database; workers really drain them |
| Buggy front end | The checkout handler really throws for about a third of requests |
| Poison the logs | A real customer order whose **gift message** contains a prompt injection. orders-api logs it like any API logs input, and Pixel catches it |
| Fix everything | Really restarts the database (new process), rolls back the bad deploys, and starts extra workers if the queue is backed up |

`PIXEL_MODE=sim node server.js` (or `npm run start:sim`) runs the built-in simulator instead, if you ever need a demo without the real stack.

Click **Tap to wake Pixel** on the stage first. Browsers only allow sound after a click.

**Stage shortcuts:** `M` talk, `H` herd view, `Shift+R` reset the demo. If the server restarts mid-demo, the stage shows a banner and resyncs by itself when it's back.

### Give Pixel a Claude brain (optional)

```bash
npm install                         # installs @anthropic-ai/sdk
set ANTHROPIC_API_KEY=sk-ant-...    # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
node server.js
```

With a key, free-form questions and postmortems are written by Claude. Without one, Pixel uses its hand-written offline personality, so **the demo never depends on Wi-Fi**.

### Page a real Slack channel (optional)

Create a Slack incoming webhook and set `SLACK_WEBHOOK_URL` before starting. Pixel then posts its pages there too.

### Declare real incidents in incident.io (optional)

Create an API key in incident.io (Settings â†’ API keys) with **Create incidents** and **Edit incidents**, then set `INCIDENT_IO_API_KEY`. When Pixel gets sick it declares an incident (`POST /v2/incidents`), picking the most severe severity when it collapses and the least severe otherwise. It updates the summary on recovery and again with the postmortem. Optional: `INCIDENT_IO_SEVERITY_ID` to force a severity, `INCIDENT_IO_VISIBILITY=private`.

## Features

- **Live sickness** from metrics, with realistic cascades (a dead database slows the API and breaks pages).
- **Talk to Pixel** by mic (press M) or by typing.
- **On-call phone** pages in character; acknowledge on the phone or by **waving at the camera**.
- **Camera**: Pixel's eyes follow you; it says hello when you appear. Processing stays in the browser.
- **Early warning**: a slow leak makes Pixel sneeze *before* anything breaks.
- **Memory**: "Wait. I've felt this before. INC-001â€¦", including what fixed it last time.
- **Immune system**: prompt injections in logs raise a shield and are reported, never obeyed.
- **Postmortem**: timeline, impact, likely cause, security note, what fixed it, follow-ups. Download as Markdown.

## Body map

| Organ | System | Metric |
|---|---|---|
| Heart | Database | query latency (ms) |
| Lungs | API / network | p95 latency (ms) |
| Brain | Auth service | login error rate (%) |
| Stomach | Job queue | backlog (jobs) |
| Skin | Front end | page error rate (%) |

## The herd

Press **H** on the stage (or the One Pixel / Herd toggle) to see one mini-Pixel per service, linked by their dependencies:

```
                web
              /     \
 worker   orders-api   auth
      \       |       /
         pg-primary
```

Sickness spreads one hop at a time: kill the database and pg-primary flatlines, orders-api, auth and worker get sick about two seconds later, and web two seconds after that. Red "infection" particles flow along the lines towards the services that depend on the sick one.

## Real monitoring tools

| Tool | How | Setup |
|---|---|---|
| **Prometheus** (pull) | Polls PromQL queries and maps each result to an organ | `PROMETHEUS_URL=http://prometheus:9090` and `PIXEL_PROM_QUERIES='{"heart":"<promql returning ms>","lungs":"<promql>"}'` (optional `PIXEL_PROM_INTERVAL_MS`, default 5000) |
| **Alertmanager** (push) | `POST /api/adapters/alertmanager` | Add a `webhook_configs` receiver pointing at that URL. Organ comes from a `pixel_organ` label, the `service` label, or keywords in the alert name. `severity` sets how sick: critical, warning, info. Resolved alerts heal. |
| **Sentry** (push) | `POST /api/adapters/sentry` | Add a webhook (or internal integration) alert action. Organ comes from the `service` tag or project name; defaults to the skin (front end). The event text goes into Pixel's overheard logs, so prompt injections hidden in error messages raise the shield. |

```bash
curl -X POST http://localhost:3000/api/adapters/alertmanager -H "Content-Type: application/json" \
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"LoginErrors","service":"auth","severity":"critical"}}]}'
```

## Watch any website

Point Pixel at real URLs and their response times (or uptime) drive organs:

```bash
PIXEL_PROBES='{"skin":"https://your-site.com","lungs":"https://api.your-site.com/health"}' node server.js
```

Latency organs get the real response time; error-rate organs get 0% or 100%; a site that doesn't answer flatlines its organ. Checked every 5 seconds (`PIXEL_PROBE_INTERVAL_MS`).

## Connect anything

Any tool can report a symptom with one POST. Signals expire after 60 seconds.

```bash
curl -X POST http://localhost:3000/api/signal \
  -H "Content-Type: application/json" \
  -d '{"source":"datadog","organ":"lungs","metric":"api_p95_ms","value":3000}'
```

Send `value` (mapped to health with the organ's curve) or `health` (0-100) directly. Arrays are accepted.

## How it works

```
Senses (simulator, webhooks, mic) -> Body (plain code, health 0-100) -> Brain (personality + Claude) -> Expression (creature, voice, pages)
```

- **Body** (`lib/body.js`): deterministic. The AI never decides whether something is broken.
- **Brain** (`lib/brain.js`): hand-written lines for events; Claude for questions and postmortems; a "lie guard" rejects any AI reply that claims all is fine while an organ is sick.
- **Immune system**: log lines are untrusted. Text that tries to instruct the AI raises Pixel's shield and is recorded in the postmortem.
- **Personality bible**: `prompts/personality.md`. Edit it to change how Pixel talks; it feeds the Claude prompts.

## Test

```bash
npm test
```

Runs the whole demo story end to end (break, cascade, page, injection, questions, webhook, recovery, postmortem, herd hop order, Alertmanager, Sentry and Prometheus, incident.io and Slack against mocks, wave-to-acknowledge, memory, early warning): 37 checks. Then `test/real.js` runs the **real** stack on separate ports (24 checks: real orders flowing, the database process really killed and restarted, real cascades, an injection arriving through a real gift message, 3,000 real jobs drained by scaled-up workers, a real auth misconfiguration and rollback). It also tests the Claude brain through the real SDK against a mock API (request shape, untrusted-log wrapping, lie guard, outage fallback): 9 checks.

## Files

```
server.js            HTTP + live events (SSE) + heartbeat loop
lib/sim.js           Pixel Mart simulator and chaos actions
lib/organs.js        Body map and health curves
lib/body.js          Deterministic health, incidents, diary
lib/brain.js         Personality, injection detection, questions, postmortems
lib/llm.js           Optional Claude client (falls back offline)
lib/stack.js         Starts, measures and breaks the real Pixel Mart processes
services/            Pixel Mart: db, auth, orders, worker, web, customers
lib/integrations.js  Slack and incident.io (optional, outbound)
lib/adapters.js      Prometheus, Alertmanager, Sentry (optional, inbound)
public/herd.js       The herd view
prompts/personality.md
public/              Stage, chaos panel, on-call phone
test/smoke.js        End-to-end test
DEMO.md              3-minute demo script and checklist
```
