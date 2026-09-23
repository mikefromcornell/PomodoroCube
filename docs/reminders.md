# Reminder alerts

Every alert fires at an **exact elapsed fraction** of the run (not at a fixed
minute), so it works for any preset — 5 minutes or 3 hours.

| Moment | Default | Chime | Spoken line | Card |
| --- | --- | --- | --- | --- |
| 50 % elapsed | on | E5 → A5, soft | “Halfway there. Fifteen minutes remaining in your focus.” | yes |
| 75 % elapsed | on | E5 → G5 → C6, rising | “Seventy-five percent done. Seven minutes, thirty seconds remaining.” | yes |
| 90 % elapsed | on | two bright pings | “Ten percent left. Three minutes remaining.” | yes |
| every N minutes | 5 min | short ping | “Twenty minutes remaining.” | yes |
| back to the tab | on | — | “Fifteen minutes remaining.” (only if you were away > 90 s) | — |
| last 10 seconds | on | one tick per second | — | — |
| finish | on | four-note fanfare + voice | “Time's up. Your 30 minute focus session is complete.” | sticky, with actions |

Spoken alerts always include the **time remaining** — the phrase “15 minutes 30
seconds remaining” is generated from the exact remaining milliseconds at the
moment the alert fires, then rounded to the nearest second.

## Controls (Reminder alerts panel)

| Setting | Effect |
| --- | --- |
| 50 / 75 / 90 % elapsed | Turn any of the three milestone alerts off |
| Spoken time remaining | Master switch for voice; chimes and cards still work |
| Extra time calls | Speak the remaining time every 2, 5, 10 or 15 minutes (off by default = every 5) |
| Time call when you come back | Speaks the remaining time when the tab regains focus (throttled to one per 90 s) |
| Final 10-second ticks | Audible per-second ticks at the end |
| Finish time's-up | Master switch for the finish fanfare + voice |
| Keep repeating until handled | Re-chimes softly every 5 s (up to ~1 min) until you interact |
| Auto-start next phase | Begins the break/focus automatically 1.5 s after the finish |
| Reminder cards | On-screen cards with a quick action |
| Vibration | Phone vibration, per-alert patterns |

## Sound and voice

* Chimes are generated with the Web Audio API — no audio files, no downloads.
  Volume and tone are set in **Sound & voice**.
* Browsers block audio until the user interacts with the page. Pressing **Start**
  (or **Test the four alerts**) unlocks the audio context; the app also primes it
  on the first click or keypress anywhere on the page.
* Spoken alerts use the Web Speech API with a voice you pick. If a voice cannot
  read your language, the picker falls back to the system default.
* Desktop notifications (the 🔔 button in the header) require permission and a
  secure context (`https://` or `localhost`). They are optional; cards and voice
  work without them.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No sound at all | The audio context is still locked — click **Start** or **Test the four alerts** once. Check the tab is not muted, and raise the volume slider. |
| Voice speaks but no chime | `Finish time's-up` or the individual alert toggles are off, or the volume slider is at 0. |
| Chime plays about a second late | The tab was in the background and throttled; this is a browser limit. See [accuracy.md](accuracy.md#honest-limits). |
| No voice, only chimes | The browser has no Speech Synthesis support, or the voice was removed at the OS level. Pick a different voice in **Sound & voice**. |
| Nothing happens when the timer ends | Some browsers suspend timers on battery-saver for *background* tabs. Keep the tab visible, or enable desktop notifications so the OS can surface the alert. |
| Vibration does nothing | Only supported on mobile browsers (and only after a user gesture on some), and the phone must not be in silent mode. |
