# Foluma 0.1 validation

Environment: macOS arm64, Python 3.14.4, PyMuPDF 1.28.2, Pillow 12.3.0, Node 25.8.2, Rust 1.98.1. The app uses a bundled interpreter; the end user does not need these development tools.

## Visible import and parsing progress, 2026-10-10

The macOS app was rebuilt and passes strict deep signature verification. Traditional Chinese 0.4.15 includes the progress labels.

All 31 TypeScript checks, strict TypeScript including unused-symbol checks, Vite production build and whitespace checks pass. Browser checks used the actual desktop frontend with substituted task events to verify progress directly under the toolbar without opening status, separate bars for concurrent books, running/queued counts, live page counts and percentages, cancellation by task ID, indeterminate queued/unknown-total work, and automatic removal after completion, cancellation or failure. Previous-project preparation and export tasks do not appear in this area. English and Traditional Chinese were visually checked at 1180 × 820 and 860 × 600. Task execution and cancellation APIs are unchanged; large-book performance was not re-measured.

## Installed plugin updates, 2026-10-10

All 31 TypeScript checks, strict TypeScript including unused-symbol checks, Vite production build and whitespace checks pass. The macOS app was rebuilt and passes strict deep signature verification. Traditional Chinese 0.4.14 adds the update labels; the editor remains 0.4.6.

Browser checks used the actual desktop frontend with substituted plugin RPC responses. Installed rows expose an orange update badge, current/new versions and Update action; installed IDs no longer repeat in Included or Catalog. Checks cover offline bundled updates taking precedence over newer cached downloads, official-only updates, failed installation retaining the current version, preserving a disabled plugin, and replacing an installed version with Restart needed. English and Traditional Chinese layouts fit at 1180 × 820 and 860 × 600. Official network downloads were not performed in this pass; installer validation is unchanged.

## UX/UI flow improvements, 2026-10-10

All 30 TypeScript checks and 68 Python checks pass, along with strict TypeScript including unused-symbol checks, Ruff, both Vite builds and whitespace checks. The macOS app was rebuilt and passes `codesign --verify --deep --strict`. Editor 0.4.6 and Traditional Chinese 0.4.13 are included in the app and local plugin artifacts.

Chromium checked the desktop frontend and packaged editor against an isolated real Python engine; only native IPC and dialogs were substituted. Three generated 24-page PDFs exercised retained selections, disclosed hidden selections, export and removal of only visible selected books, and undo removal. Delayed metadata writes verified uninterrupted Title-to-Author input, serial commits across several rapid blurs, preservation of newer input, and an unchanged preview across metadata saves. Preview observations confirmed a thumbnail before the larger image. Inline title/language errors and blank-page previews were checked. Successful saves retained identical workspace bounds after moving feedback into the fixed status bar.

Single-book export opened only the save dialog and passed the selected edition to the real EPUB worker. Format and per-format edition choices survived reload and remained synchronized with project batch settings. Import used one picker covering enabled PDF/ZIP formats, routed the selected PDF to its importer and retained the book when the picker was cancelled. English and Traditional Chinese layouts were visually checked at 1180 × 820 and 860 × 600; narrow windows collapsed secondary panels, panels could reopen, export settings stayed inside the viewport, and the virtual page list retained its 29-pixel rows. WebKit independently passed the slow-save focus, serial commit, stable preview, fixed notification, inline validation and blank-preview checks.

The rebuilt frozen engine, with an isolated profile, `/tmp` as its working directory and no Python path/home overrides, independently imported a generated PDF through its native worker, generated a preview and exported an EPUB that passed ZIP integrity. Bundled editor/language versions and their final asset contents were verified. Native file dialogs and very large-book performance were not re-exercised in this pass.

## Performance and native packaging, 2026-10-08

All 68 Python tests, 27 TypeScript/SDK tests, Ruff and strict TypeScript/Vite builds pass. The macOS release app was rebuilt and passes `codesign --verify --deep --strict`. Its signature remains ad-hoc with hardened runtime; notarization was not performed.

The work is split into reversible stages:

| Commit | Change |
| --- | --- |
| `3a76a59` | Package native format workers with runtime directories, unpacked once at installation. |
| `52a313b` | Reuse unchanged source fingerprints on project open; explicit refresh still hashes all sources. |
| `d460563` | Prepare each supported PDF image resource once, retaining per-page layout checks. |
| `815871a` | Reuse saved asset paths across current/undo/redo state and remove redundant project reads and snapshots. |
| `711e3a1` | Send only the requested page and asset to preview workers. |
| `b1b2f37` | Coalesce progress, omit unused plugin request files and record worker/task elapsed time. |

Generated local measurements, with warm filesystem caches:

| Case | Before | After |
| --- | --- | --- |
| Repeated PDF native-worker startup | About 8.1 s | 0.125 s in the native import check |
| 375 PDF pages sharing one 1750×2480 JPEG resource | 5.414 s | 0.091 s |
| 24 distinct 1750×2480 Flate images | 2.297 s | 2.313 s; no measured speed-up in this case |
| 375-page metadata edit with 100 undo snapshots, median of five | 40.30 ms | 14.74 ms |
| 1,000-page metadata edit with 100 undo snapshots, median of five | 107.10 ms | 37.01 ms |
| Cached preview request for a 1,000-page document, median of 30 | 2.082 ms | 0.050 ms |
| Serialized document data for that preview | 392,291 bytes | 461 bytes |

The shared-image result applies to reused PDF resources, not to books containing different scans on every page. Distinct-image compression remains a substantial cost. Metadata-edit measurements use small generated image assets to isolate state and filesystem overhead; preview measurements cover cache hits, not image decoding or UI drawing. These are local generated cases, not throughput guarantees for real books.

The directory-based PDF worker's first import still took 11.36 s. The packaging prototype increased the PDF package from about 36 MB to 64 MB (about 138 MB unpacked). New package tests verify runtime files, executable permissions and flattened framework symlinks. All seven native format workers were exercised: PDF/CBZ/ZIP/EPUB import and PDF/CBZ/EPUB export, with original JPEG bytes and archive integrity checks.

Final checks ran the rebuilt app's frozen engine from `/tmp`, with an isolated `FOLUMA_DATA`, a system-only executable search path, and no Python environment overrides. A generated three-page PDF included two shared JPEG pages and a composed page. Automatic preparsing, opening the saved book, metadata/crop/rotation edits, the 320×120 rotated preview, validated EPUB export, undo/redo and restart restoration all passed. This exercised the packaged engine and workers, not the native UI.

Regression tests also cover unchanged-source reuse, changed/renamed sources, full refresh detecting same-size/same-time content edits, per-page composition decisions for shared images, lossless indexed PNGs, storage error propagation, portable undo/redo assets after deleting the old asset copies, rejection of escaped asset directories, and preview snapshots remaining stable during document changes. Progress tests preserve phase changes, completion and the latest progress before failure.

`[timing]` records keep the worker's phase times and add `total_seconds` for request preparation, process startup, processing and exit. `[task-timing]` includes the running engine task's asset adoption and project persistence; queue wait and UI rendering are outside this measurement. Autosaves remain synchronous to preserve failure and revision semantics, with the repeated work removed.

Real large-book files, UI frame rates, peak memory, cold/external-disk throughput and Windows/Linux were not tested in this pass.

## Background PDF rendering, 2026-10-08

All 60 Python integration tests and 26 TypeScript/SDK tests pass, along with Ruff and strict TypeScript/Vite builds. The new generated-PDF regression first reproduced a `render_required` failure during automatic project preparsing, then verified that four background books complete, complex pages use Auto PNG rendering, original JPEG bytes and blank pages are preserved, sources remain unchanged, and saved books reopen without parsing again. Existing checks also verify sharing render-enabled opening requests with preparsing and retaining manual rendering confirmation when preparsing is disabled.

Project preparsing now enables rendering at Auto resolution from the start, avoiding a second PDF inspection or a failed background task for pages that need rendering. Preferences, the Traditional Chinese language pack (0.4.11), and the user guide describe this behavior. The reported 375-page PDF and the packaged macOS app were not tested in this check.

## Background processing and book windows, 2026-10-07

The current source passes 51 Python integration tests, 26 TypeScript/SDK tests, strict TypeScript/Vite builds, Ruff and the macOS debug app build. New checks cover bounded/shared parsing, authorized rendering queued behind an unapproved parse, cancellation before publishing staged imports, parallel export name reservation, immutable export revisions, serial-export preferences, signal-scoped cancellation, retained window sessions and cancellation of peer-window closing.

Native checks used a separate `Foluma Check.app` identifier and isolated data directory with four generated twelve-page PDFs:

- Three books preparse automatically; the complex fourth book waits for rendering consent. Confirming rendering changes the bottom-left preparation summary from 3/4 to 4/4. Restart reuses all four saved books.
- Both processing options are enabled with concurrency 2 by default; saving concurrency 3 persists after leaving and reopening Preferences.
- Two books open in independent windows. Inserting a blank in the first changes its page count to 13 while the second remains at 12. Switching the main window to another book preserves the first window's selection and undo state; undo returns it to 12. The blank-suggestion tool remains bound to its originating book/window and closes independently.
- Batch export visibly runs two exports simultaneously, keeps book navigation available and reports two successful outputs. Both EPUB archives pass ZIP integrity checks; later edits correctly require re-export.
- Quitting with uncommitted author input in a secondary window saves that input and closes all test windows. Targeted quit, close-response and page-selection listeners are scoped to their receiving windows; global Tauri listeners otherwise receive targeted events in every window.
- Closing a project with its main blank-suggestion tool open closes the tool, releases its document retention and returns to the empty workspace. Cancelled peer closing preserves remaining windows and their document retention; restart uses the same peer-save checks.

These UI checks used the development engine and plugin packages in a locally signed debug app; they do not establish release notarization or frozen-engine packaging.

## Automated

`npm run test:engine` runs thirty-nine integration tests using real generated PDFs: exact JPEG stream retention; lossless Flate pixels; PDF physical order; composed/rotated/blank page handling; explicit raster consent; split crop and cropped cover output; validated EPUB structure; monotonic revisions and atomic rejected edits; undo/redo; project round-trip, embedded images, unknown extension state and source relinking; portable asset bundles; plugin installation, SHA checks, ZIP traversal rejection, restart/safe mode/removal/reinstallation, native worker execution; first-launch bundled editor installation respecting disable/removal/existing profiles; cancellation preserving an existing output; atomic completed-task results; live language installation/disable/removal/reinstallation, safe-mode fallback and invalid language packages; JSON-RPC startup/EOF handling. Series checks cover natural sorting, lazy loading, independent edits, shared settings, review/export revision tracking, restart restoration and missing sources. An injected autosave failure preserves the old project and current dirty document, blocks switching and permits a later successful save. PDF performance regressions cover resource lookup without pixel hashing, temporary versus export compression, singleton filter arrays, rejection of oversized images before extraction, and worker phase timings. Format-plugin checks cover independent defaults, removal without automatic reinstallation, legacy migration with preserved edits, generic input/output suffixes, ambiguous providers and source-independent saved books.

`npm test` runs twelve checks, including an editor-to-engine batch integration test with real PDFs and EPUBs. It checks active-book preservation, different source lengths, embedded images, split/blank/cover edits, name collisions, per-book failures and cancellation. Series batches also verify export without a preset, independent layouts, active-session undo preservation and no automatic review approval. Other editor operations are checked independently of React: split/restore with stable identities; direction changes; Apple Books virtual cover gap; range parsing; noncontiguous reorder; portable preset remapping, embedded assets, split restoration and preservation of later target pages. Spread navigation visits every pair exactly once in both directions, with every cover/gap combination; inserted blanks retain original page identities and match cropped page dimensions. Preview scheduling checks two concurrent jobs, 100 cancelled queued requests, large-preview priority, independent cancellation of shared requests, caching and retries. Bridge checks verify that format discovery exposes active providers only. Plugin-list checks cover automatic categorization, filtering, stable sorting, unique ID counts, same-version suppression and preservation of updates and installed capabilities.

`npm run build` checks strict TypeScript and builds the core. `npm run package:editor` builds all bundled packages, including independent native format workers. Tests prepare development format packages through `scripts/package_plugin.py --development --formats-only`. Ruff checks the Python code. The macOS workflow repeats checks and builds a local app artifact; it does not publish a release.

## Native UI

Tested the packaged `.app` with `FOLUMA_DATA` set to the repository's isolated `artifacts/qa-data` directory:

1. Import the eight-page `artifacts/Foluma-reference.pdf`, generated by `scripts/make_demo.py`.
2. Save and reopen `artifacts/Foluma-QA.mteproj` through native file dialogs.
3. Install the editor through the bundled engine's plugin installer, restart, then open its workspace from the sidebar. JavaScript and CSS load from the installed package, not the base application.
4. Confirm real thumbnails and page preview after fixing custom-protocol URL decoding.
5. Insert a blank page, undo (eight pages), redo (nine pages), save the project.
6. Export through the native Save dialog. The resulting EPUB contains nine spine pages and passes the engine's independent structure validator.

The final desktop layout was also tested with the packaged app and the current editor package in `artifacts/desktop-ui-final`. `artifacts/Foluma-pages.pdf` repeats the reference PDF four times to exercise 32-page scrolling:

- Import using ⌘O; scroll the virtualized core table and select page 28. Its preview updates correctly.
- Select page 28 in the editor, switch between list and two-column thumbnails, and retain the focused page. Fixed deferred React scroll handlers reading a cleared event target in both page lists.
- Split page 28 (32 → 33 pages), restore it (33 → 32), and preserve focus throughout.
- Save `artifacts/Foluma-pages.mteproj` with ⌘S and export `artifacts/Foluma-pages.epub` with ⌘E. The app reports successful structural validation.

The final `.app` passes `codesign --verify --deep --strict`. The bundled frozen engine was additionally checked with an actual nine-page export. The macOS archive is a local ad-hoc-signed test artifact, not a notarized release. Remote CI has not been run because the source has not been pushed.

### UX update, 2026-09-27

Validated the rebuilt packaged app with a fresh isolated `FOLUMA_DATA` directory:

- The editor installs from the bundled package on first launch, without fetching the catalog. The welcome screen offers a direct Open PDF action; workspace navigation lives in the sidebar.
- Opened the 32-page reference PDF from the welcome screen. Selected pages 27–28 in the default thumbnail view and enabled spread preview. Switching to book information and back preserved the selection, visible thumbnail range and spread mode.
- Previewed a 60% split on page 28. The guide matched the image bounds and displayed right-half-first reading order. Splitting produced 33 pages; undo restored 32.
- Exported with leading-blank simulation enabled and checked the ZIP and EPUB spine: 32 pages, no inserted virtual blank. Saved the project through the native dialog.
- Removed the editor through Plugin Management and restarted. The app showed zero installed plugins and no Edit Pages entry. Automated checks also cover disabled, existing and safe-mode profiles, repeat startup after removal, and a corrupt bundled package.

The leading blank simulates reader page pairing only; it never changes document pages or export contents. Both reading directions and cover-only behavior are covered by the TypeScript checks.

### Direct interactions, batches and language packs, 2026-09-27

Tested the packaged app with a separate fresh profile at `/tmp/foluma-interaction-qa.zLz8hA`:

- First launch used English and installed editor 0.2.0 offline. Installed the included Traditional Chinese language package and selected it in Preferences; both the host and already mounted editor translated without restarting.
- Used the native context menu to insert a blank page and undo it. Dragged a single page, then a selected two-page group; both reorders preserved the expected order and selection. Right-clicking the group preserved its selection and split both pages (32 → 34).
- Saved the layout preset through the native dialog. Applied it to 32-, 40- and 8-page PDFs in the batch dialog. Two books exported with 34 and 42 EPUB spine pages; the short book reported the missing required source page independently. The current 34-page book and unsaved edits stayed intact.
- Checked both exported ZIPs and EPUB spines. An existing `Volume A.epub` retained its exact bytes; the new book was named `Volume A (2).epub`.
- Removed the active language package in Plugin Management. The host and editor immediately returned to English, preserving the current book and workspace state. The included package remained available for reinstallation.

Batch cancellation, embedded preset images and differing book lengths are also covered by the real engine integration test. Native multi-file selection was exercised; native file-drop routing is implemented but has not been exercised in this UI run.

After the final copy and accessibility adjustments, all 16 automated checks, Ruff, strict TypeScript, the packaged macOS build and `codesign --verify --deep --strict` passed again. A second fresh profile confirmed the final English default, offline editor installation and accessible labels in the “Batch PDF to EPUB” dialog.

### Ten editor and series improvements, 2026-09-27

Built the packaged app with editor 0.3.0 and language pack 0.2.0. Native QA used an independently identified copy at `/tmp/foluma-series-qa-l1m0rsa8/Foluma Series QA.app`, launched with `open -n -a … --env FOLUMA_DATA=/tmp/foluma-series-qa-l1m0rsa8/data`. Passing the environment through `open` is necessary: resolving the bundle via the UI automation tool can otherwise launch a separate instance using the default profile.

- Imported the test folder through the native folder dialog. Its 32-, 12- and 40-page PDFs appeared as Vol.1, Vol.2, Vol.10, along with one deliberately invalid PDF. Unopened volumes had no loaded page count.
- Verified spread buttons and arrow keys advance a complete pair. B inserted a blank before original PDF page 3, retaining focus while updating both paired thumbnails and the connected large preview. A native context-menu action inserted a blank after page 2 in another volume.
- Marked two pages with M and navigated with Shift+M. Switched volumes and recovered the first book's 33 pages, original PDF page 3 focus, marks and 160% zoom; the second book retained its separate 13-page layout.
- Marked the first volume reviewed and opened the next unreviewed book. The series table distinguished reviewed, editing and not-started volumes and initially selected only the reviewed book for export.
- Selected only Vol.2 and Vol.10, confirmed the named target list, and applied LTR plus cover exclusion. Vol.1 retained RTL and its included cover. Native preview also confirmed the separate cover thumbnail and leading body gap for LTR.
- Exported all four entries without a preset. Three succeeded; the invalid PDF failed independently. ZIP integrity and OPF inspection confirmed 33 / 12 / 39 spine pages and RTL / LTR / LTR respectively. The pre-existing `Vol.1.epub` kept its exact bytes and the new export became `Vol.1 (2).epub`. Retry remaining produced no duplicate successful outputs.
- Edited Vol.1 after export: its review state returned to Editing and export state changed to Needs re-export. Installed the included Chinese pack and verified both series and editor layouts translated immediately.
- Quit and relaunched with the isolated profile. The last book, saved layouts, reading settings, output directory and language restored. Reopening Vol.1 retained its two marks, focused source page and 160% zoom after restart.

All 20 automated checks, Ruff, strict TypeScript, the macOS application build and `codesign --verify --deep --strict` passed. Folder selection was exercised natively; OS folder-drop routing was reviewed in code but not exercised in this UI run.

### PDF performance safeguards, 2026-09-30

All 25 automated checks, Ruff, strict TypeScript, the packaged macOS build and signature verification passed. The frozen engine was exercised against both original 123-page volumes of 魔法少女小圓 完全版 in an isolated temporary directory:

- Full imports completed in 4.307 and 4.176 seconds. All pages retained direct PDF image assets.
- A representative indexed Flate page took 0.043 seconds with a single filter name and 0.027 seconds with the equivalent singleton array.
- The first volume exported completely in 59.279 seconds (329.26 MiB). ZIP integrity and all 123 spine pages passed; one JPEG retained its exact bytes, and indexed pages 8, 40 and 80 retained identical dimensions, palette and pixels.
- Compression level 6 retained lossless pixels while sampled indexed pages compressed in 0.43–0.60 seconds instead of 3.53–5.13 seconds at level 9. Those PNGs were approximately 7–9% larger.

Native UI confirmed editor 0.3.1 active after restart, preserving the existing 125-page project, spread view, 100% zoom and page 124 focus. Cached previews displayed. Final uncached navigation was blocked because the original PDF paths had subsequently disappeared and the replacement first-volume PDF had a different SHA-256; no relink or document edit was made. Import/export timings above were collected before that source change.

Worker phase timings are written to the existing local engine log; previews log only when they take at least 0.25 seconds. The preview queue cancels obsolete waiting work; at most two already running previews finish before newer work starts.

### Managed folder projects, 2026-09-30

All 28 automated checks, Ruff, strict TypeScript, the packaged macOS build and signature verification passed. The project integration checks cover copied PDF intake and duplicate imports; groups, moves and order; independent saved edits and embedded images; removal/restoration; relocating the entire project; external file/group renames; changed sources and matching-content relinking; output EPUB integrity; legacy migration, including missing edited and never-opened books; importing an edited single-book project; invalid paths, symlinks and collisions; rollback after failed manifest writes; and reopening after an interrupted removal. Preview checks also reject reuse of queued work tied to a former source path.

Native QA used a separately identified app with an isolated profile. Created a project through the new dialog and native folder picker, imported a two-PDF folder, created 番外, moved Vol.1 into it, opened the editor and inserted a blank page. Removed that book, found its two-page layout in Removed, and restored it. Filesystem checks confirmed the PDF returned to 番外 with identical bytes and both saved pages intact. The main app was then updated and relaunched with editor 0.3.2; the user's existing 125-page legacy book and page 124 focus survived, and Project displayed the legacy migration entry point. The default 1180×820 layout was visually inspected; a smaller-window resize was not verified. OS file-drop delivery and live Finder changes are covered by routing/code and filesystem integration checks, not this native UI run.

Projects keep visible PDFs in the root or one group level, hidden metadata/assets in `.foluma`, and recoverable removed PDFs under `.foluma/removed`. Copies leave import sources untouched. Opening or Refresh folder reconciles external changes; no continuous filesystem watcher is used. A missing legacy book that was never opened has no original fingerprint or edits, so a selected replacement establishes its first fingerprint. Edited books always require their stored fingerprint for relinking.

### Automatic render resolution, 2026-09-30

All 29 automated checks, Ruff, strict TypeScript, the packaged macOS build and signature verification passed. Auto is the default for standalone imports, lazy project imports and editor/project batches; manual 72–600 DPI remains available. The old automatically saved 300-DPI preference migrates once to Auto, while other saved manual values remain. Already rendered project assets are unchanged.

The integration check covers a scan at less than 1 DPI, page and image rotation, cropping, text-only pages, a small logo on a text page, very large vector pages, thin pages, invalid resolution inputs, and rejecting oversized manual renders before allocation. The real batch-to-engine test verifies both omitted and explicit Auto values, including project batches and preservation of the active book.

All 486 page-size estimates in the current 243-page Madoka volumes fit the 6000-pixel longest-edge limit. Each book has 240 ordinary 3494×4924 pages and a 3401×4924 cover at native density; its two wider pages use the size cap. Five sampled pages per volume rendered in 2.294 / 2.323 seconds, and every sample matched the RGB pixels of an independent native-size render exactly. These timings cover ten sampled pages, not a full-book import.

Native QA confirmed the existing 300-DPI preference migrated to Auto, the Project render label and consent dialog used Auto, and editor 0.3.3’s batch dialog defaulted to Auto. The first 243-page volume then imported completely through the packaged app and was autosaved in the user’s managed project. Its engine timing was 127.224 seconds total: 0.217 seconds checking pages and 126.775 seconds preparing PNGs. All 243 saved page dimensions obeyed the cap; the cover and two wide pages’ saved PNG headers matched their project metadata. The app was left showing the completed book with Changes saved and no running task.

### Faster lossless PNG rendering, 2026-09-30

The measured bottleneck was PNG encoding: sampled ordinary pages took about 0.08 seconds to rasterize and 0.20–0.48 seconds to save with MuPDF. Imports now use the already bundled Pillow encoder at compression level 3. A page is stored as grayscale only when every RGB pixel has equal channels; tinted pixels retain RGB. Resolution, composition and pixel values are unchanged. No parallel renderer or new dependency was added.

A fresh full import of the first 243-page volume took 49.950 seconds, versus the prior packaged run’s 127.224 seconds (about 2.5× faster). All 243 rendered images were decoded and compared against the previous saved PNGs by size and SHA-256 of RGB pixels: every page matched. Output contained 234 grayscale and 9 RGB pages; combined PNG size changed from 564,697,570 to 575,819,673 bytes (+1.97%). Comparison followed source asset identities so the user’s later 245-page layout, including edits and blanks, was not changed.

All 30 automated checks and Ruff passed. The added integration check verifies all 256 gray levels, a one-channel tint, overlaid text, dimensions and DPI metadata, and exact PNG retention through EPUB export. The packaged macOS build and signature verification also passed. Its frozen engine imported five sampled pages from the second volume in 1.187 seconds; all five matched the previous RGB pixels. The updated app restored the user’s saved 245-page first volume.

### Workspace usability fixes, 2026-09-30

The follow-up covers all 15 items in the local usability review: pending metadata, action scope, group creation, review marks, batch results/retries, empty projects and import summaries, recovery, compact project controls, page navigation/insertion, unsaved decisions, cover/language terminology, shared export defaults, plugin/language status, refresh summaries, and search/position changes. Editor and Traditional Chinese packages are now 0.3.4 and 0.3.2. No new runtime dependency was introduced.

All 34 automated checks passed: 23 Python engine checks and 11 Node checks. Added checks cover serialized metadata commits, preserving newer/failed input, immediate acknowledgement of document revisions and saved state before delayed notifications, background-document isolation, atomic group creation with moves and rollback, duplicate/subfolder import counts, rename/missing refresh counts, migrating attention counts from older manifests, explicit review override, and rendering-required batch errors. Ruff, strict TypeScript, Rust formatting and the packaged macOS build passed.

Native QA used generated PDFs and FOLUMA_DATA under /tmp/foluma-ux-fix-20260930. Creating a group kept both selected books; choosing to move them placed both in the new group with selection retained. Empty projects showed Add your first book. Folder import reported three additions and one skipped subfolder. Search reduced the list to the matching vector book; Move to position placed the second book first in one operation. Removal exposed Undo removal, and restoration replaced the earlier notice with a restoration count. Refresh detected one external rename without changing book identity or its saved layout.

In the packaged application, focused Title and Author inputs followed by Command-S retained their new values and displayed Book project saved. Editing the language field and immediately exporting retained en in the EPUB metadata. Native testing exposed a response/notification ordering race; the bridge regression now verifies both revision and saved-state ordering. The page list moved from page 2 to 3 with Down and back with Up; entering page 4 selected the wide source. Splitting, an attention mark, its completion warning/cancel/override, and inserting an image were exercised. The new image was selected and visible at page 5. Book edits invalidated the earlier completion state, and the project reported the remaining attention mark.

The toolbar exported only the selected second book while the first book remained open. A three-book batch produced two successes and a rendering-required failure; the per-book rendering retry added only that book and retained all three final results. The preset workflow inherited the project output directory and exposed Show file and a completion summary. Six EPUB outputs passed ZIP integrity and spine checks: 8, 10, 8, 8, 10 and 24 pages, including collision-numbered files. The original-image ZIP contained only the selected inserted PNG and passed integrity checks.

Preferences installed and activated the included Traditional Chinese pack in one selection, without changing the book's en metadata. Included packages displayed Installed rather than a disabled Install. Catalog loading left book tools available; failure displayed the offline/local-package guidance and collapsed technical details, without claiming that the catalog was empty.

Unsaved book replacement offered Save and continue, Discard changes and Cancel; cancelling the save dialog kept the current book. The native macOS predefined Quit bypasses Tauri close events, so its menu action was replaced with a guarded Command-Q action. Native QA confirmed Cancel retained the modified standalone book and Save and continue wrote its eight-page .mteproj before the process exited. Updating the normal installation to editor 0.3.4 retained the original 245-page book, page 245 focus, spread view and 100% zoom.

The final native follow-up verified Restart in safe mode with no active plugins, then Restart normally with editor 0.3.4 active and the original 245-page book restored at page 245, spread view and 100% zoom. These restart checks used the normal desktop profile because macOS relaunch did not retain the temporary FOLUMA_DATA override. A generated standalone PDF was then renamed in the focused Title field; Command-Q followed by Discard changes exited the app without creating a book project. Relaunch restored the original managed book. The app was left in its original Plugins view with both project books selected, English interface and Auto resolution. Original book content was not edited.

A smaller-window native resize was not established through the available menu interaction, so minimum-window visual validation is not claimed here.

### Independent format plugins, 2026-10-02

All thirty-two Python tests, eleven Node checks, Ruff and the strict TypeScript/Vite build passed. The macOS arm64 app also built successfully and passed `codesign --verify --deep --strict`; it is ad-hoc signed, not notarized.

A fresh isolated profile at `/private/tmp/foluma-format-native-jcqw92n7/profile` exercised the packaged frozen engine and native PDF-import/EPUB-export workers through JSON-RPC, with no repository Python path or Python home configured and `/tmp` as the working directory. A generated two-page JPEG PDF imported as ordinary image files, retained a half-page crop and inserted blank, and exported as a structurally intact three-page EPUB. After saving the project, removing the PDF importer, deleting the original PDF and restarting, the project reopened, previewed and exported successfully. Removing the EPUB exporter and restarting left no format providers, prevented export without a hidden fallback and created no output. Offline reinstallation of only the included EPUB exporter restored export while the PDF importer remained removed. The core's frozen dependency directory contains no MuPDF or Fitz payload.

Automated migration checks additionally preserve legacy document identity, revision, page edits and unknown extension state. An importer result that alters non-asset state is rejected without rewriting the saved project. Generic mock `.scan` and `.pages` providers verify the same project, import and atomic export paths without PDF/EPUB assumptions. This foundational phase did not include CBZ, image-book, PDF-export or EPUB-import plugins. Native UI interactions for the new dynamic format menus have not been exercised in this run.

### Optional CBZ and PDF formats, 2026-10-02

All thirty-five Python tests, eleven Node checks and Ruff passed. New checks cover optional, separately removable CBZ import/export and PDF export; natural page ordering; original JPEG bytes; WebP conversion and transparency; ComicInfo title/language/direction/cover round-trip; cropped and blank pages; shared PDF image resources; EXIF normalization with palette transparency; CMYK preview/crop output; and failed import/export preserving the current book and existing output. Malformed archives, unsafe paths, symlinks, duplicate names, oversized declarations, animated pages and UTF-16 XML entity declarations are rejected.

Packaged native QA used `/private/tmp/foluma-next-format-native-utjn3l1z/profile`, a fresh isolated profile with `/tmp` as the working directory, no Python path/home override, and a system-only executable search path. Only PDF import and EPUB export were default-installed. The three new format packages installed offline and became active only after restart. A three-page CBZ containing PNG, JPEG and WebP pages imported in natural order, then exported a reordered five-page CBZ and PDF with a half-page crop, reused original JPEG and white blank. Both formats retained metadata and expected dimensions; JPEG bytes and the PDF's shared resource were verified. A mixed CBZ/ZIP managed project also exported both books to PDF with collision-numbered filenames.

Translated path rejection left the open book intact, and exporting over the source was blocked. After removing both importers and deleting the original CBZ, the saved edited project reopened, previewed and exported through both remaining exporters. Removing CBZ export left PDF export working; offline CBZ reinstallation followed by PDF removal left CBZ export working without restoring either importer. The core contains no MuPDF payload. The app passes ad-hoc signature verification; Poppler rendered all five PDF pages, and the contact sheet was visually inspected for crop placement, page proportions, transparency on white and the blank page. The new native UI menus have not been manually exercised. EPUB import and folder-of-images plugins remain outside this phase.

A final rebuilt-bundle check at `/private/tmp/foluma-native-color-9ed4op85/profile` verified rotated indexed PNG alpha, native CMYK thumbnails, RGB conversion of cropped CMYK CBZ pages, PDF crop dimensions and transparent pixels composited on white. The saved project also exported after removing its CBZ importer and deleting the source ZIP. Both PDF pages were rendered with Poppler and visually inspected. Signature verification passed again for the rebuilt app.

### Plugin categories, 2026-10-02

The thirty-five Python and twelve Node checks pass, along with TypeScript/Vite, Ruff and whitespace checks. The macOS app was rebuilt with the Traditional Chinese pack at 0.4.2 and passes ad-hoc signature verification.

Native UI checks used a disposable app copy and isolated profile at `/private/tmp/foluma-plugin-ui-jfefix4u/profile`, without changing the normal profile. With all seven packages installed, All displays four ordered groups: two importers, three exporters, one editing tool and one language pack. Each category filter displays only its matching installed rows and count. Tab/Space switches filters, category controls expose pressed states, and Included does not repeat installed versions. Returning to All restores the four group headings. Install/remove dialogs and checkbox activation are not counted as validated in this UI pass; disabled/pending grouping and update visibility are covered by the automated check.

### Independent ZIP image import, 2026-10-04

All thirty-six Python tests and twelve Node checks pass, along with Ruff, strict TypeScript/Vite, the macOS app build and ad-hoc signature verification. ZIP image import 0.1.0 is optional and separately installable/removable. CBZ import 0.1.1 declares only `cbz`; ZIP declares only `zip`. Both packages bundle the same image-archive implementation without requiring the other package at runtime. The language pack is 0.4.3. Existing CBZ 0.1.0 users should update before installing ZIP to avoid its old overlapping suffix declaration.

Automated checks cover installing ZIP without CBZ, natural JPEG/PNG/WebP page order, original JPEG preservation, uppercase ZIP filenames, managed folder discovery, restart-delayed disabling, independent CBZ routing and reopening/previewing/exporting saved pages after deleting both original and managed source copies and removing ZIP. The shared archive rejection checks and ZIP EXIF/transparency/CMYK checks remain green.

Native QA used the rebuilt packaged frozen engine with an isolated `foluma-zip-native-*` profile, a system-only executable search path, no Python environment overrides and `/tmp` as the working directory. ZIP installed offline without CBZ and imported naturally ordered images with ComicInfo title, language, reading direction and cover selection. Original JPEG bytes were retained. A translated unsafe-path rejection left the current document unchanged. After installing CBZ, both native workers used separate suffixes successfully. Removing ZIP and deleting its original source still allowed reopening the saved crop/blank edits, previewing them and exporting a validated four-page EPUB while CBZ remained active. The core bundle contains no MuPDF/Fitz payload. This phase did not re-exercise native UI installation dialogs.

### Independent EPUB image import, 2026-10-04

All thirty-nine Python tests and twelve Node checks pass, together with Ruff, strict TypeScript/Vite, the macOS app build and ad-hoc signature verification. EPUB image import 0.1.0 is optional, separately installable/removable and independent of EPUB export. The core and SDK remain unchanged. The language pack is 0.4.4; CBZ import 0.1.2 and ZIP import 0.1.1 include the shared archive validator updates.

Automated checks cover EPUB 2/3 fixtures from both Foluma export and independent package structures: spine order distinct from filename order; metadata and multiple authors; separate/nonlinear covers, guide/landmark selection and SVG cover declarations; percent-encoded Unicode/space paths; original JPEG/PNG bytes; shared assets across repeated/cropped pages; normalized SVG crops, white blanks and cover-only round-trips. Unused obfuscated fonts remain accepted without decoding them. Missing resources, invalid manifests/spines, unsafe references, XML entity declarations, animated images, encrypted content, text, multiple-image composition, transforms and SVG geometry overridden through styles all fail without replacing the current book or changing the source. Saving and reopening after removing the importer and deleting the source retains preview and export functionality.

Native QA used `/private/tmp/foluma-epub-native-ow32z3wb/profile` with the rebuilt frozen engine, a system-only executable search path, no Python environment overrides and `/tmp` as the working directory. EPUB import worked as the only active format plugin, with PDF import and EPUB export removed. A generated image publication retained explicit spine order, metadata, its cropped SVG cover, Unicode asset paths, original image bytes and a white blank. Translated text/layout, unsafe-path and encryption errors preserved the current document. After removing EPUB import and deleting its source, the saved project reopened, retained crop/blank dimensions, rendered the expected cropped colors and white blank, and exported a validated three-page EPUB after reinstalling only EPUB export. Offline importer reinstallation completed the EPUB round-trip. Both rebuilt CBZ and ZIP workers imported independently afterward. The core bundle contains no MuPDF/Fitz payload or added format-parser files. Native installation dialogs were not re-exercised; this phase validates the packaged engine and workers.

Scope remains simple image publications. Text reflow, composite SVG/CSS rendering, DRM content and restoration of unpublished editor state are unsupported. Blank geometry follows the publication viewport, which may differ from a pre-export Foluma blank size.

## Scope and limits

- Preview pairing emulates the existing Apple Books cover gap. An external Apple Books import has not been tested in this session.
- PDF extraction is deliberately conservative: only an upright full-page image with supported color/filter data and no extra composition is accepted directly. Other pages use PNG rendering, automatically with Auto during project preparsing and with confirmation for manual imports (manual 72–600 DPI remains available). Auto follows a dominant scan’s displayed pixel density; pages without a dominant image use 200 DPI. Auto caps the longest edge at 6000 pixels.
- Undo keeps 100 metadata snapshots; source image bytes are shared. Local asset and thumbnail files are retained under app data; automatic disk-cache reclamation is not implemented.
- Folder imports read immediate files supported by active import plugins. Managed project refresh also scans one group level; deeper nesting is not supported. Autosaved projects and last-book selection persist; undo history and the current batch's transient error rows do not survive reopening. View preferences are stored locally per document. Saved books with normalized image assets can reopen without their source or importer. A legacy PDF-backed project still needs its matching original and the enabled PDF importer for its first migration; missing/changed originals leave the project unchanged.
- Plugins are trusted local code, not sandboxed. Native workers are bundled by their authors; the engine does not run pip for plugins.
- Distribution to other Macs still needs a Developer ID signing/notarization workflow. This build uses ad-hoc signatures for local testing.
- The official catalog is not published while the GitHub repository remains private. Offline/local installation is the working distribution path for this iteration.

### Maintainability refactor, 2026-10-04

All forty-one Python tests and twelve Node checks pass, including the regression for split originals that share an ID but have different crops, undo after direction changes, cancellation during batch preparation, and migration of edited legacy books whose source files are still present. The migration regression first reproduced the missing active document, then passed after restoring the saved-project filename check; it also verifies metadata, page edits, extension data, review status and the unchanged original project. Both Vite builds, strict TypeScript with unused-symbol checks, Ruff and whitespace checks pass.

The engine owns direction changes; the editor sends metadata without a duplicate page-reordering implementation. Shared ordering and batch export helpers live in the SDK, while preset preparation remains in the editor. Preview cache and worker subprocess state now have separate owners and locks. RPC dispatch, project migration and export publication are separated into focused methods. Document workflows, plugin management and UI panels are separated from their root components, and JSX/CSS use multiline formatting.

Playwright checked the actual desktop frontend and built editor assets in Chromium with a mocked Tauri bridge: normal selected-book export through the keyboard command, disabled export and no task dispatch from Removed, metadata-only direction changes, preview page jumps, and preserved plugin category/catalog state across navigation. This browser pass covers frontend behavior rather than native dialogs. An isolated frozen-engine check additionally verified project opening, a real worker-generated preview, a cache hit, cache clearing and clean shutdown. Editor 0.4.1 is packaged locally as `artifacts/org.foluma.editor-0.4.1.mte-plugin`; it provides an upgrade path for existing editor installations.

### Project creation and batch book information, 2026-10-04

All forty-four Python tests and fifteen Node checks pass, together with strict TypeScript including unused-symbol checks, Vite production builds, Ruff and whitespace checks. The new checks cover volume gaps, full-width digits, sequential numbering and exclusions, custom side-story titles, blank-author preservation, invalid metadata and stale revisions. Project checks verify initial information on unopened and saved books, restart persistence, independent later imports, preserved page edits and review status, export invalidation, and rollback of a failed initial copy without changing the active project or original sources. The Traditional Chinese pack is 0.4.5.

Playwright exercised the actual desktop frontend connected to a real Python engine through an isolated HTTP proxy; only native IPC and file dialogs were substituted. Created a project with title, author and LTR reading direction, imported four generated PDFs, preserved volume numbers 01/02/10, customized the side story, and reordered the initial list. Opening the first book imported its configured metadata. Batch author changes updated both unopened books and the active document while retaining completed review. Sequential renaming then produced 005/006/007 while excluding the side story and retaining its name and author. English and Traditional Chinese dialogs were visually inspected, including the visible action footer with volume controls expanded.

The rebuilt frozen engine independently passed initial-file preview, project creation with per-book metadata, real native-worker import, batch title/author changes, review retention and clean shutdown with a temporary profile, system-only executable search path and no Python environment overrides. The complete macOS app was rebuilt with native format packages and passes `codesign --verify --deep --strict`; native file dialogs were not re-exercised in this phase. Creation information belongs to each initial book; no persistent project defaults are stored or inherited by later imports.
