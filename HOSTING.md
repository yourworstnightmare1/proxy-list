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