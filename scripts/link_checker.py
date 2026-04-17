import re
import requests
from concurrent.futures import ThreadPoolExecutor

INPUT_FILE = "list-v2.0.2r17.md"

def extract_links(content):
    return re.findall(r'https?://[^\s|]+', content)

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

def test_links(links):
    results = {}
    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(is_working, url): url for url in links}
        for future in futures:
            results[futures[future]] = future.result()
    return results

def process_markdown(content, results):
    total_links = 0
    section_counts = {}
    current_section = None

    new_lines = []

    for line in content.splitlines():
        if line.startswith("# "):
            current_section = line
            section_counts[current_section] = 0

        match = re.search(r'(https?://[^\s|]+)', line)

        if match:
            url = match.group(1)
            if results.get(url, False):
                new_lines.append(line)
                section_counts[current_section] += 1
                total_links += 1
            else:
                continue
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

    return updated

def main():
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    links = extract_links(content)
    results = test_links(links)

    updated = process_markdown(content, results)

    with open(INPUT_FILE, "w", encoding="utf-8") as f:
        f.write(updated)

if __name__ == "__main__":
    main()