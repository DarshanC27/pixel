// Shared helpers for every Pixel screen.

export function connect(handlers) {
  let es;
  const open = () => {
    es = new EventSource("/events");
    for (const [type, fn] of Object.entries(handlers)) {
      es.addEventListener(type, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (err) {
          console.error(type, err);
        }
      });
    }
    es.onerror = () => {
      handlers.offline?.();
    };
    es.onopen = () => handlers.online?.();
  };
  open();
  return () => es.close();
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

// Tiny organ icons for lists (same shapes as on Pixel's body).
const ICON_PATHS = {
  heart: '<path d="M12 20C5 15 4 9 8 8.5c2-.2 3.4 1 4 2 .6-1 2-2.2 4-2 4 .5 3 6.5-4 11.5z"/>',
  lungs: '<ellipse cx="8" cy="13" rx="4.2" ry="6"/><ellipse cx="16" cy="13" rx="4.2" ry="6"/>',
  brain: '<path d="M7 13c-2-2 0-5 2.5-4 1-2 4.5-2 5 0 2.5-.6 4 2 2 4 .8 2-2 3.5-3.5 2.5-1.3 1.3-3.7 1.3-4.4 0C6 18 5 15 7 13z"/>',
  stomach: '<ellipse cx="12" cy="13" rx="8" ry="5"/>',
  skin: '<circle cx="7" cy="9" r="2.2"/><circle cx="15" cy="7" r="1.8"/><circle cx="12" cy="14" r="2.4"/><circle cx="17" cy="16" r="2"/><circle cx="7" cy="17" r="1.7"/>',
};
export function organIcon(id) {
  const span = document.createElement("span");
  span.className = `organ-icon oi-${id}`;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${ICON_PATHS[id] || ""}</svg>`;
  return span;
}
export const STATUS_WORD = { ok: "Healthy", uneasy: "Uneasy", sick: "Sick", critical: "Critical", dead: "Stopped" };

const ORGAN_NAMES = { heart: "Heart", lungs: "Lungs", brain: "Brain", stomach: "Stomach", skin: "Skin" };
const SYSTEM_NAMES = { heart: "database", lungs: "API", brain: "auth", stomach: "queue", skin: "front end" };

export function fmt(o) {
  if (o.value === null || o.value === undefined) return "no reading";
  if (o.unit === "ms") return o.value >= 1000 ? `${(o.value / 1000).toFixed(1)}s` : `${Math.round(o.value)}ms`;
  if (o.unit === "%") return `${Number(o.value).toFixed(1)}%`;
  return `${Math.round(o.value)} ${o.unit}`;
}

export function diaryText(d) {
  if (d.kind === "organ") {
    const word = { ok: "feels better", uneasy: "feels off", sick: "is sick", critical: "is critical", dead: "STOPPED" }[d.to] || d.to;
    return `${ORGAN_NAMES[d.organ]} (${SYSTEM_NAMES[d.organ]}) ${word}`;
  }
  if (d.kind === "injection") return `Blocked a prompt injection in ${d.svc || "the"} logs`;
  if (d.kind === "recovered") return `Fully recovered. ${d.incident || ""} closed`;
  if (d.kind === "warning") return `Achoo: ${SYSTEM_NAMES[d.organ]} creeping up`;
  if (d.kind === "memory") return `Remembered this from ${d.past}`;
  return d.kind;
}

// Tiny, safe Markdown renderer (escapes everything first).
export function markdown(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const lines = md.split(/\r?\n/);
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      html += "<table>" + body.map((r, ri) => "<tr>" + cells(r).map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("") + "</tr>").join("") + "</table>";
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
        const item = lines[i++].replace(/^\s*[-*] /, "");
        const box = item.match(/^\[( |x)\] (.*)$/i);
        html += box ? `<li class="task"><input type="checkbox" ${box[1].toLowerCase() === "x" ? "checked" : ""}> ${inline(box[2])}</li>` : `<li>${inline(item)}</li>`;
      }
      html += "</ul>";
      continue;
    }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
    i++;
  }
  return html;
}
