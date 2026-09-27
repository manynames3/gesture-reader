# Product-quality audit

Status: **in progress, not release-approved**. This is a quality pass on the
existing web/macOS product, not a mobile port. Passing automated tests alone
does not establish real-world gesture accuracy or store-level polish.

The dated sections are historical evidence. Their installer sizes/checksums
belong to those rounds; see **Verification commands** for the current build.

## September 27, 2026: library, reader, and recovery pass

Inspected actual Chromium screenshots at desktop and narrow widths and launched
the local Electron renderer. The following problems were found and addressed:

| Observed issue | Change | Regression evidence |
| --- | --- | --- |
| Returning users still saw the large first-import hero | Compact reading desk and last-read shortcut; full library count stays stable during search | Returning-library browser test and desktop/narrow screenshots |
| Search with no matches behaved like an import button | Separate no-results state with Clear search | Returning-library browser test |
| A partly successful import hid rejected files | Persistent import report with per-file failures | Mixed PDF/text import browser test |
| A transient IndexedDB opening failure prevented retries | Clear the rejected connection promise and provide a persistent retry action | Storage-reconnection browser test |
| Delete confirmation lacked keyboard containment and restoration | Native modal, Escape, explicit Tab wrapping, busy/error state, restored focus | Keyboard removal browser test |
| PDF events could overwrite newly added bookmarks | Synchronize the reader adapter's bookmark state with library changes | Bookmark/turn/reopen tests in Chromium and Electron |
| Narrow windows hid saved bookmarks and obscured pages with thumbnails | Keep bookmark/page controls accessible; close thumbnails on entering compact width | 390px and 320px reader checks |
| Automatic page width remained tiny after sidebar/window resizing | Observe the real PDF viewport and recalculate fit outside resize-observer delivery | Rendered page width assertion, not just container height; screenshot review |
| Password prompts could be covered by the loading overlay | Hide the overlay while a PDF.js dialog requires input | Real AES-256 PDF, wrong password then correct password |
| Invalid PDFs left an endless opening overlay | End the loading state and offer Try opening again; library remains reachable | Malformed-PDF browser test |
| Reading-state save failures were silent or blocked Back without explanation | Persistent failure message, explicit retry, and intentional leave-without-saving | Injected quota failure, retry, and bookmark restoration |
| Camera failure could still be labeled active or retain a stream | Report actual status, release tracks on worker/capture failure, provide retry | Fake-camera failure/retry tests and permission-denial test |
| Closing setup unexpectedly disabled gestures | Separate Close gesture setup from Turn off gestures | Fake-camera close/reopen/disable checks |
| A worker that never replied could silently stall forever | Bounded startup/inference watchdogs; ignore late results after failure | Fake-time engine tests |

No production dependencies were added. PDFs and camera data remain local.

## September 27, 2026: setup and production offline pass

- Found and fixed an invisible calibration session: hiding setup mid-check used
  to consume subsequent gestures without turning pages. Closing setup now ends
  the check and resets the detector; an explicit Cancel calibration action and
  practice-mode label make the state clear.
- Moved the Palm swipe / Head tilt selector to the top, increased setting text
  and target sizes, and kept Turn off gestures in a fixed footer. Inspected
  1280x720 and 390x640 screenshots; both mode choices and the off action remain
  reachable without scrolling. Opening/closing setup manages keyboard focus.
- Removed the stale import toast from the reader. Refined PDF viewport fitting
  to observe the host and listen for iframe viewport transition completion,
  avoiding parent-observer delivery loops over a foreign document. Repeated the
  narrow-reader and save-failure tests three times each.
- A real production offline test initially failed because lazy PDF viewer files
  were never cached. The build now generates a content-hashed manifest covering
  307 self-hosted assets (about 32.6 MiB), including both recognition models.
  Readiness requires the complete cache and an active controller, not just a
  registered service worker.
- Added visible offline readiness/failure/retry states, cache repair, and a
  downloaded-update action. Updates wait instead of replacing an open reader's
  runtime immediately. Cache cleanup is restricted to this app and retains a
  previous build; unrelated origin caches survive.
- Production tests disconnect before the first PDF import, read and navigate
  the PDF, and initialize/process frames through both real bundled models while
  offline. Camera input is a synthetic canvas: this verifies packaging and
  inference startup, **not physical recognition accuracy**. No external request
  was observed in that flow.
- Tested cache eviction/repair without losing the PDF library and an actual
  changed worker response that remains waiting until the update action is used.
  The update test uses a localhost proxy because the production preview keeps
  static assets in memory; it does not alter repository or deployment files.
- Browsers without service workers retain online reading and are not offered
  a retry action that cannot work.

## September 27, 2026: missing-file recovery and WebKit pass

- Reproduced a recovery trap in both repositories: a matching fingerprint was
  reported as a duplicate even when its managed PDF copy was missing. Reimport
  now restores that copy under the same document ID, retaining metadata, page,
  zoom, layout, rotation, and bookmarks. Restored PDFs are not reanalyzed or
  silently reset. The library offers Add PDF again and reports restoration.
  The Electron flow deletes only its temporary test-managed copy, reimports
  through the native dialog, and verifies identical catalog state, a still-intact
  original fixture, and successful reopening on the saved page.
- WebKit initially stalled at Saving because Blob preparation failed and left
  an IndexedDB transaction locked. New imports store byte buffers; the reader
  creates a temporary Blob URL when opening. Legacy Blob records remain usable.
  Explicit transaction aborts protect against failed writes and partial metadata
  commits. Unit tests cover quota retry and legacy compatibility.
- Ran the complete reader suite in Playwright WebKit: import, text search,
  saved state, narrow fitting, encrypted/malformed PDFs, camera denial,
  simulated palm/head turns, disconnect/reconnect, and the real face model.
  Safari does not normally focus mouse-clicked buttons; removal now explicitly
  remembers its trigger for keyboard focus restoration.
- Browser-native failure injection uses prototypes so WebKit's native-object
  wrappers do not silently bypass mocks. A synthetic camera now continuously
  draws frames, including after reconnect, instead of relying on a single
  static canvas frame.
- Production tests exercise both recognition models and reading after the
  serving origin is actually shut down. An uncached request confirms that the
  origin is unavailable. Chromium additionally uses offline emulation.
  Playwright's WebKit offline switch has a
  [confirmed service-worker limitation](https://github.com/microsoft/playwright/issues/42775);
  shutting down the server tests real cache fulfillment instead of skipping
  the offline requirement. Both browsers also pass cache repair and update checks.
- WebKit screenshots of the narrow setup were inspected. These checks still
  do not establish physical gesture accuracy or installed-Safari permissions.

## September 27, 2026: PDF lifecycle and desktop transaction pass

- A rejected PDF analysis task previously escaped before the cleanup block:
  encrypted and malformed imports could retain PDF workers. Cleanup now wraps
  the loading task itself. Tests check both rejected/successful analysis and
  termination of actual browser PDF workers.
- Native viewer constructor options disable annotation editing, split/merge,
  scripting and the fake ML manager. Removed the nonfunctional Select pages
  strip from thumbnails instead of leaving an editing affordance in this
  read-only product. Selection, search and original-byte download remain tested.
- Saved-state restoration waits for native initial-view setup and page loading.
  Startup events do not overwrite saved state; the iframe is inert until ready,
  except when a password prompt needs input. Tests wait for the real ready state
  before navigating, and cover canceling the password prompt without trapping
  the user behind the opening overlay.
- Added a reproducible, synthetic 120-page fixture containing text, an image-only
  scan, Japanese/Chinese/Korean text, natural rotation and mixed sizes. Browser
  checks cover local character maps, search highlighting on page 119, exact
  last-page boundaries, outline destinations, single/continuous/spread layouts,
  restored zoom/rotation, selection, original-byte download, fullscreen and
  three-page print preparation. This is not proof of operating-system printer
  behavior, complex commercial PDFs, or large-byte performance.
- One complete WebKit run caught an intermittent outline-navigation failure.
  Added event diagnostics and stopped dispatching resize when the actual PDF
  viewport dimensions did not change. A subsequent complete run passed, as did
  12 concurrent repeated WebKit search/boundary/outline flows. This evidence does
  not establish a universal fix or 100% navigation reliability.
- The next desktop run exposed a separate confirmed reversal: page 2 briefly
  appeared, then a native resize reapplied page 1. Repeated testing reproduced
  it once in 12 launches, and the event stack traced the jump to PDF.js's scale
  refit using a stale cached scroll location. The adapter now updates the native
  viewport immediately after a page turn and before its own resize dispatch.
  Confirmation requires the current page to be visible, rather than accepting
  any nearby visible page. Twelve subsequent native import/turn/bookmark/reopen
  launches passed. A browser regression also injects a resize during a turn.
- A real filesystem failure test reproduced desktop state divergence: failed
  catalog saves changed in-memory reading state despite unchanged disk bytes.
  Commits now publish a new snapshot only after atomic catalog replacement.
  Removal stages the managed PDF, restores it if catalog writing fails, and
  recovers interrupted staging from the committed catalog on restart. Startup
  recovery is shared by concurrent readers; read failures are not mislabeled
  corruption. Cleanup of an already committed removal is retried at startup
  when interrupted; unreferenced staging is preserved if the catalog is corrupt
  or missing rather than assuming it is safe to delete.
- Added native Electron disk-failure coverage for the visible save/removal
  retry flows, in addition to unit checks for retry, import rollback and restart
  recovery. No production dependency was added.

## September 27, 2026: keyboard, larger text and motion pass

- Keyboard tests reproduced lost focus when opening a PDF, no focus destination
  for an empty bookmark list, and Page Down turning the document while focused
  in setup. The reader now focuses Back on entry and restores the exact library
  card or Continue reading shortcut on return. Page updates do not steal focus.
  Setup/popover controls and modified browser shortcuts do not invoke page turns.
- The reader has a named main landmark, a document heading and an atomic live
  page-position status. The bookmark list is a named region with a focusable empty
  state, Escape restoration and dismissal when focus moves away. Full regression
  testing caught and corrected a blur/click race that reopened the list when its
  own trigger was clicked, leaving gestures paused. That interaction has an
  explicit pointer regression check as well as the existing gesture-pause check.
  A trigger-related blur guard alone still failed in WebKit: Safari can blur to
  no element before the pointer click. Dismissal now observes the actual focus
  destination with `focusin`, excluding the trigger; outside pointer clicks
  remain independently handled. The WebKit popover check passed three repeated
  runs, then the full camera/page-turn flow passed in both engines.
- Tests navigate into the native PDF toolbar with keyboard traversal, open
  Find, enter a query, close it with Escape, and return to the outer controls.
  WebKit uses Option-Tab for all-controls navigation, respecting
  [Safari's documented preference](https://support.apple.com/en-jo/guide/safari/cpsh003/mac)
  rather than overriding the browser's default Tab behavior. A bounded traversal
  and attached focus path cover native iframe boundary stops.
- At 200% root text size and a 390px window, the old compact grid overlapped
  page/bookmark controls and clipped Enable gestures. The compact toolbar now
  wraps according to available space, without shrinking the user's text. Actual
  Chromium and WebKit screenshots were inspected. Normal 390px/320px layouts
  remain separately checked; this text-resize test is not a full browser-zoom or
  every-dialog reflow audit.
- Enlarged the desktop saved-bookmarks target, page-position text, tracking
  metrics and privacy copy. Tests measure selected app button/label targets and
  key setup text against its composited solid backgrounds. The selected text
  meets the [4.5:1 contrast threshold](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
  This does not certify all PDF content, every component or complete WCAG compliance.
- Reduced motion was honored by the outer app but not the PDF iframe's 140ms
  sidebar transition. The adapter now applies reduced-motion styles inside the
  native viewer as well. Both outer and iframe computed transitions are checked.
- Six browser checks cover these paths in both engines. Actual VoiceOver output,
  comprehensive native PDF action traversal and installed-Safari settings still
  need assessment. No production dependency was added.

## September 27, 2026: damaged desktop library recovery

- Baseline tests reproduced an empty library after catalog corruption or loss,
  even while managed PDF copies remained. Structurally invalid JSON records also
  passed directly to the renderer. Catalog parsing now validates identities,
  fingerprints and the metadata/reading-state shape before publishing records.
  Non-finite incoming page/time values cannot poison future catalog reads.
- Each primary atomic commit updates an extra atomic local catalog copy. A
  missing/damaged primary uses a valid backup, retaining its document identity,
  titles, covers and reading state. Both damaged catalog versions are preserved
  when applicable. A backup failure cannot falsely roll back a committed save
  or removal; a visible warning and Retry backup action expose that failure.
  The backup may be older after an interrupted update. This is not a separate
  drive backup or a guarantee against device loss or power-loss durability.
- Without valid metadata, recovery reconstructs records from exact managed UUID
  filenames and hashes bytes as a stream. Unrelated filenames, symlinks and
  unsupported header/size files are not imported or deleted. Ambiguous staged
  removals are preserved/recovered when no primary catalog can establish intent;
  a valid primary still determines committed removal cleanup. Reconstructed
  records keep their IDs, deduplicate future imports and start on page 1.
- The library explains recovery versus unavailable titles/bookmarks, instead of
  silently presenting a fresh empty library. Native tests import and read an
  actual PDF, save page 2 and a bookmark, close, damage the primary, restart and
  reopen on page 2; losing both catalogs then restarts the same bytes on page 1
  with an explicit state-loss report. Original fixture bytes remain unchanged.
  Desktop and 390px recovery screenshots were inspected. Rebuilt titles and
  covers cannot be restored from lost catalog metadata alone.
- Unit checks cover backup recovery, lost catalog reconstruction, strict record
  validation, backup-write retry, non-finite values, removed-document safety,
  concurrent startup, preserved staged copies and invalid-file retention.
  No production dependencies or additional IPC channels were added.

## September 27, 2026: large imports and sustained inference

- A three-file adapter test reproduced concurrent full-file allocation for an
  entire desktop drag-and-drop batch. The repository now reads and commits one
  file before reading the next. It retains per-file failures rather than losing
  good imports after one read rejects. A new test verifies peak buffered files
  and IPC batch size of one, not only final library count.
- Web and desktop drag-and-drop now check size before a full read/hash and
  validate the five-byte header before materializing a non-PDF. Native selection
  checks size before `readFile`. The existing desktop 500 MB limit is consistent
  across surfaces. A real sparse 501 MiB selected file exercises native rejection
  and continued import of the following valid file without allocating a giant
  test buffer. Header/read/size failure paths have regressions.
- The PDF inspection workflow produced a 32-page, 61.9 MiB synthetic scan book
  with unique 2040x2640 JPEG image streams. First and last pages were rendered
  with Poppler and inspected; reader screenshots were inspected in both engines.
  The durable generation recipe is tracked, not the large binary or personal
  document data. The optional suite records real production-build timing.
- The first comparison used browser defaults with different pixel densities;
  performance comparisons now use 2x in both engines. A hardware-acceleration
  experiment did not yield a consistent gain and was removed from production
  code. The native viewer already enables it by default, confirmed by live
  options. No rendering-resolution reduction or PDF feature removal was used
  to obtain a faster-looking result.
- Native `data-loaded` marks render start, not completion. The benchmark now
  waits for native rendering state FINISHED and two animation frames before
  recording a page as painted. Import/open/turn smoke budgets are intentionally
  distinct from physical accuracy and general device-performance acceptance.
- Actual bundled recognition models were run with synthetic 30 FPS canvas
  video for 20 seconds per mode while reading the scan-heavy PDF. The first
  combined run averaged 14.6-14.8 completed frames/second, with one frame in
  flight and no unintended page changes in that synthetic no-hand/no-face scene.
  Switching models reused the stream; disable ended its track and both workers.
  This is **not** the five-minute physical neutral-reading test, actual hand/face
  inference throughput or a CPU/memory/thermal endurance qualification.
- Safari-engine scan rendering still shows longer animation-frame gaps than
  Chromium. Frame gaps are not proof of a blocked JavaScript event loop; selected
  canvas-call instrumentation did not identify slow calls in WebKit. Further
  installed-Safari profiling remains needed rather than blaming an unproven
  source or changing native graphics options speculatively.
- Final production-options performance pass: all four optional checks passed.
  With finished-page paint checks, the 61.9 MiB book imported in 473ms/878ms,
  opened in 615ms/1473ms and turned in 91-132ms/229-257ms
  (Chromium/WebKit respectively). The measured open frame gaps peaked at
  38ms/320ms. These are machine-local observations, not cross-device guarantees.
  The final sustained-model run averaged 14.8-15.0 FPS in Chromium and
  14.3 FPS in WebKit across both modes, including three manual turns per mode.
  P95 inference acknowledgement was 17.4ms/19ms for palm and 4.1ms/7ms for
  head in the synthetic no-hand/no-face scene. All workers terminated and
  tracks ended on disable. The telemetry JSON is regenerated under the optional
  suite's output directory; subsequent general suites may clear those artifacts.

## September 27, 2026: high-resolution camera capture pass

- Reproduced the unbounded fallback with a synthetic 1920×1080 camera stream:
  rejecting video bitmap resize options caused full-resolution frames to reach
  the actual recognition worker. Camera constraints are preferences, not a
  guarantee that an external camera delivers 640×480.
- Extracted capture into a session-local helper. Native bitmap resizing remains
  the preferred path. If it rejects or silently ignores the requested dimensions,
  capture switches to a reusable canvas capped at 640×480 while preserving aspect
  ratio and leaving inference pixels unmirrored. Unexpected bitmap sizes are
  closed, never sent to inference; small camera frames are not enlarged.
- Recheck pause, page navigation, failure, visibility and disable state after
  asynchronous capture. Late frames are closed rather than submitted. Capture
  is also skipped while page navigation is busy.
- Added unit coverage for landscape/portrait/small input, fallback reuse,
  dimension changes, ignored resize, invalid fallback output and both-path
  failure. Browser checks use actual capture APIs and bundled palm/head models
  with 1080p synthetic video in native, rejected and ignored-resize cases.
  They also exercise delayed capture during bookmark pause and disable,
  immediate track release on total capture failure, and continued manual turns.
- Expanded the optional sustained model workload to 1080p input in both native
  and canvas capture paths. This measures throughput and bounded allocation,
  **not** recognition accuracy with real hands/faces or a physical camera.
- All six optional production checks passed. Over 20 seconds per mode/path,
  Chromium averaged 14.6-14.9 FPS and WebKit 13.8-14.3 FPS, including three
  manual page turns per workload. P95 inference acknowledgement ranged from
  16.5-24ms for palm and 2.9-10ms for head in the synthetic no-hand/no-face scene.
  All worker inputs were 640×360 with at most one in flight. Each run requested
  one camera stream; disabling ended its track and terminated both model workers.
  The fallback had comparable throughput to native resizing on this machine.
  The WebKit setup screenshot was inspected after pause/resume; direction copy,
  mode selection and the fixed off action remained visible.
- Lint excludes generated Playwright trace/report files rather than treating
  archived third-party JavaScript from a test trace as application source.

## September 27, 2026: whole-page hands-free reading pass

- The actual desktop reader opened a portrait sheet in Page Width, leaving its
  lower section outside the viewport. Gestures turn pages but do not scroll,
  so setup needed an obvious way to see the whole sheet before reading hands-free.
- Added an explicit **Fit whole page** action near the control-method instructions.
  Opening setup does not change zoom automatically. The action goes through the
  shared reader command bus and typed PDF.js integration, keeps the current page,
  bookmarks, rotation and layout, and saves the Page Fit preference per document.
- Browser coverage verifies keyboard activation, visible PDF content bounds,
  page turning and reopen restoration, a 390×640 rotated-page setup, and honest
  failure/retry when the native scale setter rejects. The fit remains available
  if camera permission is denied; manual reading must not depend on camera access.
- The first geometry check measured the transparent 9px decorative native page
  border and incorrectly treated that shadow as clipped PDF content. The check
  now measures the native canvas wrapper's content bounds; its clipping budget
  was not increased to make the assertion pass.
- Fitted state uses a readable success check and a polite screen-reader status,
  not a dimmed unavailable-looking label. A native zoom-menu fit also clears an
  obsolete fit error. Failure/retry coverage now retains the two-page layout.
- Screenshot review found bookmark notifications covering the fixed camera-off
  action. Reader notifications are now offset above bottom controls and do not
  intercept pointer input; a short narrow setup checks the actual bounds.
- Page-turn failures previously inherited a green success checkmark. Notifications
  now distinguish success, information and failure; errors use an alert and an
  exclamation mark. A real native navigation-failure injection checks unchanged
  page state, honest error feedback, successful retry and removal of the old error.
- Final full regression pass succeeded (198 checks). After extending native-menu
  recovery coverage, all four focused whole-page/feedback flows passed again in
  each browser engine; TypeScript, lint and whitespace checks also succeeded.
  Fresh desktop and short narrow screenshots were inspected, including the
  readable fitted state and bookmark notification above the off action.

## September 27, 2026: real macOS package pass

- Launched the previous packaged binary and requested a 500×600 native window.
  Its 980×680 minimum prevented the resize, even though CSS device-emulation
  checks had passed. The minimum is now 360×480; real native window resizing
  retains page controls, setup mode choices and the camera-off action.
- The old ASAR shipped duplicate public assets and server-only build output.
  Packaging now includes only the static renderer, desktop code and package
  metadata. The rebuilt ASAR is 35,508,887 bytes (about 34 MiB), roughly half
  the previous 68 MiB archive. All 307 runtime assets remain present.
- Corrected the macOS permission explanation to mention both palm swipes and
  head tilts, with an explicit on-device privacy statement. Verified it in the
  actual built Info.plist, not merely the Forge configuration.
- Added an origin-allowlisted Chromium session request policy below the CSP.
  A main-process session fetch to a controlled local HTTP server failed with
  `ERR_BLOCKED_BY_CLIENT` before any server request, independent of renderer CSP.
  PDF, model, WASM and other application-protocol requests continued to work.
- Built the ARM64 DMG, mounted it read-only, verified its Applications shortcut
  and deep/strict ad-hoc signature, and copied the app to a temporary Applications
  folder outside the checkout. Confirmed packaged execution from its ASAR with
  an isolated user-data folder; no real user library or Applications installation
  was changed. Previous installers remain archived under
  `outputs/installer-archive-RB4ZusbX/out/`.
- The copied app reloaded offline, imported a PDF through native IPC, turned a
  page, saved a bookmark and Page Fit, processed synthetic 1080p input through
  both real bundled models, stopped its track, and restored the page/bookmark/
  zoom after process restart. A managed byte-range read returned `%PDF-` with
  status 206. Removing the managed copy left the test source file unchanged.
  No external renderer requests were observed. This is not physical accuracy.
- The final full suite passed 199 checks; both separate package checks passed.
  Fresh compact installed-copy and minimum native-window screenshots were
  inspected. Package inventory and runtime JSON are written under
  `test-results/packaged/`; generated test installations are detached and cleaned.
- That round's DMG is preserved at
  `outputs/installer-archive-fimmV9/out/make/Gesture Reader.dmg`,
  135,873,742 bytes (about 130 MiB).
  SHA-256: `8f69ed2059e233ead28e2bf82d8cdddfab918ee7d0adb311aa4b0747174e5f5f`.
  This is an unnotarized local quality-test build, not a published release.

## September 27, 2026: native menus and reader import feedback

The running native application's original File menu contained only Close Window;
the default View menu exposed Reload and Developer Tools. Native menu inspection
also showed that interface zoom had generic labels that could be confused with
PDF zoom.

- Added File → Add PDFs… with the standard Command-O accelerator and the existing
  import flow. A narrow, unsubscribable preload notification passes no Electron
  event or arbitrary channel access to the renderer. The command is disabled
  while no reader window exists.
- Kept standard Mac application, editing, window and fullscreen controls; labeled
  interface zoom separately. Installed builds omit reload/developer menu roles.
  About now describes the app, its version and local-only processing.
- Opening the picker from an active PDF exposed a real missing state: import
  feedback previously existed only in the library. The reader now shows progress,
  recoverable failures, retry/dismiss controls, and pauses gesture navigation
  during import. A synchronous import guard rejects late gesture events as busy.
- Native tests cover menu import, canceled import preserving page/bookmark,
  repeated-command suppression, picker failure, modal guards and closing the
  window. Three consecutive focused repetitions passed before the final run.
- Inspected the compact error screen. It initially exposed Electron's internal
  IPC error prefix. The preload now removes only its known transport prefix,
  retaining the useful error message; unknown failures receive a readable
  fallback. Four bridge unit tests cover errors, successful arguments/results,
  and event-free subscription cleanup. The corrected compact screenshot keeps
  page controls and retry/dismiss controls visible.
- The installed-copy suite now invokes the actual menu, verifies packaged menu
  roles, and exercises picker failure without exposing the internal IPC prefix.
  Dialog selections/errors are controlled test doubles; these checks do not
  prove a physical keyboard shortcut, real Finder picker interaction, OS camera
  permission, or physical gesture accuracy.
- That round's ARM64 DMG is preserved at
  `outputs/installer-archive-Ysagej/out/make/Gesture Reader.dmg`, 135,875,759 bytes.
  SHA-256: `0726e77433bb46785d8452f7ee43d5841aedaad4ba19540f565098d490261527`.
  Previous installers remain in the ignored `outputs/installer-archive-*` folders;
  no user library or real Applications-folder installation was modified.
- Final verification: TypeScript, lint and all 204 general-suite checks passed;
  both separate DMG checks passed. The copied installed app exercised menu import
  and clean picker errors offline before continuing PDF/model/state-restoration
  checks. Packaged main/preload files matched the current source byte-for-byte.

## September 27, 2026: real interface zoom and fitted search

Tested Electron's actual 200% WebContents zoom at native 720×960 and 360×480
window sizes, not CSS font scaling or an emulated viewport. At minimum size,
the renderer's usable viewport is 180×224 CSS pixels.

- The camera-off button initially ended at y=388 in that 224px-high viewport.
  Short-window setup now fills the viewport, keeps Close/Off outside its scrolling
  options, and has dialog semantics with keyboard focus containment/return.
  Options can be scrolled with Page Down without turning the PDF.
- Extremely narrow reader controls now keep every command reachable using compact
  visual labels and full accessible names. Library Add PDFs initially extended
  to x=228 in a 180px-wide viewport; header/recent-reading/dialog reflow fixes
  that clipping. Sensitivity choices stack rather than truncate their labels.
- PDF.js's native main container enforced 350px width even inside a 180px iframe.
  That rendered the fitted page off-screen and could fool a container-only fit
  check. The adapter now removes that minimum; the new native test bounds the
  actual PDF canvas against both the viewer and real iframe viewport.
- Native search and tools now fit narrow frames. Both popups are positioned
  outside the horizontally scrolling toolbar so they are not clipped; their options
  remain scrollable and rotation can be activated.
- Native search found the requested match on page 2, then its fixed 50px match
  scroll margin exposed mostly page 1 and reversed the current page. A small typed
  adapter retains native highlighting and keeps the selected whole page visible
  for Page Fit. Other zoom modes retain native positioning; text-layer repaint
  does not steal the viewport. The hook is restored when the document closes.
- Six unit checks cover that adapter. The complete native zoom flow passed three
  consecutive focused repetitions; short-window keyboard flows also passed in
  Chromium and WebKit. Native captures are used for visual inspection because
  the default automation screenshot cropped a zoomed WebContents capture.
- Final visual inspection caught a second false-positive: the search panel had
  valid DOM dimensions but was clipped by its scrolling toolbar ancestor. Its
  fixed positioning now escapes that clip, and the native test requires a real
  pointer click on the visible input before searching. Fresh captures show the
  actual search field and scrollable Print/Save tools, not merely hidden DOM.
- These checks do not establish physical gesture accuracy, actual screen-reader
  speech, installed Safari/Edge zoom behavior, or every native PDF dialog's reflow.
- Local rebuilt ARM64 DMG from this pass: `outputs/installer-archive-HbdktS/out/make/Gesture Reader.dmg`, 135,864,066 bytes.
  SHA-256: `f4da514763db0a2c4487b6033d67105faccfb881f2c79c2d9e86e1edc8a2de2d`.
  It remains an unnotarized local test build, not a published release.

## September 27, 2026: partial catalog recovery

- Three new baseline checks failed: one invalid record with no backup erased a
  healthy document's title/bookmarks; a stale backup replaced newer healthy state
  and resurrected a removed entry; a failed repair removed the primary catalog
  before its replacement committed, making a retry lose otherwise usable metadata.
- Recovery now validates records independently, retains healthy primary entries,
  and fills only damaged identities from the backup. Conflicting duplicate UUIDs
  (including case variants) are not resolved by arbitrarily trusting the first row.
  Valid records in a partially damaged backup can still repair the primary.
- Damaged catalog bytes are copied to uniquely named recovery files before repair.
  The source remains available until atomic replacement succeeds, so a disk-write
  failure can retry without losing healthy metadata. Original PDFs remain untouched.
- The repair report distinguishes healthy entries kept from backup entries restored
  and copies rebuilt without metadata. The 390px native recovery report was inspected;
  an actual Electron restart retained page 2 and its bookmark with no usable backup.
- All 19 desktop library unit checks, TypeScript, lint, and the focused native restart
  flow passed. The complete regression matrix passed with 218 general checks and
  two separate package checks. The copied DMG-installed app was restarted with a
  partially damaged catalog and no backup; healthy records matched their pre-damage
  metadata, and page 2, its bookmark, and Page Fit were retained offline. Fresh native
  narrow recovery, search/tools, and installed recovery/200% setup captures were
  inspected. This is not physical-camera or full store-readiness proof.
- Rebuilt local ARM64 DMG from the partial-catalog pass: `outputs/installer-archive-2BMEMZ/out/make/Gesture Reader.dmg`, 135,863,142 bytes,
  SHA-256 `6daf9c906587e070b0c6664a9d2e4c4a97425baa3e1f0791e2ec0e252af2f2aa`.
  Previous zoom-pass installer is preserved in `outputs/installer-archive-HbdktS/`.

## September 27, 2026: tracking failures and resize preservation

- Injected a 503 response for each actual locally bundled model, with synthetic
  camera streams and real workers. Baseline errors exposed local file URLs rather
  than useful instructions. Switching to the other method then reported readiness
  with a stopped camera and zero processed frames.
- Model failures now give plain, mode-specific retry instructions. Changing methods
  after a fatal tracking error restarts the camera and worker together, while healthy
  method changes continue to reuse the existing camera. Error/loading/off states clear
  stale FPS, confidence, lock and hold metrics.
- Visual inspection found the empty failed-camera preview pushing Try camera again
  below the visible panel. The error and retry action now lead the scrolling options;
  the failed preview collapses to a status strip without removing the video element
  needed for retry. Narrow 390px captures show a visible retry and camera-off control.
  Keyboard retry returns focus to the stable Close setup button rather than leaving
  it on a removed element; that path passed in both browser engines.
- The same narrow flow exposed a genuine page reversal during resize. Event traces
  showed PDF.js refitting from a cached page-1 location while page 2 was selected.
  The adapter captures the reading anchor before the native window resize handler,
  preserves the selected page around refitting, and keeps PDF-space position when
  that location belongs to the selected page. Pending anchors follow newer command
  turns and the native listener is removed when the reader closes.
- Six focused browser flows cover both model failures/retries, switching away from
  failure in either direction, stalled inference/camera release/late-result rejection,
  and real within-page position, 150% zoom and bookmark preservation across resizes.
  Failure injection is confined to local requests and the worker boundary; successful
  and retry inference run the real models. These checks do not measure physical
  gesture accuracy, OS permission/disconnection behavior or sustained device load.
- All six focused flows passed in Chromium and WebKit. The final keyboard retry and
  within-page resize flows were rerun after the focus correction. Complete regression
  verification passed with 230 general checks and two separate installed-copy/package
  checks against the rebuilt local installer. Fresh WebKit narrow-model-error,
  Chromium stalled-tracking, and installed 200% camera-denial captures were inspected.
  The installed short setup still keeps Camera Off visible while its error/retry
  options scroll; it does not promise every option is visible simultaneously.
- This round's local ARM64 DMG is now preserved at
  `outputs/installer-archive-oweopK/out/make/Gesture Reader.dmg`, 135,866,576 bytes,
  SHA-256 `ddf05b3aa8c0753a3c4eabc2c094d6113ecc963a7be5f07689c78c810abad3ab`.
  The previous partial-catalog build is preserved in `outputs/installer-archive-2BMEMZ/`.

## September 27, 2026: full-screen setup containment

- A baseline browser test demonstrated that the covered Next page control could
  still take focus while short-window setup claimed to be an accessible modal.
  Inactivating the outer reader alone still let the native PDF Find button take
  focus across the iframe boundary. The top bar, recovery banners, feedback and
  PDF are now inert and hidden from accessibility traversal during full-screen
  setup; the native PDF document is also inert without restarting the viewer.
- A shared media-query hook keeps the panel's modal presentation and covered
  reader on the same breakpoint. Focus returns after inert is removed, and the
  reader becomes interactive again on closing setup or resizing to its ordinary
  side-panel presentation. Escape, setup scrolling and Camera Off remain available.
- Full-screen setup keeps live inference for its preview and both-direction
  practice, but neither palm nor head events turn the covered PDF. Copy explicitly
  says to close setup before reading; completing calibration explains Finish then
  Close. Normal side-panel reading and gestures after closing setup still work,
  without a second camera request.
- Two new unit cases reproduced a pre-reset inference returning a late turn and
  obsolete metrics in both modes. Reset now discards that in-flight result until
  frameDone, preserving the watchdog and fresh-frame throughput. Mode changes and
  stopped/failed workers clear the discard flag. Setup boundaries reset before
  paint, avoiding the passive-effect race.
- Screenshot review caught a separate issue missed by focus-wrap tests: the setup
  header could disappear after focusing/clicking options. The retained failing
  trace recorded the outer panel scrolling by 57px. Explicit ancestor scrolling
  reproduced it independently of timing. The panel now uses non-scrollable clipping;
  only options scroll, leaving Close and Camera Off fixed. Browser tests retain
  layout/scroll diagnostics and check both controls after attempted ancestor scroll.
- These checks use actual PDF.js controls and native window zoom, but synthetic
  camera/recognition or explicit permission denial. They do not prove physical
  gesture accuracy or actual screen-reader speech.
- Final rebuilt verification passed: 134 unit tests, two rendered-output checks,
  40 Chromium and 40 WebKit browser flows, eight production-browser flows, and
  eight Electron checks (232 general checks). Two separate actual-DMG checks
  passed, including a copied installed app running offline with its managed
  library and native 200% interface zoom. TypeScript, lint and diff checks passed.
  Final Chromium/WebKit compact screenshots, scroll diagnostics and the installed
  200% setup capture were inspected; Close and Camera Off remained visible.
- This round's local ARM64 DMG is now preserved at
  `outputs/installer-archive-oahWjN/out/make/Gesture Reader.dmg`, 135,868,113 bytes,
  SHA-256 `0e538498aabe4ee4d9bb03801a504c54c398624b3d8667f500fbe4158c15044c`.
  Package inventory verified revision `dec98cd753e3554b` and all 307 runtime assets.
  The first intermediate containment build is recoverably preserved in
  `outputs/installer-archive-JgiWms/`; the earlier tracking-recovery installer is
  preserved in `outputs/installer-archive-oweopK/`. Nothing was published.

## September 27, 2026: native PDF dialogs and iframe focus

- At 180×224 CSS pixels (the actual compact Mac window at 200% interface zoom),
  the baseline password dialog extended past its iframe and clipped its controls.
  At 320×400, native Document Properties also exceeded its viewport. New browser
  checks reproduced both before changes; retained screenshots show the clipping.
- The adapter's compact native-viewer styles now constrain password, properties
  and print-preparation dialogs to their viewport with border-box sizing. Fields
  reflow rather than forcing a horizontal desktop table. Dialog content scrolls,
  while action rows remain sticky so Cancel, OK and Close stay reachable. The
  password field's center is checked for actual pointer visibility, not merely
  programmatic filling. No vendor asset or production dependency was changed.
- Native dialogs now have accessible names. Password uses its existing localized
  instruction (including the wrong-password response); document details and print
  preparation have explicit names. These DOM/role checks are not a claim about
  actual VoiceOver speech.
- Extending gesture integration to native Document Properties exposed a separate
  stuck-pause bug. Its retained diagnostic showed both parent and PDF document
  focused, native body active and the camera status still Paused after closing the
  dialog. Parent-window blur had mistaken entry into the PDF iframe for leaving
  the app. The camera loop now checks the settled document focus chain on the next
  task: iframe focus resumes appropriately, while actual document focus loss
  remains paused and resets tracking. The pending check is canceled on focus and
  teardown. The existing text-entry/modal pause guards remain intact.
- Browser flows exercise incorrect/correct passwords, keyboard dialog closure,
  named scrolling properties, real 120-page print preparation followed by keyboard
  cancellation, and successful turns afterward at both compact sizes. The OS print
  call is stubbed: no printer opens and no print job is sent. Gesture integration
  checks rejection during the native modal, resumption without clicking outside
  its iframe, and simulated document-focus loss/resumption without another camera
  request. Physical window-switch/camera behavior is still a release gate.
- The actual native Mac window at 200% zoom separately passed password retry,
  property-dialog bounds/closure, password cancellation and return to the library.
  Its captures were inspected, along with the WebKit print-progress capture. The
  tiny dialog viewport still requires vertical scrolling for long details, not
  simultaneous display of every field.
- Inspection also exposed generic native file naming (`document.pdf`) rather than
  the source filename. Original filename propagation to native properties/download
  still needs correction and verification in both managed-storage surfaces.
- Final regression passed 134 unit tests, two rendered-output checks, 44 Chromium
  and 44 WebKit flows, eight production-browser flows and eight Electron checks
  (240 general checks). Two separate DMG checks passed against the copied installed
  app offline. Its 200% document-details bounds and keyboard Close were checked;
  the capture now waits two paint frames instead of accepting a stale Tools-menu
  image. Both package checks were rerun after that verification correction, and
  the resulting actual dialog capture was inspected. TypeScript, lint and diff
  checks also passed.
- This round's ARM64 DMG (now preserved under
  `outputs/installer-archive-iiVTa4/out/make/Gesture Reader.dmg`): 135,870,507 bytes,
  SHA-256 `05e68d0de905417296a2024d719f57edbeaeb1fa33df8f7d10f853921e4a4c2f`.
  Package inventory verified revision `a4baa48450655731` and all 307 runtime assets.
  The prior full-screen-setup installer is preserved in
  `outputs/installer-archive-oahWjN/`. This build is local, unnotarized and unpublished.

## September 27: original filenames and short-window details

- Both browser engines reproduced generic `document.pdf` native details/downloads.
  The typed adapter now supplies the imported filename through the pinned PDF.js
  viewer's filename channel, refreshing it on document initialization and metadata
  load. It does not change the source URL, expose a filesystem path, rewrite PDF
  metadata or decrypt/re-save a protected document. The wrapper has no public
  filename attribute; this private integration stays isolated in the adapter and
  is covered against the actual pinned viewer rather than a mock.
- Real PDF tests cover Korean text, spaces, punctuation, two distinct documents,
  switching, reopen and page reload. Native details show the exact original name;
  all downloaded bytes equal their imported bytes. WebKit canonically decomposes
  Unicode download names on macOS, so that assertion permits NFC/NFD equivalence
  only, not changed punctuation, case or replacement names. Protected-file
  downloads remain byte-identical to the original encrypted fixture.
- The native Mac test saves the Unicode-named download only to an isolated QA
  profile. The copied DMG-installed app separately passed original-name/details
  and exact-byte download after restart offline. No real Save dialog, user download
  location or original PDF is changed by those tests.
- A follow-up long-filename check exposed a separate containment failure in both
  engines at 1280x300: the native details dialog extended outside its iframe and
  opening it focused the bottom Close action with filename rows above the visible
  area. The prior containment only applied below 350px width. All three native
  dialogs now have viewport-bounded sizing regardless of width and a sticky action
  row; compact widths retain their existing stacked fields. Details remain
  scrollable, rather than shrinking text or hiding fields.
- Six focused filename/password/print flows passed in each browser engine after
  that correction. The long-name flow exercises 1280x300, 500x360, 390x640 and
  180x224, scrolls to the actual original name, checks bounds/no horizontal overflow,
  closes by keyboard and turns a page afterward. The corrected wide/short WebKit
  capture was inspected: the complete long filename wraps and Close stays visible.
- Before the final short-window correction, the complete suite passed 242 general
  checks and two separate DMG checks. That interim installer is preserved under
  `outputs/installer-archive-LeSM6S/`: 135,872,197 bytes, SHA-256
  `2d366f42bcd35e76d59b90e13c30f78205ef03220c49263de6e21f0b3a6acbc1`.
  Its inventory verified revision `3866d00037e2269e` and 307 assets.
- Final regression passed 134 unit, two rendered-output, 46 Chromium, 46 WebKit,
  eight production-browser and eight Electron checks (244 general checks), plus
  two separate checks against the newly copied DMG-installed app. Native 200%
  zoom also exercised a wide/short viewer with the long name and keyboard Close.
  Its actual window capture and the current installed compact details capture
  were inspected. Additional focused reruns passed in Chromium, WebKit and native
  Electron after strengthening the long-name test to scroll to the `.pdf` suffix
  and hit-test it: even its last line remains readable above the sticky action,
  not just present in the DOM. Tiny viewers still need vertical scrolling to read
  a long value; the complete details are not all simultaneously visible.
  TypeScript, lint, diff checks and all 134 unit checks passed again afterward.
- This round's ARM64 DMG (now preserved under
  `outputs/installer-archive-7AGxOo/out/make/Gesture Reader.dmg`): 135,872,173 bytes,
  SHA-256 `eb5bf9995ef423adc7ca74650d625a90fbf22113c426257dfcab62f3a1ff332b`.
  Inventory verified revision `8833cbc3b7dbfcd7` and all 307 runtime assets.
  This build is local, unnotarized and unpublished. Prior installers remain
  recoverable in their named archive directories.
- Physical palm/head accuracy, real OS camera behavior and VoiceOver output remain
  unverified release gates. These filename/dialog checks do not satisfy them.

## September 27: optional browser storage and actual quota recovery

- Browser tests reproduced a rejected storage estimate hiding successfully
  imported documents behind a false library failure, and a never-settling estimate
  keeping Add PDFs disabled. Library refresh now waits only for the real catalog;
  the optional usage/persistence estimate updates separately with the existing
  generation guard. A late response cannot overwrite newer refresh state or an
  unmounted app. Unknown capacity shows `— used`, a precaution about keeping
  original PDFs, and no invented capacity bar. Normal reading/import remain usable.
- A unit baseline also reproduced an optional persistence call throwing after
  bytes had already committed, incorrectly rejecting the overall import. The
  request is still made after a successful import/restore, but its result cannot
  reject or stall the committed import. A browser never-settling persistence flow
  separately verifies the import spinner clears and its PDF opens.
- The estimate fault fixtures now patch the StorageManager prototype and assert
  unknown usage explicitly; patching a single returned manager instance did not
  reliably keep the fault active on every call/engine. Rejected/stalled cases then
  passed in Chromium and WebKit through import, page turn, return and page reload.
  The persistence flow and all eight web-repository unit checks also passed.
- The actual-quota flow uses a newly created normal Chromium profile, the official
  [CDP quota override](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Storage.pdl),
  and real IndexedDB writes, not a repository or thrown-write mock. Immediate
  checks initially still allowed writes despite CDP reporting the override. The
  [native bucket implementation](https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/instance/bucket_context.h)
  caches available space for 30 seconds; the test explicitly lets that cache expire
  before writing. Browser-reported capacity is attached as evidence, not assumed
  equal to CDP's configured limit.
- With the real constrained write, the error explains removing unused app copies
  and retrying, while explicitly saying original files are not deleted. The test
  passed with catalog/blob count and previous bookmarks unchanged; restoring the
  quota then allowed reimport without page reload. Seeded high-entropy PDF comment
  bytes keep the distinct fixture substantial without changing its readable pages.
  The WebKit suite explicitly skips this Chromium-only CDP case; its optional-API
  paths are exercised independently. No computer disk was filled. Cleanup removes
  only the temporary QA profile, never a user's library or browser profile.
- Final regression passed 135 unit, two rendered-output, 50 Chromium, 49 WebKit,
  eight production-browser and eight Electron checks (252 general checks), plus
  two separate DMG-installed-copy checks. The Chromium-only quota case is
  explicitly skipped in WebKit, not counted as a WebKit pass. TypeScript, lint
  and diff checks also passed. The current quota-error and unknown-capacity
  browser captures were inspected: the library stays available, its previous
  page/bookmark remain visible, and error guidance is readable.
- Current local ARM64 DMG: `out/make/Gesture Reader.dmg`, 135,871,903 bytes,
  SHA-256 `f6b3d20746615b40f39aab0ddccbe0ba059522a240a0cb46a3acea81597319b5`.
  Its inventory verified revision `cf182dc20c4d3950` and all 307 runtime assets.
  The previous installer remains archived. This build is local, unnotarized and
  unpublished. Physical gesture accuracy, VoiceOver, real storage eviction and
  interrupted/low-storage PWA installs remain release gates; neither this fault
  injection nor this quota case proves them.

## September 27: usable full-storage recovery and removal focus

- A second actual-quota test now follows the guidance a user sees: remove an
  unused app-managed PDF, then retry the failed import without changing the
  configured quota or reloading. An isolated normal Chromium profile, native
  IndexedDB writes and the official CDP override constrain capacity. The unused
  and replacement fixtures contain high-entropy binary attachments to avoid
  storage compression; no production dependency or user PDF is changed. The
  retained PDF's complete catalog record, saved page and bookmark survive, and
  the temporary original source remains byte-identical after removal. This is
  Chromium-only; WebKit explicitly skips the CDP cases rather than claiming them.
- That UI flow exposed a keyboard defect: after successful removal, the original
  focused button disappeared and focus fell back to the document body. Ordinary
  next-card and search-filtered removal tests independently reproduced it. The
  app now queues restoration only after successful deletion, then waits for the
  actual catalog refresh. Visible DOM order chooses the next card, then previous
  card; Search handles a removed final search match, and Add PDFs handles an empty
  library. Cancel and failed removal retain their existing safe behavior.
- If a user moves focus while a slow refresh is pending, the restoration must
  not steal it. A real read-only IndexedDB transaction held open by continued
  reads exercises that race in Chromium and WebKit without inserting production
  delays or replacing catalog data. Focus on Search survives the eventual update.
- Focused checks passed three keyboard cases in each browser engine, the actual
  quota-removal flow and the native disk-failure/removal retry case. The narrow
  browser capture was inspected: error guidance remains readable and the retained
  card has a visible focus ring. TypeScript, lint and diff checks passed. Full
  regression and the fresh installed-copy check subsequently passed; the prior DMG
  is recoverably archived at `outputs/installer-archive-n2vnqr/out`.
- This does not certify physical gesture accuracy, VoiceOver, browser eviction,
  PWA installation or downloaded-app permission/Gatekeeper behavior. Those
  release gates remain open; nothing has been published or pushed.
- The first complete regression passed 259 general checks and both package
  checks, but inspecting the real installed-copy screenshot found a material
  issue those assertions missed: in a 360×480 native window at 200% interface
  zoom, the removal toast became a tall oval obscuring the focused Add PDFs
  button. A new actual-overlap assertion failed against that DMG, confirming the
  visual defect rather than accepting its passing focus/viewport assertions.
- Notifications now have bounded corners and non-shrinking icons. Library
  notifications move into normal flow immediately below the header when width
  is at most 300 CSS pixels or height at most 420, keeping the full message and
  leaving controls unobscured. Normal windows retain floating feedback; reader
  notifications stay non-interactive. Browser assertions cover 180×224 and
  640×300 views in both engines. The focused checks, TypeScript, lint and diff
  checks passed; the installer and full regression were rebuilt/rerun.
- The rebuilt DMG passed both package checks including the new actual-overlap
  assertion. Its 200%-zoom native capture was inspected: Add PDFs is unobscured,
  and the complete message sits in the scrollable library layout below the
  header instead of floating above it. The intermediate defective build is
  archived at `outputs/installer-archive-eEwXgm/out`.
- One subsequent general rerun failed the existing three-page print checkpoint:
  the native-print stub reported zero instead of three. Its trace is preserved
  under `outputs/print-failure-RdapPm`; inspected console/network records did not
  identify the cause. Twelve parallel repeated print/fullscreen cases passed
  unchanged, but that does not resolve the intermittent failure. Another full
  regression then passed unchanged; keep print reliability open for further diagnosis.
- Final regression after the notification correction passed 135 unit, two
  rendered-output, 54 Chromium, 52 WebKit, eight production-browser and eight
  Electron checks (259 general checks). The two Chromium-only actual-quota
  cases remain explicit WebKit skips. Both corrected DMG checks passed, including
  offline installed-copy reading and the focused-button/notification overlap
  assertion. Current ARM64 DMG: `out/make/Gesture Reader.dmg`, 135,864,560 bytes,
  SHA-256 `db9aa77276045beb7b377aff2b0823bc8dcf25b9096c75939199f0d9d4497c41`,
  runtime revision `8fb6afe1d2972204` with all 307 assets. It remains local,
  unnotarized and unpublished. Passing reruns do not erase the preserved print
  failure or satisfy the remaining physical/accessibility/platform gates.

## September 27: diagnosed print checkpoint timing

- Test-only print lifecycle instrumentation reproduced the five-second timeout
  in two of 30 parallel Chromium runs, then three of 20 runs with encoding
  diagnostics. In each latter failure, PDF.js had started printing and submitted
  its first 1275×1650 canvas to `toBlob`, but the conversion callback had not
  arrived. The document was visible; there was no cancellation or image error.
  The original snapshots/console alone could not distinguish this waiting state
  from an aborted job. New diagnostic traces are retained under
  `outputs/print-diagnostics` and `outputs/print-blob-diagnostics`.
- Twenty parallel forensic runs with a longer bounded checkpoint all completed
  three-page printing. One first-page conversion took 6709.6 ms, and two took
  about 1007 ms; subsequent conversions in those jobs took 5–30 ms. This matches
  [Chromium's canvas encoder](https://chromium.googlesource.com/chromium/src/+/lkgr/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc):
  PNG encoding uses idle work with a desktop 1000 ms start fallback and a
  5700 ms completion fallback. Its source explicitly notes that their combined
  6.7-second deadline can exceed a six-second web-test limit. This is evidence
  of a too-short automated checkpoint, not an observed lost print job.
  `outputs/print-encoding-timing-report.json` retains the timing/lifecycle data.
- The production viewer and print resolution are unchanged. The test now waits
  up to 25 seconds for its actual native-print checkpoint (allowing the three
  pages' browser encoding fallbacks), still requires exactly three pages, and
  additionally requires every page image to be fully loaded at 1275×1650
  pixels (150 DPI for the 612×792-point fixture). Closing a dialog or merely
  inserting image elements cannot satisfy it. No retries or synthetic success
  signal were added; the native OS print call alone remains intercepted so no
  physical job is sent. Lifecycle/image-error/encoding data are attached even
  if the checkpoint fails.
- With the stronger image assertions, 20 single-window Chromium cases and
  12 WebKit cases passed. Chromium reported version 149.0.7827.55; its slowest
  single-window conversion was 140 ms and its slowest complete test 1675 ms.
  The retained JSON report is `outputs/print-single-window-report.json`.
  Full regression with the stronger checkpoint passed 135 unit, two rendered,
  54 Chromium, 52 WebKit, eight production-browser and eight Electron checks
  (259 general checks), plus the two separate DMG checks. TypeScript, lint and
  diff checks passed. The full Chromium run also exercised the slow conversion
  and completed printing correctly. The current DMG is unchanged because this
  round modified only tests and documentation. These findings diagnose the
  observed intermittent timeout, not
  all future print failures or actual printer/heavy-document performance.

## September 27: vector-heavy reading, footer-search correctness and real PDF workers

- A new deterministic, authoring-only recipe builds a 24,245,166-byte (23.1 MiB),
  16-page synthetic vector chart report. Each page has eight clipped charts,
  40 visible traces of 500 samples per chart, transparent scatter marks,
  selectable labels and outline entries. Structural checks confirm no image
  pages and the distant page-12 search label. Poppler rendering was inspected
  before app testing; the first-page plots/labels are intact. This is a QA
  intermediate, ignored by Git and never packaged or deployed, not customer
  content or unused padding. No production dependency was added.
- Its production-browser flow measures actual finished page renders and a paint
  opportunity, import/open, four turns, distant footer search, library return and
  bookmark/reopen, with animation-frame gap reports at 2x pixel density. It shares
  the scan check's broad five-second import/open and 750 ms painted-turn smoke
  budgets, not a universal performance SLA. Both
  browser baselines failed the saved-page check: searching a page-12 footer then
  closing Find allowed PDF.js to select the mostly visible next page (13), so
  bookmarking and reopening retained the wrong page. Merely seeing an initial
  page-12 label was insufficient; it could change on the next scroll update.
- The typed search adapter retains native highlighting, horizontal position and
  zoom, while bounding vertical scrolling to the matched page. A short page
  remains fully visible; a tall page does not expose mostly its neighbor when
  the match is near a footer. Repaints/unselected matches still do not steal the
  viewport, and document disposal restores the original method. Four new unit
  cases cover upper/lower/already-contained and short-page geometry. Three small
  footer regressions cover page-width, 150% and page-fit in both engines, including
  actual visible highlight, native/outer page agreement, bookmark and reopen.
  The test uses the native visible Match Case label rather than trying to click
  its intentionally hidden checkbox input. A paint poll now waits when a reopened
  viewer has not allocated its page views yet instead of throwing prematurely.
- Diagnostics also exposed real `LoopbackPort` PDF workers in both browser
  baselines. The pinned wrapper uses an `about:srcdoc` iframe, while its worker
  attribute was root-relative. PDF.js resolves a cross-origin worker using that
  iframe URL; this resolution fails and falls back to UI-thread parsing. The
  renderer now resolves bundled runtime assets against the real application origin
  before mounting the viewer. No CSP, protocol allowlist, PDF bytes or runtime
  dependency changed. The actual worker port is now asserted, not inferred from
  the presence of a worker asset or constructor call.
- Three production runs per engine passed both fixes. Compared with one prior
  same-machine, 2x baseline per engine, Chromium's cold-open maximum frame gap
  fell from 835.4 ms to 40.6–48.5 ms, with fully painted open 1501.9 ms versus
  884.6–921.2 ms. WebKit's gap fell from 644 ms to 111–115 ms, with open 1363.3 ms
  versus 590.7–618.6 ms. All six corrected reports identify a real `Worker`; both
  earlier reports identify `LoopbackPort`. These are bounded synthetic-fixture
  observations, not a universal speed guarantee or thermal qualification.
  Reports are preserved under `outputs/vector-worker-diagnostic` and
  `outputs/vector-threaded`. The corrected app screenshot was inspected: the
  page-12 footer, outer/native page 12 and saved bookmark agree, without page 13
  filling the viewport. The 700+ ms original cold-open gap motivated diagnosis,
  not lowering pixel density or simplifying the fixture to pass.
- The first worker-only full regression failed CJK rendering (56 Chromium cases
  passed, one failed). Its trace proved that the real blob worker could not
  resolve root-relative `cmaps/UniJIS-UCS2-H.bcmap`, `UniGB-UCS2-H.bcmap` and
  `UniKS-UCS2-H.bcmap` URLs. The correction resolves maps, fonts, ICC data, images,
  sandbox and WASM as well as the worker against the app origin. Both browser
  engines then passed all four focused CJK/footer checks; their screenshots show
  readable Japanese, Chinese and Korean with real workers and no external requests.
  The failed trace is retained under `outputs/cjk-worker-failure-1vYAfS`.
- Focused browser footer cases and the native import case now pass with actual
  worker assertions. The installed-copy tests additionally exercise footer Find
  at real 200% interface zoom and CJK asset fetches through the offline desktop
  protocol. The first expanded package run exposed two automation errors: it
  selected a zoom control that PDF.js intentionally hides below 560 CSS pixels,
  and filled the native page field without establishing actual mouse focus.
  The zoom is now selected visibly at wider 200% zoom before shrinking again;
  CJK page jump clicks the field before filling/Enter. The focused installed CJK
  flow then passed and its readable three-language screenshot was inspected.
  Failed package evidence is retained under `outputs/package-worker-failure-WmwFtA`.
  The complete 269-check general regression and all eight optional performance/model
  checks passed before the subsequent native-fit correction below.
  The previous DMG is recoverably archived at
  `outputs/installer-archive-X4Pyss/out`; the intermediate worker-only package is
  retained at `outputs/installer-archive-9O0vsY/out`. Physical accuracy, screen-reader speech,
  actual printer behavior, installed-browser/PWA lifecycle, near-limit/repeated
  large imports and sustained memory/thermal behavior remain open release gates.

## September 27: native whole-page fit after a footer search

- The expanded installed-copy flow exposed a further real navigation bug after
  its automation mistakes were corrected. Widening the window preserved page 2;
  choosing native Page Fit then changed it to page 3. Recorded events show the
  old page-2 XYZ anchor (top 307) being reused during scale change, followed by
  a page-3 selection before the scale event. This was not a download failure.
  Evidence is retained under `outputs/footer-zoom-diagnostic`.
- Two browser reproductions at 640x300 and 1280x300 also failed after the native
  fit selection. The viewer now captures only the native zoom select's Page Fit
  change before PDF.js handles it, positioning the currently selected whole page
  and refreshing its scroll anchor first. Numeric and page-width zoom retain
  their native within-page behavior; startup is guarded and disposal removes
  the listener. No runtime dependency or document bytes changed.
- All six focused CJK/footer/fit checks passed in each browser engine. The new
  fit cases require outer/native page agreement, the actual Page Fit value,
  bookmark and reopen on page 2. The corrected short-window screenshot was
  inspected and shows the whole selected page rather than its next neighbor.
- The rebuilt DMG passed all three package checks, including the previously
  failing footer-fit sequence, offline CJK maps through the desktop protocol,
  real workers, original-byte download and managed-state restoration. The full
  general regression passed 273 checks; all eight optional workload checks,
  TypeScript, lint and diff validation also passed. A separate final package
  rerun retained artifacts under `outputs/package-fit-verified` so the general
  suite cannot clear them. Its 200% footer-fit and offline CJK screenshots were
  inspected: native/outer page numbers agree and the expected page is visible.
  The pre-fit package is recoverably retained at `outputs/installer-archive-N2fefQ/out`.
- The final production vector reports record fully painted open at 906.5 ms in
  Chromium and 585.9 ms in WebKit, maximum open frame gaps of 49/99 ms, and
  painted turns of 78.6–303.8/95.2–279.7 ms respectively. Both report actual
  `Worker` ports, no page errors and reopening page 12 with its bookmark. These
  are this machine's synthetic 2x results, not physical gesture latency or a
  universal PDF performance guarantee.

## Near-limit scans and native memory amplification

- Generated a 256-page, 519,607,538-byte (495.5 MiB) synthetic scan book, below
  the actual `500 * 1024 * 1024` limit. Every page contains a unique visible
  high-resolution JPEG, not unused padding. First/last pages were rendered and
  visually checked. The authoring recipe also retains its default 32-page mode;
  generated PDFs are ignored and never shipped with the app.
- Added separate Chromium/WebKit/Electron stress flows: near-limit import,
  completed-page painting, real PDF worker use, page boundaries, bookmark and
  saved-page restoration, removal, and three repeated 61.9 MiB library cycles.
  Browser teardown checks live worker lifecycles and document URL release.
  An initial probe incorrectly counted only explicit `terminate()` calls and
  retained worker/iframe references itself. It was corrected before interpreting
  memory results; the probe failure was not evidence of an app worker leak.
- The native baseline did reveal excessive main-process allocation: sampled
  peak RSS was 2,784,231,424 bytes (2.59 GiB), and sampled external memory was
  2,093,068,308 bytes. The protocol allocated a complete buffer for every PDF
  response, which `Response` copied again. Native import separately read the
  full file into RAM. These are actual allocations, not an assumed leak.
- PDF responses now use descriptor-owned, 64 KiB disk streams with a byte-sized
  web-stream queue. Completion/cancellation closes the descriptor. HEAD, suffix,
  open-ended and unsatisfiable ranges have checks; unsatisfiable requests return
  416 rather than incorrectly serving the final byte. Native dialog import now
  copies to app-managed staging on disk, validates and stream-hashes that copy,
  then shares the existing duplicate/restore/atomic-catalog commit path. Originals
  are only read. Failed imports remove their staging and committed-copy rollback
  remains covered. No production dependency was added.
- The first corrected native near-limit run sampled peak RSS at 251,510,784 bytes
  (239.9 MiB), about 91% lower than baseline, with 60,974,184 bytes of external
  memory. Fully painted open was 1,352.7 ms; native import plus the test's copied-
  file hash verification was 3,125.1 ms. Three smaller cycles also passed, with
  external memory after removal at 4.5/27.1/4.0 MiB. Evidence is retained under
  `outputs/stress-native-baseline`, `outputs/stress-native-streamed` and
  `outputs/stress-native-bounded`.
- Measurements are main-process-only, natural-GC samples at 200 ms, so they can
  miss brief peaks and exclude renderer/GPU memory. New sampled regression gates
  allow at most 128 MiB external memory and 256 MiB RSS growth over startup for
  these isolated workloads. Chromium's separate forced-GC teardown gate allows
  16 MiB retained buffer backing; this is not a natural-GC or peak-memory claim.
  WebKit's corresponding memory field is explicitly unavailable. Real-world
  complex files, long sessions, thermal behavior and physical inference remain
  unqualified.
- The final expanded run passed all six checks, including actual native page-
  number input to paint page 256, disabled Next at the boundary, returning to
  page 1 and then restoring page 2/bookmark. Native near-limit sampled peak RSS
  was 243,154,944 bytes (231.9 MiB), external peak 66,348,100 bytes; completed
  open was 1,359.1 ms. The three smaller native cycles ended with 8.5/7.9/15.5 MiB
  external memory. Chromium after near-limit removal retained 7,181,461 bytes
  of measured backing storage; the three smaller cycles retained roughly
  4.7/4.7/4.8 MiB. Both browser engines report zero live document workers,
  zero explicitly held document-blob bytes, no storage errors and no page errors.
  The complete 275-check general suite, TypeScript/lint, and eight separate
  workload/model checks passed. Final reports/screenshots are retained outside
  the general suite's cleared directory at `outputs/stress-final-browser`,
  `outputs/stress-final-native` and `outputs/performance-streamed-verified`.

## September 27, 2026: bounded native soak and dependency follow-up

- Added an optional five-minute native processing test with four one-minute
  palm/head phases, 48 painted manual page turns, three camera restarts, and
  natural-GC idle sampling. It uses the actual local models but a moving
  synthetic rectangle, not a human hand/face or physical camera.
- The pre-dependency-update run completed 930/910/917/903 inference frames,
  averaging 14.9–15.3 FPS. Manual painted turns stayed below 66 ms on this
  machine. Input was bounded to 640×360, with one frame in flight. Camera tracks
  ended after disable; vision workers terminated; leaving the reader removed
  the remaining PDF worker. No page exceptions or HTTP(S) requests were observed.
  The idle top-isolate heap was about 10.1 MiB and backing storage about 6.5 MiB.
  These are scoped measurements, not exclusive whole-app RAM, absence of leaks,
  tracked-landmark performance, physical gesture accuracy, or thermal certification.
  This historical run predates the dependency/landing changes below.
- An initial test-harness attempt attached its sampler before Electron created
  the window. The test now waits for the window and enabled import control.
  Sampling retains counters rather than frames/Worker objects, and phase labels
  change before model startup so startup is not attributed to a previous phase.
- Updated existing Next/eslint-config-next pins to 16.3.6 and removed overrides
  that forced older sharp/PostCSS versions over upstream dependencies. The lock
  now resolves sharp 0.35.4, PostCSS 8.5.23 and nanoid 3.3.19 for those paths.
  No new production dependency was added. The unused Worker image-processing
  endpoints explicitly return 404; three boundary unit tests cover this.
- A fresh `npm audit --omit=dev` reports zero known advisories. The full audit
  still reports 48 affected package entries (5 low, 2 moderate, 39 high, 2
  critical), primarily in development/build tooling. Counts include propagated
  dependency paths, not 48 distinct vulnerabilities. Reachability and compatible
  toolchain upgrades still need review; this is not a blanket security clearance.

## September 27, 2026: public landing page and publication

- The first-import landing page now explains head-right/left and palm-left/right
  directions, camera opt-in, conventional controls and explicit whole-page fit.
  A new browser test checks 1440/390/280px widths and zero camera requests on entry.
  The 390px rendered screenshot was inspected; controls and copy stay contained.
- Added a dedicated `build:pages` static export for the existing public Cloudflare
  Pages project. Only `dist/client` is uploaded; the default Worker hosting and
  locally packaged Electron targets remain available. Updating the public site
  does not update previously downloaded macOS installers.
- The first plain-file export probe passed reading/offline checks but exposed a
  framework homepage prefetch to `/.rsc` returning 404. Pages now rewrites it to
  the exported `index.rsc`; the offline manifest includes that payload, and the
  service worker resolves its per-request query from this build's cache.
  A Pages-specific check verifies route bytes, offline payload retrieval,
  camera/microphone policy, no-cache HTML/SW headers, WASM/worker MIME types and
  absent image-processing APIs. Both browser engines are exercised against
  Wrangler's local Pages server, not a generic file server.
  The separate server/Worker production suite passed all eight checks again
  after this shared service-worker change; rendered output, TypeScript and lint
  were rechecked. Generated Wrangler QA shims are excluded from source linting.
- The first local Pages-server attempt inherited the generated Worker target's
  no-bundle setting and failed before browser tests with a missing Wrangler
  watch module. The QA command explicitly enables bundling for the Pages shim;
  no application dependency or production Worker is added to the static site.

## Verification commands

Latest complete pass: lint and TypeScript succeeded; **144 unit tests, 2 rendered
output checks, 60 Chromium tests, 58 WebKit tests, 8 production-browser tests,
and 8 Electron tests passed (280 checks total)**. Two Chromium-only quota cases are
explicitly skipped in WebKit. Both web and
desktop renderer builds succeeded. Screenshots of the compact reader, unlocked
encrypted PDF, returning library, scanned/CJK pages and natural rotation were
inspected. The PDF inspection workflow caught a clipped fixture rotation during
generation; the fixture was corrected before the browser matrix was run.
Fresh normal-width compact and 200% root-text reader screenshots were inspected
in Chromium and WebKit after the keyboard/focus corrections. `git diff --check`
also succeeded. Large lazy PDF/vision chunk warnings remain; this is not a
performance or physical-camera acceptance result.
The dedicated Pages static-export suite separately passed ten Chromium/WebKit
checks after the homepage routing/cache correction. These are outside the
280-check general-suite count. The exported landing screen was inspected at
390px, with additional automated 1440/280px containment and camera-opt-in checks.
The native damaged-catalog/backup retry flow passed against the freshly rebuilt
desktop renderer; its desktop and narrow recovery screenshots were inspected.
The expanded optional production performance suite separately passed eight checks;
it is not included in the general-suite count. The actual DMG inventory and
installed-copy flows separately passed three package checks; they are also outside
the general-suite count. Final CJK, footer-fit and compact installed screenshots
were inspected, including actual 200% native zoom.
The separate near-limit/repeated-library stress suite passed six checks after
bounded native import/streaming changes, including last-page paint, disabled Next
at the boundary and browser/native memory regression gates. It is also outside
the general-suite count. New native tests cover streamed cancellation/range
semantics, native staged-copy deduplication/restoration and catalog-failure retry.

Most recent separately verified local ARM64 DMG: `out/make/Gesture Reader.dmg`, **135,867,140 bytes**,
SHA-256 `a3c9445e39312025ca89b814044fe5657f9a1a05c9957c613ca1d7745ff08263`.
The installed inventory verified revision `81ed0610750267ac` and **307 assets**.
This build is ad-hoc signed, unnotarized and unpublished; earlier installers
remain recoverably archived. No physical camera was activated in this round.
This installer predates the subsequent dependency and landing-page changes;
publishing updated source/web files does not qualify or update that installer.
The post-streaming package passed all three actual-DMG checks: signature/asset
inventory, copied installed app with offline reading/models/state restoration,
and offline CJK maps with a real worker. Its 200% footer-fit and CJK screenshots
were inspected. Evidence is retained at `outputs/package-streamed-verified`;
the previous verified installer is retained at `outputs/installer-archive-kvfSeb/out`.

- `npm run lint`
- `npx tsc --noEmit`
- `npm test`: unit tests, web build, rendered-output checks, Chromium/WebKit flows,
  production offline/update flows, desktop renderer build, and Electron integration tests.
- `npm run test:production` builds and runs the production offline/update suite
  separately from development-server tests.
- `npm run test:pages` checks the dedicated Cloudflare Pages static export
  separately from the Worker/server-rendered production target.
- `npm run test:e2e:webkit` runs the same reader flows with the Safari engine.
- `npm run electron:package && npm run test:packaged` builds and checks the actual
  macOS DMG. It is separate from development Electron checks and uses a temporary
  installation/profile, with actual models and synthetic video rather than a webcam.
- `npm run test:performance` is separate from `npm test` and requires the locally
  generated scan-heavy and vector-heavy fixtures. It measures both engines at equal pixel density
  and exercises actual models with synthetic video; it is not physical accuracy.
- `npm run test:stress` separately checks Chromium/WebKit and native managed
  storage with generated 32/256-page scan fixtures. It verifies resource teardown,
  streamed protocol/native copying and original-file hashes; bounded memory probes
  are not whole-application or long-session qualification.
- Browser screenshots are regenerated in `test-results/`, including
  `library-desktop.png`, `library-narrow.png`, `reader-narrow.png`,
  `camera-denied.png`, and `encrypted-unlocked.png`.
- The Electron test imports a real PDF through the native import IPC path,
  using a deterministic file-dialog selection, reads pages, bookmarks, closes,
  recovers a missing managed copy, and reopens. The separate security/storage test verifies isolated renderer
  APIs, local assets, and byte-range reads.
- `npx playwright test tests/e2e/pdf-corpus.spec.ts --config playwright.webkit.config.ts --grep 'distant search' --repeat-each 12 --workers 3`
  passed all 12 repetitions after viewport-resize deduplication.
- `npx playwright test --config playwright.electron.config.ts --grep 'native import' --repeat-each 12 --workers 1`
  reproduced one native page reversal before the immediate viewport update;
  all 12 repetitions passed after rebuilding with the correction. Event
  diagnostics are attached to native tests for any future recurrence.

On this external-drive checkout, the development file watcher has served stale
modules after edits. Stop the owned development server before verification and
let Playwright start a fresh one. A passing test against stale code is not proof.

## Remaining release-quality gates

| Requirement | Current evidence and remaining work |
| --- | --- |
| Reliable palm and head control | Deterministic sequences, fake-camera integration, real face-model initialization are covered. These do **not** establish physical accuracy. Measure both directions at 0.5-1.5m, at least 18/20 intended gestures per direction, exactly one turn per recognition, and zero accidental turns during five minutes of neutral reading. Test internal/external cameras and poor light. |
| Complete PDF reading experience | Text, encrypted/malformed files and a synthetic scanned/CJK/rotated/mixed-size 120-page matrix are exercised in both browser engines, including outline, search highlighting, selection, layout restoration, fullscreen, print preparation and original-byte download. The intermittent five-second print checkpoint is now traced to Chromium's 6.7-second idle-encoding fallback under parallel load; a bounded wait and stronger fully loaded image checks pass repeated Chromium/WebKit runs. Complex real-world documents, heavy-document print performance and actual OS printer behavior remain unverified. |
| Responsive, clear setup | Library, compact reader, and desktop/short narrow setup inspected. Head-tilt discovery, visible off control and calibration exit have regression coverage. An explicit whole-page fit now supports hands-free reading without silently replacing saved zoom; content-bounds, rotation/layout preservation, reopen, failure/retry, keyboard activation and non-obscured off controls are checked. Continue first-time-user feedback and full keyboard/screen-reader review. |
| Accessible end-to-end use | Keyboard import/open/return, card and Continue focus restoration, empty/saved bookmark traversal, setup key isolation, native Find and iframe exits, 200% root text in a narrow reader, selected contrast/targets and outer/iframe reduced motion have browser checks. Real Electron 200% zoom now covers compact setup, focus containment/return, camera off, whole-page bounds, search, turns, rotation and library reflow. Actual screen-reader output, every native PDF action/dialog and installed Safari/Edge zoom remain unverified. |
| Honest recovery under all failures | Import, connection, save, missing managed files, malformed-PDF and camera-denial paths are exercised. Reimport keeps identity/state. Desktop catalog-write rollback/retry, interrupted removal, damaged/missing catalog reconstruction and extra backup failure/retry now have checks, including native restarts and honest state-loss reporting. Partial catalog damage preserves healthy metadata, limits stale-backup restoration, and remains retryable after failed commits; the actual DMG-installed reader retained its saved page/bookmark offline. Canceled password prompts and analysis-worker cleanup are covered. Injected actual local-model failures in both modes, healthy real-model retries, alternate-method recovery, stalled inference/camera release and late-result rejection now pass in both browser engines. Continue full browser-storage eviction, physical camera disconnect and unsupported-browser/WASM failure checks. |
| Cross-browser web support | Chromium and Playwright WebKit reader flows, fake-camera routing/recovery, and real bundled models are covered. Installed Safari/macOS permission behavior and Edge-specific behavior are still unverified. |
| Offline PWA | Chromium and WebKit production tests verify fresh launch with the origin disconnected, local PDF import/reading, both bundled model initializations, cache repair and update approval. Still verify installed-PWA lifecycle and interrupted/low-storage installs. WebKit tests deliberately avoid the known offline-emulation defect. |
| Privacy/security | Existing local-origin/CSP/IPC checks remain; production import/reading/model-switch flow observed no external requests. Still exercise production calibration and physical-device sessions in the final network audit. |
| Performance | A 61.9 MiB scan-heavy PDF and 23.1 MiB vector chart report are timed against production builds in both engines at 2x pixel density, with finished-page paint checks. Vector work exposed UI-thread fake workers and incorrect footer-page retention; real PDF workers, local font/map fetching, search/bookmark/reopen and native Page Fit after a footer now have checks. Separate Chromium/WebKit/Electron flows passed a 495.5 MiB, 256-page scan book and three repeated 61.9 MiB import/read/remove cycles, including finished first/last-page paint, boundaries and saved-state restoration. Native memory amplification was corrected using streamed PDF responses and disk-staged, chunk-hashed imports; bounded main-process samples and Chromium forced-GC teardown buffers have regression gates, not whole-app memory qualification. Actual models process synthetic 1080p, 30 FPS input for 20 seconds per mode in both native-resize and canvas-fallback paths while reading the scan book; resized dimensions, queue size, mode switching, manual controls and resource release are checked. These do not qualify actual hand/face inference, installed-Safari frame latency, all real-world complex files or sustained CPU/memory/thermal behavior. Large lazy PDF/vision chunks remain. |
| Packaged macOS experience | Actual ARM64 DMG built; Applications shortcut, signature, Info.plist and full runtime asset inventory checked. A copied installed app outside the checkout reloaded/read/inferred offline and restored managed state after restart. Real native compact window constraints and source-safe removal are checked. User Applications-folder installation, downloaded-file Gatekeeper/quarantine behavior, real OS camera permission/disconnection and native printer dialogs still require verification. |

Earlier quality fixes were packaged as a local unnotarized test build. Subsequent
source/web publication is not a new macOS installer release or store approval.
