# Foluma 0.1

Accepted direction: a new independent repository, macOS first, portable architecture; Tauri + React/TypeScript and a bundled Python engine. Deliver the PDF-to-EPUB core plus an independently installable full editor. Original repository is read-only reference at d3888b987da1b606cfe61bca261b04aad0aac443.

## Boundaries

- Python owns documents, stable page/asset IDs, revisions, validated atomic changes, undo/redo, projects and jobs. UI selection stays in the frontend.
- PDF physical page order is authoritative. Preserve supported source image streams. Ask before rendering unsupported compositions to PNG; default Auto resolution with a 6000-pixel longest-edge limit.
- Export staged EPUBs, validate before publication, never damage existing files on errors/cancellation.
- Plugin packages contain a versioned manifest and either optional web/native code or a data-only language catalog. Code plugins are trusted local code, not an OS sandbox; lifecycle changes take effect on restart. Language packages install, disable and remove immediately, with English built in as the default and fallback.
- The editor uses the public host API and ships as a separate plugin package inside the app. A fresh profile installs it offline by default; existing settings, including disable/removal, are respected. It includes preview, reader-style leading blank-page pairing, reorder, insert/delete, split/restore, covers, original image export, presets and undo/redo.
- New .mteproj directory format references original PDFs with fingerprints, embeds inserted/generated assets, preserves unknown plugin state, supports source relinking. No legacy project compatibility.
- Future: format plugins and spread analysis; OCR/translation/typesetting use stable page IDs, original/derived assets and namespaced plugin state.

## Delivery checks

- [x] Packaged app -> engine -> PDF -> install editor -> insert blank -> validated EPUB.
- [x] Core lossless paths, consent-based raster fallback, revision-safe history and atomic output.
- [x] Plugin installer/catalog implementation, offline/local installation, safe mode, projects and relinking. Public catalog publication is deferred.
- [x] Full editor and portable presets.
- [x] Single/multi-page drag reorder and native context menus; one preset applied to multiple PDFs with separate EPUB exports and isolated failures.
- [x] English by default, installable/removable Traditional Chinese language package, live language switching.
- [x] Python integration tests, TS model checks, native UI checks, locally signed macOS app and plugin. Public release/notarization is deferred.

## Editor and series improvements, 2026-09-27

- [x] Navigate one complete spread at a time, following reading direction with buttons and arrow keys.
- [x] Insert blanks before/after the current page using nearby buttons, context menus or B / Shift+B.
- [x] Pair spread thumbnails with the same rules as the large preview; show current and source page numbers.
- [x] Join preview pages at the center with common height and zoom for seam inspection.
- [x] Save manual review flags with the book; M toggles, Shift+M advances. Restore page, scroll, mode and zoom locally.
- [x] Import/drop a folder or multiple PDFs, naturally sort volumes and load contents lazily.
- [x] Autosave independent per-volume projects; restore the last series/book after restarting.
- [x] Track not started/editing/reviewed/exported states, invalidate reviewed/exported status after edits and advance to the next unreviewed book.
- [x] Apply only selected reading-direction and cover/body settings to selected books, with explicit scope confirmation.
- [x] Export selected books using their own saved edits without a preset; isolate failures, retry remaining items and preserve existing outputs.

Series scanning currently includes PDFs immediately inside the selected folder. Each volume uses the existing `.mteproj` format and export queue. Preset copying remains an advanced editor tool for documents with known matching structures.

## Pending work — usage discussion, 2026-09-27

- [ ] **Spread analysis and insertion suggestions — separate optional plugin, explicitly deferred.** Most input spreads already consist of two separate single pages and need blank-page insertion to correct left/right pairing. Some arrive as complete landscape images; the user normally splits these into two pages for reader compatibility. Keep this assistant out of the base editor's required workflow.

The deferred spread plugin should follow this sequence:

1. Use computer vision or another suitable method to propose candidate page pairs. The algorithm/technology is not selected yet. Existing split-page provenance can supply known pairs.
2. Show adjacent-page previews in a candidate list. Let the user explicitly confirm true positives and reject false positives; retain those decisions with the book's stable page IDs.
3. Plan across the whole book using the confirmed pairs, reading direction, cover handling and the chosen reader's initial page-pairing behavior. An inserted blank changes all subsequent pairing, so evaluate the combined result rather than fixing each candidate independently.
4. Suggest insertion boundaries between identified pages, with a before/after preview and the affected downstream spreads. Preserve visual continuity: do not insert a blank inside a confirmed spread or silently override the user's existing edits. If constraints conflict or continuity is uncertain, flag the location for manual review.
5. Keep analysis and insertion separate. Suggestions must not automatically modify the book; apply only user-approved changes and support undo. Each volume has its own candidates and plan, without assuming shared spread locations across the series.

The intended benefit is less manual inspection and page-parity bookkeeping while retaining human control over image continuity and final quality. The spread assistant remains future work; folder-based series editing is implemented independently of detection.

UI direction: traditional desktop tooling inspired by calibre, with labeled icon commands, a dense page table, sidebar navigation, book/page properties and a fixed status bar. The editor supports both list and thumbnail views without changing the document model or core/plugin boundary.

GitHub repository remains private. Do not publish releases or change repository visibility implicitly. Development artifacts and a release-ready catalog are created locally.
