"""Synthetic vector-heavy report for reader QA; no downloads or user content.

Thousands of visible paths, transparency, clipping and selectable labels stress
operator processing rather than image decoding. Authoring only: reportlab/pypdf.
"""
from math import cos, sin
from pathlib import Path
from random import Random
from reportlab.pdfgen import canvas
from pypdf import PdfReader

destination = Path("output/pdf/vector-heavy-16-page.pdf")
destination.parent.mkdir(parents=True, exist_ok=True)
pdf = canvas.Canvas(str(destination), pagesize=(612, 792), invariant=1, pageCompression=1)
pdf.setTitle("Vector-heavy Research Report")
pdf.setAuthor("Gesture Reader synthetic performance QA")
for page in range(16):
    rng = Random(9300 + page)
    pdf.setFillColorRGB(0.97, 0.97, 0.95)
    pdf.rect(0, 0, 612, 792, fill=1, stroke=0)
    pdf.setFillColorRGB(0.08, 0.15, 0.13)
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawString(36, 746, "VECTOR RESEARCH REPORT")
    pdf.setFont("Helvetica", 10)
    pdf.drawString(36, 726, "Synthetic charts - paths, clipping, transparency and searchable text")
    pdf.bookmarkPage(f"page-{page + 1}")
    pdf.addOutlineEntry(f"Research sheet {page + 1}", f"page-{page + 1}", 0)
    for plot in range(8):
        x = 42 + plot % 2 * 276
        y = 556 - plot // 2 * 166
        width, height = 246, 136
        pdf.setFillColorRGB(1, 1, 1)
        pdf.setStrokeColorRGB(0.7, 0.76, 0.73)
        pdf.rect(x, y, width, height, fill=1, stroke=1)
        pdf.saveState()
        clip = pdf.beginPath()
        clip.rect(x, y, width, height)
        pdf.clipPath(clip, stroke=0)
        pdf.setLineWidth(0.25)
        pdf.setStrokeAlpha(0.32)
        # Independent visible traces, not repeated/off-page padding.
        for series in range(40):
            pdf.setStrokeColorRGB(0.1 + rng.random() * 0.3, 0.35 + rng.random() * 0.3, 0.4 + rng.random() * 0.3)
            path = pdf.beginPath()
            phase = rng.random() * 6.28
            for point in range(500):
                px = x + point * width / 499
                py = y + height * (0.5 + 0.3 * sin(point / 35 + phase) * cos(series / 8) + rng.uniform(-0.07, 0.07))
                if point == 0:
                    path.moveTo(px, py)
                else:
                    path.lineTo(px, py)
            pdf.drawPath(path)
        pdf.setFillAlpha(0.3)
        pdf.setFillColorRGB(0.2, 0.55, 0.4)
        for _ in range(250):
            pdf.circle(x + rng.random() * width, y + rng.random() * height, 0.8, fill=1, stroke=0)
        pdf.restoreState()
        pdf.setFillColorRGB(0.1, 0.2, 0.17)
        pdf.setFont("Helvetica", 8)
        pdf.drawString(x, y - 12, f"Experiment {page + 1}.{plot + 1} - 40 traces / 500 samples")
    pdf.setFont("Helvetica", 10)
    pdf.drawString(36, 30, f"Vector performance checkpoint {page + 1:02d} - Page {page + 1} of 16")
    pdf.showPage()
pdf.save()
reader = PdfReader(destination)
assert len(reader.pages) == 16
assert all(not list(page.images) for page in reader.pages)
assert "Vector performance checkpoint 12" in reader.pages[11].extract_text()
assert destination.stat().st_size > 1024 * 1024
print(f"Vector fixture: {len(reader.pages)} pages, {destination.stat().st_size / 1024 / 1024:.1f} MiB")
