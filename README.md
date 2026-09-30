# Foluma

A local workspace for turning PDFs into fixed-layout EPUB books. Organize a series in a project folder, edit each book's pages, and export books individually or in batches.

Foluma uses Tauri and React/TypeScript for the desktop interface, with a separate Python engine for documents, undo history, and background tasks. The engine is bundled with the app; end users do not need to install Python, Node.js, or Rust.

## Getting started

1. Open `src-tauri/target/release/bundle/macos/Foluma.app` after building the app.
2. Choose **Open PDF** to work on one book, or **New project** to choose a location for a collection.
3. Use **Edit pages** to arrange the book, then choose **Export EPUB**.

The page editor installs from the bundled package on first launch, without a network connection. It is an independent plugin: disabling or removing it takes effect after restarting, and the app will not automatically reinstall it. Basic conversion remains available without the editor.

For an existing installation, update **Page editor** to **0.3.3** from **Plugins → Included packages**, or install `artifacts/org.foluma.editor-0.3.3.mte-plugin`, then restart.

English is built in. Install the Traditional Chinese language pack from **Plugins → Included packages**, then select it under **Preferences → Interface language**. Language packs can be disabled or removed immediately. A book's language setting controls EPUB metadata independently of the interface language.

## Folder projects

A project is a folder you choose. Imported PDFs are copied into it, groups correspond to subfolders, and saved edits and embedded images live in the hidden `.foluma` directory. Move the entire project folder to keep its books and edits together.

- Add PDFs, import the PDF files directly inside a folder, or import an existing `.mteproj` book project.
- Create and rename groups, move books between them, and change their order. Groups support one level of subfolders.
- Remove books and recover them from **Removed**. Removing a group moves its books to **Ungrouped**. Import sources are left untouched.
- Open the project or choose **Refresh folder** to discover filesystem changes. New PDFs are added; uniquely matching renamed files retain their saved edits. Missing or changed sources are flagged, and relinking an edited book requires the original content.
- Migrate an older series with **Save series as folder project**. Its individual book layouts and review state are preserved.

Each book keeps its own page order, blanks, crops, review marks, and saved edits. Use **Reviewed** and **Next unreviewed** to track progress. Select books to share reading direction or cover settings, or export each book's own layout without applying a preset. Existing output files are preserved by numbering duplicate names; failed items can be retried. Editing an exported book marks it **Needs re-export**.

Standalone books can also be saved as `.mteproj` folders. These reference the original PDF and embed inserted or rendered images. If the PDF moves, relink a file with matching contents. Older series continue to use per-book projects under the app's data directory until migrated.

## Page editing

The desktop layout uses a toolbar, workspace sidebar, page list, preview, inspector, and status bar, with organization inspired by [calibre](https://manual.calibre-ebook.com/gui.html).

- Switch between list, thumbnail, and spread views. Drag one or several pages to reorder them, or use the context menu. **Shift+F10** opens the same menu from the keyboard.
- Insert images or blank pages, split spreads with a preview guide, restore splits, and manage covers and reading direction.
- Navigate by complete spreads in the selected reading direction. Previews show both the current page number and original PDF page number; selection, view mode, scroll position, and zoom are saved per book.
- Mark pages for review and jump to the next mark.
- Use **Presets → Apply preset to PDFs…** to apply a portable layout preset to books with matching page structures and export them separately.

**Simulate leading blank** previews the page pairing used by readers such as Apple Books. It does not insert a blank into the document or exported EPUB.

| Action | Shortcut |
| --- | --- |
| Open PDF | ⌘O |
| Open project | ⇧⌘O |
| Save project | ⌘S |
| Export EPUB | ⌘E |
| Insert blank before / after the current page | B / Shift+B |
| Toggle review mark / jump to next marked page | M / Shift+M |

Windows and Linux use Ctrl in place of ⌘ for the document shortcuts.

## Image handling and performance

Supported full-page images are extracted directly, preserving their original image data. Pages with text, rotation, compositing, or other unsupported content require confirmation before rendering to PNG.

**Auto** resolution follows the main image's displayed pixel density, with a maximum of 6000 pixels on the longest edge. Pages containing only text, vectors, or small images use 200 DPI within the same size limit. Manual settings from 72 to 600 DPI remain available. Changing this preference does not regenerate images already saved in a project.

PNG rendering uses lossless compression. Pages are stored as grayscale only when every pixel's red, green, and blue channels are equal; even a slight tint retains RGB. Preview requests prioritize the large preview and discard obsolete queued work.

In a local 243-page benchmark, the faster PNG encoder reduced a fresh import from approximately **127 seconds to 50 seconds**. All rendered pages retained identical decoded pixels, while total PNG size increased by about 2%. Results depend on the PDF and hardware; see the [validation record](docs/VALIDATION.md) for the measurements and test coverage. Reopening a saved project reuses its rendered images.

## Development

Requires Python 3.11 or newer, Node.js, Rust, and the platform's Tauri prerequisites.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm install
npm run tauri dev
```

Run checks and build the desktop app:

```sh
npm run test:engine
npm test
npm run build
npm run tauri build
```

The build produces editor and Traditional Chinese language packages, plus a plugin catalog, in `artifacts/`. These commands do not publish a release. See the [implementation plan](docs/PLAN.md), [plugin API](docs/PLUGIN-API.md), and [validation record](docs/VALIDATION.md).

## Current status

This is a local test build for macOS Apple Silicon, using an ad-hoc signature without notarization. Windows and Linux have not been validated. Plugin catalog fetching and hash verification are implemented; local and bundled packages are the supported distribution path for this iteration.

Folder changes are reconciled when opening or refreshing a project, without a continuous watcher. Preview files and generated assets are retained locally; automatic cache cleanup is not implemented. Plugins are trusted local code and are not sandboxed.

## Provenance

PDF image stream and EPUB packaging utilities are adapted from HAKU's MIT-licensed `manga-to-epub` at commit `d3888b9`. The application, document model, plugin API and interface are independent of the original GUI.
