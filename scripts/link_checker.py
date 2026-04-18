import re
import json
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

INPUT_FILE = "list.md"
STATUS_FILE = "link_status.json"
CHANGELOG_FILE = "CHANGELOG.md"

FAIL_THRESHOLD = 3

# -----------------------
# Extract links
# -----------------------
def extract_links(content):
    return re.findall(r'https?://[^\s|]+', content)

def normalize_url(url):
    return url.strip().rstrip("/")

# -----------------------
# Load/save failure state
# -----------------------
def load_status():
    try:
        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def save_status(status):
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2)

# -----------------------
# Test link
# -----------------------
def is_working(url):
    try:
        r = requests.get(url, timeout=5)
        return r.status_code < 400
    except:
        return False

def test_links(links):
    results = {}
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(is_working, url): url for url in links}
        for future in futures:
            url = futures[future]
            try:
                results[url] = future.result()
            except:
                results[url] = False
    return results

# -----------------------
# Process markdown
# -----------------------
def process(content, results, status):
    current_section = None
    seen = set()
    new_lines = []

    kept = 0
    removed = 0

    for line in content.splitlines():
        if line.startswith("# "):
            current_section = line

        match = re.search(r'(https?://[^\s|]+)', line)

        if match:
            url = match.group(1)
            norm = normalize_url(url)

            if norm in seen:
                continue
            seen.add(norm)

            working = results.get(url, False)

            if working:
                status[url] = 0
                new_lines.append(line)
                kept += 1
            else:
                status[url] = status.get(url, 0) + 1

                if status[url] < FAIL_THRESHOLD:
                    new_lines.append(line)
                    kept += 1
                else:
                    removed += 1
        else:
            new_lines.append(line)

    return "\n".join(new_lines), kept, removed

# -----------------------
# Update counts + version
# -----------------------
def update_meta(content, total):
    content = re.sub(r"Total Links:\s*\d+", f"Total Links: {total}", content)

    today = datetime.now().strftime("%B %d, %Y")
    content = re.sub(r"Last Updated: .*", f"Last Updated: {today}", content)

    # revision bump
    content = re.sub(
        r"r(\d+)",
        lambda m: f"r{int(m.group(1)) + 1}",
        content
    )

    return content

# -----------------------
# CHANGELOG
# -----------------------
def update_changelog(removed, total):
    entry = f"""
## {datetime.now().strftime('%Y-%m-%d')}
- Removed: {removed}
- Total: {total}
"""

    try:
        with open(CHANGELOG_FILE, "a") as f:
            f.write(entry)
    except:
        pass

# -----------------------
# MAIN
# -----------------------
def main():
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    links = extract_links(content)

    status = load_status()

    results = test_links(links)

    content, kept, removed = process(content, results, status)

    total = kept

    content = update_meta(content, total)

    with open(INPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    save_status(status)

    update_changelog(removed, total)

    # commit info
    with open("commit_info.txt", "w") as f:
        f.write(f"v0.0.0|r0|{removed}|{total}")

if __name__ == "__main__":
    main()
