# Contribute to the List
Thanks for wanting to build our list and help the community! Here's how to request your link to the list:

# 1. Contribution through GitHub
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

# 2. Contribute through Google Forms
[Go to the form here and fill out the info](https://forms.gle/SMx9EUkBeiFuLwBa8), then submit. Your Google email and real name are not shared with us. Please make sure to give a name/alias so we can give you credit for your contribution, else I will just fill it in with "Anonymous Contributor".

# Rules
1. Do not give links that are already on the list. It will be denied.
2. Link must be working and active.
3. Keep formatting consistent, do not change the formatting other than what is listed in the formatting guide above. This is to avoid problems and breaking the markdown or site.
4. Do not submit links that are in blocked domains:

## Blocked Domains
The following domains are not allowed to be submitted:
- `b-cdn.net`
- `blooket.com`

## Pull Request Edits
I may edit the pull request if there is a mistake or small error, then push those edits to main. You will still be fully credited for contributing to the list.

# Common Questions
### Will these links show on both `list.md` and the website?
Yes, they are automatically synced.

### What if a link I submit no longer works?
After three consecutive failed HTTP checks (runs every six hours), a link is eligible to be removed from `list.md`. The scheduled job usually keeps **purging** off on GitHub runners so temporary blocks do not delete working links; `link_status.json` still tracks failures. To drop dead rows from the repo, run `python scripts/link_checker.py` locally without `LINK_CHECK_NO_PURGE`, or set the Actions variable `LINK_CHECK_NO_PURGE` to `false`.

### What if a link I submit is blocked?
It will stay, it will just be likely unusable by users on that filter.

