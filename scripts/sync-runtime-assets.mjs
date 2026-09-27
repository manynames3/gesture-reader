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
const faceModelPath = join(
  publicRoot,
  "vendor",
  "mediapipe",
  "models",
  "face-landmarker-float16-v1.task",
);
const modelUrl =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const faceModelUrl =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const modelSha256 =
  "97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482";
const faceModelSha256 =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

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
  mkdir(dirname(faceModelPath), { recursive: true }),
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

async function ensureModel(path, url, expectedSha256, label) {
  let bytes;
  try {
    await access(path);
    bytes = new Uint8Array(await readFile(path));
  } catch {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not download the MediaPipe ${label} model (${response.status}).`,
      );
    }

    bytes = new Uint8Array(await response.arrayBuffer());
    const temporaryPath = `${path}.download`;
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, path);
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(
      `The MediaPipe ${label} model failed its integrity check.`,
    );
  }
}

await Promise.all([
  ensureModel(modelPath, modelUrl, modelSha256, "gesture"),
  ensureModel(
    faceModelPath,
    faceModelUrl,
    faceModelSha256,
    "face landmarker",
  ),
]);
