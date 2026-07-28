import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the private local-first reader shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Gesture Reader — Private, hands-free PDFs<\/title>/i,
  );
  assert.match(html, /Gesture Reader/);
  assert.match(html, /Private, hands-free PDFs/);
  assert.match(html, /Add PDFs/);
  assert.match(html, /Your documents and camera frames never leave this device/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /fonts\.googleapis|googletagmanager|analytics/i);
});

test("ships self-hosted PDF, gesture, and PWA assets", async () => {
  const root = new URL("../", import.meta.url);
  const [manifest, serviceWorker, gestureModel, faceModel] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(
      new URL(
        "public/vendor/mediapipe/models/gesture-recognizer-float16-v1.task",
        root,
      ),
    ),
    readFile(
      new URL(
        "public/vendor/mediapipe/models/face-landmarker-float16-v1.task",
        root,
      ),
    ),
  ]);

  assert.match(manifest, /Gesture Reader/);
  assert.match(serviceWorker, /gesture-reader-v\d+/);
  assert.ok(gestureModel.byteLength > 8_000_000);
  assert.ok(faceModel.byteLength > 3_700_000);
  await access(
    new URL(
      "public/vendor/mediapipe/0.10.35/wasm/vision_wasm_module_internal.wasm",
      root,
    ),
  );
  await access(
    new URL("public/vendor/pdfjs/5.5.207/viewer.worker.min.mjs", root),
  );
});
