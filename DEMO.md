# 3-minute demo script

## Setup (before you walk on)
- [ ] `npm test` passes (37 + 9 checks).
- [ ] Backup video recorded (see `docs/backup-video.md`).
- [ ] `node server.js` running (or double-click `start-demo.cmd`).
- [ ] Projector: http://localhost:3000/ full screen (F11). Click **Tap to wake Pixel**, then **Camera off** to turn the camera on (allow it).
- [ ] Laptop: http://localhost:3000/chaos.
- [ ] **Memory trick:** do one rehearsal run (press 1, then 0) *without* resetting, so on stage Pixel says "I've felt this before".
- [ ] Phone: the `/oncall` address the server printed. Tap the screen once so it can buzz.
- [ ] Volume up. Chrome or Edge (needed for mic and camera).
- [ ] Backup video of a full run saved on the desktop.

## The run

| Time | Say | Do |
|---|---|---|
| 0:00 | "On-call engineers ignore dashboards. Nobody ignores a sick pet." | Step in front of the camera; Pixel says hello and its eyes follow you |
| 0:20 | "This is Pixel. It *is* our shop's system. Heart is the database, lungs the API." | Point at the vitals |
| 0:35 | "A bad deploy is slowly leaking database performance." | Press **8**; Pixel sneezes: "Nothing's broken yet." |
| 0:50 | "Now it gets serious. Let's kill the database." | Press **1** |
| 0:55 | (let it play) | Heart flatlines, Pixel collapses, phone buzzes, Pixel remembers the last incident |
| 1:15 | "Pixel, what hurts?" | Press **M** and ask out loud |
| 1:25 | "Here's the whole system as a herd. Watch the outage spread." | Press **H**, then **H** again to go back |
| 1:30 | "I'm on call, so I acknowledge by waving." | Wave at the camera; Pixel waves back, the phone shows acknowledged |
| 1:45 | "Now an attacker hides a message for the AI in our logs." | Press **7**; shield goes up: "Nice try." |
| 2:05 | "Health comes from plain code, so a lying log can't fake it." | Point at the flatline still showing |
| 2:15 | "Let's fix it." | Press **0**; wait for "I LIVE!" |
| 2:30 | "And it writes the postmortem itself, and files it in incident.io." | Click **Postmortem** |
| 2:45 | "Pixel plugs into anything: Datadog, Sentry, Slack, incident.io. Your system finally has a face." | Show the curl on the chaos panel |

## If something goes wrong
- No sound: click the stage once (browsers block audio until a click).
- Mic not working: type the question in the box instead.
- Wave not detected: tap **Acknowledge** on the phone. Wave big, side to side, about 2-3 times.
- Things look messy: press **Shift+R** on the stage (or **R** on the chaos panel) to reset instantly.
- Total failure: play the backup video and keep talking.
