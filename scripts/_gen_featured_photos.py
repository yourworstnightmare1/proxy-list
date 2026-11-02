import base64
from pathlib import Path

root = Path("docs/featured")
keys = [
    ("catclass", "catclass.jpg"),
    ("duckmath", "duckmath.jpg"),
    ("studyhub", "studyhub.jpg"),
    ("voidnetwork", "voidnetwork.jpg"),
    ("c00lkidtech", "c00lkidtech.jpg"),
    ("pgis3", "pgis3.jpg"),
]
parts = []
for key, name in keys:
    b64 = base64.b64encode((root / name).read_bytes()).decode("ascii")
    parts.append(f'    {key}: "data:image/jpeg;base64,{b64}"')
    print(key, len(b64))

js = (
    "(function (global) {\n"
    '  "use strict";\n'
    "  global.__proxyListFeaturedPhotos = {\n"
    + ",\n".join(parts)
    + "\n  };\n"
    "  function applyFeaturedPhotos() {\n"
    "    var photos = global.__proxyListFeaturedPhotos;\n"
    "    if (!photos) return;\n"
    "    var slides = document.querySelectorAll('.featured-slide[data-featured-photo-key]');\n"
    "    for (var i = 0; i < slides.length; i++) {\n"
    "      var slide = slides[i];\n"
    "      var key = slide.getAttribute('data-featured-photo-key');\n"
    "      var src = key && photos[key];\n"
    "      if (!src) continue;\n"
    "      var img = slide.querySelector('.featured-slide-photo');\n"
    "      if (!img) {\n"
    "        img = document.createElement('img');\n"
    "        img.className = 'featured-slide-photo';\n"
    "        img.alt = '';\n"
    "        img.width = 1920;\n"
    "        img.height = 1000;\n"
    "        slide.insertBefore(img, slide.firstChild);\n"
    "      }\n"
    "      img.src = src;\n"
    "    }\n"
    "  }\n"
    "  global.__proxyListApplyFeaturedPhotos = applyFeaturedPhotos;\n"
    "  if (document.readyState === 'loading') {\n"
    "    document.addEventListener('DOMContentLoaded', applyFeaturedPhotos);\n"
    "  } else {\n"
    "    applyFeaturedPhotos();\n"
    "  }\n"
    "})(typeof window !== 'undefined' ? window : globalThis);\n"
)
out = Path("docs/featured-photos.js")
out.write_text(js, encoding="utf-8")
print("wrote", out.stat().st_size)
