"""Side-by-side "before | after" sheets from real app screenshots (no drawing on the map itself).

Usage: python3 scripts/compare_shots.py artifacts/map-realism  (needs Pillow)
Desktop views are cropped to the map area (right of the 392 px panel); the phone view is shown whole.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/map-realism")
PAIRS = {
    "city": "Общий вид (z11.8)",
    "baiterek": "Байтерек (z17.2, наклон 62°)",
    "expo": "EXPO / Нур Алем (z16.2, наклон 58°)",
    "mobile": "Телефон 390×844: план прогулки на карте",
}


FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)


def font(size: int):
    for p in FONTS:
        if Path(p).is_file():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def sheet(name: str, title: str) -> Path:
    a = Image.open(ROOT / "before" / f"before-{name}.png").convert("RGB")
    b = Image.open(ROOT / "after" / f"after-{name}.png").convert("RGB")
    if name != "mobile":
        a, b = (im.crop((392, 56, im.width, im.height)) for im in (a, b))
    head, gap = 70, 16
    out = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height) + head), "white")
    out.paste(a, (0, head))
    out.paste(b, (a.width + gap, head))
    d = ImageDraw.Draw(out)
    d.text((12, 8), title, fill="#17201C", font=font(26))
    d.text((12, 40), "ДО — 4cb6f98", fill="#7A2E2E", font=font(22))
    d.text((a.width + gap + 12, 40), "ПОСЛЕ — эта ветка", fill="#176447", font=font(22))
    path = ROOT / f"compare-{name}.png"
    out.save(path, optimize=True)
    return path


if __name__ == "__main__":
    for n, t in PAIRS.items():
        print(sheet(n, t))
