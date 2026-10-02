# Contribute to the List
Thanks for wanting to build our list and help the community! Here's how to request your link to the list:

# 1. Contribute through the Proxy List
You can contribute through the Proxy List site by clicking the "Contribute" button in the sidebar and filling out the form labeled "Submit links for review". You must have an account on the list in order to do this.
You can also [click here](https://yourworstnightmare1.github.io/proxy-list/contribute/) and you will be taken to the form.

# 2. Contribution through GitHub
## Requesting Links
1. [Fork this repository](https://github.com/yourworstnightmare1/proxy-list/fork)
2. Open the `list.md` file.
3. Add your link below with the following format:
(View the markdown by selecting raw view in the top right of the file)

### Adding links under existing section
| Locked | Link | Found Date | Username | Password | Contributor |
| - | - | - | - | - | - |
| Y | https://example.com | 12/12/2000 | N/A | N/A | ContributorName

**Link Data**
<br>
**Locked** - Only use and set to Y if the link requires username/password to enter. Common for frogie's arcade links. **If you do not have the username/password, do not add it! It's useless to us if no one can access it!!** If it doesn't need login leave blank.\
**Link** - Where the link goes.\
**Found Date** - Date when you made the pull request.\
**Username** - **Only fill if you used the locked data.** Fill with the username to login.\
**Password** - **Only fill if you used the locked data.** Fill with the password to login.\
**Contributor** - Fill with your GitHub username and have it link to it. This can be done with the following (replace username with yours):
```
[Username](https://github.com/Username)
```

## Example for adding links

### 🐸 frogie's arcade
> [!NOTE]
> | Category | Capabilities | Protocol(s) | Links |
> | - | - | - | - |
> | Proxy/Games | captcha | Ultraviolet | 1 |
>
| Locked | Link | Found Date | Username | Password | Contributor |
| - | - | - | - | - | - |
| | https://frogiesarcade.win | 5/1/2026 | N/A | N/A | [yourworstnightmare1](https://github.com/yourworstnightmare1/)
| | https://tetosarcade.win | 5/2/2026 | N/A | N/A | [yourworstnightmare1](https://github.com/yourworstnightmare1/)

### Adding links under a new section
### [Emoji] linkName
> [!NOTE]
> | Category | Capabilities | Protocol(s) | Links |
> | - | - | - | - |
> | pending | pending | pending | 1 |
| Locked | Link | Found Date | Username | Password | Contributor |
| - | - | - | - | - | - |
| Y | https://example.com | 12/12/2000 | N/A | N/A | ContributorName
<br>

**Header**
<br>
**Emoji** - replace with an emoji that matches the name, design or logo of that site. It does not matter if the emoji is used already.\
**linkName** - replace with the name of the section\
<br>
**Information**
<br>
**Category** - Either Games or Proxy/Games. Proxy/Games is only applied if the site allows you to go to external sites from within the site.\
**Capabilities** - Network-sided features the proxy has. If the category is "Games", leave this as N/A. If you are unsure what capabilities this has, set it to unknown.\
**Protocols** - Proxies used by this site. If you are unsure what capabilites this has, set it to unknown.\
**Links** - Number of links in this category. If this is updater later, the link check bot will likely auto-update the count for you.\
<br>
<br>
**Link Data**
<br>
**Locked** - Only use and set to Y if the link requires username/password to enter. Common for frogie's arcade links. **If you do not have the username/password, do not add it! It's useless to us if no one can access it!!** If it doesn't need login leave blank.\
**Link** - Where the link goes.\
**Found Date** - Date when you made the pull request.\
**Username** - **Only fill if you used the locked data.** Fill with the username to login.\
**Password** - **Only fill if you used the locked data.** Fill with the password to login.\
**Contributor** - Fill with your GitHub username and have it link to it. This can be done with the following (replace username with yours:
```
[Username](https://github.com/Username)
```

## Example for new sections

### 💜 Selenite
> [!NOTE]
> | Category | Capabilities | Protocol(s) | Links |
> | - | - | - | - |
> | Games | N/A | N/A | 1 |

| Locked | Link | Found Date | Username | Password | Contributor |
| - | - | - | - | - | - |
| | https://selenite.cc | 5/2/2026 | N/A | N/A | [yourworstnightmare1](https://github.com/yourworstnightmare1/)

4. Commit your changes to `main` branch.
5. Open a pull request.

## Pull Request Edits
I may edit the pull request if there is a mistake or small error, then push those edits to main. You will still be fully credited for contributing to the list.

# Maintainer helpers

### GitHub sources for providers (#52)
If a proxy publishes open-source / self-hostable code, add it to `docs/provider_github_sources.json` under `sources` (key = provider title without leading emoji). Run `python3 scripts/convert_list_to_json.py` afterward. The site shows a **GitHub** link next to that provider in the list and link summary.

### Discovering new hosts from ThreatFeed (#47)
[1NobleCyber/ThreatFeed](https://github.com/1NobleCyber/ThreatFeed) publishes refreshed S3, Cloudfront, and generic proxy-host feeds. To list candidates that are not already on this repo:

```bash
python3 scripts/suggest_threatfeed_links.py
python3 scripts/suggest_threatfeed_links.py --feeds s3,cloudfront,generic --limit 200
```

Output defaults to `scripts/threatfeed_candidates.txt`. These are **unverified** discovery candidates — check each URL before adding it to `list.md` or `unsorted.md`.

# Common Questions
### Will these links show on both `list.md` and the website?
Yes, they are automatically synced.

### What if a link I submit no longer works?
After three consecutive failed HTTP checks (runs every six hours), a link is eligible to be removed from `list.md`. The scheduled job **purges** dead rows by default once that threshold is reached (`link_status.json` tracks consecutive failures). To keep failure counts without deleting rows (for debugging), set the Actions variable `LINK_CHECK_NO_PURGE` to `true`, or run `python scripts/link_checker.py` locally with `LINK_CHECK_NO_PURGE=true`.

### When do users see update banners?
Link checks and filter metadata run every six hours **silently** (no revision bump). Users only get the refresh banner when **revision** and **Last Updated** change — on **Sundays** when the bot removes or adds links, or when a maintainer bumps **version** and `## Update Notice` for a weekly release.

