# Gesture Reader

Gesture Reader is a local-first PDF library and reader for the web and macOS.
It can turn one page at a time when an on-device camera model recognizes an
open-palm swipe. PDFs, thumbnails, reading state, bookmarks, and camera frames
stay on the device.

## What is included

- Full PDF.js viewer: thumbnails, outline, search and highlighting, text
  selection, page jump, zoom/fit, rotation, single/continuous/two-page layouts,
  presentation mode, print, download, and password prompts.
- Local library: multi-file import and drop, SHA-256 duplicate detection,
  metadata/cover extraction, title and author search, recent sorting, progress,
  bookmarks, and safe removal of only the app-managed copy.
- Gesture setup: camera selection, mirrored preview, sensitivity, direction
  inversion, two-direction calibration, neutral reset, and cooldown feedback.
- PWA storage in IndexedDB with persistent-storage and quota warnings.
- Electron storage under the macOS application-data directory with an atomic,
  recoverable catalog and managed PDF copies.
- Locally bundled PDF.js, MediaPipe WASM, and gesture-recognizer model. Runtime
  network access is blocked by policy.

## Run the web app

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` during development. Camera access works on
localhost; a production web deployment must use HTTPS.

The first build downloads the pinned MediaPipe model, verifies its SHA-256
digest, and copies all runtime assets into `public/vendor/`.

## Build the macOS app

```bash
npm run electron:package
```

Electron Forge writes an unsigned `.dmg`, `.zip`, and `.app` under `out/`.
This personal-use build is intentionally not notarized or App Store signed.

## Controls

- Left/Right arrow: previous/next page
- Page input: jump to a page
- Bookmark button: add or remove the current page
- PDF.js toolbar: search, zoom, fit, rotate, layout, print, save, and
  presentation controls
- Enable gestures: requests video permission and starts local recognition
- Swipe left: next page
- Swipe right: previous page

For calibration, keep the full wrist and all five fingers inside the preview.
Hold the open palm still until the palm lock reaches 3/3, then swipe. After the
left check, move the hand out of view briefly and wait for Ready before raising
it again for the right check.

The gesture engine arms only after `Open_Palm` is detected with sufficient
confidence in three of four frames. A swipe must cover the configured horizontal
distance in 120–450 ms, exceed twice the vertical drift, and be followed by a
neutral reset plus an 800 ms cooldown. It never wraps at document boundaries.

## Privacy and security

- Camera permission is requested only after **Enable gestures** is selected.
- Only video is requested; audio is never requested.
- Camera tracks stop when gestures are disabled, the app is hidden, or the
  window closes.
- Recognition pauses during text entry, dialogs, window blur, and page
  animation.
- The Electron renderer is sandboxed with context isolation and Node
  integration disabled. IPC, navigation, popups, camera permission, and the
  application protocol are allowlisted.
- No account, telemetry, remote-PDF URL, cloud sync, or analytics code is
  included.

The browser and macOS libraries are independent by design.

## Verification

```bash
npm test
npm run lint
```

`npm test` runs gesture and navigation unit tests, library storage/recovery
tests, a production build check, browser tests with real PDF bytes and a fake
camera stream, and Electron integration tests for the secure protocol and
managed storage.

Additional PDF fixtures for manual testing can be generated with:

```bash
/Users/aiden/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  work/create_pdf_fixtures.py
```

## Project map

- `app/` — application shell, metadata, and styles
- `components/gesture-reader/` — library, PDF reader, and gesture setup UI
- `lib/` — shared contracts, command bus, PDF adapter, gesture engine, storage
- `electron/` — hardened Electron main process, preload bridge, and catalog
- `scripts/` — runtime-asset and Electron-renderer builds
- `tests/` — unit, browser, rendered-output, and Electron integration tests
