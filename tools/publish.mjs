#!/usr/bin/env node
/* ============================================================================
 * tools/publish.mjs — publish PomodoroCube to your own GitHub account.
 *
 *   node tools/publish.mjs <github-username> [repo-name] [options]
 *
 * What it does, in order:
 *   1. renames every mikefromcornell placeholder to your real username
 *   2. makes sure this folder is a git repo (main branch) and commits anything
 *      still uncommitted
 *   3. points `origin` at https://github.com/<user>/<repo>.git
 *   4. creates the repository on GitHub (only when the `gh` CLI is installed
 *      and you pass --gh), otherwise it just pushes
 *   5. pushes main, the release branch and the version tag
 *   6. prints the two GitHub UI clicks that turn on free Pages hosting
 *
 * Options:
 *   --dry-run     show what would happen, change nothing
 *   --gh          create the GitHub repo with the gh CLI before pushing
 *   --private     create the repo as private (with --gh)
 *   --force       push even if the remote already has a different history
 *   --no-push     stop before pushing (prepare the repo only)
 *   --rewrite-only  only rewrite the placeholders, then stop
 *
 * No dependencies: only the Node standard library and your existing git/gh
 * credentials are used. Nothing is sent anywhere except your own repo.
 * ========================================================================= */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const username = positional[0] || process.env.GITHUB_USER || '';
const repo = positional[1] || 'PomodoroCube';

const DRY = flags.has('--dry-run');
const REWRITE_ONLY = flags.has('--rewrite-only');
const NO_PUSH = flags.has('--no-push');
const USE_GH = flags.has('--gh');
const PRIVATE = flags.has('--private');
const FORCE = flags.has('--force');

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`
};
const say = (s = '') => console.log(s);
const step = (n, s) => say(`${c.b(`${n}.`)} ${s}`);
const ok = (s) => say(`   ${c.g('✓')} ${s}`);
const warn = (s) => say(`   ${c.y('!')} ${s}`);
const die = (s) => { say(`\n${c.r('✗')} ${s}\n`); process.exit(1); };

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts }).trim();
}
/** Read-only git query: returns '' instead of throwing (e.g. before `git init`). */
function safeGit(args) { try { return git(args); } catch { return ''; } }
const has = (cmd) => {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

/* ---------------------------------------------------------------- validate */
say(`\n${c.b('PomodoroCube publisher')} ${c.dim('— free hosting on GitHub Pages')}\n`);
if (!username) {
  die('Usage: node tools/publish.mjs <github-username> [repo-name] [--dry-run] [--gh] [--private]\n' +
      '       e.g. node tools/publish.mjs octocat');
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(username)) {
  die(`"${username}" does not look like a GitHub username (letters, digits and single hyphens, max 39).`);
}
if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) die(`"${repo}" is not a valid repository name.`);
if (!has('git')) die('git is not installed or not on PATH.');

const owner = username;
const url = `https://github.com/${owner}/${repo}.git`;
const site = `https://${owner.toLowerCase()}.github.io/${repo}/`;

/* ------------------------------------------------- 1. rewrite placeholders */
step(1, `Rewrite the ${c.b('mikefromcornell')} placeholders`);
const TEXT = new Set(['.md', '.json', '.html', '.js', '.mjs', '.css', '.yml', '.yaml', '.txt', '.webmanifest']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT.has(extname(entry)) && st.size < 2_000_000) out.push(full);
  }
  return out;
}
const files = walk(root);
let changed = 0, occurrences = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('mikefromcornell')) continue;
  const n = src.split('mikefromcornell').length - 1;
  occurrences += n;
  changed++;
  if (!DRY) writeFileSync(file, src.split('mikefromcornell').join(owner));
  say(`   ${c.dim('·')} ${file.replace(root + '/', '')} ${c.dim(`(${n})`)}`);
}
if (!changed) ok('nothing to rewrite — placeholders already point at a real account');
else ok(`${occurrences} placeholder${occurrences === 1 ? '' : 's'} in ${changed} file${changed === 1 ? '' : 's'} ${DRY ? 'would be' : ''} set to ${c.b(owner)}`);

if (REWRITE_ONLY) {
  say(`\n${c.dim('--rewrite-only given: stopping after the rewrite.')}\n`);
  process.exit(0);
}

/* --------------------------------------------------------- 2. git repo/commit */
step(2, 'Prepare the repository and commit');
if (!existsSync(join(root, '.git'))) {
  if (DRY) ok('would run: git init -b main');
  else { git(['init', '-b', 'main']); ok('initialised a new repository on branch main'); }
} else {
  ok(`repository already initialised (branch ${safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main'})`);
}
const identity = (() => {
  try { return { name: git(['config', 'user.name']), email: git(['config', 'user.email']) }; }
  catch { return null; }
})();
if (!identity || !identity.name || !identity.email) {
  if (DRY) ok('would set a local commit identity (you can change it later)');
  else {
    git(['config', 'user.name', owner]);
    git(['config', 'user.email', `${owner}@users.noreply.github.com`]);
    warn(`no git identity found — set a local one to "${owner} <${owner}@users.noreply.github.com>"`);
    warn('change it with:  git config user.name "Your Name" && git config user.email you@example.com');
  }
}
const inRepo = existsSync(join(root, '.git'));
const dirty = inRepo ? safeGit(['status', '--porcelain']) : '';
if (!inRepo && DRY) {
  ok('would commit every file as the initial commit on main');
} else if (dirty) {
  if (DRY) ok(`would commit ${dirty.split('\n').length} changed path(s)`);
  else {
    git(['add', '-A']);
    git(['commit', '-m', `chore: point repository links at ${owner}/${repo}`]);
    ok('committed the placeholder rewrite');
  }
} else if (!dirty) ok('working tree is clean');

/* -------------------------------------------------------------- 3. remote */
step(3, 'Point origin at your GitHub repository');
const current = safeGit(['remote', 'get-url', 'origin']);
if (current === url) ok(`origin already set to ${url}`);
else if (DRY) ok(`would set origin → ${url}${current ? ` (was ${current})` : ''}`);
else {
  if (current) { git(['remote', 'set-url', 'origin', url]); ok(`origin updated → ${url}`); }
  else { git(['remote', 'add', 'origin', url]); ok(`origin added → ${url}`); }
}

/* ------------------------------------------------------- 4. create + push */
const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
step(4, `Create the repository (${USE_GH ? 'gh CLI' : 'manual'}) and push`);
if (USE_GH) {
  if (!has('gh')) die('--gh was given but the GitHub CLI is not installed (https://cli.github.com).');
  if (DRY) ok(`would run: gh repo create ${owner}/${repo} ${PRIVATE ? '--private' : '--public'} --source=. --remote=origin --push`);
  else {
    try {
      execFileSync('gh', ['repo', 'create', `${owner}/${repo}`,
        PRIVATE ? '--private' : '--public',
        '--description', 'A virtual pomodoro cube timer — accurate countdown, 50/75/90 % reminders, spoken time remaining.',
        '--source', '.', '--remote', 'origin', '--push'], { cwd: root, stdio: 'inherit' });
      ok(`created and pushed ${owner}/${repo}`);
    } catch {
      warn('gh repo create failed (the repo may already exist) — falling back to a plain push');
      push();
    }
  }
} else {
  say(`   ${c.dim('create an empty repo named')} ${c.b(repo)} ${c.dim('at https://github.com/new (no README, no .gitignore)')}`);
  push();
}
function push() {
  if (NO_PUSH) { ok(`--no-push given: branch ${branch} is ready to push when you are`); return; }
  if (DRY) { ok(`would run: git push -u origin ${branch} --follow-tags`); return; }
  try {
    execFileSync('git', ['push', '-u', 'origin', branch, '--follow-tags', ...(FORCE ? ['--force'] : [])],
      { cwd: root, stdio: 'inherit' });
    ok(`pushed ${branch} (and tags) to ${owner}/${repo}`);
    const branches = safeGit(['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
    for (const b of branches) {
      if (b === branch) continue;
      try { execFileSync('git', ['push', '-u', 'origin', b], { cwd: root, stdio: 'inherit' }); ok(`pushed branch ${b}`); }
      catch { warn(`could not push branch ${b} (optional)`); }
    }
  } catch {
    die('git push failed. Check your credentials (an SSH key or a Personal Access Token),\n' +
        '   and that you created the empty repository on GitHub first.');
  }
}

/* ---------------------------------------------------------- 5. done + Pages */
step(5, 'Turn on free hosting (GitHub UI, two clicks)');
say(`   ${c.dim('1.')} https://github.com/${owner}/${repo}/settings/pages`);
say(`   ${c.dim('2.')} Build and deployment → Source: ${c.b('GitHub Actions')}`);
say(`   ${c.dim('The included workflow deploys on every push to')} ${c.b(branch)}${c.dim('.')}`);
say('');
say(`   ${c.b('Your timer will be live at')}  ${c.g(site)}`);
say(`   ${c.dim('Accuracy test:')}                ${site}?test=1`);
say(`   ${c.dim('Repository:')}                   https://github.com/${owner}/${repo}`);
say('');
if (!USE_GH) {
  say(`${c.dim('Tip: install the GitHub CLI (https://cli.github.com) and re-run with --gh to let this')}`);
  say(`${c.dim('script create the repository for you.')}\n`);
}
