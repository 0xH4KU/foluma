# Foluma user guide

[Back to the project overview](../README.md)

## Getting started

1. Open Foluma.
2. Choose **Import book** to work on one book, or **New project** to choose a location for a collection.
3. Use **Edit pages** to arrange the book. Choose the format and edition in the toolbar's **Export settings**, then choose **Export** to save the book.

**Import book** opens one file picker for all enabled formats and selects the matching importer automatically. If two plugins support the same extension, choose which importer to use after selecting the file.

The page editor, PDF import plugin and EPUB export plugin install from bundled packages on first launch, without a network connection. Each is independent: disabling or removing it takes effect after restarting, and the app will not automatically reinstall it. PDF import and EPUB export can be removed separately, just like the editor. Missing format actions lead to Plugins instead of falling back to hidden built-in codecs. Reinstall packages from **Plugins → Included packages** when needed.

Plugin Management groups packages into **Import**, **Export**, **Editing and tools**, and **Language packs**. Category filters apply to installed, included and downloadable packages, with counts for unique plugins. The default **All plugins** view groups each list by capability; disabled and restart-pending plugins keep their category. Installed versions are not repeated under included packages, and identical included versions are not repeated in the official catalog. Available updates remain visible.

Each launch checks included packages and the official catalog in the background for newer versions of installed plugins. An update notice opens **Plugins**, where you choose which packages to update; closing the notice defers the reminder until the next launch. Included updates remain available offline. Checking does not install packages or change plugin activation.

Updates appear on the plugin's row under **Installed**, with an orange **Update available** badge, current/new versions and an **Update** button. The Installed heading shows the update count for the selected category. **Included packages** and **Official catalog** list plugins that are not installed. Updating preserves a disabled plugin's state; code-plugin updates show **Restart needed** until the app restarts. When the catalog is offline, an available included update is used before a newer cached download.

### EPUB export editions

Single-book export, project batch export and the editor's preset batch dialog offer two editions:

- **General (default)** centers images and supports both single-page and two-page reading.
- **Two-page optimized** aligns facing pages to the spine and moves horizontal padding to the outer edges. It preserves the common page size, source images and crops. Images remain off-center in single-page view; this is an alignment preference, not a forced two-page reading mode.

The selected output format and each format's edition are remembered across these workflows and app launches. Single-book export uses the toolbar's **Export settings** directly, without asking for the edition again. If a saved format or edition is unavailable, an enabled format and its default edition are used.

The EPUB retains the book title; the two editions have distinct publication identifiers so readers can keep both. Single-book export suggests an edition suffix for the optimized version; batch output retains book titles and the usual collision numbering. EPUB import can reopen both editions. Both reading directions, inserted blank pages and bookshelf-only covers are supported; spread positions follow the actual reading order, beginning with one unpaired page.

EPUB export automatically uses white page padding in light mode and black padding when the reader reports dark mode, in both General and Two-page optimized editions. This changes only the page background: source images, crop bounds, alignment and fixed viewport dimensions remain unchanged. Inserted blank pages remain white. EPUB import accepts the corresponding `:root`, `color-scheme` and background media rules so these books can be edited again.

**Preferences → EPUB page size** sets the canvas used by both EPUB editions, including single-book and batch exports. The default is **1750 × 2480**; width and height can be saved as integers from 1 to 10000. Each export captures this setting when submitted. Images fit proportionally within the canvas without resampling or recompression, and blank pages use the same canvas. Update the EPUB export plugin to **0.1.3** to use this setting.

### Optional formats

Install these separately from **Plugins → Included packages**, then restart. They are available offline but are not automatically installed; import and export remain independent.

- **ZIP image import** accepts `.zip` archives containing static JPEG, PNG or WebP pages. Nested page folders use natural filename order (`1`, `2`, `10`), and macOS resource forks/hidden files are skipped. Original JPEG/PNG bytes are kept when possible; WebP and rotated EXIF images become ordinary PNG assets. Optional `ComicInfo.xml` supplies title, author, language, reading direction and cover selection. Without it, the filename supplies the title, language defaults to `zh-Hant`, and direction defaults to left-to-right. ZIPs containing only PDFs or other documents are not image books.
- **CBZ import** accepts `.cbz` books with the same image and metadata handling. Update existing CBZ installations to **0.1.2** before installing ZIP image import, then restart: CBZ 0.1.0 claimed both extensions, while 0.1.1 and later leave `.zip` to the independent ZIP plugin. ZIP import 0.1.1 and CBZ import 0.1.2 include the shared archive validation updates.
- **EPUB image import** accepts EPUB 2/3 books with simple image pages: one JPEG, PNG or WebP image per XHTML page, a single-image SVG with a rectangular `viewBox` crop, or a white SVG blank. Reading order follows the package spine, with title, authors, language and reading direction retained. EPUB 2 cover metadata/guide entries and EPUB 3 cover images/landmarks select the cover; a cover outside the reading spine becomes a cover-only page. Repeated images share an asset, and original JPEG/PNG bytes are kept when normalization is unnecessary. Foluma's exported crops and blank pages can be imported again. Blank dimensions follow the encoded SVG viewport, which can differ from the original Foluma blank size. Update to **0.1.3** for automatic light/dark padding, spine-aligned exports and comics with shared CSS resets, centered image wrappers, pixel size limits and publisher image annotations. CSS rules whose subject is absent from the page are ignored, including unused rules inside media queries; applicable transforms, generated text, multiple-image composition and SVG geometry overrides remain unsupported. Cover guides pointing to artwork already displayed in the spine reuse that page. Font obfuscation on unused fonts is allowed; encrypted page content is unsupported.
- **CBZ export** writes the current page order, real crops and white blank pages. Uncropped JPEG/PNG bytes are preserved; cropped pages are lossless PNG, with CMYK crops converted to RGB. ComicInfo metadata includes the selected cover and reading direction. CBZ is a finished image book, not an editable Foluma project: attention marks, undo state and cover-only spread preferences are not encoded.
- **PDF export** creates an image-based PDF with the current page order, crops, blank pages, title, author, language and reading direction. Repeated images share one PDF resource, without resampling/recompressing JPEGs. Pixel dimensions become PDF points; pages beyond 14400 points are proportionally reduced without changing image data. Crops clip the displayed page but retain the complete source image in the PDF; use a separate redaction tool when hidden content must be removed. This does not reconstruct text, vector artwork or an OCR layer from an original PDF.

ZIP and CBZ import reject unsafe paths, symlinks, duplicate filenames and XML entity declarations. Archives are limited to 10000 entries and 2 GB uncompressed; individual images to 128 MB and 100 million pixels; ComicInfo metadata to 1 MB. Empty or invalid image books fail without replacing the open document. Existing outputs and source files retain the engine's overwrite protection and atomic publication rules.

EPUB import uses the same archive and image limits, with at most 10000 reading pages and 1 MB per XML/CSS resource. It resolves only resources inside the archive, evaluates no scripts or network content, and rejects missing resources, XML entities, encrypted archives and unsupported layouts without replacing the open book. Imported images are independent of the source EPUB and its importer after saving a project.

English is built in. Choose **Install and use 繁體中文** under **Preferences → Interface language** to install the included language pack and switch immediately. Language packs can be disabled or removed immediately. A book's language setting controls EPUB metadata independently of the interface language.

## Folder projects

**New project** guides you through location, book information, and a file/order preview. Enter a series title, optional author and reading direction, then add the first books. Keep existing volume numbers, number in the preview order, or omit the suffix; set the starting number, digit width and title style. Move rows, adjust individual volume numbers, use a custom title for side stories, or exclude a book before creating the folder. Blank author fields preserve imported author metadata. These choices apply to the selected first books; later imports keep their own information.

Use **Batch book information…** in the project view to update selected books, books in the current view, or the entire project. Review each resulting title and author before applying. Titles, authors and language can change while retaining completed page review; exported books become **Needs re-export**. Reading-direction or cover-placement changes still require review. Project source filenames remain provenance; exports use each book's title.

A project is a folder you choose. Imported source books are copied into it, groups correspond to subfolders, and saved edits and embedded images live in the hidden `.foluma` directory. Move the entire project folder to keep its books and edits together. Imported page images are saved independently of the source format: removing an import plugin or losing the original source does not stop an already imported book from opening, previewing or exporting through another installed plugin.

- Add files supported by enabled import plugins, import supported files directly inside a folder, or import an existing `.mteproj` book project.
- Create groups while keeping your selection, or choose to move the selected books into the new group. Rename groups, move books between them, and change their order with arrows or **Move to position**. Groups support one level of subfolders.
- Search titles and filenames, and use the visible group tabs to switch between **All books**, **Ungrouped**, custom groups and **Removed**.
- Remove books and use **Undo removal**, or recover them from **Removed**. Removing a group moves its books to **Ungrouped**. Import sources are left untouched.
- In **Removed**, permanently delete selected books or **Empty Removed** after reviewing the book count and size. This deletes project source copies and saved edits; original import sources and exported files are kept.
- **Close project** returns to the welcome screen and stops reopening that project on the next launch. Saved project files are kept, and unsaved changes use the existing save/discard/cancel prompt. Finish or cancel background tasks before closing.
- Open the project or choose **Refresh folder** to discover filesystem changes. New supported book files are added; uniquely matching renamed files retain their saved edits. Missing or changed sources are flagged, but saved page images remain usable. Relinking an edited book still requires the original content.
- Migrate an older series with **Save series as folder project**. Its individual book layouts and review state are preserved.

Each book keeps its own page order, blanks, crops, attention marks, and saved edits. Use **Book reviewed** and **Next unreviewed** to track progress. Pending page marks remain visible in the project, and completing review with remaining marks requires confirmation. Select books to share reading direction or cover settings, or export each book's own layout without applying a preset. Batch results show completion counts; a book that needs rendering offers **Allow rendering and retry this book**. Existing output files are preserved by numbering duplicate names. Editing an exported book marks it **Needs re-export**.

The toolbar identifies standalone books and the current book separately from selected project books. In the project view, **Export selected books** and ⌘E export the selection; in a book view they export the current book. Book information is committed before saving, exporting or changing books, including while an input still has focus. Unsaved standalone books offer **Save and continue**, **Discard changes** and **Cancel**.

Searching, filtering and switching book groups retain the selected books. The selection bar reports how many selected books are hidden. **Export selected books**, move and remove use only the currently visible selected books. The batch information dialog explicitly offers selected, visible or all project books. Clear the filters to bring hidden selections back, or use **Clear selection** to deselect everything. Entering or leaving **Removed** clears the selection so active and removed books have separate batch scopes.

Standalone books can also be saved as `.mteproj` folders. These embed all page images and retain source paths as provenance. Missing originals do not block saved-image previews or exports; relinking still requires matching contents. Older series continue to use per-book projects under the app's data directory until migrated.

## Page editing

Use the toolbar's sidebar button and the editor's **Page tools** button to show or hide secondary panels. Narrow windows automatically give more room to the preview; the page tools can be reopened whenever needed. Previews show a thumbnail while a larger image loads, and editing book information keeps an unchanged page preview in place. Success messages use the fixed status bar, and errors appear in a fixed corner without resizing the workspace; invalid title and language fields also show their errors beside the input.

The desktop layout uses a toolbar, workspace sidebar, page list, preview, inspector, and status bar, with organization inspired by [calibre](https://manual.calibre-ebook.com/gui.html).

- Switch between list, thumbnail, and spread views. Drag one or several pages to reorder them, or use the context menu. **Shift+F10** opens the same menu from the keyboard.
- Insert images or blank pages, split spreads with a preview guide, restore splits, and manage covers and reading direction.
- Use **Rotate selected images 90° clockwise** in page properties or the context menu. It rotates all selected image pages by a quarter turn; two clicks correct an upside-down image and four return to the original orientation. Rotation is saved with projects and presets and supports undo/redo. Splitting follows the displayed orientation. EPUB, PDF and CBZ exports retain the rotation; rotated source images are encoded as lossless PNGs for export, while the project's original files and **Export originals** remain unchanged.
- Navigate by complete spreads with left/right keys in the selected reading direction; use up/down in the page list for individual pages, or enter a preview page number to jump directly. Previews show both the current page number and original PDF page number; selection, view mode, scroll position, and zoom are saved per book. Newly inserted images are selected immediately.
- Mark pages for attention and jump to the next mark.
- Mark a spread by selecting a page, then Option-clicking an adjacent image page (Alt on Windows/Linux), or select two adjacent image pages and use **Mark selected pages as a spread** in the context menu. A book icon identifies marked pages. Option-click the same pair again or choose **Remove spread mark** to clear it. Marks are saved with the project and support undo/redo.
- Open **Blank suggestions…** to see each marked spread's current pairing and the ranges where blank pages can align them. A compact independent window opens beside the main window when screen space permits; drag its title bar anywhere, including outside the app or onto another display, and resize it as needed. Click a reference position to select that page in the main editor, then use the existing blank-before/after actions or B / Shift+B. Previews and suggestions update after edits, undo/redo and changes to reading or cover settings. Suggestions use the current page order and leading-blank preview setting; source page numbers are only labels. Removed, separated or excluded marked pages require correction or removal of the mark before recommendations are shown. Closing the tool window keeps the book open.
- Use **Presets → Apply preset to PDFs…** to apply a portable layout preset to books with matching page structures and export them separately.

**Simulate leading blank** previews the page pairing used by readers such as Apple Books. It does not insert a blank into the document or exported EPUB.

| Action | Shortcut |
| --- | --- |
| Import book | ⌘O |
| Open project | ⇧⌘O |
| Save project | ⌘S |
| Export current book | ⌘E |
| Insert blank before / after the current page | B / Shift+B |
| Toggle review mark / jump to next marked page | M / Shift+M |

Windows and Linux use Ctrl in place of ⌘ for the document shortcuts.

## Image handling and performance

**Preferences → Background processing** controls project preparsing and concurrent export. Both are enabled by default, with two tasks each; concurrency is configurable from 1 to 8. Turning concurrent export off processes one book at a time. Opening a project or adding books starts preparsing unread books and saves the results in their existing book projects. Later opens reuse these saved pages and images. Opening a book already being preparsed joins the same task and gives queued work priority. Complex PDF pages render automatically as PNG using Auto resolution during preparsing; supported images are still extracted directly. A failure in one book does not stop the rest.

Import and parsing progress appears directly below the main toolbar, with the current book, processing stage, progress bar, completed/total counts, percentage and Cancel action. Concurrent parsing shows each running book and the queue count; preparation with no known total uses an indeterminate bar. The top progress area closes when importing/parsing finishes. The bottom-left status bar retains task history, export activity, errors and cancellation. Batch cancellation cancels all tasks started by that batch. Background work permits editing and switching books. Each export uses a snapshot taken when that export is submitted; edits made afterward still require another export. Concurrent exports reserve distinct filenames and retain the existing protection for source and destination files.

Use **Open in new window** beside a project book to edit several books simultaneously. Reopening the same book window focuses the existing window. Each window keeps its document, selection, zoom and scroll; windows displaying the same document share revisions and undo/redo. Blank-suggestion tools stay attached to their originating book and select pages in their originating editor. Closing a book window keeps the main workspace open. Closing the main workspace or switching projects first checks and saves pending changes in the other book windows. Close a book's windows before removing or relinking it.

Supported full-page images are extracted directly, preserving their original image data. Pages with text, rotation, compositing, or other unsupported content render automatically during project preparsing. Manual imports and books opened with preparsing disabled require confirmation before rendering to PNG.

**Auto** resolution follows the main image's displayed pixel density, with a maximum of 6000 pixels on the longest edge. Pages containing only text, vectors, or small images use 200 DPI within the same size limit. Manual settings from 72 to 600 DPI remain available. Changing this preference does not regenerate images already saved in a project.

PNG rendering uses lossless compression. Pages are stored as grayscale only when every pixel's red, green, and blue channels are equal; even a slight tint retains RGB. Preview requests prioritize the large preview and discard obsolete queued work.

**Preferences → Storage** shows combined preview and imported-image cache usage, with a breakdown of both and the amount currently in use. It offers a **1 GB / 5 GB / 10 GB / Custom** limit (default 5 GB; custom 1–1000 GB). Save the limit to apply it. Oldest unused cache files are removed automatically; recent files and files in use may temporarily exceed the limit. **Clear cache now** removes available previews and unused imported/rendered images from the application cache and reports the space freed. Images needed by open books, undo/redo history or background tasks are kept. Clearing may make the next preview or import slower. PDFs, saved project images, saved edits and Removed books are excluded from cleanup.

In a local 243-page benchmark, the faster PNG encoder reduced a fresh import from approximately **127 seconds to 50 seconds**. All rendered pages retained identical decoded pixels, while total PNG size increased by about 2%. Results depend on the PDF and hardware; see the [validation record](VALIDATION.md) for the measurements and test coverage. Reopening a saved project reuses its rendered images.
