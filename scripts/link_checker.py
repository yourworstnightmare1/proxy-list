import re
import requests
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# -----------------------
# Auto-detect markdown file
# -----------------------
def find_markdown_file():
    for file in os.listdir("."):
        if file.endswith(".md") and file.startswith("list-"):
            return file
    raise FileNotFoundError("No list-*.md file found")

INPUT_FILE = find_markdown_file()

# -----------------------
# Extract links
# -----------------------
def extract_links(content):
    return re.findall(r'https?://[^\s|]+', content)

# -----------------------
# Normalize URL (for dedupe)
# -----------------------
def normalize_url(url):
    return url.strip().rstrip("/")

# -----------------------
# Extract version + revision
# -----------------------
def extract_version_revision(content):
    v_match = re.search(r"v\d+\.\d+\.\d+", content)
    r_match = re.search(r"r\d+", content)

    version = v_match.group(0) if v_match else "v0.0.0"
    revision = r_match.group(0) if r_match else "r0"

    return version, revision

# -----------------------
# Test if link works
# -----------------------
def is_working(url):
    try:
        r = requests.head(url, timeout=5, allow_redirects=True)
        if r.status_code < 400:
            return True
    except:
        pass

    try:
        r = requests.get(url, timeout=5)
        return r.status_code < 400
    except:
        return False

# -----------------------
# Parallel testing
# -----------------------
def test_links(links):
    results = {}
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(is_working, url): url for url in links}
        for future in futures:
            results[futures[future]] = future.result()
    return results

# -----------------------
# Process markdown (dedupe + cleanup)
# -----------------------
def process_markdown(content, results):
    total_links = 0
    section_counts = {}
    current_section = None

    seen_urls = set()
    new_lines = []

    for line in content.splitlines():
        if line.startswith("# "):
            current_section = line
            section_counts[current_section] = 0

        match = re.search(r'(https?://[^\s|]+)', line)

        if match:
            url = match.group(1)
            normalized = normalize_url(url)

            # Remove duplicates (exact only)
            if normalized in seen_urls:
                continue
            seen_urls.add(normalized)

            # Remove dead links
            if results.get(url, False):
                new_lines.append(line)
                section_counts[current_section] += 1
                total_links += 1
        else:
            new_lines.append(line)

    updated = "\n".join(new_lines)

    # Update total links
    updated = re.sub(
        r"Total Links:\s*\d+",
        f"Total Links: {total_links}",
        updated
    )

    # Update section counts
    for section, count in section_counts.items():
        updated = re.sub(
            rf"({re.escape(section)}.*?\|\s*Links\s*\|\s*)(\d+)",
            rf"\g<1>{count}",
            updated,
            flags=re.DOTALL
        )

    return updated, total_links

# -----------------------
# Version logic
# -----------------------
def bump_revision(content):
    match = re.search(r"r(\d+)", content)
    if match:
        new_r = int(match.group(1)) + 1
        return re.sub(r"r\d+", f"r{new_r}", content)
    return content

def bump_version_if_needed(content, old_total, new_total):
    if new_total != old_total:
        match = re.search(r"v(\d+)\.(\d+)\.(\d+)", content)
        if match:
            major, minor, patch = map(int, match.groups())
            patch += 1
            return re.sub(
                r"v\d+\.\d+\.\d+",
                f"v{major}.{minor}.{patch}",
                content
            )
    return content

# -----------------------
# Update dates
# -----------------------
def update_dates(content):
    today = datetime.now().strftime("%B %d, %Y")

    return re.sub(
        r"Last Updated: .*",
        f"Last Updated: {today}",
        content
    )

# -----------------------
# MAIN
# -----------------------
def main():
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    links = extract_links(content)
    old_total = len(set(normalize_url(l) for l in links))

    results = test_links(links)

    updated, new_total = process_markdown(content, results)

    removed_links = old_total - new_total

    # Apply updates
    updated = bump_revision(updated)
    updated = bump_version_if_needed(updated, old_total, new_total)
    updated = update_dates(updated)

    # Extract version + revision AFTER update
    version, revision = extract_version_revision(updated)

    # Save markdown
    with open(INPUT_FILE, "w", encoding="utf-8") as f:
        f.write(updated)

    # Export commit info
    with open("commit_info.txt", "w") as f:
        f.write(f"{version}|{revision}|{removed_links}|{new_total}")

if __name__ == "__main__":
    main()
