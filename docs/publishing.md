# Publishing — everything free

PomodoroCube is a static site, so any free static host works. GitHub Pages is the
default because the repository and the hosting live in the same place, and both
are free for public and private repos.

## The fast path — one command

```bash
node tools/publish.mjs <your-github-username>        # add --gh to create the repo via the GitHub CLI
node tools/publish.mjs <your-github-username> --dry-run   # see what it would do
```

The script rewrites every `YOUR-USERNAME` placeholder to your account, makes sure
this folder is a git repository on `main`, sets `origin`, creates the repository
(with `--gh`, when the [GitHub CLI](https://cli.github.com) is installed) and
pushes `main` plus tags. It uses only the Node standard library and your existing
git credentials — nothing is uploaded anywhere except your own repository.
Afterwards, enable Pages as described below.

## GitHub Pages (included workflow)

The repo ships with `.github/workflows/pages.yml`, which runs the static checks,
uploads the repo root as the site artefact and deploys it on every push to `main`.

1. **Create the repository.** Either:

   ```bash
   # from this directory
   git init -b main
   git add -A
   git commit -m "PomodoroCube 1.0.0"
   git remote add origin https://github.com/mikefromcornell/PomodoroCube.git
   git push -u origin main
   ```

   …or create an empty repo called `PomodoroCube` on GitHub and push this folder
   into it.

2. **Enable Pages.** Repository → **Settings → Pages → Build and deployment →
   Source: GitHub Actions**. (Not “Deploy from a branch” — the workflow already
   handles deployment, including the checks.)

3. **Wait for the workflow.** The *Deploy to GitHub Pages* run appears under the
   **Actions** tab; the first run takes under a minute. Your site is then at:

   ```
   https://mikefromcornell.github.io/PomodoroCube/
   ```

4. **Replace the placeholders.** These files contain `mikefromcornell` and are the
   only things that need editing:

   | File | What to change |
   | --- | --- |
   | `README.md` | live-demo link, clone URL |
   | `package.json` | `homepage`, `repository.url`, `bugs.url` |
   | `docs/*.md` | clone/issue links if you want them exact |

   ```bash
   grep -rn "mikefromcornell" . --exclude-dir=.git
   ```

5. **Custom domain (optional, still free).** Settings → Pages → *Custom domain*.
   Add a `CNAME` file containing your domain, then create a `CNAME` record at your
   DNS provider pointing at `mikefromcornell.github.io`. HTTPS is provisioned
   automatically.

### Deploying to a project page vs. the root

Everything uses relative paths, so the site works unchanged at
`https://name.github.io/` (user page), `https://name.github.io/PomodoroCube/`
(project page) or a custom domain. No configuration required.

## Other free hosts

| Host | How | Notes |
| --- | --- | --- |
| **Cloudflare Pages** | Connect the repo, leave the build command empty, output directory `/` | Unmetered bandwidth, global CDN |
| **Netlify** | “Add new site → Import an existing project”, publish directory `/`, no build command | Free tier is plenty |
| **Vercel** | Import the repo; framework preset “Other”, no build step | Free for personal projects |
| **GitLab Pages** | Add a `.gitlab-ci.yml` that copies the repo into `public/` | Same idea, different CI |
| **Codeberg Pages** | Push a `pages` branch, or use their CI | Fully free-and-open-source friendly |

For all of them: **do not add a build step.** There is no toolchain, and none is
needed. Point the host at the repository root and it just works.

## What about private repos?

GitHub Pages is free for public repositories. If you want the *source* private but
the *site* public, publish with Cloudflare Pages, Netlify or Vercel (free plans
support private repos), or keep the source in a private repo and mirror the built
folder into a public one with a small workflow.

## Verifying a deployment

After the first deploy:

* `https://your-site/?test=1` → the accuracy suite should pass 20/20.
* Open DevTools → **Application → Service Workers** → `sw.js` should be activated
  (it can only register over `https://` or `localhost`).
* DevTools → **Application → Manifest** → the icon, name and theme should resolve,
  and installability should read *Installable*.
* Lighthouse → *Installable* + *Works offline*: both should pass.
