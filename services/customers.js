// customers: real shoppers hitting the real storefront, a few times a second.
// This is the traffic that makes the metrics real.

import { call, sleep, url } from "./lib.js";

const ITEMS = ["Mechanical keyboard", "Coffee beans", "Desk plant", "Noise-cancelling headphones"];
const GIFTS = ["", "", "", "Happy birthday!", "Thanks for everything", "Enjoy :)"];
const RATE = Number(process.env.CUSTOMERS_PER_S || 6);

async function shopper() {
  for (;;) {
    const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
    const giftMessage = GIFTS[Math.floor(Math.random() * GIFTS.length)];
    await call(url("web", "/api/checkout"), { method: "POST", body: { item, giftMessage }, timeoutMs: 8000 }).catch(() => {});
    await sleep((1000 / RATE) * 3 * (0.5 + Math.random()));
  }
}

// A few concurrent shoppers so one slow request doesn't stop all traffic.
for (let i = 0; i < 3; i++) shopper();
process.on("SIGTERM", () => process.exit(0));
