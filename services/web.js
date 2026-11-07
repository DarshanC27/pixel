// web: the Pixel Mart storefront. Serves a real shop page and the checkout API the page calls.
// A "buggy deploy" makes checkout really throw, like a bad front-end release.

import { serve, createWindow, call, log, url, PORTS } from "./lib.js";

const NAME = "web";
const window = createWindow();
const chaos = { buggy: false };
let token = null;
const business = { checkouts: 0, failed: 0 }; // cumulative: real customer orders won and lost

async function getToken() {
  if (token) return token;
  const { data } = await call(url("auth", "/token"), { method: "POST", body: { userId: "shopper" }, timeoutMs: 2000 });
  token = data.token;
  return token;
}

const SHOP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixel Mart</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f7fb;color:#1b1d2e}
header{background:#1b1d2e;color:#fff;padding:16px 24px;font-weight:800;font-size:22px}
main{max-width:860px;margin:0 auto;padding:24px 16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
.card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 4px 16px rgba(0,0,0,.06)}.card b{display:block;font-size:18px}
button{margin-top:10px;background:#4fd1a5;border:0;border-radius:99px;padding:10px 16px;font-weight:700;cursor:pointer}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #ccd;margin:8px 0 16px}
#msg{margin-top:16px;font-weight:600}</style></head><body><header>Pixel Mart</header><main>
<label>Gift message (optional)<input id="gift" placeholder="Happy birthday!"></label>
<div class="grid">${["Mechanical keyboard", "Coffee beans", "Desk plant", "Noise-cancelling headphones"]
  .map((i) => `<div class="card"><b>${i}</b><button data-item="${i}">Buy</button></div>`)
  .join("")}</div><p id="msg"></p></main><script>
document.querySelectorAll("button[data-item]").forEach(b=>b.onclick=async()=>{
  const r=await fetch("/api/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({item:b.dataset.item,giftMessage:document.getElementById("gift").value})});
  const d=await r.json();document.getElementById("msg").textContent=r.ok?"Order #"+d.orderId+" placed. Thank you!":"Checkout failed: "+(d.error||r.status);
});</script></body></html>`;

serve({
  name: NAME,
  port: PORTS.web,
  window,
  html: { "/": SHOP },
  untimed: ["GET /health", "GET /metrics", "POST /admin/chaos"],
  routes: {
    "GET /health": () => ({ ok: true }),
    "GET /metrics": () => ({ ...window.stats(), chaos, ...business }),

    "POST /api/checkout": async (b) => {
      business.checkouts++;
      try {
        return await checkout(b);
      } catch (err) {
        business.failed++;
        throw err;
      }
    },

    "POST /admin/chaos": (b) => {
      if (b.buggy !== undefined) chaos.buggy = !!b.buggy;
      if (b.heal) chaos.buggy = false;
      log(NAME, "INFO", chaos.buggy ? "deploy web@9.1.3 complete" : "rolled back web to 9.1.2");
      return chaos;
    },
  },
});

async function checkout(b) {
  if (chaos.buggy && Math.random() < 0.35) {
    log(NAME, "ERROR", "TypeError: cart.items is undefined (checkout.js:212)");
    throw new Error("Internal error");
  }
  let t;
  try {
    t = await getToken();
  } catch (err) {
    log(NAME, "ERROR", `login failed: ${err.message}`);
    throw Object.assign(new Error("login unavailable"), { status: 503 });
  }
  try {
    const { status, data } = await call(url("orders", "/orders"), { method: "POST", body: { token: t, item: b.item, giftMessage: b.giftMessage }, timeoutMs: 6000 });
    if (status === 401) {
      token = null; // try a fresh login next time
      log(NAME, "WARN", "checkout rejected: not logged in (401 from orders-api)");
      throw Object.assign(new Error("Please log in again"), { status: 502 });
    }
    return data;
  } catch (err) {
    if (err.status === 502) throw err;
    log(NAME, "ERROR", `checkout failed: ${err.message}`);
    throw Object.assign(new Error("Checkout is unavailable right now"), { status: 502 });
  }
}
