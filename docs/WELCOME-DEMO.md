# Welcome tour videos

First-visit walkthrough clips are served from `docs/welcome-demo/` as `./welcome-demo/*.mp4`.

## Naming

`{step}_{os}_{theme}_16x9.mp4`

- **step:** `filter_select_demo`, `normal_search_and_palette`, `changelog_demo`, `statistics_navigation_demo`, `settings_demo`
- **os:** `windows11` (default / unknown devices) or `macos26`
- **theme:** `dark` or `light` (site moonlight/auto-dark → `dark`; auto-light → `light`)

## Source

Canonical copies live in `Documents/proxy-list-demo-vids/welcome_demo/`.

On this machine, `docs/welcome-demo` is a directory junction to that folder so local `wrangler` / static serving can play the clips without duplicating ~200MB in git. MP4s are gitignored.

To sync on another machine:

```powershell
New-Item -ItemType Junction -Path docs\welcome-demo -Target "C:\path\to\proxy-list-demo-vids\welcome_demo"
```

Or copy the MP4s into `docs/welcome-demo/` before `npm run deploy:cloudflare`.

Force the tour anytime with `?welcomeTour=1`, or use **Settings → Replay welcome tour**.
