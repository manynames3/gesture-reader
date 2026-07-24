import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicRoot = join(root, "public");
const pdfRoot = join(publicRoot, "vendor", "pdfjs", "5.5.207");
const mediaPipeRoot = join(
  publicRoot,
  "vendor",
  "mediapipe",
  "0.10.35",
);
const modelPath = join(
  publicRoot,
  "vendor",
  "mediapipe",
  "models",
  "gesture-recognizer-float16-v1.task",
);
const modelUrl =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const modelSha256 =
  "97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482";

async function copyDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

await Promise.all([
  rm(join(publicRoot, "pdfjs"), { recursive: true, force: true }),
  rm(join(publicRoot, "mediapipe"), { recursive: true, force: true }),
  mkdir(pdfRoot, { recursive: true }),
  mkdir(dirname(modelPath), { recursive: true }),
]);
await Promise.all([
  copyDirectory(
    join(root, "node_modules/pdfjs-dist/cmaps"),
    join(pdfRoot, "cmaps"),
  ),
  copyDirectory(
    join(root, "node_modules/pdfjs-dist/iccs"),
    join(pdfRoot, "iccs"),
  ),
  copyDirectory(
    join(root, "node_modules/pdfjs-dist/standard_fonts"),
    join(pdfRoot, "standard_fonts"),
  ),
  copyDirectory(
    join(root, "node_modules/pdfjs-dist/wasm"),
    join(pdfRoot, "wasm"),
  ),
  copyDirectory(
    join(root, "node_modules/pdfjs-dist/web/images"),
    join(pdfRoot, "images"),
  ),
  rm(join(mediaPipeRoot, "wasm"), { recursive: true, force: true }),
]);

await mkdir(join(mediaPipeRoot, "wasm"), { recursive: true });
await Promise.all([
  cp(
    join(root, "node_modules/pdfjs-viewer-element/dist/pdf.worker.min.mjs"),
    join(pdfRoot, "viewer.worker.min.mjs"),
  ),
  cp(
    join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
    join(pdfRoot, "pdf.worker.min.mjs"),
  ),
  cp(
    join(root, "node_modules/pdfjs-dist/build/pdf.sandbox.min.mjs"),
    join(pdfRoot, "pdf.sandbox.min.mjs"),
  ),
  cp(
    join(
      root,
      "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js",
    ),
    join(mediaPipeRoot, "wasm", "vision_wasm_module_internal.js"),
  ),
  cp(
    join(
      root,
      "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm",
    ),
    join(mediaPipeRoot, "wasm", "vision_wasm_module_internal.wasm"),
  ),
]);

let modelBytes;
try {
  await access(modelPath);
  modelBytes = new Uint8Array(await readFile(modelPath));
} catch {
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(
      `Could not download the MediaPipe gesture model (${response.status}).`,
    );
  }

  modelBytes = new Uint8Array(await response.arrayBuffer());
  const temporaryPath = `${modelPath}.download`;
  await writeFile(temporaryPath, modelBytes);
  await rename(temporaryPath, modelPath);
}

const digest = createHash("sha256").update(modelBytes).digest("hex");
if (digest !== modelSha256) {
  throw new Error("The MediaPipe gesture model failed its integrity check.");
}
