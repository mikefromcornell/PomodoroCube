# Contributing

Thanks for wanting to help. Issues and pull requests are welcome.

## The two rules

1. **Zero dependencies.** No frameworks, no libraries, no CDN links, no `npm
   install`. The project must keep working when `node_modules`, the network and
   the build system do not exist.
2. **No build step.** `index.html` must stay openable straight from the file
   system. Source files are what ships.

Everything else is open for discussion.

## Getting started

```bash
git clone https://github.com/mikefromcornell/PomodoroCube.git
cd PomodoroCube
npm start                 # http://localhost:8080  (standard library only)
# or just open index.html
```

No install, no watch task: edit, reload, done.

## Before you open a PR

```bash
npm run check             # node --check on the JS + tools/check.mjs
open "http://localhost:8080/?test=1"
```

* `npm run check` must pass.
* The accuracy suite must stay at 20/20 with alert lateness in the low
  milliseconds. If your change touches timing, say so in the PR description and
  paste the measured numbers.
* If you change the timer logic, update [docs/accuracy.md](docs/accuracy.md#measured-results)
  rather than adding a claim without a measurement.

## Code style

* Plain ES2020+, `'use strict'`, IIFE-wrapped modules, no classes required.
* 2-space indent, single quotes, semicolons, ~110 column soft limit.
* Name things for what they do; comment the *why*, not the *what*.
* Keep DOM lookups out of hot paths; the render loop runs ~11×/second.
* Accessibility is not optional: every control needs a label, keyboard access,
  and a visible focus state.

## Good first issues

* A custom preset stored per phase (e.g. a 45-minute focus you use often).
* A minimal always-on-top “compact” mode for a second monitor.
* An optional “clock time when the session ends” readout.
* Translations (the UI strings are all in `index.html` / `src/app.js`; a
  language JSON + a picker would be a clean, self-contained PR).
* More alert points (e.g. 25 % or a user-defined list).

## Reporting a timing problem

Accuracy reports are gold. Include:

1. the numbers from the **Accuracy** panel (engine, tick gap, worst lateness),
2. the result of `?test=1` (screenshot or the JSON from the console),
3. browser + version, OS, and whether the tab was in the foreground,
4. what you expected versus what happened.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
