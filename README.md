# proxy-list
The Proxy List is the best place to find unblocked links of all your favorite proxy and game sites. New links are added weekly with hundreds of links available.

# Share the list
Feel free to download the list and share it around! The list is also available at https://yourworstnightmare1.github.io/proxy-list/.

# Embed on another site
Use an **iframe** — paste the snippet from [docs/embed.html](docs/embed.html) (or open `/embed.html` on the hosted site). The list loads at `?embed=1` with a compact layout (no bottom ad, portrait orientation lock disabled). Example:

```html
<iframe
  src="https://yourworstnightmare1.github.io/proxy-list/?embed=1"
  title="Proxy list"
  width="100%"
  height="720"
  style="border:0;border-radius:8px;max-width:100%;min-height:480px;"
  loading="lazy"
></iframe>
```

You cannot embed the full app as a single inline HTML string without an iframe: the UI loads `data.json` and scripts from the host. Cross-site iframes may block sign-in (third-party cookies). `docs/_headers` sets `frame-ancestors *` for Cloudflare Pages; GitHub Pages allows framing by default.

# Deploy on Cloudflare Pages
This site is static HTML in `docs/` — there is no compile step.

**Recommended (Cloudflare Pages + Git):** In the Pages project → **Settings** → **Build**:

| Setting | Value |
| --- | --- |
| Build command | *(leave empty)* |
| Build output directory | `docs` |
| Root directory | `/` |

Do **not** use `npx wrangler deploy` as the build command. Pages uploads the output folder automatically; Wrangler only needs an API token and is meant for Workers CLI deploys.

**Optional (Wrangler CLI):** Commit includes `wrangler.jsonc` and `workers/site.js` (static assets + `POST /api/link-click` IP rate limit). Locally or in CI you can run `npm run deploy:cloudflare` only if `CLOUDFLARE_API_TOKEN` (and usually `CLOUDFLARE_ACCOUNT_ID`) are set — create a token at [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) with **Account** → **Cloudflare Pages Edit** and **Workers Scripts Edit**.

For global click counts via the Worker, set these secrets on the Worker:

```bash
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

Use a Firebase service account with Datastore/Firestore access. Rate limit is **40 clicks/hour/IP**.

# Versioning info
The default version format is v[version]r[revision].
<br>
[version] uses standard semantic versioning. [revision] is updated each time a new link or change is made.

# Contributions
View [CONTRIBUTING.md](https://github.com/yourworstnightmare1/proxy-list/blob/main/CONTRIBUTING.md) for details on how to request links. You can also submit links on Google Forms if the Contributing Guide confuses you [here](https://forms.gle/NjWM3wQCKEAy6VKu6).
<br>
**I am only accepting contributions to list.md, I am not taking contributions on any code present here.**

# License

This repository uses a dual license:

| Scope | License | File |
| --- | --- | --- |
| **Site code** (HTML, scripts, tooling, config) | [MIT](LICENSE) | `LICENSE` |
| **List data** (`list.md`, generated JSON, link datasets) | [CC BY 4.0](LICENSE-CC-BY-4.0) | `LICENSE-CC-BY-4.0` |

You may copy, share, and remix the proxy list data with attribution. The website code is open under MIT with the usual permissions and warranty disclaimer.

CC BY 4.0 covers the list data and datasets derived from it, including `list.md`, `unsorted.md`, `link_status.json`, and the generated files under `docs/` such as `data.json`, `unsorted.json`, `link_check_meta.json`, `link_check_snapshot.json`, `contributor_link_totals.json`, `popular_links.json`, `linklens.json`, and `submission_url_keys.json`.

# How is CAPTCHA tested?
CAPTCHA is tested using the official [Google ReCAPTCHA demo](https://www.google.com/recaptcha/api2/demo)

# When is the list updated?
**Automation (silent maintenance)**: The list is automatically checked every six hours. Each run re-checks HTTP for links in `list.md` and updates per-URL failure counts in `link_status.json`. Link filter metadata (`docs/link_check_meta.json`), exported JSON, and a UTC-day game-database snapshot (`docs/gdb_stats.json` + `docs/stats/archive/gdb_catalogs/`) are refreshed on every run. These updates do **not** bump revision or `Last Updated` in `list.md`, so users are not prompted to refresh unless you publish a release.

**Sunday releases (user-facing)**: Revision (`r###`) and `Last Updated` in `list.md` only bump when the link checker runs on **Sunday** (or when you manually run the workflow with **Bump revision and Last Updated** checked). That is when users see the “new site update” banner. For a full weekly release, also bump the **version** (`vX.Y`) and write `## Update Notice` in `list.md` on Sunday, then run `python scripts/convert_list_to_json.py`.

After three consecutive failing runs for the same URL, that row is removed from `list.md`. Failure counts live in `link_status.json`. To pause deletions while still recording failures (for debugging), set the Actions repository variable `LINK_CHECK_NO_PURGE` to `true`, or run `python scripts/link_checker.py` locally with `LINK_CHECK_NO_PURGE=true`. Use `LINK_CHECK_PUBLISH_RELEASE=true` locally to force a revision bump, or `LINK_CHECK_PUBLISH_RELEASE=silent` to force silent mode.

**Manual**: I will periodically update the list if I find new proxies, or if someone makes a pull request and I approve.

**Auto-sort unsorted links**: When an unsorted URL contains an existing provider name (e.g. `gn-math`, `Noblocc`, `Velara`), you can move it into that provider section with:

```bash
python3 scripts/autosort_unsorted_links.py          # preview matches (dry-run)
python3 scripts/autosort_unsorted_links.py --apply  # move links + refresh docs/data.json
```
