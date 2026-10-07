# Foluma 0.1

Accepted direction: a new independent repository, macOS first, portable architecture; Tauri + React/TypeScript and a bundled Python engine. Deliver the PDF-to-EPUB core plus an independently installable full editor. Original repository is read-only reference at d3888b987da1b606cfe61bca261b04aad0aac443.

## Boundaries

- Python owns documents, stable page/asset IDs, revisions, validated atomic changes, undo/redo, projects and jobs. UI selection stays in the frontend.
- PDF physical page order is authoritative. Preserve supported source image streams. Ask before rendering unsupported compositions to PNG; default Auto resolution with a 6000-pixel longest-edge limit.
- Export staged EPUBs, validate before publication, never damage existing files on errors/cancellation.
- Plugin packages contain a versioned manifest and either optional web/native code or a data-only language catalog. Code plugins are trusted local code, not an OS sandbox; lifecycle changes take effect on restart. Language packages install, disable and remove immediately, with English built in as the default and fallback.
- The editor uses the public host API and ships as a separate plugin package inside the app. A fresh profile installs it offline by default; existing settings, including disable/removal, are respected. It includes preview, reader-style leading blank-page pairing, reorder, insert/delete, split/restore, covers, original image export, presets and undo/redo.
- New .mteproj directory format references original PDFs with fingerprints, embeds inserted/generated assets, preserves unknown plugin state, supports source relinking. No legacy project compatibility.
- Future: OCR/translation/typesetting use stable page IDs, original/derived assets and namespaced plugin state. Image-based automatic spread diagnosis has been abandoned in favor of manual marks in the editor.

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

## Manual spread marks and blank suggestions, 2026-10-06

- Automatic image-based spread diagnosis is abandoned: the editor's facing thumbnails already support fast visual inspection.
- [x] Option-click or use the context menu to mark two adjacent image pages as a spread. Store the relationship by stable page IDs in the editor's existing extension data; saving and undo/redo retain it.
- [x] Calculate blank-insertion ranges across all manually marked spreads using the current order, existing blanks, cover placement and leading-blank preview setting. One insertion can align several marks; each volume is independent.
- [x] Show current spread previews and reference positions in a compact independent native window, initially outside the main window when screen space permits. The title bar supports dragging beyond the app and onto other displays. Users choose the actual insertion point and use the existing blank-page actions; previews update after edits. Closing the tool keeps the main editor open.
- [x] Flag missing, separated, excluded or conflicting marked pages and suspend recommendations until those relationships are corrected or removed. Never insert inside a marked spread.

This prototype extends the existing page-editor plugin; it adds no image analysis dependency, independent plugin or automatic blank insertion.

## Page rotation, 2026-10-06

- [x] Rotate selected image pages clockwise in 90-degree steps from page properties or the context menu. Preserve source assets and stable page IDs; retain rotation in saved projects, undo/redo and layout presets.
- [x] Render previews in the selected orientation, split in visual coordinates and size inserted blanks to match rotated pages.
- [x] Normalize rotated images once in the engine's export staging pipeline so all format exporters receive correctly oriented lossless PNG assets and transformed crops. Keep document edits and original-image exports untouched.

## Background processing and book windows, 2026-10-07

- [x] Preparse managed projects on open/add, enabled by default; persist ordinary book projects and join/promote existing tasks when a book is opened. Require consent for complex PDF rendering.
- [x] Bound parsing and export independently (default 2, configurable 1–8); allow serial export and disable preparsing through Preferences. Keep editing and book switching available during background work.
- [x] Stage imports away from the document lock, publish only after cancellation/project checks, reserve parallel export filenames and keep immutable export revisions.
- [x] Show aggregate activity and individual progress/cancellation in the bottom-left status bar.
- [x] Open project books in independent native editor windows, filter document events, retain shared sessions/undo state and bind tools to their originating document/window. Check pending edits before closing other windows or switching projects.

UI direction: traditional desktop tooling inspired by calibre, with labeled icon commands, a dense page table, sidebar navigation, book/page properties and a fixed status bar. The editor supports both list and thumbnail views without changing the document model or core/plugin boundary.

GitHub repository remains private. Do not publish releases or change repository visibility implicitly. Development artifacts and a release-ready catalog are created locally.
