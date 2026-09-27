"""Generate a synthetic reader QA corpus, never personal document content.

Requires test-authoring tools reportlab, Pillow and pypdf; not app dependencies.
Run from the repository root. The committed fixture needs no Python at test time.
"""

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter


destination = Path("tests/fixtures/reader-corpus.pdf")
destination.parent.mkdir(parents=True, exist_ok=True)
source = BytesIO()
pdf = canvas.Canvas(source, pagesize=(612, 792), invariant=1)
pdf.setTitle("Reader Quality Corpus")
pdf.setAuthor("Gesture Reader synthetic QA")
pdf.setSubject("120 pages: text, scan, CJK, rotation, mixed sizes and outline")

for font in ["HeiseiMin-W3", "STSong-Light", "HYSMyeongJo-Medium"]:
    pdfmetrics.registerFont(UnicodeCIDFont(font))


def heading(page, title, size=(612, 792)):
    pdf.setPageSize(size)
    pdf.setPageRotation(0)
    pdf.setFillColorRGB(0.12, 0.14, 0.12)
    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawString(36, size[1] - 54, title)
    pdf.setFont("Helvetica", 11)
    pdf.drawString(36, size[1] - 78, "Synthetic local reader test - no personal data")
    pdf.drawString(36, 24, f"PAGE {page} OF 120")


for page in range(1, 121):
    if page == 2:
        # Image-only page: no text layer and no implicit OCR promise.
        scan = Image.new("RGB", (1224, 1584), "#fffdf6")
        ink = ImageDraw.Draw(scan)
        title_font = ImageFont.load_default(size=40)
        body_font = ImageFont.load_default(size=28)
        ink.text((90, 110), "SCANNED PRACTICE SHEET", fill="#222820", font=title_font)
        for row in range(8):
            y = 270 + row * 115
            ink.text((90, y), f"Line {row + 1}: Keep your hands on the instrument.", fill="#293126", font=body_font)
            ink.line((90, y + 65, 1130, y + 65), fill="#d0d6c9", width=2)
        raster = BytesIO()
        scan.save(raster, format="PNG")
        raster.seek(0)
        pdf.setPageSize((612, 792))
        pdf.setPageRotation(0)
        pdf.drawImage(ImageReader(raster), 0, 0, width=612, height=792)
        pdf.bookmarkPage("scan")
        pdf.addOutlineEntry("Scanned page", "scan", level=0)
    elif page == 3:
        heading(page, "CJK text and bundled character maps")
        samples = [
            ("HeiseiMin-W3", "こんにちは世界", 650),
            ("STSong-Light", "你好世界", 565),
            ("HYSMyeongJo-Medium", "안녕하세요 세계", 480),
        ]
        for font, text, y in samples:
            pdf.setFont(font, 28)
            pdf.drawString(48, y, text)
        pdf.bookmarkPage("cjk")
        pdf.addOutlineEntry("CJK text", "cjk", level=0)
    elif page == 4:
        heading(page, "Naturally rotated sheet")
        pdf.setFont("Helvetica", 16)
        pdf.drawString(36, 600, "This page has a 90-degree PDF rotation.")
        pdf.bookmarkPage("rotated")
        pdf.addOutlineEntry("Rotated sheet", "rotated", level=0)
    elif page == 5:
        heading(page, "Wide landscape page", (842, 595))
        pdf.setFont("Helvetica", 16)
        pdf.drawString(36, 440, "A wide page should refit without cropping or changing saved zoom.")
        pdf.bookmarkPage("wide")
        pdf.addOutlineEntry("Wide page", "wide", level=0)
    elif page == 6:
        heading(page, "Narrow page", (300, 700))
        pdf.setFont("Helvetica", 12)
        pdf.drawString(36, 560, "A narrow mixed-size page.")
        pdf.bookmarkPage("narrow")
        pdf.addOutlineEntry("Narrow page", "narrow", level=0)
    else:
        heading(page, "Reader basics" if page == 1 else f"Long document section {page}")
        pdf.setFont("Helvetica", 15)
        pdf.drawString(36, 640, f"Selectable content on page {page}.")
        if page == 1:
            pdf.bookmarkPage("basics")
            pdf.addOutlineEntry("Reader basics", "basics", level=0)
            pdf.drawString(36, 600, "Search, select, turn, bookmark, and resume.")
        if page == 119:
            pdf.drawString(36, 600, "Unique search target: copper hummingbird.")
        if page == 120:
            pdf.bookmarkPage("final")
            pdf.addOutlineEntry("Final section", "final", level=0)
            pdf.drawString(36, 600, "Last page. Navigation must not wrap.")
    pdf.showPage()

pdf.save()
writer = PdfWriter()
writer.clone_document_from_reader(PdfReader(source))
writer.pages[3].rotate(90)
with destination.open("wb") as output:
    writer.write(output)
reader = PdfReader(destination)
assert len(reader.pages) == 120
assert not reader.pages[1].extract_text().strip()
assert reader.pages[3].rotation == 90
assert "copper hummingbird" in reader.pages[118].extract_text()
assert len(reader.outline) == 7
print(f"Created {destination}: {len(reader.pages)} pages, {destination.stat().st_size} bytes")
