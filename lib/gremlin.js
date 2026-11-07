// Gremlin: an autonomous adversary that attacks the real Pixel Mart stack.
// It waits until the system is healthy, then picks the attack Pixel is weakest against:
// attacks Pixel has never seen, or the ones Pixel took longest to recover from.
// Gremlin learns too, so attacker and defender co-evolve.

export const ATTACKS = {
  assassin: { name: "Assassin", steps: ["kill_db"], line: "Snip. Your database is gone." },
  slow_poison: { name: "Slow Poison", steps: ["leak_db"], line: "Just a tiny query-builder upgrade. Nobody will notice… yet." },
  molasses: { name: "Molasses", steps: ["slow_db"], line: "Every query now wades through molasses." },
  fog: { name: "Fog", steps: ["slow_network"], line: "Fog rolling into eu-west-2b. Breathe, little Pixel." },
  identity_theft: { name: "Identity Theft", steps: ["break_auth"], line: "I rotated your keys. Who are you again?" },
  spam_cannon: { name: "Spam Cannon", steps: ["flood_queue"], line: "Three thousand marketing emails. Bon appétit." },
  bad_deploy: { name: "Friday Deploy", steps: ["frontend_errors"], line: "Shipped straight to prod on a Friday. You're welcome." },
  blind_and_strike: { name: "Blind & Strike", steps: ["poison_logs", "kill_db"], combo: true, line: "First I whisper lies into your logs. Then I strike." },
  double_trouble: { name: "Double Trouble", steps: ["break_auth", "frontend_errors"], combo: true, line: "Two at once. Pick one, Pixel." },
};

const TAUNTS_WIN = ["Hmph. Lucky.", "You won't be so fast next time.", "Fine. I'm just warming up.", "Noted. Adapting."];

export function createGremlin({ stack, getState, say, onLaunch, onDefeated }) {
  const cooldownMs = Number(process.env.GREMLIN_COOLDOWN_MS || 18000);
  const sequence = (process.env.PIXEL_GREMLIN_SEQUENCE || "").split(",").map((s) => s.trim()).filter((s) => ATTACKS[s]);
  const stats = Object.fromEntries(Object.keys(ATTACKS).map((k) => [k, { uses: 0, lastRecoveryMs: null }]));
  let enabled = true;
  let current = null; // { id, attack, startedAt }
  let nextAt = Date.now() + Number(process.env.GREMLIN_FIRST_DELAY_MS || 8000);
  let calmSince = Date.now();
  let round = 0;

  function allClear() {
    const s = getState();
    const f = stack.faults;
    return !s.incident && s.mood === "happy" && !f.db && !f.network && !f.auth && !f.queue && !f.frontend;
  }

  function choose() {
    if (sequence.length) return sequence[round % sequence.length];
    const singles = Object.keys(ATTACKS).filter((k) => !ATTACKS[k].combo);
    const triedAllSingles = singles.every((k) => stats[k].uses > 0);
    const pool = Object.keys(ATTACKS).filter((k) => triedAllSingles || !ATTACKS[k].combo);
    // Prefer what Pixel has never faced, then what took Pixel longest to fix.
    const score = (k) =>
      (stats[k].uses === 0 ? 2 : 0) + (stats[k].lastRecoveryMs ? Math.min(2, stats[k].lastRecoveryMs / 30000) : 0) + Math.random() * 0.6 - stats[k].uses * 0.15;
    return pool.sort((a, b) => score(b) - score(a))[0];
  }

  async function launch(id) {
    const a = ATTACKS[id];
    round++;
    stats[id].uses++;
    current = { id, name: a.name, round, startedAt: Date.now() };
    say(a.line, current);
    onLaunch?.(current);
    for (const [i, step] of a.steps.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 2500));
      stack.chaos(step);
    }
  }

  function tick() {
    if (!enabled) return;
    const clear = allClear();
    if (current) {
      // Defeated once everything is healthy again and every fault is gone.
      if (clear && Date.now() - current.startedAt > 4000) {
        const ms = Date.now() - current.startedAt;
        stats[current.id].lastRecoveryMs = ms;
        const done = current;
        current = null;
        calmSince = Date.now();
        nextAt = Date.now() + cooldownMs * (0.75 + Math.random() * 0.5);
        say(TAUNTS_WIN[Math.floor(Math.random() * TAUNTS_WIN.length)], null);
        onDefeated?.(done, ms);
      }
      return;
    }
    if (!clear) {
      calmSince = Date.now();
      return;
    }
    if (Date.now() >= nextAt && Date.now() - calmSince > 3000) launch(choose());
  }

  const timer = setInterval(tick, 1000);
  return {
    stats: () => ({ enabled, round, current, attacks: stats, nextInMs: current ? null : Math.max(0, nextAt - Date.now()) }),
    setEnabled(v) {
      enabled = !!v;
    },
    stop: () => clearInterval(timer),
  };
}
