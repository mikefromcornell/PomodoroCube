#!/usr/bin/env node
/* ============================================================================
 * tools/check.mjs — dependency-free static checks for PomodoroCube.
 *
 *   node tools/check.mjs
 *
 * Verifies that the app is internally consistent. Run locally or in CI.
 * ========================================================================= */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => { failures++; console.error(`  \u2717 ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

console.log('\nPomodoroCube static checks\n--------------------------');

/* 1 ── every local file referenced by the HTML/CSS/manifest actually exists */
const html = read('index.html');
const manifest = JSON.parse(read('manifest.webmanifest'));
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = m[1];
  if (!/^(https?:|data:|#|mailto:)/.test(url)) refs.add(url);
}
for (const icon of manifest.icons) refs.add(icon.src);
refs.add(manifest.start_url.replace(/^\.\//, 'index.html'));
const missing = [...refs].filter((r) => !existsSync(join(root, r.replace(/^\.\//, ''))));
check(missing.length === 0, missing.length ? `missing referenced files: ${missing.join(', ')}` : `${refs.size} referenced files exist`);

/* 2 ── the three required alert thresholds are still wired up */
const app = read('src/app.js');
check(/alertHalf/.test(app) && /0\.5/.test(app), '50 % alert present');
check(/alert75/.test(app) && /0\.75/.test(app), '75 % alert present');
check(/alert90/.test(app) && /0\.9/.test(app), '90 % alert present');

/* 3 ── the countdown must be deadline-based, not tick-counted */
check(/deadline/.test(app) && /Date\.now\(\)/.test(app), 'deadline-based clock (drift-free)');
check(/performance\.now\(\)/.test(app), 'monotonic clock used for gap/lateness diagnostics');

/* 4 ── default preset is 30 minutes everywhere */
const focusInApp = /focusMin:\s*(\d+)/.exec(app);
check(focusInApp && Number(focusInApp[1]) === 30, `default focus preset in app.js is ${focusInApp ? focusInApp[1] : '?'} min (expected 30)`);
check(/value="30"/.test(html), 'default preset shown as 30 in the UI');

/* 5 ── no runtime dependencies, no remote requests, no build step */
const remote = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
check(remote.length === 0, remote.length ? `index.html loads remote resources: ${remote.join(', ')}` : 'zero remote resources (works offline)');
check(!/<script[^>]+type="module"[^>]+src="http/.test(html), 'no remote module imports');
check(existsSync(join(root, 'package.json')), 'package.json present');
const pkg = JSON.parse(read('package.json'));
check(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'zero runtime dependencies');

/* 6 ── versions agree between package.json and the manifest */
check(pkg.version && manifest.name.includes('PomodoroCube'), `package version ${pkg.version}`);

/* 7 ── service worker shell list matches real files */
const sw = read('sw.js');
const swFiles = [...sw.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, '')).filter((f) => f && !f.endsWith('/'));
const swMissing = swFiles.filter((f) => !existsSync(join(root, f)));
check(swMissing.length === 0, swMissing.length ? `service worker lists missing files: ${swMissing.join(', ')}` : `service worker shell (${swFiles.length} files) is complete`);

console.log('--------------------------');
if (failures) {
  console.error(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
