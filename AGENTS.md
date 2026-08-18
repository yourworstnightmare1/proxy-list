# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
`proxy-list` is a **static website** (all UI assets live in `docs/`, main page is `docs/index.html`)
served in development by a thin **Cloudflare Worker** (`workers/site.js`, config `wrangler.jsonc`).
The Worker serves the `docs/` assets plus a few JSON APIs: `POST /api/link-click`,
`POST /api/link-clicks/get`, `POST /api/presence-ping`, `GET /api/presence-active`.
There is **no build/compile step** for the site — `docs/data.json` (the ~29k-link dataset the UI
loads) is committed, so the site renders without running any tooling.

### Run / build / test (the dev environment already has deps installed)
- Run the app (dev): `npm run dev` → `wrangler dev`, serves on `http://localhost:8787`.
  It serves the static `docs/` site and the `/api/*` Worker endpoints together.
- Build: `npm run build` is a no-op message (static site, nothing to compile).
- Tests: there is no test runner configured. The one standalone check is
  `node scripts/test_data_loader_urls.js` (asserts URL-resolution logic in `docs/data-loader.js`;
  prints `ok` on success).
- Lint: no linter is configured.

### Non-obvious gotchas
- **`python` is not on PATH — only `python3`.** The npm script `build:filter-stats` and the
  README/CONTRIBUTING maintenance commands invoke bare `python`, which fails here. Run the optional
  Python tooling in `scripts/` with `python3 scripts/<name>.py` instead. (`requests` is available.)
  These Python scripts are optional maintenance tooling (link checker, `list.md`→JSON converters,
  filter-stats) and are **not** needed to run or demo the site.
- **Firebase is optional and degrades gracefully.** Without the Worker secrets
  `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`, `/api/link-click` and
  presence endpoints fall back to in-edge Cache counters and return a `warning` field
  (`via: "edge"`). Sign-in, saved links, admin pages, and global/shared stats require real Firebase
  config; local dev works fine without it.
- **Port 8787 is shared** by both `wrangler dev` and the optional self-hosted webhook server
  (`scripts/github_webhook_server.py`). Do not run both at once.
