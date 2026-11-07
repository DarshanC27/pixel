# 3-minute demo script: hands off

The point of the demo: **nobody touches anything.** Pixel and Gremlin fight on a real system while you talk.

## Setup (before you walk on)
- [ ] `npm test` passes (smoke, brain, real and war suites).
- [ ] Double-click `start-demo.cmd` (or `node server.js`) **at least 5 minutes before**, so Pixel has already earned a few antibodies and the learning curve has bars on it.
- [ ] Projector: http://localhost:3000/ full screen (F11). Click **Tap to wake Pixel** to hear both voices.
- [ ] Second screen: the real shop at http://127.0.0.1:4105/ and the chaos panel at /chaos (it lists the real processes and PIDs).
- [ ] Phone on `/oncall` (address printed by the server). Tap it once so it can buzz.
- [ ] Backup video recorded (see `docs/backup-video.md`).

## The run

| Time | Say | What's happening on screen |
|---|---|---|
| 0:00 | "On-call engineers ignore dashboards. Nobody ignores a sick pet. This is Pixel, and it *is* our shop: heart is the database, lungs the API." | Pixel bouncing; real orders ticking up on the scoreboard |
| 0:25 | "That purple thing is Gremlin, an AI whose only job is to break our real system. Neither of us is touching anything." | Gremlin card counting down to its next attack |
| 0:40 | (let it play) | Gremlin strikes. The process really dies, Pixel collapses, the phone buzzes |
| 0:55 | "Pixel isn't told what happened. It reads the evidence, diagnoses the root cause, and runs the real fix." | "Investigating… Diagnosis… I'll restart the database." Pixel recovers |
| 1:20 | "Every attack it survives becomes an antibody. Look at the learning curve: the same attack, half the time." | Point at the bars shrinking, and the antibody cards |
| 1:40 | "It even vaccinates. A slow leak it has seen before gets rolled back before customers notice." | Green bars = vaccinated |
| 2:00 | "Gremlin can hide instructions for the AI in the logs. Health comes from plain code, so Pixel just says 'Nice try.'" | If a Blind & Strike round happens, the shield goes up |
| 2:20 | "After every incident it writes and files its own postmortem." | Click **Postmortem** (the only click in the demo) |
| 2:40 | "Detect, diagnose, fix, learn, document. Incidents that resolve themselves, on a real system. That's Pixel." | Scoreboard: attacks defended, orders saved |

## If something goes wrong
- No sound: click the stage once (browsers block audio until a click).
- Want a specific attack right now: the chaos panel still works (keys 1–8).
- Things look messy: **Shift+R** on the stage resets the shop to healthy (antibodies are kept).
- Total failure: play the backup video and keep talking.
