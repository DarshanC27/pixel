// auth: issues signed session tokens and verifies them against the session table in the database.
// Verification results are cached for a few seconds, so a database outage hits auth one hop later.

import crypto from "node:crypto";
import { serve, createWindow, call, log, url, PORTS } from "./lib.js";

const NAME = "auth";
const window = createWindow();
// A healthy auth signs and verifies with the same key. The "bad deploy" fault rotates only
// the verification key (a classic config mismatch), so every token, even a fresh one, fails.
const goodKey = crypto.randomBytes(32);
let signKey = goodKey;
let verifyKey = goodKey;
let keyId = "prod-2026-11";
const cache = new Map(); // token -> { userId, until }
const CACHE_MS = 4000;

const sign = (payload, k) => crypto.createHmac("sha256", k).update(payload).digest("base64url");

serve({
  name: NAME,
  port: PORTS.auth,
  window,
  okBelow: 400, // a rejected login is a failure from the user's point of view
  untimed: ["GET /health", "GET /metrics", "POST /token", "POST /admin/chaos"],
  routes: {
    "GET /health": () => ({ ok: true }),
    "GET /metrics": () => ({ ...window.stats(), key_id: keyId }),

    "POST /token": async (b) => {
      const userId = String(b.userId || "guest");
      const payload = `${userId}.${Date.now()}`;
      const token = `${payload}.${sign(payload, signKey)}`;
      await call(url("db", "/sessions"), { method: "POST", body: { token, userId }, retries: 2 });
      return { token };
    },

    "POST /verify": async (b) => {
      const token = String(b.token || "");
      const parts = token.split(".");
      const payload = parts.slice(0, 2).join(".");
      if (parts.length !== 3 || sign(payload, verifyKey) !== parts[2]) {
        log(NAME, "ERROR", `token signing key not found (kid=${keyId})`);
        return [401, { valid: false, error: "bad signature" }];
      }
      const hit = cache.get(token);
      if (hit && hit.until > Date.now()) return { valid: true, userId: hit.userId };
      try {
        const { data } = await call(url("db", "/sessions/check"), { method: "POST", body: { token }, timeoutMs: 700, retries: 2, backoffMs: 300 });
        if (!data.valid) return [401, { valid: false, error: "session revoked" }];
        cache.set(token, { userId: data.userId, until: Date.now() + CACHE_MS });
        return { valid: true, userId: data.userId };
      } catch (err) {
        log(NAME, "ERROR", `session store unreachable: ${err.message}`);
        throw Object.assign(new Error("session store unreachable"), { status: 503 });
      }
    },

    "POST /admin/chaos": (b) => {
      if (b.rotateKey) {
        verifyKey = crypto.randomBytes(32);
        keyId = `prod-2026-11-r${Math.floor(Math.random() * 900 + 100)}`;
        cache.clear();
        log(NAME, "WARN", `deploy auth@4.2.0 rotated the verification key (kid=${keyId}) but not the signing key`);
      }
      if (b.heal && verifyKey !== goodKey) {
        verifyKey = goodKey;
        signKey = goodKey;
        keyId = "prod-2026-11";
        cache.clear();
        log(NAME, "INFO", "rolled back auth@4.2.0, keys match again");
      }
      return { keyId };
    },
  },
});
