"""Build an optional, scan-heavy performance fixture from synthetic content.

Authoring-only dependencies: reportlab, Pillow, numpy, pypdf. Nothing is
downloaded. The generated PDF stays out of Git; tests use the durable recipe.
"""
import argparse
from io import BytesIO
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab import rl_config
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from pypdf import PdfReader

rl_config.useA85 = False
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--pages", type=int, choices=(32, 256), default=32,
                    help="32 pages for routine performance checks; 256 for near-limit stress checks")
args = parser.parse_args()
page_count = args.pages
destination = Path(f"output/pdf/scan-heavy-{page_count}-page.pdf")
destination.parent.mkdir(parents=True, exist_ok=True)
pdf = canvas.Canvas(str(destination), pagesize=(612, 792), invariant=1)
pdf.setTitle("Scan-heavy Practice Book" if page_count == 32 else "Near-limit Scan Book")
pdf.setAuthor("Gesture Reader synthetic performance QA")
title_font = ImageFont.load_default(size=62)
body_font = ImageFont.load_default(size=36)
for index in range(page_count):
    # Unique high-resolution textured pages require actual decode/render work.
    # These are visible image streams, not unused padding or repeated references.
    rng = np.random.default_rng(7300 + index)
    pixels = rng.integers(220, 256, size=(2640, 2040, 3), dtype=np.uint8)
    image = Image.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    draw.rectangle((90, 100, 1940, 260), fill="#e7efcd")
    draw.text((125, 145), "SCAN-HEAVY PRACTICE BOOK", fill="#263321", font=title_font)
    draw.text((125, 315), "Synthetic score - no personal document data", fill="#263321", font=body_font)
    for staff in range(7):
        top = 520 + staff * 255
        for line in range(5):
            draw.line((145, top + line * 24, 1880, top + line * 24), fill="#30332e", width=3)
        for note in range(12):
            x = 220 + note * 135
            y = top + ((note + staff + index) % 5) * 24
            draw.ellipse((x, y - 10, x + 32, y + 10), fill="#20251e")
            draw.line((x + 30, y, x + 30, y - 72), fill="#20251e", width=3)
    draw.text((125, 2430), f"PAGE {index + 1} OF {page_count} - Scan {index + 1:02d}", fill="#263321", font=body_font)
    raster = BytesIO()
    image.save(raster, format="JPEG", quality=92)
    raster.seek(0)
    pdf.drawImage(ImageReader(raster), 0, 0, width=612, height=792)
    pdf.showPage()
    if page_count > 32 and (index + 1) % 32 == 0:
        print(f"Generated {index + 1}/{page_count} visible scan pages", flush=True)
pdf.save()
del pdf  # Release authoring streams before validating the near-limit document.
reader = PdfReader(destination)
assert len(reader.pages) == page_count
assert all(len(page.images) == 1 for page in reader.pages)
assert destination.stat().st_size > 30 * 1024 * 1024
if page_count == 256:
    assert 480 * 1024 * 1024 < destination.stat().st_size < 500 * 1024 * 1024
print(f"Synthetic scan fixture: {len(reader.pages)} pages, {destination.stat().st_size / 1024 / 1024:.1f} MiB")
