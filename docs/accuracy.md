# Accuracy

Time accuracy is the point of a timer, so this document explains exactly how the
countdown works, how it was measured, and where the remaining limits are.

## The model

```
deadline   = startAt + totalMs        (absolute wall-clock epoch ms)
remaining  = deadline − Date.now()    (recomputed on every render)
```

Nothing counts ticks, so nothing accumulates error. Ticks (100 ms, driven from a
Web Worker, with a `setInterval` fallback) only decide *how often* the display is
refreshed. If the browser throttles a background tab to one tick per second, the
cube redraws once per second — but the numbers it draws are still exact, and a
tab that was frozen for ten minutes wakes up showing the correct remaining time.

Alert events are treated the same way. Every pending event (50 %, 75 %, 90 %,
each time call, each final tick, the finish) has:

1. an **absolute target instant** derived from `startAt` and `totalMs`, and
2. an **armed `setTimeout`** aimed exactly at that instant, re-armed whenever the
   deadline moves.

The 100 ms tick loop also scans for events whose target instant has passed. That
is what makes catch-up work: after a freeze, the first tick fires everything that
was missed, in order, and records how late it was.

## What the diagnostics panel reports

| Field | Meaning |
| --- | --- |
| Clock engine | `Web Worker · 100 ms` when available, otherwise the main-thread fallback |
| Tick interval | Nominal tick period |
| Longest tick gap | Largest gap between consecutive ticks (seconds) |
| Worst alert lateness | Largest `now − target` measured for any alert this session |
| Late alerts (>0.5 s) | Alerts that arrived more than half a second late |
| Throttled gaps (>1.2 s) | How often the browser starved us for over a second |
| System clock jumps | Times the wall clock moved differently from the monotonic clock (NTP adjustment) |

A few throttled gaps are normal and expected while a tab is in the background.
They do not move the deadline; they only delay how quickly an alert becomes
audible.

## The built-in test suite

Open the app with `?test=1`:

```
index.html?test=1                       # local file, 20 s runs, 11 s freeze
index.html?test=1&duration=60&freeze=30 # longer, more demanding
index.html?test=1&autorun=0             # load without starting
```

The suite runs against the live app in the same document and renders a report
panel with the measured values. It covers:

1. **Alert punctuality** — a clean run; each of the four alerts must fire exactly
   once and within 300 ms of its target (it also reports the exact lateness).
2. **Frozen page** — a synchronous 11 s block of the main thread (the same thing
   a throttled background tab or a sleeping laptop does). After the freeze the
   remaining time must still equal `deadline − now`, the finish must still land
   on the true deadline, and any alert that fell inside the freeze must be
   reported as caught-up rather than dropped.
3. **Pause / resume** — the remaining time must be frozen while paused and the
   total wall time must equal run time + paused time.
4. **SET and adjustments** — the steppers must write exact millisecond values,
   floor at zero instead of wrapping, and ± buttons must shift a running deadline
   without restarting the run and without ever pushing it into the past.
5. **Display consistency** — 24 samples verify that the internal deadline never
   skews from the preset.
6. **Preset integrity** — pressing Start must run exactly the block the cube is
   showing, for eight different ways of setting it: the fresh 30:00 default, the
   ±1/±5 minute buttons, preset chips, chips combined with ± buttons, the SET flow
   with seconds (00:45, 12:30) and keyboard nudges. The running deadline span is
   checked against the displayed value, not just the internal state.

Programmatic access (handy for embedding or CI):

```js
await window.__runAccuracyTest();          // resolves when finished
console.log(window.__accuracyTestResults); // { results, summary, diag, … }
```

Every alert is also observable from outside the app:

```js
window.__pomodoroCube.hooks.onEvent = (e) =>
  console.log(e.id, 'target', e.target, 'fired', e.firedAt, 'late', e.late);
```

## Measured results

Headless Chrome 131 on an idle Linux container, `?test=1&duration=20` (the
default), 20/20 checks passed:

| Check | Expected | Measured |
| --- | --- | --- |
| 50 % alert | 10 s mark | fired 10.04 s, **0 ms late** |
| 75 % alert | 15 s mark | fired 15.04 s, **1 ms late** |
| 90 % alert | 18 s mark | fired 18.04 s, **0 ms late** |
| finish | 20 s mark | fired 20.04 s, **0 ms late** |
| deadline integrity | `deadline − startAt = 20000 ms` | **20000 ms** |
| frozen 11 s: remaining time | `deadline − now` | off by **0 ms** |
| frozen 11 s: finish | 20 s after start | **0 ms late** |
| frozen 11 s: covered alert | caught up and reported | caught up 1.40 s late |
| pause 3 s: remaining | unchanged while paused | 5997 ms → 5997 ms |
| pause 3 s: wall time | `8 s + 3 s = 11 s` | **11.00 s** |
| SET steppers | exact ms values, floor at 00:00 | exact |
| ± buttons while running | deadline shifts, run not restarted | exact |
| Start runs the display | 8 preset paths, display === running block | exact (was wrong before 1.0.1) |

Real-world numbers will differ with your hardware and load; run the suite on your
own device to see them.

## Honest limits

* **A throttled tab delays when an alert becomes audible.** Chrome/Safari throttle
  background timers to roughly one per second (more aggressively on mobile). The
  countdown stays exact, but a chime scheduled inside such a window may play up
  to about a second late. The diagnostics panel shows this as lateness.
* **A device that sleeps cannot play sound.** When the machine wakes, the alert
  fires immediately and the lateness is reported.
* **Wall-clock adjustments.** If the system clock is corrected by NTP (or changed
  by hand) during a run, the deadline moves with it; the “system clock jumps”
  counter surfaces this.
* **The screen-off case.** Web apps cannot wake a locked phone. For an alarm that
  must ring with the screen off, use the OS timer/clock app. Screen Wake Lock is
  requested while the timer runs (toggle in *Session*) so an open tab does not
  sleep mid-session on supported browsers.
* **Voices vary.** Spoken alerts use whatever voices your OS provides; pick one
  in *Sound & voice*. Speech is best-effort — the chime and the on-screen card
  carry the same information.
