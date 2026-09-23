# Architecture

Three runtime files, no build step, no dependencies, no network requests.

```
index.html      markup + the SVG display definition
src/styles.css  design tokens, cube faces, screen, themes
src/app.js      everything else: state, clock, alerts, audio, speech, UI
```

## src/app.js at a glance

| Section | Responsibility |
| --- | --- |
| helpers / storage | DOM helpers, a `localStorage` wrapper that degrades to memory in sandboxed frames |
| settings | defaults, load/save, the `DEFAULT_SETTINGS` object is the single source of truth |
| app state | phase, status, `totalMs`, `startAt`, `deadline`, fired-event set, SET draft |
| time helpers | `clock()` (MM:SS), `human()` (spoken durations) |
| audio fx | Web Audio chimes, one small synth per alert |
| speech | voice list, picking, `speak()` with cancel-and-queue handling |
| ticker | Web Worker ticks at 100 ms, `setInterval` fallback |
| 7-segment display | builds the digit polygons, `setDigits()` toggles segments |
| events / alert marks | derives every pending event with an absolute target instant |
| precise scheduling | arms short-lived `setTimeout`s at the exact target instants |
| the main tick | drift diagnostics, catch-up, render throttling |
| lifecycle | start / pause / resume / reset / setPhase / adjust / finish |
| SET | the SET → M / S → SET draft editor |
| rendering | cube faces, ring, digits, chips, buttons, diagnostics |
| notifying | toasts, desktop notifications, vibration, title flashing |
| wake lock | screen wake lock while running |
| persistence | session snapshot + restore (including “finished while away”) |
| wiring | settings controls, keyboard, visibility handling, service worker |

## The clock

```
startTimer(ms):
  startAt  = Date.now()
  deadline = startAt + ms
  status   = 'running'
  → ticker.start(), arm events, wake lock, persist
```

* `render()` always computes `remaining = deadline − Date.now()`.
* `events()` returns every pending event with `target = startAt + totalMs * p`
  (marks), `startAt + n * step` (time calls) or `deadline − n * 1000` (final ticks).
* `schedulePrecise()` re-arms `setTimeout`s only when the pending set changes and
  only for events within 45 s, so timers stay short and accurate.
* `checkEvents()` fires everything that is due, in order, on every tick — this is
  the catch-up path after a freeze.
* `pauseTimer()` stores `pausedRemaining` and stops the ticker;
  `resumeTimer()` rebuilds `startAt`/`deadline` so the fired-event bookkeeping
  stays valid.

Only one alert can fire per tick: if a freeze covered several marks, the most
recent one wins (the finish takes precedence), and the lateness of the others is
recorded in the diagnostics.

## Observability

```js
window.__pomodoroCube = {
  state, settings, diag, hooks,
  tick, render, startTimer, pauseTimer, resumeTimer, resetTimer, setPhase, adjust,
  openSet, nudgeDraft, confirmSet, cancelSet,
  clock, human, events, checkEvents, setDigits
};
```

`hooks.onEvent` and `hooks.onFinish` receive `{ id, kind, target, firedAt, late }`
so embedding pages — and `tests/accuracy.test.js` — can observe the real firing
instants. The whole accuracy suite is built on these hooks, nothing else.

## Rendering

* The cube is CSS 3D (`transform-style: preserve-3d`), three faces plus a soft
  contact shadow; faces carry the print and the display.
* The display is one inline SVG: a 60-tick ring (`<line>` elements rotated 6°
  apart), a hairline `pathLength="100"` arc, and four 7-segment digits built from
  seven `<polygon>`s each.
* Updates are diffed: digits only repaint when the MM:SS string changes, ticks
  only when the lit count changes, and the ring arc is a single attribute write.
  The timer renders at ~11 fps while running and does no work at all when idle.
* Theming is CSS custom properties with a `data-theme` attribute; `auto` follows
  `prefers-color-scheme`.

## Offline

`sw.js` caches the app shell with a *stale-while-revalidate* strategy: the cached
copy is served instantly (so it works offline) and refreshed in the background.
It only ever handles same-origin GET requests — third-party requests are passed
straight through, of which there are none anyway.
