# Local PDF fixtures

`password-protected.pdf` is a three-page, selectable-text test document generated
from `tests/e2e/pdfFixture.ts` and encrypted with pypdf using AES-256. It contains
only project-owned QA text. Its intentionally public test password is
`reader-test`; it contains no personal data or credentials.

The committed fixture keeps browser tests independent of Python at test time.
The browser test checks a wrong password, successful unlocking, rendered text,
and page navigation.

`reader-corpus.pdf` is a deterministic 120-page synthetic document generated
by `scripts/build-pdf-corpus.py` using ReportLab, Pillow and pypdf. It includes
selectable text, an image-only scanned page (no OCR), Japanese/Chinese/Korean
CID fonts requiring bundled character maps, a naturally rotated page, wide and
narrow page sizes, seven outline destinations, and a unique search phrase near
the end. There is no personal content, JavaScript, or form data.

The reader tests use the committed PDF without Python dependencies. Generation
tools are only needed to rebuild it. Inspect rendered pages after regeneration,
especially CJK glyphs and the rotated page; a text extraction alone is not proof
of correct rendering.
