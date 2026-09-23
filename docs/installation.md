# Installation

PomodoroCube is a static site: `index.html` + two source files + assets. There is
nothing to install and nothing to build.

## Option 1 — use the hosted copy (0 seconds)

Open the deployed page and, optionally, install it:

* **Desktop Chrome/Edge** — click the install icon in the address bar.
* **Android Chrome** — menu ⋮ → *Add to Home screen*.
* **iPhone Safari** — Share → *Add to Home Screen*.
* **Desktop Safari/Firefox** — bookmark it; everything works, minus the install
  prompt.

## Option 2 — open the file directly

Download or clone the repo and open `index.html` in any modern browser. Works
offline, immediately, with no server.

Note that a few browser features are unavailable on `file://`: the service
worker (offline caching), the install prompt and desktop notifications require
`http://localhost` or `https://`.

## Option 3 — run a local server

No dependencies are needed — `tools/serve.mjs` uses only the Node standard
library:

```bash
node tools/serve.mjs          # http://localhost:8080
node tools/serve.mjs 3000     # a different port
```

Or use anything you already have:

```bash
python3 -m http.server 8080
npx serve .
php -S localhost:8080
```

## Option 4 — publish your own copy free

See [publishing.md](publishing.md). GitHub Pages, Cloudflare Pages, Netlify and
Vercel's free tiers all host it as-is, and you can keep the repo private and
still publish the site.

## Verifying your install

1. Open `/?test=1` and wait for the report — 20/20 checks should pass on a
   desktop browser, with alert lateness in the low milliseconds.
2. Open the app, press **Start**, and confirm the display counts down and the
   ring unwinds.
3. Press **Test the four alerts** to hear the 50 / 75 / 90 % and finish sounds.
4. Reload mid-session: the timer resumes with the correct remaining time
   (toggle *Continue session after reload* in the Session panel to change this).
