# proxy-list
This is a complete list of lots of well known and probably working proxies. Check Releases for new versions of the list.

# Share the list
Feel free to download the list and share it around! The list is also available at https://yourworstnightmare1.github.io/proxy-list/.

# Versioning info
The default version format is v[version]r[revision].
<br>
[version] uses standard semantic versioning. [revision] is updated each time a new link or change is made.

# Contributions
View [CONTRIBUTING.md](https://github.com/yourworstnightmare1/proxy-list/blob/main/CONTRIBUTING.md) for details on how to request links. You can also submit links on Google Forms if the Contributing Guide confuses you [here](https://forms.gle/NjWM3wQCKEAy6VKu6).
<br>
**I am only accepting contributions to list.md, I am not taking contributions on any code present here.**

# How is CAPTCHA tested?
CAPTCHA is tested using the official [Google ReCAPTCHA demo](https://www.google.com/recaptcha/api2/demo)

# When is the list updated?
**Automation**: The list is automatically checked every six hours. Each run re-checks HTTP for links in `list.md` and updates per-URL failure counts in `link_status.json`. After three consecutive failing runs for the same URL, that row is eligible to be removed from `list.md`. The scheduled workflow keeps purging **off** by default (`LINK_CHECK_NO_PURGE`, so flaky CI does not mass-delete working proxies); counters still advance. To have the bot purge dead links from the repo, set the Actions repository variable `LINK_CHECK_NO_PURGE` to `false`, or run `python scripts/link_checker.py` locally with that variable unset.\
**Manual**: I will periodically update the list if I find new proxies, or if someone makes a pull request and I approve.

# How to use
## Windows
Simply download and open it in Notepad. If you are not on Windows 11 or are on macOS, you will have to go to https://markdownlivepreview.com/ to view it as markdown support is only in Windows 11+.
## macOS
Once downloaded, right-click or control-click or press the spacebar on the file and select "Quick Look". This will show the file properly.

# gn-math Discord automation (experimental)
If gn-math has no public API, you can collect results by running a Discord bot script that sends checks in a channel and parses the reply message.

## What was added
- `scripts/linklens_collector.py`: sends a command per link and writes `docs/linklens.json`.
- `docs/index.html`: clicking a link now opens a summary modal using data from `docs/linklens.json`.

## Setup
1. Create a Discord bot and invite it to your server.
2. Ensure it can read message history, read messages, and send messages in the target channel.
3. Install dependencies:
   - `pip install discord.py`
4. Export environment variables:
   - `export DISCORD_BOT_TOKEN="your_bot_token"`
   - `export DISCORD_CHANNEL_ID="1447086087079071824"`
   - `export GN_MATH_COMMAND_TEMPLATE="/check all url {domain}"`
   - `export GN_MATH_AUTHOR_NAMES="gn-math#8961"`
   - Optional: `export GN_MATH_AUTHOR_ID="gn_math_bot_user_id"` to only accept replies from gn-math.

## Run
- Quick dry run (no messages sent):
  - `python scripts/linklens_collector.py --dry-run --max-links 5`
- Real run:
  - `python scripts/linklens_collector.py --max-links 50`
- History ingest only (recommended for slash-command workflows):
  - `python scripts/linklens_collector.py --ingest-history --history-limit 4000`

## Periodic sync
You can continuously rescan Discord messages and update `docs/linklens.json`:

- Required environment variables:
  - `export DISCORD_BOT_TOKEN="your_bot_token"`
  - `export DISCORD_CHANNEL_ID="1447086087079071824"`
  - `export GN_MATH_AUTHOR_NAMES="gn-math#8961"`
- Start periodic sync (every 5 minutes by default):
  - `python scripts/linklens_periodic_sync.py`
- Custom interval:
  - `python scripts/linklens_periodic_sync.py --interval-seconds 120`
- One-shot run (same script, no loop):
  - `python scripts/linklens_periodic_sync.py --run-once`

## Refresh unchecked links (one command)
When you add links to `list.md`, run:

- `python scripts/update_unchecked_links.py`

This will:
- rebuild `docs/data.json`
- regenerate `links.txt`
- print how many links remain unchecked based on `docs/linklens.json`

Optional Discord alert (enabled by default when unchecked links > 0):
- Uses `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID` (or `DISCORD_NOTIFY_CHANNEL_ID`)
- Mention/name in alert defaults to `@your_username` and can be changed with `DISCORD_NOTIFY_MENTION`
- Disable alerts with: `export UNCHECKED_NOTIFY_DISCORD=0`

## Notes
- The command template must match whatever gn-math listens for in that channel.
- Keep delays/rate low to avoid spam/rate limits (defaults are conservative).
- If gn-math response formatting changes, parsing may need small regex updates.
