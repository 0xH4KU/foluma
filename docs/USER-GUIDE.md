# Foluma user guide

[Back to the project overview](../README.md)

## Getting started

1. Open Foluma.
2. Choose **Import book** to work on one book, or **New project** to choose a location for a collection.
3. Use **Edit pages** to arrange the book, then choose **Export current book** and an enabled output format.

The page editor, PDF import plugin and EPUB export plugin install from bundled packages on first launch, without a network connection. Each is independent: disabling or removing it takes effect after restarting, and the app will not automatically reinstall it. PDF import and EPUB export can be removed separately, just like the editor. Missing format actions lead to Plugins instead of falling back to hidden built-in codecs. Reinstall packages from **Plugins → Included packages** when needed.

Plugin Management groups packages into **Import**, **Export**, **Editing and tools**, and **Language packs**. Category filters apply to installed, included and downloadable packages, with counts for unique plugins. The default **All plugins** view groups each list by capability; disabled and restart-pending plugins keep their category. Installed versions are not repeated under included packages, and identical included versions are not repeated in the official catalog. Available updates remain visible.

### EPUB export editions

Single-book export, project batch export and the editor's preset batch dialog offer two editions:

- **General (default)** centers images and supports both single-page and two-page reading.
- **Two-page optimized** aligns facing pages to the spine and moves horizontal padding to the outer edges. It preserves the common page size, source images and crops. Images remain off-center in single-page view; this is an alignment preference, not a forced two-page reading mode.

The EPUB retains the book title; the two editions have distinct publication identifiers so readers can keep both. Single-book export suggests an edition suffix for the optimized version; batch output retains book titles and the usual collision numbering. EPUB import can reopen both editions. Both reading directions, inserted blank pages and bookshelf-only covers are supported; spread positions follow the actual reading order, beginning with one unpaired page.

EPUB export automatically uses white page padding in light mode and black padding when the reader reports dark mode, in both General and Two-page optimized editions. This changes only the page background: source images, crop bounds, alignment and fixed viewport dimensions remain unchanged. Inserted blank pages remain white. EPUB import accepts the corresponding `:root`, `color-scheme` and background media rules so these books can be edited again.

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

Standalone books can also be saved as `.mteproj` folders. These embed all page images and retain source paths as provenance. Missing originals do not block saved-image previews or exports; relinking still requires matching contents. Older series continue to use per-book projects under the app's data directory until migrated.

## Page editing

The desktop layout uses a toolbar, workspace sidebar, page list, preview, inspector, and status bar, with organization inspired by [calibre](https://manual.calibre-ebook.com/gui.html).

- Switch between list, thumbnail, and spread views. Drag one or several pages to reorder them, or use the context menu. **Shift+F10** opens the same menu from the keyboard.
- Insert images or blank pages, split spreads with a preview guide, restore splits, and manage covers and reading direction.
- Navigate by complete spreads with left/right keys in the selected reading direction; use up/down in the page list for individual pages, or enter a preview page number to jump directly. Previews show both the current page number and original PDF page number; selection, view mode, scroll position, and zoom are saved per book. Newly inserted images are selected immediately.
- Mark pages for attention and jump to the next mark.
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

Supported full-page images are extracted directly, preserving their original image data. Pages with text, rotation, compositing, or other unsupported content require confirmation before rendering to PNG.

**Auto** resolution follows the main image's displayed pixel density, with a maximum of 6000 pixels on the longest edge. Pages containing only text, vectors, or small images use 200 DPI within the same size limit. Manual settings from 72 to 600 DPI remain available. Changing this preference does not regenerate images already saved in a project.

PNG rendering uses lossless compression. Pages are stored as grayscale only when every pixel's red, green, and blue channels are equal; even a slight tint retains RGB. Preview requests prioritize the large preview and discard obsolete queued work.

**Preferences → Storage** shows preview cache usage and offers a **1 GB / 5 GB / 10 GB / Custom** limit (default 5 GB; custom 1–1000 GB). Save the limit to apply it. Oldest-used previews are removed automatically; recent or generating previews may temporarily exceed the limit. **Clear cache now** clears available previews immediately and reports the space freed. Previews regenerate when needed. PDFs, saved edits, imported/rendered image assets and Removed books are excluded from this cache limit and cleanup.

In a local 243-page benchmark, the faster PNG encoder reduced a fresh import from approximately **127 seconds to 50 seconds**. All rendered pages retained identical decoded pixels, while total PNG size increased by about 2%. Results depend on the PDF and hardware; see the [validation record](VALIDATION.md) for the measurements and test coverage. Reopening a saved project reuses its rendered images.
