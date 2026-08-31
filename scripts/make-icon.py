#!/usr/bin/env python3
"""Build build/icon.png + build/icon.icns from the Matteblack mark.

The logo ships black-on-transparent, which would vanish on a dark card, so its
alpha is reused as a white stencil. Geometry follows Apple's Big Sur template:
an 824px squircle centred in a 1024px canvas, so macOS's own shadow and grid
line up with every other icon in the Dock.

    python3 scripts/make-icon.py && npm run electron:dist
"""
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "attached_assets" / "Logo-black_1777692939445.png"
OUT = ROOT / "build"

S, ART = 1024, 824
R = int(ART * 0.2246)
BG = (11, 11, 12, 255)

card = Image.new("RGBA", (ART, ART), (0, 0, 0, 0))
ImageDraw.Draw(card).rounded_rectangle([0, 0, ART - 1, ART - 1], radius=R, fill=BG)

logo = Image.open(SRC).convert("RGBA")
logo = logo.crop(logo.getbbox())
mark = Image.new("RGBA", logo.size, (255, 255, 255, 255))
mark.putalpha(logo.getchannel("A"))

w = int(ART * 0.60)
mark = mark.resize((w, round(w * logo.height / logo.width)), Image.LANCZOS)
card.alpha_composite(mark, ((ART - w) // 2, (ART - mark.height) // 2))

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.alpha_composite(card, ((S - ART) // 2, (S - ART) // 2))
OUT.mkdir(exist_ok=True)
icon.save(OUT / "icon.png")

with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / "icon.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ""), (2, "@2x")):
            px = size * scale
            icon.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{size}x{size}{suffix}.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)

print("wrote", OUT / "icon.png", "and", OUT / "icon.icns")
