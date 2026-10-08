# Developing Foluma

[Back to the project overview](../README.md)

## Requirements

The validated development target is macOS Apple Silicon. Install Python 3.11 or newer, Node.js 22.18 or newer, stable Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run locally

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm ci
npm run tauri dev
```

The development command builds the included plugins before starting the frontend and desktop shell. Format workers use the repository's Python environment in development.

## Checks

```sh
.venv/bin/ruff check engine plugins tests scripts
npm run test:engine
npm test
npm run build
```

Python checks exercise the engine and formats; TypeScript checks cover document actions, editor models and integration flows. The build checks types and bundles the frontend. Both test commands prepare development format packages automatically. See [validation records](VALIDATION.md) for coverage and manual checks.

## Build the app

```sh
npm run tauri build
```

The build packages the editor, language pack and self-contained native format workers, freezes the Python engine, and builds the frontend. Outputs include:

- `src-tauri/target/release/bundle/macos/Foluma.app`
- A disk image under `src-tauri/target/release/bundle/dmg/`
- Independent `.mte-plugin` packages and `catalog.json` under `artifacts/`

The packaged app needs no developer runtimes. These commands create local artifacts; they do not publish a release. macOS builds currently use an ad-hoc signature without notarization.

```sh
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Foluma.app
```

The [macOS workflow](../.github/workflows/check.yml) repeats automated checks and uploads an app archive plus plugin packages as CI artifacts.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `desktop/` | React desktop shell, projects, preferences and plugin management |
| `engine/foluma/` | Python document model, storage, history and background jobs |
| `plugins/` | Independent editor, format workers and language packs |
| `sdk/` | Shared plugin types, actions, translations and UI primitives |
| `src-tauri/` | Rust host, native dialogs, engine bridge and app configuration |
| `scripts/` | Engine/plugin packaging and reproducible demo generation |
| `tests/` | Python and TypeScript checks |
| `assets/` | Source app icon |
| `docs/` | User guide, plugin API, development plan and validation history |

Generated builds, packages, caches and local test data are ignored by Git.

## App icon

`assets/AppIcon.svg` is the source of truth. Generate platform icons with the installed Tauri CLI:

```sh
npm run tauri -- icon assets/AppIcon.svg --output build/app-icons
cp build/app-icons/icon.png build/app-icons/icon.icns build/app-icons/icon.ico src-tauri/icons/
```

Commit the SVG and the three desktop icons together. Additional generated platform assets stay in the ignored build directory.

## Plugins and sample books

- `npm run package:plugins:dev` builds development plugin packages under `build/`.
- `npm run package:editor` builds release plugin packages and the catalog under `artifacts/`.
- `.venv/bin/python scripts/make_demo.py` generates an eight-page reference PDF under `artifacts/`, without external sample files.
- Set `FOLUMA_DATA` to an isolated directory when launching an app for manual checks, so it uses a separate profile.

Release format plugins bundle their own native workers and runtime directories, unpacked once at installation. The base engine does not bundle MuPDF or an EPUB writer. See the [plugin API](PLUGIN-API.md) for package structure and host capabilities.

Older PDF-backed projects migrate to stored page images when opened with PDF import enabled. Their original PDF and importer are required for this one-time migration; afterward saved books no longer depend on either.
