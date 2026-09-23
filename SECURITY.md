# Security & privacy

## The short version

PomodoroCube is a static page. There is no server, no backend, no database, no
account system, no analytics and no third-party code. Nothing you do in the app
is transmitted anywhere.

## What the app stores

| Where | What | Why |
| --- | --- | --- |
| `localStorage` (`pomodorocube.settings.v1`) | your toggles, presets, chosen voice, theme | so the app opens the way you left it |
| `localStorage` (`pomodorocube.session.v1`) | a running/paused session (deadline, phase, fired alerts) | so a reload or accidental tab close does not lose your session |
| Service worker cache | the app's own files | so it works offline |

Both keys can be cleared from your browser's site-data settings, or by turning off
*Continue session after reload* / *Remember last preset*. Nothing is sent to the
network, ever — you can verify this in DevTools → Network (the app makes zero
requests after load) and by reading `src/app.js`, `sw.js`.

## Permissions the app may ask for

| Permission | When | Granted/denied |
| --- | --- | --- |
| Notifications | only if you press 🔔 *Notify* | purely optional; cards + voice work without it |
| Screen Wake Lock | while a timer runs (*Keep screen awake*, default on) | released when paused/stopped; harmless if denied |
| Clipboard / camera / location / etc. | never requested | — |

## Hosting considerations

* Everything is client-side, so a compromise of the host cannot expose user data
  — there is none. It could serve a modified `app.js`, which is why the source is
  small, readable and reviewable in one sitting.
* `sw.js` only intercepts same-origin GET requests and never caches third-party
  content.
* The app contains no `innerHTML` sinks for user-supplied or remote data. All
  dynamic text is set through `textContent`, so there is no XSS surface from the
  app's own data. (The one place with generated markup is the built-in test
  report, which only renders its own fixed strings and measured numbers.)
* No `eval`, no dynamic script injection of remote code, no inline event handlers
  in the HTML.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/mikefromcornell/PomodoroCube/security/advisories/new)
or email the maintainer rather than filing a public issue. Include a description,
reproduction steps and the impact you believe it has. You can expect an
acknowledgement within a few days; fixes to this project are small and fast.
