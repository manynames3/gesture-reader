import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = "dist/client";
const files = [];
async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(join(directory, entry.name), `${relative}/`);
    else if (!relative.endsWith(".map")) files.push(relative);
  }
}
await collect(join(root, "assets"), "assets/");
await collect(join(root, "vendor"), "vendor/");
files.push("manifest.webmanifest", "hand-swipe.svg", "favicon.svg", "favicon-32.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png");
// Static exports also need their homepage navigation payload when offline.
try {
  await access(join(root, "index.rsc"));
  files.push("index.rsc");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const hash = createHash("sha256");
const template = await readFile("public/sw.js", "utf8");
hash.update(template);
// Server-only markup/metadata changes must invalidate cached HTML too, even
// when the client chunks did not change. These files are hashed, never cached.
for (const path of ["dist/server/index.js", "dist/server/ssr/index.js"]) {
  hash.update(path).update(await readFile(path));
}
let bytes = 0;
for (const path of files.sort()) {
  const data = await readFile(join(root, path));
  hash.update(path).update(data);
  bytes += data.byteLength;
}
const manifest = { revision: hash.digest("hex").slice(0, 16), bytes, assets: ["/", ...files.map((path) => `/${path}`)] };
if (!template.includes('"__OFFLINE_MANIFEST__"')) throw new Error("Offline manifest placeholder missing");
await writeFile(join(root, "sw.js"), template.replace('"__OFFLINE_MANIFEST__"', JSON.stringify(manifest)));
console.log(`Offline bundle: ${manifest.assets.length} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${manifest.revision}`);
