# Plugin API 1

Foluma loads optional workspaces and independent import/export formats from `.mte-plugin` ZIP packages. The editor in `plugins/editor/` is the working reference. It builds independently and is **not** imported by the base application. UI packages can use any framework; export `mount(element, host)` and return a cleanup function. The host mounts each workspace in a shadow root. Bundle dependencies locally; no CDN or network runtime is needed.

```json
{
  "id": "org.example.tool",
  "name": "Example tool",
  "version": "0.1.0",
  "api_version": 1,
  "platforms": ["all"],
  "ui": {"entry": "tool.js", "style": "tool.css", "title": "Example"}
}
```

IDs use lowercase letters, numbers, dots and hyphens. Versions use `major.minor.patch`. Files are relative to the package root; traversal, symbolic links, duplicate entries and encrypted ZIPs are rejected. Unpacked packages are limited to 256 MB and 5,000 entries. Installing, updating, enabling and removing executable plugins changes the **next** launch. Language packs take effect immediately. Installed code stays fixed for the current process. Safe mode skips every plugin. A profile without `plugins.json` installs the bundled editor before loading plugins on its first launch. An existing config, including an empty installed list, is never overwritten by the editor default. PDF import and EPUB export are seeded once on first use of format plugins, including upgrades from their formerly built-in versions. Their recorded default-install state prevents later removal or disabling from being undone on restart.

Plugins are trusted local code. The shadow root isolates styles, **not privileges**. Native workers can access files and the network with the user's permissions. Foluma does not claim a sandbox or permission enforcement. Install only packages from trusted authors.

## Host interface

The source of truth is [`sdk/types.ts`](../sdk/types.ts). The host optionally provides `getLocale`/`subscribeLocale` for live translation updates, `contextMenu` for native menus, `setBusy`/`cancelTask` for multi-step work, and `onFileDrop` for book files routed to the editor. `getFormats?()` returns active plugin manifests with a `format` declaration; do not assume PDF or EPUB is always available. New methods are optional additions to API 1. The host supplies document snapshots, subscriptions, atomic `apply(book, changes)`, `preview`, native file dialogs, confirmation, status/error reporting and `task`/`rpc` methods. A plugin's UI stores only selections, focus and view preferences. Do not keep a mutable parallel document model. A workspace mounts on its first visit and stays mounted while hidden, preserving its UI state across navigation; resize handlers should ignore zero-sized hidden containers.

`getExportPreferences?()` returns the most recent output `directory` and the current rendering `dpi`; `setOutputDirectory?(directory)` remembers a new output location. Older hosts can fall back to an empty directory and Auto resolution. `notify(message, {label, run}?)` can attach a reversible action; an empty message clears the existing notice. `confirm(message, title?, okLabel?)` supports an action-specific confirmation label.

`host.preview(book, page, size, signal?)` accepts an optional `AbortSignal`. Abort on unmount or when the requested page changes. The host shares matching requests, drops queued work when all consumers cancel, runs at most two previews and prioritizes larger previews over thumbnails. Already running previews finish and populate the cache. Older hosts ignore the optional signal, so views should also ignore results after cancellation.

Every edit uses `document_id` and `base_revision`. Stale edits fail without partial changes. Keep page IDs when moving pages; create UUIDs for inserted or split pages. Assets are immutable and shared between page crops. Crops are normalized `[x, y, width, height]`. The host owns history, retaining up to 100 metadata snapshots. Unknown `extensions[plugin_id]` JSON survives save/open even when its plugin is absent.

| RPC | Parameters / result |
| --- | --- |
| `document.get` | Current snapshot or `null` |
| `app.info` | Startup state, including last series snapshot or `null`, plus `series_error` if restoration failed |
| `series.get` | Current series snapshot or `null` |
| `series.scan` | Legacy compatibility: `paths` resumes the former externally linked series |
| `series.create` | `parent`, `name`: creates a new managed project directory without overwriting an existing folder |
| `series.open_project` | `path`: opens a managed project, checks external changes and restores the current book; also accepted by `project.open` |
| `series.migrate` | `parent`, `name`: copies a legacy series and its saved edits into a managed project |
| `series.add` | `paths`, optional `group`: copies supported source files, immediate folder files, or an edited `.mteproj`; response adds `summary: {added, skipped, folders_skipped}` |
| `series.group` | `name`, optional `previous`: creates or renames a real subfolder; optional `ids` when creating a group moves selected books in the same rollback-capable operation |
| `series.move` | `ids`, `group` (empty means root/Ungrouped): moves selected source files |
| `series.remove` / `series.restore` | `ids`: reversible removal/restoration of source files with book edits retained |
| `series.delete_group` | `name`: moves books to Ungrouped; refuses unknown files or name collisions |
| `series.refresh` | Scans the root and one level of visible subfolders; response adds `summary: {added, renamed, missing, changed}` and snapshot `refreshed_at` |
| `series.relink` | `id`, `path`: copies a matching original source back to a missing project location |
| `series.reorder` | `ids`: complete ordered list of active book IDs |
| `series.review` | Entry `id`, boolean `reviewed`; requires explicit `allow_pending: true` to complete review when built-in editor page marks remain |
| `series.output` | Existing output `directory` |
| `series.configure` | Entry `ids`, `metadata` containing only `direction` and/or `cover_only`; returns per-entry `{id, error}` results |
| `document.apply` | Document reference + `changes: {pages?, metadata?, extension?: {id, data}}` |
| `document.undo`, `document.redo` | `document_id` |
| `document.release` | `document_id`; releases a background document after batch processing |
| `app.locale` | Optional `code`; reads or persists the active interface language and returns available languages and messages |
| `plugins.bundled`, `plugins.install_bundled` | List included offline packages or install one by `id` |
| `document.preview` | `document_id`, `page_id`, `size` (64–2048); managed resource path |
| `project.open` | `path` to a `.mteproj` directory |
| `project.save` | Document reference + `path` |
| `project.relink` | Document reference + `source_id`, `path`; SHA-256 must match |
| `task.start` | See operations below; returns a task descriptor |
| `task.cancel`, `task.get` | Task `id` |
| `bundle.write` | Document reference + `plugin`, `path`, opaque `payload`, file `asset_ids`, `overwrite` |
| `bundle.read` | Document reference + `plugin`, `path`; returns payload, remapped asset IDs and snapshot |

`host.task(params)` waits for completion, exposes progress in the main toolbar and rejects failures/cancellation. There is one foreground job at a time; thumbnail processes have a separate bounded queue. Tasks are bound to the initiating document and revision. Exports use that immutable snapshot; imported image and worker results are applied only if the document still matches.

| Operation | Extra parameters |
| --- | --- |
| `import` | `path`, optional `plugin_id`, opaque `options`, and backward-compatible `render: true`, `dpi` (`"auto"` by default, or integer 72–600; Auto follows a dominant image’s displayed pixel density, falls back to 200 DPI and caps the longest edge at 6000 pixels), optional `background: true` to leave the open book untouched |
| `series.open` | `entry_id`; opens its saved project or imports it lazily; accepts the same `render`, `dpi` and `background` options as import |
| `export` | Document reference + output `path`, `overwrite`, optional `plugin_id` and opaque `options`; or `directory` for automatic naming with no overwrites. Directory exports require `plugin_id` when multiple exporters are active |
| `images.import` | Document reference + image `paths`, zero-based insertion `position` |
| `images.export` | Document reference + `page_ids`, `.zip` `path`, `overwrite`; full original images |
| `plugin` | Document reference + active `plugin_id`, opaque `input` |

## Format plugins

One package declares one direction in `format`; import and export are separate packages. A format plugin does not need a `ui` workspace. The desktop import menu, drag-and-drop routing, project file scanning and export/batch format choices use only active declarations. There is no built-in codec fallback.

Plugin Management groups packages automatically using `format.direction`, then `language`; other packages appear under Editing and tools. No extra manifest category field is required.

PDF import (`org.foluma.import.pdf`) and EPUB export (`org.foluma.export.epub`) remain the only default-installed formats. Included optional packages are CBZ import (`org.foluma.import.cbz`, suffix `cbz`), ZIP image import (`org.foluma.import.zip`, suffix `zip`), CBZ export (`org.foluma.export.cbz`) and image-based PDF export (`org.foluma.export.pdf`). Install each independently and restart to expose its actions. They use the same worker protocol; no new core codec or dependency is required. Packaging discovers manifests directly from `plugins/*/manifest.json`.

ZIP and CBZ workers bundle the same `plugins/image_archive.py` implementation independently; neither requires the other plugin to be installed. Development packages include the shared module, while native workers freeze it. ZIP import accepts static JPEG, PNG and WebP images with optional ComicInfo metadata. Update CBZ import 0.1.0 to 0.1.1 before installing ZIP import to remove its old `zip` alias and avoid overlapping providers.

```json
{
  "id": "org.example.import.scan",
  "name": "Scan import",
  "version": "0.1.0",
  "api_version": 1,
  "platforms": ["macos-arm64"],
  "format": {"direction": "import", "name": "SCAN", "extensions": ["scan"]},
  "workers": {"macos-arm64": "workers/import-scan"}
}
```

`extensions` is a nonempty, unique list of lowercase alphanumeric suffixes without dots. The host matches suffixes case-insensitively. Pass `plugin_id` when more than one plugin supports a suffix. Import plugins may declare `rendering: true` to indicate page-rendering options; the bundled PDF plugin retains explicit rendering consent and Auto/manual DPI options. Missing or ambiguous providers produce an error with `data.kind: "format_plugin_required"`.

Format workers receive `{plugin_id, operation, input, book, messages}` on stdin and use the normal progress/result protocol. `messages` is the current translation catalog. For `operation: "import"`, `book` is null and `input` contains the absolute source `path`, host-owned `asset_directory`, and opaque `options`. Return a complete schema-1 book, with every image asset a `kind: "file"` PNG/JPEG resource. The host validates the book and copies resources into its own storage before publishing it. Preserve original encoded images when possible; the book must not require the import plugin to decode its pages later.

For `operation: "export"`, `book` is an immutable snapshot with ordinary image assets; `input.path` is a staging filename and `input.options` contains caller options. Write exactly that staging file and return a result object such as `{total: 12}`. The host protects sources, handles cancellation and atomically publishes the output, including no-overwrite collision naming for directory exports. The suffix is selected from the provider declaration, not hardcoded in the engine.

The PDF import plugin also handles `operation: "materialize"` for legacy PDF-backed projects. It must preserve every field except asset records. The host validates the unchanged identity, pages and metadata, embeds the resulting image files and atomically checkpoints an already saved project without changing its revision. Missing/changed originals or a disabled importer produce an actionable failure without rewriting the project.

`images.import` and `images.export` remain generic editor resource operations (inserting image assets and retrieving original selected assets), not registered book-format providers. They do not decode PDFs or provide a hidden EPUB exporter. New book-level image/ZIP/CBZ formats should use the same independent format-plugin contract.

## Language packs

A language pack is a data-only plugin with `language: {"locale": "zh-Hant", "name": "繁體中文", "messages": "messages.json"}` instead of `ui` or `workers`. `messages.json` maps English source strings to translations. Numeric placeholders such as `{0}` must match between source and translation. Language packs cannot declare executable entry points; use a separate plugin for code. English (`en`) is the built-in fallback and cannot be replaced by a pack. Only one installed pack per locale is allowed. Installing a pack makes it available in Preferences; switching is immediate. Disabling or removing the selected pack resets the preference to English. Missing translations fall back to their English source text. Interface language does not change EPUB metadata.

The engine translates errors and progress using the same catalog. UI plugins can use `sdk/i18n.ts`, initialize it from `host.getLocale()` and subscribe to locale changes without unmounting their workspace. Translations are rendered as text, never HTML.

## Native workers

Add `workers: {"macos-arm64": "workers/tool"}` (or `macos-x86_64`, `windows-x86_64`, `linux-x86_64`) and preserve the executable bit in the ZIP. Bundle its runtime; Foluma does not install packages into its engine environment. The worker receives one JSON line on stdin with `{plugin_id, input, book}`. Emit progress and exactly one result on stdout; logs go to stderr:

```json
{"progress":{"done":1,"total":4,"message":"Processing"}}
{"result":{"changes":{"extension":{"id":"org.example.tool","data":{"completed":true}}}}}
```

Or emit `{"error":{"message":"Reason","data":null}}` and exit nonzero. The host validates the result and document revision before applying it. A process exit without a valid result is an error. Cancellation terminates the worker process group on macOS/Linux. Generated images can enter through `images.import`; original asset records are never overwritten.

## Project and preset storage

`.mteproj/project.json` is schema 1; original source paths are relative where possible and bound to SHA-256 fingerprints. All imported/inserted/rendered images are copied into `assets/`. JSON publication is atomic. The editor's `.mtepreset` is a ZIP with generic `bundle.json` plus embedded images. It maps source page numbers to the target source book, preserves normalized crops and split restoration, and retains target pages after the preset's source range. It does not import legacy `manga-to-epub` projects or presets.

## Catalog

`scripts/package_plugin.py` produces the editor, language-pack and native format-plugin ZIPs and `artifacts/catalog.json` with its SHA-256 and release URL. Official installation uses HTTPS and verifies the downloaded package hash and ID. No release is published by building. The repository is currently private; until a reachable release exists, use local package installation. Windows/Linux packaging is not yet validated.

## Batch processing

Series processing opens each entry's independently saved project in the background and exports it to the chosen directory. The editor's optional advanced preset workflow instead imports supported books, reads a preset bundle with asset remapping, and applies its layout before export. Both reuse the same queue and release background documents in `finally`. The active book's session is retained, including undo history, when it is part of the batch. Failed books are reported separately, and cancellation stops pending books while keeping completed exports. The host keeps one foreground worker job at a time. Directory exports sanitize names, append numbers for collisions and still publish atomically without overwriting a file created during export.

## Series persistence

`series.changed` notifications carry the current series snapshot. Managed entries have stable IDs independent of their paths (legacy entries retain path-derived IDs), a saved document ID/revision, reviewed/exported revisions and output paths. An edit invalidates review/export status until the new revision is reviewed/exported. An export does not mark a book reviewed. Settings for unopened books are recorded and applied on first import; page edits are never copied between volumes.

Managed projects store their manifest at `.foluma/project.json`, ordinary `.mteproj` book edits under `.foluma/books/`, and source copies in the root or a single group subfolder. Stored paths are relative so the directory can move. Removed sources stay under `.foluma/removed/`; their edits and revisions remain available. Snapshots include `managed`, `directory`, `groups`, active `items` and `removed`; each book includes `group`, `missing` and `changed`. Group changes do not invalidate review/export revisions. External renames are matched only when the original content has one unambiguous candidate. Changed sources never replace the expected fingerprint or acquire old edits. Missing, never-opened legacy books may have a null fingerprint until their first source is supplied; edited books retain their known fingerprint. Missing legacy sources do not block migration of their saved edits. Legacy series remain under the application data directory's `series/` folder until explicitly migrated. Edits checkpoint the project before notifying the UI that it is saved; a save failure leaves the document dirty and prevents switching away until it can be saved. The last series and active book restore at startup. Missing source entries remain available for source relinking. Editor review flags live in `extensions["org.foluma.editor"].review`; focus, scroll and preview settings are local per-document UI preferences and do not travel with the project.

Each entry also reports `review_count`, counting unique attention marks on pages still present in the saved book. Older manifests derive this count from their saved book on first inspection; unavailable saved layouts return `null` rather than an assumed count. Other plugin extension payloads remain opaque.
