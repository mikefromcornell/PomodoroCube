# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-09-25

### Fixed

* **Start now runs exactly the block the cube is showing.** Pressing Start used to
  re-derive the length from your saved settings, so a preset you had just set
  could be ignored and replaced by the 30-minute default (or by whatever preset
  was used last). Measured before the fix: `+5 min` then Start ran **30:00**
  instead of 35:00, `SET 00:45` then Start ran **45:00**, and a keyboard nudge to
  12:00 ran **45:00**. Every one of those paths now runs precisely what the
  display shows.
* **The 30-minute default now survives a reload.** *Remember last preset* defaulted
  to on, so after using a 5-minute preset the app reopened at 05:00 rather than
  30:00. It now defaults to off — the cube always opens at 30:00 unless you opt in.
* Selecting a preset chip while a timer was running left the tick worker and the
  scheduled alerts alive after the run was discarded. The run is now stopped
  cleanly first.
* The accuracy suite gained a **preset integrity** scenario (eight Start paths)
  and a *SET then Start* check, so display/preset drift cannot return unnoticed.

[1.0.1]: https://github.com/mikefromcornell/PomodoroCube/releases/tag/v1.0.1

## [1.0.0] — 2026-09-23

First public release.

### Added

* Virtual pomodoro **cube** timer: CSS 3D cube with a printed top face, phase
  label on the side and a dark display on the front. Click the cube to
  start/pause.
* SVG 7-segment countdown display (MM:SS) with ghosted unlit segments.
* 60-tick progress ring that counts down one tick per minute, plus a hairline arc
  for sub-minute precision; the ring turns red in the final 10 %.
* Reminder alerts at **50 %**, **75 %** and **90 %** elapsed, each with its own
  chime, and a spoken announcement of the **time remaining**.
* Optional extra spoken time calls every 2 / 5 / 10 / 15 minutes, a time call when
  you return to the tab, final 10-second ticks, finish fanfare, repeat-until-handled
  and auto-start of the next phase.
* Reminder cards with actions (**Start break**, **+5 min**, dismiss), desktop
  notifications, vibration and a flashing tab title.
* Adjustable preset: **30 minutes by default**, any minutes/seconds from 1 s to
  12 h. Quick presets (5–60), the SET → M/S → SET flow, ±1 min / ±5 min buttons,
  and ±10 s / ±1 min keyboard nudges — all of which shift a *running* timer
  without restarting it.
* Focus / short break / long break phases with their own presets.
* Full keyboard control and live accuracy diagnostics (tick gap, worst alert
  lateness, throttled gaps, system clock jumps).
* Drift-free deadline-based clock, Web Worker ticks, catch-up after a frozen tab,
  pause/resume, session persistence across reloads, and Screen Wake Lock.
* Progressive Web App: manifest, maskable icons, offline service worker.
* Built-in accuracy test suite (`?test=1`) — alert punctuality, frozen-page
  behaviour, pause/resume and SET-flow checks with a visible report.
* Zero-dependency tooling: `tools/serve.mjs` (static server), `tools/check.mjs`
  (consistency checks) and `tools/publish.mjs` (one-command GitHub Pages
  publisher), all runnable with plain Node.
* GitHub Actions workflows for free GitHub Pages deployment and static checks.
* Light and dark themes, responsive layout, reduced-motion support.

[1.0.0]: https://github.com/mikefromcornell/PomodoroCube/releases/tag/v1.0.0
