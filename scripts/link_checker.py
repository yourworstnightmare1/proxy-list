import re
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

INPUT_FILE = "list.md"

# -----------------------
# Extract links
# -----------------------
def extract_links(content):
    return re.findall(r'https?://[^\s|]+', content)

# -----------------------
# Normalize URL
# -----------------------
def normalize_url(url):
    return url.strip().rstrip("/")

# -----------------------
# Extract version + revision
# -----------------------
def extract_version_revision(content):
    try:
        v_match = re.search(r"v\d+\.\d+\.\d+", content)
        r_match = re.search(r"r\d+", content)

        version = v_match.group(0) if v_match else "v0.0.0"
        revision = r_match.group(0) if r_match else "r0"

        return version, revision
    except:
        return "v0.0.0", "r0"

# -----------------------
# Test link
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
# Parallel test
# -----------------------
def test_links(links):
    results = {}
    try:
        with ThreadPoolExecutor(max_workers=25) as executor:
            futures = {executor.submit(is_working, url): url for url in links}
            for future in futures:
                url = futures[future]
                try:
                    results[url] = future.result()
                except:
                    results[url] = False
    except:
        # fallback if threading fails
        for url in links:
            results[url] = False

    return results

# -----------------------
# Process markdown
# -----------------------
def process_markdown(content, results):
    total_links = 0
    section_counts = {}
    current_section = None

    seen_urls = set()
    new_lines = []

    for line in content.splitlines():
        try:
            if line.startswith("# "):
                current_section = line
                section_counts[current_section] = 0

            match = re.search(r'(https?://[^\s|]+)', line)

            if match:
                url = match.group(1)
                normalized = normalize_url(url)

                # skip duplicates
                if normalized in seen_urls:
                    continue
                seen_urls.add(normalized)

                # skip dead links
                if not results.get(url, False):
                    continue

                new_lines.append(line)

                if current_section:
                    section_counts[current_section] += 1
                    total_links += 1
            else:
                new_lines.append(line)

        except:
            # never crash on bad line
            new_lines.append(line)

    updated = "\n".join(new_lines)

    # update total links
    try:
        updated = re.sub(
            r"Total Links:\s*\d+",
            f"Total Links: {total_links}",
            updated
        )
    except:
        pass

    # update section counts
    for section, count in section_counts.items():
        try:
            updated = re.sub(
                rf"({re.escape(section)}.*?\|\s*Links\s*\|\s*)(\d+)",
                rf"\g<1>{count}",
                updated,
                flags=re.DOTALL
            )
        except:
            pass

    return updated, total_links

# -----------------------
# Versioning
# -----------------------
def bump_revision(content):
    try:
        match = re.search(r"r(\d+)", content)
        if match:
            return re.sub(r"r\d+", f"r{int(match.group(1)) + 1}", content)
    except:
        pass
    return content

def bump_version_if_needed(content, old_total, new_total):
    try:
        if new_total != old_total:
            match = re.search(r"v(\d+)\.(\d+)\.(\d+)", content)
            if match:
                major, minor, patch = map(int, match.groups())
                return re.sub(
                    r"v\d+\.\d+\.\d+",
                    f"v{major}.{minor}.{patch + 1}",
                    content
                )
    except:
        pass
    return content

# -----------------------
# Update date
# -----------------------
def update_dates(content):
    try:
        today = datetime.now().strftime("%B %d, %Y")
        return re.sub(r"Last Updated: .*", f"Last Updated: {today}", content)
    except:
        return content

# -----------------------
# MAIN
# -----------------------
def main():
    print("Starting script...")

    version = "v0.0.0"
    revision = "r0"
    removed_links = 0
    new_total = 0

    try:
        with open(INPUT_FILE, "r", encoding="utf-8") as f:
            content = f.read()

        links = extract_links(content)
        old_total = len(set(normalize_url(l) for l in links))

        print(f"Found {len(links)} links")

        results = test_links(links)

        updated, new_total = process_markdown(content, results)

        removed_links = max(0, old_total - new_total)

        updated = bump_revision(updated)
        updated = bump_version_if_needed(updated, old_total, new_total)
        updated = update_dates(updated)

        version, revision = extract_version_revision(updated)

        with open(INPUT_FILE, "w", encoding="utf-8") as f:
            f.write(updated)

    except Exception as e:
        print("ERROR:", e)

    # 🔥 ALWAYS create commit_info.txt (even on failure)
    try:
        with open("commit_info.txt", "w") as f:
            f.write(f"{version}|{revision}|{removed_links}|{new_total}")
    except:
        pass

    print("Finished script")

if __name__ == "__main__":
    main()
