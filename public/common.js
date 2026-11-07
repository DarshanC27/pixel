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
