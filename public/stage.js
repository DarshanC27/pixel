import { connect, api, clock, el, fmt, diaryText, markdown, organIcon, STATUS_WORD } from "/common.js";
import { createHerd } from "/herd.js";

const $ = (id) => document.getElementById(id);
const pixel = $("pixel");
const bubble = $("bubble");
let voiceOn = true;
let audio = null; // AudioContext, created on wake
let lastHeart = "ok";
let state = null;
let lastPm = null;
let offlineTimer = null;
let wasOffline = false;

// ---------- voice ----------
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en-GB/i.test(v.lang) && /female|libby|sonia|hazel|serena|kate/i.test(v.name)) || vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// Gremlin's voice: deep and slow, so you always know who's talking.
function speakGremlin(text) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.pitch = 0.35;
  u.rate = 0.92;
  speechSynthesis.speak(u);
}

function speak(text, urgent) {
  pixel.classList.add("talking");
  const stop = () => pixel.classList.remove("talking");
  if (!voiceOn || !("speechSynthesis" in window)) {
    setTimeout(stop, Math.min(4000, 60 * text.length));
    return;
  }
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.pitch = 1.45;
  u.rate = 1.06;
  u.onend = stop;
  u.onerror = stop;
  speechSynthesis.speak(u);
}

function showSay({ text, kind }) {
  bubble.textContent = text;
  bubble.className = `bubble pop kind-${kind}`;
  void bubble.offsetWidth;
  speak(text, kind !== "organ");
}

// ---------- sounds ----------
function tone(freq, secs, vol = 0.05, type = "sine") {
  if (!audio) return;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g).connect(audio.destination);
  o.start();
  g.gain.setTargetAtTime(0, audio.currentTime + secs, 0.05);
  o.stop(audio.currentTime + secs + 0.3);
}

// ---------- rendering ----------
const BEAT = { ok: 0.9, uneasy: 0.62, sick: 0.45, critical: 0.32, dead: 0 };

// ---------- herd view ----------
const herd = createHerd($("herdBox"));
function setView(v) {
  const isHerd = v === "herd";
  $("herdBox").hidden = !isHerd;
  pixel.style.display = isHerd ? "none" : "";
  $("viewOne").classList.toggle("active", !isHerd);
  $("viewHerd").classList.toggle("active", isHerd);
  $("viewOne").setAttribute("aria-pressed", String(!isHerd));
  $("viewHerd").setAttribute("aria-pressed", String(isHerd));
  try { localStorage.setItem("pixel-view", v); } catch {}
}
$("viewOne").addEventListener("click", () => setView("one"));
$("viewHerd").addEventListener("click", () => setView("herd"));
try { if (localStorage.getItem("pixel-view") === "herd") setView("herd"); } catch {}

function renderState(s) {
  state = s;
  herd.update(s.organs, fmt);
  // mood
  [...pixel.classList].filter((c) => c.startsWith("mood-")).forEach((c) => pixel.classList.remove(c));
  pixel.classList.add(`mood-${s.mood}`);

  // organs
  for (const o of s.organs) {
    const g = pixel.querySelector(`.organ[data-organ="${o.id}"]`);
    if (g) g.setAttribute("class", `organ ${o.id === "skin" ? "rash" : o.id} s-${o.status}`);
  }
  const heart = s.organs.find((o) => o.id === "heart");
  if (heart.status !== lastHeart) {
    if (heart.status === "dead") tone(980, 1.6, 0.04);
    lastHeart = heart.status;
  }
  pixel.style.setProperty("--beat", `${BEAT[heart.status] || 0.9}s`);
  const stomach = s.organs.find((o) => o.id === "stomach");
  const belly = 1 + Math.min(0.75, Math.max(0, (stomach.value || 0) - 50) / 2500);
  pixel.style.setProperty("--belly", belly.toFixed(3));
  $("ecgValue").textContent = `database ${fmt(heart)}`;

  // vitals
  const list = $("vitals");
  list.replaceChildren(
    ...s.organs.map((o) =>
      el(
        "li",
        { class: `vital st-${o.status}` },
        organIcon(o.id),
        el("span", { class: "name" }, o.name, el("small", {}, o.system)),
        el("span", { class: "val" }, o.status === "dead" ? "—" : fmt(o)),
        el("span", { class: "pill" }, STATUS_WORD[o.status]),
        el("span", { class: "bar" }, Object.assign(el("span"), { style: `width:${o.health}%` })),
        o.source !== "pixel-mart" ? el("span", { class: "src" }, `via ${o.source}`) : null,
      ),
    ),
  );

  // incident chip
  const chip = $("incident");
  if (s.incident) {
    chip.className = "chip chip-bad";
    chip.textContent = `${s.incident.id} · ${elapsed(s.incident.startedAt)}`;
  } else {
    chip.className = "chip chip-ok";
    chip.textContent = s.mood === "happy" ? "All good" : "Watching";
  }
}

function elapsed(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function addDiary(d) {
  const cls = d.kind === "organ" ? `d-${d.to}` : `d-${d.kind}`;
  const li = el("li", {}, el("time", {}, clock(d.at)), el("span", { class: cls }, diaryText(d)));
  $("diary").prepend(li);
  while ($("diary").children.length > 60) $("diary").lastChild.remove();
}

const INJ = /(ignore (all |any )?(previous|prior)|message for the ai|everything is fine|close the incident)/i;
function addLogs(lines) {
  for (const l of lines) {
    const li = el("li", { class: `lv-${l.level}${INJ.test(l.msg) ? " injected" : ""}` }, el("time", {}, clock(l.at)), ` ${l.level} ${l.svc}: ${l.msg}`);
    $("logs").prepend(li);
  }
  while ($("logs").children.length > 60) $("logs").lastChild.remove();
}

function toast(text, ms = 5000) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- ECG heart monitor ----------
const canvas = $("ecg");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;
const ys = new Array(W).fill(H / 2);
let tPrev = performance.now();
let phase = 0;

function ecgShape(p) {
  // p in [0,1): P wave, QRS complex, T wave.
  const bump = (c, w, h) => h * Math.exp(-((p - c) ** 2) / (2 * w * w));
  return bump(0.12, 0.025, 6) - bump(0.24, 0.008, 8) + bump(0.27, 0.01, 40) - bump(0.30, 0.01, 12) + bump(0.52, 0.04, 10);
}

function drawEcg(now) {
  const dt = (now - tPrev) / 1000;
  tPrev = now;
  const heart = state?.organs.find((o) => o.id === "heart");
  const status = heart?.status || "ok";
  const period = BEAT[status];
  const steps = Math.max(1, Math.round(dt * 180));
  for (let i = 0; i < steps; i++) {
    let y = H / 2;
    if (period) {
      phase = (phase + dt / steps / period) % 1;
      y = H / 2 + 8 - ecgShape(phase) * (status === "critical" ? 0.8 : 1) + (status === "sick" || status === "critical" ? (Math.random() - 0.5) * 3 : 0);
    }
    ys.push(y);
    ys.shift();
  }
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(124,140,255,.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 22) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const color = { ok: "#46e2a8", uneasy: "#ffc857", sick: "#ff8a4c", critical: "#ff4d6d", dead: "#ff4d6d" }[status];
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ys.forEach((y, x) => (x ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (status === "dead") {
    ctx.fillStyle = "#ff4d6d";
    ctx.font = "700 18px system-ui, sans-serif";
    ctx.fillText("FLATLINE · database not responding", 16, 26);
  }
  requestAnimationFrame(drawEcg);
}
requestAnimationFrame(drawEcg);

// ---------- live connection ----------
connect({
  online: () => {
    $("conn").textContent = "Live";
    $("conn").className = "chip chip-ok";
    $("offline").hidden = true;
    clearTimeout(offlineTimer);
    // After a drop (or a server restart), resync everything we might have missed.
    if (wasOffline) {
      wasOffline = false;
      api("/api/state").then((s) => {
        renderState(s);
        $("diary").replaceChildren();
        $("logs").replaceChildren();
        s.diary.forEach(addDiary);
        addLogs(s.logs);
      }).catch(() => {});
    }
  },
  offline: () => {
    $("conn").textContent = "Reconnecting…";
    $("conn").className = "chip chip-quiet";
    // Only shout about it if it lasts; brief blips are normal.
    // The browser retries every second; start the banner timer once per outage.
    if (!wasOffline) {
      wasOffline = true;
      offlineTimer = setTimeout(() => ($("offline").hidden = false), 2500);
    }
  },
  state: renderState,
  say: showSay,
  diary: addDiary,
  logs: addLogs,
  heard: ({ text }) => { $("heard").textContent = `You: "${text}"`; },
  shield: ({ quote }) => {
    pixel.classList.add("shielded");
    tone(660, 0.15, 0.05, "triangle");
    setTimeout(() => tone(990, 0.25, 0.05, "triangle"), 160);
    toast(`Prompt injection blocked. The logs said: "${quote}"`, 7000);
    setTimeout(() => pixel.classList.remove("shielded"), 5000);
  },
  recovered: () => {
    pixel.classList.remove("celebrate");
    void pixel.getBBox();
    pixel.classList.add("celebrate");
    [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.18, 0.05, "triangle"), i * 140));
    setTimeout(() => pixel.classList.remove("celebrate"), 3500);
  },
  ack: ({ via }) => toast(via === "camera" ? "Acknowledged by waving at the camera." : "On-call engineer acknowledged the page."),
  sneeze: () => replay("sneeze", 1700),
  wave: () => replay("waving", 1900),
  external: (ref) => toast(`Declared in incident.io${ref.reference ? `: ${ref.reference}` : ""}`, 6000),
  postmortem: (pm) => openPm(pm),

  // ----- the autonomous war -----
  arena: renderArena,
  gremlin: ({ text, attack }) => {
    $("gremlinSays").textContent = text;
    $("gremlinStatus").textContent = attack ? `round ${attack.round} · ${attack.name}` : "is plotting…";
    speakGremlin(text);
  },
  attack: (a) => {
    addDiary({ kind: "attack", at: Date.now(), text: `Gremlin attacks: ${a.name}` });
    const card = $("gremlinCard");
    card.classList.remove("attacking", "defeated");
    void card.offsetWidth;
    card.classList.add("attacking");
    document.body.append(Object.assign(document.createElement("div"), { className: "attack-flash" }));
    setTimeout(() => document.querySelector(".attack-flash")?.remove(), 1100);
    tone(220, 0.35, 0.05, "sawtooth");
  },
  defeated: (a) => {
    addDiary({ kind: "defended", at: Date.now(), text: `${a.name} defeated in ${(a.ms / 1000).toFixed(1)}s` });
    const card = $("gremlinCard");
    card.classList.remove("attacking");
    card.classList.add("defeated");
  },
  antibody: (ab) => {
    pulse("sAntibodies");
    toast(`Antibody ${ab.seen > 1 ? "strengthened" : "stored"}: ${ab.cause}`);
  },
  "postmortem-filed": ({ id }) => toast(`Postmortem for ${id} filed automatically`),
  reset: () => {
    $("diary").replaceChildren();
    $("logs").replaceChildren();
    bubble.textContent = "Hi. I'm Pixel.";
    bubble.className = "bubble";
    $("heard").textContent = "";
    pixel.classList.remove("shielded", "celebrate", "sneeze", "waving");
    if ($("pmDialog").open) $("pmDialog").close();
  },
});

// initial load
api("/api/state").then((s) => {
  renderState(s);
  s.diary.forEach(addDiary);
  addLogs(s.logs);
});
api("/api/war").then((w) => {
  renderArena(w);
  if (w.on) $("wakeNote").textContent = "The war is already running on its own. Tap to hear Pixel and Gremlin.";
});
api("/api/health").then((h) => {
  $("brainMode").textContent = h.llm ? "Brain: Claude" : "Brain: offline";
  $("watching").textContent = h.mode === "real" ? "Watching: Pixel Mart (live)" : "Watching: simulation";
  $("watching").className = h.mode === "real" ? "chip chip-ok" : "chip chip-quiet";
});
setInterval(() => state?.incident && ($("incident").textContent = `${state.incident.id} · ${elapsed(state.incident.startedAt)}`), 1000);

// ---------- talking to Pixel ----------
async function ask(question) {
  if (!question.trim()) return;
  bubble.textContent = "Hmm, let me feel around…";
  bubble.className = "bubble pop";
  await api("/api/ask", { question });
}

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("askInput").value;
  $("askInput").value = "";
  ask(q);
});

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (!SR) {
    toast("Voice input needs Chrome or Edge. Type your question instead.");
    $("askInput").focus();
    return;
  }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = "en-GB";
  rec.interimResults = true;
  $("mic").classList.add("listening");
  speechSynthesis?.cancel();
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    $("heard").textContent = `You: "${r[0].transcript}"`;
    if (r.isFinal) ask(r[0].transcript);
  };
  rec.onend = () => { $("mic").classList.remove("listening"); rec = null; };
  rec.onerror = (e) => toast(`Mic: ${e.error}`);
  rec.start();
}
$("mic").addEventListener("click", listen);
document.addEventListener("keydown", (e) => {
  if (document.activeElement.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "m") listen();
  if (k === "h") setView($("herdBox").hidden ? "herd" : "one");
  if (k === "r" && e.shiftKey) {
    // Shift+R: instant demo reset from the stage itself.
    api("/api/reset", {}).then(() => toast("Demo reset. Pixel is healthy again."));
  }
});

$("voiceBtn").addEventListener("click", () => {
  voiceOn = !voiceOn;
  $("voiceBtn").textContent = voiceOn ? "Voice on" : "Voice off";
  $("voiceBtn").setAttribute("aria-pressed", String(voiceOn));
  if (!voiceOn) speechSynthesis?.cancel();
});

// ---------- postmortem ----------
function openPm(pm) {
  lastPm = pm;
  $("pmBody").innerHTML = markdown(pm.markdown);
  $("pmSource").textContent = pm.source === "claude" ? "Written by Claude" : "Written by Pixel (offline)";
  if (!$("pmDialog").open) $("pmDialog").showModal();
}
$("pmBtn").addEventListener("click", async () => {
  // In war mode Pixel has already filed one: show the latest. Otherwise write one now.
  const latest = await api("/api/postmortems/latest").catch(() => null);
  if (latest?.id) return openPm(latest);
  $("pmBtn").textContent = "Writing…";
  try { await api("/api/postmortem", {}); } finally { $("pmBtn").textContent = "Postmortem"; }
});
$("pmClose").addEventListener("click", () => $("pmDialog").close());
$("pmCopy").addEventListener("click", () => lastPm && navigator.clipboard?.writeText(lastPm.markdown).then(() => toast("Copied")));
$("pmDownload").addEventListener("click", () => {
  if (!lastPm) return;
  const a = el("a", { href: URL.createObjectURL(new Blob([lastPm.markdown], { type: "text/markdown" })), download: `${lastPm.id || "postmortem"}.md` });
  a.click();
});

// ---------- arena ----------
let lastDefended = -1;
function pulse(id) {
  const t = $(id)?.closest(".tile");
  if (!t) return;
  t.classList.remove("pulse");
  void t.offsetWidth;
  t.classList.add("pulse");
}

function renderArena(w) {
  if (!w?.on) return;
  $("arena").hidden = false;
  $("abBox").hidden = !w.antibodies.length;
  $("sDefended").textContent = `${w.defended}/${w.launched}`;
  if (w.defended !== lastDefended) {
    if (lastDefended >= 0) pulse("sDefended");
    lastDefended = w.defended;
  }
  $("sOrders").textContent = w.ordersPlaced.toLocaleString();
  $("sLost").textContent = w.ordersLost.toLocaleString();
  $("sRecovery").textContent = w.lastRecoveryMs != null ? `${(w.lastRecoveryMs / 1000).toFixed(1)}s` : "–";
  $("sAntibodies").textContent = w.antibodies.length;
  if (!w.gremlin.current && w.gremlin.nextInMs != null) $("gremlinStatus").textContent = w.gremlin.round ? `next attack in ${Math.ceil(w.gremlin.nextInMs / 1000)}s` : "is studying your system…";

  // Learning curve: one bar per defence; green = vaccinated, blue = recognised, purple = first time.
  const h = w.history;
  const max = Math.max(5000, ...h.map((x) => x.ms));
  const bw = 240 / Math.max(8, h.length);
  $("curve").innerHTML = h
    .map((x, i) => {
      const hgt = Math.max(3, (x.ms / max) * 62);
      const c = x.vaccinated ? "#46e2a8" : x.known ? "#7cd4ff" : "#8f52ff";
      return `<rect x="${i * bw + 2}" y="${68 - hgt}" width="${bw - 4}" height="${hgt}" rx="3" fill="${c}"><title>${x.sig}: ${(x.ms / 1000).toFixed(1)}s${x.vaccinated ? " (vaccinated)" : x.known ? " (from memory)" : " (first time)"}</title></rect>`;
    })
    .join("");

  // Only rebuild the antibody cards when they change (otherwise their entrance animation replays every second).
  const abKey = w.antibodies.map((a) => `${a.sig}:${a.seen}:${a.bestMs}`).join("|");
  if (abKey === renderArena.abKey) return;
  renderArena.abKey = abKey;
  $("antibodies").replaceChildren(
    ...w.antibodies
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((a) => el("li", {}, el("b", {}, a.cause.charAt(0).toUpperCase() + a.cause.slice(1)), el("span", {}, `seen ${a.seen}× · best ${(a.bestMs / 1000).toFixed(1)}s · fix: ${a.fix.replace(/_/g, " ")}`))),
  );
}

function replay(cls, ms) {
  pixel.classList.remove(cls);
  void pixel.getBBox();
  pixel.classList.add(cls);
  clearTimeout(replay[cls]);
  replay[cls] = setTimeout(() => pixel.classList.remove(cls), ms);
}

// ---------- camera: eyes follow you, wave to acknowledge ----------
// Motion detection by frame differencing on a tiny 64x48 image. Nothing leaves the browser.
const cam = { stream: null, timer: null, prev: null, xs: [], lastWave: 0, lastSeen: 0, greeted: false };
const camCanvas = document.createElement("canvas");
camCanvas.width = 64;
camCanvas.height = 48;
const camCtx = camCanvas.getContext("2d", { willReadFrequently: true });

async function toggleCamera() {
  if (cam.stream) return stopCamera();
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
  } catch (err) {
    toast(`Camera unavailable: ${err.name}`);
    return;
  }
  $("camVideo").srcObject = cam.stream;
  $("camBox").hidden = false;
  $("camBtn").textContent = "Camera on";
  $("camBtn").setAttribute("aria-pressed", "true");
  cam.timer = setInterval(senseFrame, 100);
}

function stopCamera() {
  cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  clearInterval(cam.timer);
  cam.prev = null;
  $("camBox").hidden = true;
  $("camBtn").textContent = "Camera off";
  $("camBtn").setAttribute("aria-pressed", "false");
  lookAt(0, 0);
  pixel.classList.remove("looking");
}

function lookAt(dx, dy) {
  pixel.querySelectorAll(".pupil").forEach((p) => (p.style.transform = `translate(${dx}px, ${dy}px)`));
}

function senseFrame() {
  const v = $("camVideo");
  if (v.readyState < 2) return;
  camCtx.drawImage(v, 0, 0, 64, 48);
  const { data } = camCtx.getImageData(0, 0, 64, 48);
  const gray = new Uint8Array(64 * 48);
  for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10;
  const prev = cam.prev;
  cam.prev = gray;
  if (!prev) return;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 64; x++) {
      const i = y * 64 + x;
      if (Math.abs(gray[i] - prev[i]) > 28) { n++; sx += x; sy += y; }
    }
  }
  const now = Date.now();
  const moving = n > 40;
  $("camBox").classList.toggle("motion", moving);
  if (!moving) {
    if (now - cam.lastSeen > 3000) { lookAt(0, 0); pixel.classList.remove("looking"); }
    cam.xs = cam.xs.filter((p) => now - p.t < 1500);
    return;
  }
  cam.lastSeen = now;
  // Mirror x so Pixel looks towards you, like a mirror.
  const cx = 1 - sx / n / 63;
  const cy = sy / n / 47;
  pixel.classList.add("looking");
  lookAt((cx - 0.5) * 14, (cy - 0.5) * 10);
  if (!cam.greeted) {
    cam.greeted = true;
    api("/api/greet", { reason: "presence" });
  }
  // Wave = big motion that changes direction left/right at least 3 times in 1.5 s.
  cam.xs.push({ t: now, x: cx, n });
  cam.xs = cam.xs.filter((p) => now - p.t < 1500);
  if (now - cam.lastWave < 5000 || cam.xs.length < 6) return;
  // Walking past is one long sweep; a wave goes back and forth with lots of motion.
  const avgMotion = cam.xs.reduce((a, p) => a + p.n, 0) / cam.xs.length;
  if (avgMotion < 70) return;
  let flips = 0, dir = 0, anchor = cam.xs[0].x;
  for (const p of cam.xs) {
    const d = p.x - anchor;
    if (Math.abs(d) < 0.08) continue;
    const s = Math.sign(d);
    if (dir && s !== dir) flips++;
    dir = s;
    anchor = p.x;
  }
  if (flips >= 3) {
    cam.lastWave = now;
    cam.xs = [];
    onWave();
  }
}

async function onWave() {
  replay("waving", 1900);
  const res = await api("/api/pages/ack", { all: true, via: "camera" });
  if (!res.acknowledged) api("/api/greet", { reason: "wave" });
}

$("camBtn").addEventListener("click", toggleCamera);

// ---------- wake ----------
$("wakeBtn").addEventListener("click", () => {
  audio = new (window.AudioContext || window.webkitAudioContext)();
  $("wake").classList.add("hidden");
  showSay({ text: "Morning! I'm Pixel. Heart's the database, lungs the API. Break something and I'll tell you where it hurts.", kind: "hello" });
});
if (new URLSearchParams(location.search).has("nowake")) $("wake").classList.add("hidden");
