// The herd: one mini-Pixel per service, connected by their dependencies.
// When a service is sick, "infection" flows along the lines to the services that depend on it.

const NS = "http://www.w3.org/2000/svg";
// Dependencies sit below the services that need them, so infection always flows upward.
const POS = {
  skin: { x: 540, y: 80 }, // web
  stomach: { x: 130, y: 280 }, // worker
  lungs: { x: 400, y: 280 }, // orders-api
  brain: { x: 670, y: 280 }, // auth
  heart: { x: 400, y: 480 }, // pg-primary
};
const COLORS = {
  ok: { body: "#4fd1a5", dark: "#2f9c7a", light: "#9ff0d1", line: "#46e2a8" },
  uneasy: { body: "#9fd36b", dark: "#6e9c3f", light: "#d4f0a6", line: "#ffc857" },
  sick: { body: "#b5c47a", dark: "#7f8a4c", light: "#dfe6b5", line: "#ff8a4c" },
  critical: { body: "#c9b38f", dark: "#8f7b5b", light: "#ecdcc0", line: "#ff4d6d" },
  dead: { body: "#8a8fa8", dark: "#5d6178", light: "#b9bdd0", line: "#ff4d6d" },
};
const ICON = {
  heart: '<path d="M0 10C-11 2-12-8-6-9c3-.4 5 1.5 6 3 1-1.5 3-3.4 6-3 6 1 5 11-6 19z" fill="#ff4d6d"/>',
  lungs: '<ellipse cx="-6" cy="2" rx="5.5" ry="8" fill="#ff9fb6"/><ellipse cx="6" cy="2" rx="5.5" ry="8" fill="#ff9fb6"/>',
  brain: '<path d="M-8 1c-3-3 0-8 4-6 1.5-3 6.5-3 7.5 0 4-1 6 3 3 6 1 3-3 5-5 3.5-2 2-5.5 2-6.5 0C-9 6-11 3-8 1z" fill="#ffb3c7"/>',
  stomach: '<ellipse cx="0" cy="2" rx="11" ry="6.5" fill="#ffb27d"/>',
  skin: '<circle cx="-6" cy="-2" r="2.6" fill="#ff6f9a"/><circle cx="5" cy="-4" r="2.2" fill="#ff6f9a"/><circle cx="1" cy="4" r="2.8" fill="#ff6f9a"/><circle cx="8" cy="6" r="2.2" fill="#ff6f9a"/>',
};
const RANK = { ok: 0, uneasy: 1, sick: 2, critical: 3, dead: 4 };

function svg(tag, attrs = {}, html) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html) n.innerHTML = html;
  return n;
}

function edgePath(from, to) {
  // From the dependency (bottom) up to the dependent, with a gentle curve.
  const a = POS[from];
  const b = POS[to];
  const y0 = a.y - 72; // just above the dependency's antenna
  const y1 = b.y + 116; // just below the dependent's label
  const my = (y0 + y1) / 2;
  return `M${a.x} ${y0} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${y1}`;
}

function face(status) {
  if (status === "ok") return '<path d="M-17 -6 q7 -9 14 0 M3 -6 q7 -9 14 0" fill="none" stroke="#1b1d2e" stroke-width="3.5" stroke-linecap="round"/><path d="M-8 6 q8 8 16 0" fill="none" stroke="#1b1d2e" stroke-width="3.5" stroke-linecap="round"/>';
  if (status === "dead") return '<path d="M-17 -12 l10 10 m0 -10 l-10 10 M7 -12 l10 10 m0 -10 l-10 10" stroke="#1b1d2e" stroke-width="3.5" stroke-linecap="round"/><ellipse cx="0" cy="9" rx="5" ry="6" fill="#1b1d2e"/>';
  const mouth = status === "uneasy" ? '<path d="M-8 9 q8 -2 16 0" fill="none" stroke="#1b1d2e" stroke-width="3.5" stroke-linecap="round"/>' : status === "sick" ? '<path d="M-8 11 q8 -9 16 0" fill="none" stroke="#1b1d2e" stroke-width="3.5" stroke-linecap="round"/>' : '<ellipse cx="0" cy="9" rx="5" ry="6" fill="#1b1d2e"/>';
  return `<ellipse cx="-11" cy="-6" rx="7" ry="8" fill="#fff"/><circle cx="-10" cy="-5" r="4" fill="#1b1d2e"/><ellipse cx="11" cy="-6" rx="7" ry="8" fill="#fff"/><circle cx="12" cy="-5" r="4" fill="#1b1d2e"/>${mouth}`;
}

export function createHerd(container) {
  const root = svg("svg", { viewBox: "0 0 800 600", class: "herd", role: "img", "aria-label": "The herd: one creature per service, linked by dependencies" });
  const edges = svg("g", { class: "herd-edges" });
  const nodes = svg("g", { class: "herd-nodes" });
  root.append(edges, nodes);
  container.append(root);

  const edgeEls = {};
  const nodeEls = {};
  let built = false;

  function build(organs) {
    for (const o of organs) {
      for (const dep of o.dependsOn || []) {
        const d = edgePath(dep, o.id);
        const base = svg("path", { d, class: "herd-edge" });
        const flow = svg("path", { d, class: "herd-flow" });
        edges.append(base, flow);
        edgeEls[`${dep}->${o.id}`] = { base, flow, dep, to: o.id };
      }
    }
    for (const o of organs) {
      const p = POS[o.id];
      const g = svg("g", { class: "herd-node", transform: `translate(${p.x} ${p.y})` });
      const bob = svg("g", { class: "herd-bob" });
      bob.style.animationDelay = `${Math.random() * -2}s`;
      bob.innerHTML = `
        <ellipse class="hn-shadow" cx="0" cy="58" rx="40" ry="6"/>
        <line x1="0" y1="-48" x2="4" y2="-62" class="hn-antenna"/><circle cx="5" cy="-65" r="5" class="hn-bulb"/>
        <path class="hn-body" d="M0 -50 C 36 -50 48 -22 48 6 C 48 36 28 52 0 52 C -28 52 -48 36 -48 6 C -48 -22 -36 -50 0 -50 Z"/>
        <ellipse cx="-16" cy="-28" rx="16" ry="9" fill="#fff" opacity=".22" transform="rotate(-24 -16 -28)"/>
        <g class="hn-face" transform="translate(0 -8)"></g>
        <g class="hn-belly" transform="translate(0 30) scale(.9)"><rect x="-18" y="-13" width="36" height="28" rx="12" fill="rgba(255,255,255,.22)" stroke="rgba(255,255,255,.5)" stroke-width="1.5"/>${ICON[o.id]}</g>`;
      const name = svg("text", { class: "hn-name", y: 84, "text-anchor": "middle" });
      name.textContent = o.service;
      const val = svg("text", { class: "hn-val", y: 103, "text-anchor": "middle" });
      g.append(bob, name, val);
      nodes.append(g);
      nodeEls[o.id] = { g, bob, val, face: bob.querySelector(".hn-face"), lastStatus: null };
    }
    built = true;
  }

  function update(organs, fmt) {
    if (!built) build(organs);
    const byId = Object.fromEntries(organs.map((o) => [o.id, o]));
    for (const o of organs) {
      const n = nodeEls[o.id];
      const c = COLORS[o.status];
      n.g.setAttribute("class", `herd-node hs-${o.status}`);
      n.bob.querySelector(".hn-body").setAttribute("fill", c.body);
      n.bob.querySelector(".hn-body").setAttribute("stroke", c.dark);
      n.bob.querySelector(".hn-antenna").setAttribute("stroke", c.dark);
      n.bob.querySelector(".hn-bulb").setAttribute("fill", c.line);
      if (n.lastStatus !== o.status) {
        n.face.innerHTML = face(o.status);
        n.lastStatus = o.status;
      }
      n.val.textContent = o.status === "dead" ? "not responding" : fmt(o);
    }
    for (const e of Object.values(edgeEls)) {
      const src = byId[e.dep];
      const infected = RANK[src.status] >= RANK.uneasy;
      e.flow.setAttribute("class", `herd-flow${infected ? ` infected hs-${src.status}` : ""}`);
      e.flow.setAttribute("stroke", COLORS[src.status].line);
      e.base.setAttribute("class", `herd-edge${infected ? " infected" : ""}`);
    }
  }

  return { update, el: root };
}
