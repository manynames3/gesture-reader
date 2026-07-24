import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "pdf-lib";

export async function createPdfBytes() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Gesture Reader E2E Guide");
  pdf.setAuthor("Local QA");
  pdf.setSubject("Selectable local PDF test fixture");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageCopy = [
    "Welcome to Gesture Reader",
    "Searchable private local library notes",
    "Keyboard and gesture navigation",
  ];

  for (const [index, title] of pageCopy.entries()) {
    const page = pdf.addPage([612, 792]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 612,
      height: 792,
      color: rgb(0.045, 0.052, 0.047),
    });
    page.drawText("GESTURE READER E2E", {
      x: 56,
      y: 720,
      size: 11,
      font: bold,
      color: rgb(0.78, 1, 0.3),
    });
    page.drawText(title, {
      x: 56,
      y: 655,
      size: 26,
      font: bold,
      color: rgb(0.95, 0.94, 0.9),
    });
    page.drawText(`Selectable text on page ${index + 1}.`, {
      x: 56,
      y: 605,
      size: 15,
      font,
      color: rgb(0.72, 0.74, 0.71),
    });
    page.drawText(`PAGE ${index + 1}`, {
      x: 500,
      y: 38,
      size: 10,
      font,
      color: rgb(0.72, 0.74, 0.71),
    });
  }
  return Buffer.from(await pdf.save());
}

export async function writePdfFixture(directory: string) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "gesture-reader-e2e.pdf");
  await writeFile(filePath, await createPdfBytes());
  return filePath;
}
