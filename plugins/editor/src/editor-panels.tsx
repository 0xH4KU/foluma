import React, { useEffect, useRef, useState } from "react";
import type { Book, Changes, HostAPI, Page } from "../../../sdk/types";
import { t } from "../../../sdk/i18n";
import { Icon } from "../../../sdk/icons";
import { moveBefore } from "../../../sdk/order";
import { isPair, navigatePage, pageSize, parseRange, restorePages, rotatePages, spreadPages } from "./pages";
import { PageImage, Thumbnails, type ViewState } from "./thumbnails";

type SelectPage = (id: string, event?: React.MouseEvent) => void;
type Update = (changes: Changes) => Promise<void>;

export function EditorToolbar({
  book,
  ids,
  busy,
  history,
  readPreset,
  writePreset,
  openBatch,
  suggestions,
  openSuggestions,
}: {
  book: Book;
  ids: Set<string>;
  busy: boolean;
  history: (redo?: boolean) => Promise<void>;
  readPreset: () => Promise<void>;
  writePreset: () => Promise<void>;
  openBatch: () => void;
  suggestions: boolean;
  openSuggestions: () => void;
}) {
  return (
    <div className="editor-toolbar">
      <div>
        <strong>{t("Page editor")}</strong>
        <span>
          {ids.size} / {book.pages.length} {t(" pages selected")}
        </span>
      </div>
      <div className="toolbar-actions">
        <button aria-expanded={suggestions} onClick={openSuggestions}>{t("Blank suggestions…")}</button>
        <button
          title={t("Undo ⌘Z")}
          disabled={busy || !book.can_undo}
          onClick={() => void history()}
        >
          {t("↶ Undo")}
        </button>
        <button
          title={t("Redo ⇧⌘Z")}
          disabled={busy || !book.can_redo}
          onClick={() => void history(true)}
        >
          {t("↷ Redo")}
        </button>
        <details
          className="preset-menu"
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false;
          }}
        >
          <summary>{t("Presets")}</summary>
          <div>
            <button disabled={busy} onClick={readPreset}>
              {t("Load preset")}
            </button>
            <button disabled={busy} onClick={writePreset}>
              {t("Save preset")}
            </button>
            <button disabled={busy} onClick={openBatch}>
              {t("Apply preset to books…")}
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

export function PagePanel({
  book,
  host,
  ids,
  current,
  busy,
  view,
  setView,
  setSpread,
  select,
  contextMenu,
  gap,
  flags,
  spreadIds,
  initialScroll,
  rememberScroll,
  update,
  setSelected,
  setFocus,
}: {
  book: Book;
  host: HostAPI;
  ids: Set<string>;
  current: Page | undefined;
  busy: boolean;
  view: ViewState["view"];
  setView: (view: ViewState["view"]) => void;
  setSpread: (spread: boolean) => void;
  select: SelectPage;
  contextMenu: (id: string, at: { x: number; y: number }) => void;
  gap: boolean;
  flags: Set<string>;
  spreadIds: Set<string>;
  initialScroll: number;
  rememberScroll: (top: number) => void;
  update: Update;
  setSelected: (ids: Set<string>) => void;
  setFocus: (id: string | null) => void;
}) {
  const [range, setRange] = useState("");
  return (
    <aside className="pages-panel">
      <div className="panel-title">
        <strong>{t("Pages")}</strong>
        <div className="view-switch">
          <button
            title={t("List")}
            aria-label={t("List view")}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <Icon name="list" />
          </button>
          <button
            title={t("Thumbnails")}
            aria-label={t("Thumbnail view")}
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <Icon name="grid" />
          </button>
          <button
            title={t("Spread thumbnails")}
            aria-label={t("Spread thumbnails")}
            aria-pressed={view === "spreads"}
            onClick={() => {
              setView("spreads");
              setSpread(true);
            }}
          >
            <Icon name="book" />
          </button>
        </div>
      </div>
      <form
        className="range-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const parsed = parseRange(range, book.pages);
            setSelected(new Set(parsed));
            setFocus(parsed[0]);
          } catch (error) {
            host.report(error);
          }
        }}
      >
        <input
          aria-label={t("Select page range")}
          placeholder={t("Pages: 1-3, 5")}
          value={range}
          onChange={(e) => setRange(e.target.value)}
        />
        <button>{t("Select")}</button>
      </form>
      {view === "list" && (
        <div className="page-list-header">
          <span>{t("Page")}</span>
          <span>{t("Source")}</span>
          <span>{t("Status")}</span>
        </div>
      )}
      <Thumbnails
        view={view}
        book={book}
        host={host}
        selected={ids}
        focus={current?.id || null}
        select={select}
        busy={busy}
        context={contextMenu}
        gap={gap}
        flags={flags}
        spreadIds={spreadIds}
        initialScroll={initialScroll}
        rememberScroll={rememberScroll}
        move={(moving, before) => void update({ pages: moveBefore(book.pages, moving, before) })}
      />
      <div className="panel-foot">
        {ids.size}
        {t(" selected · Shift / ⌘ to select multiple")}
        <br />
        {t("Drag to reorder · Right-click for actions")}
        <br />{t("Option-click another page to mark a spread")}
      </div>
    </aside>
  );
}

export function PreviewPanel({
  book,
  host,
  current,
  ids,
  busy,
  spread,
  setSpread,
  gap,
  setGap,
  zoom,
  setZoom,
  flags,
  select,
  navigate,
  insertBlank,
  flag,
  nextFlag,
  splitRatio,
  splitPreview,
  contextMenu,
}: {
  book: Book;
  host: HostAPI;
  current: Page | undefined;
  ids: Set<string>;
  busy: boolean;
  spread: boolean;
  setSpread: (value: boolean) => void;
  gap: boolean;
  setGap: (value: boolean) => void;
  zoom: number;
  setZoom: (value: number) => void;
  flags: Set<string>;
  select: SelectPage;
  navigate: (step: number) => void;
  insertBlank: (page?: Page, before?: boolean) => void;
  flag: () => void;
  nextFlag: () => void;
  splitRatio: number;
  splitPreview: boolean;
  contextMenu: (id: string, at: { x: number; y: number }) => void;
}) {
  const index = current ? book.pages.indexOf(current) : 0;
  const [jump, setJump] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 400, height: 500 });
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const displayed = spread ? spreadPages(book, current?.id || null, gap) : current ? [current] : [];
  const aspect = (page: Page) => { const [width, height] = pageSize(page); return width / height; };
  const aspects = displayed.map((page) => (page ? aspect(page) : current ? aspect(current) : 1));
  const totalAspect = aspects.reduce((sum, value) => sum + value, 0) || 1;
  const previewHeight =
    (Math.max(1, Math.min(stageSize.height - 24, stageSize.width / totalAspect)) * zoom) / 100;
  const leftStep = book.metadata.direction === "rtl" ? 1 : -1;
  const jumpToPage = () => {
    const position = Number(jump ?? index + 1);
    if (!Number.isInteger(position) || position < 1 || position > book.pages.length) {
      host.report(new Error(t("Destination page is out of range")));
      return;
    }
    select(book.pages[position - 1].id);
    setJump(null);
  };
  return (
    <section className="preview-panel" aria-label={t("Page preview")}>
      <div className="preview-options">
        <strong>{t("Preview")}</strong>
        <div className="segmented">
          <button
            className={!spread ? "active" : ""}
            aria-pressed={!spread}
            onClick={() => setSpread(false)}
          >
            {t("Single")}
          </button>
          <button
            className={spread ? "active" : ""}
            aria-pressed={spread}
            onClick={() => setSpread(true)}
          >
            {t("Spread")}
          </button>
        </div>
        {spread && (
          <label>
            <input
              type="checkbox"
              checked={gap}
              aria-describedby="spread-help"
              onChange={(e) => setGap(e.target.checked)}
            />
            {t("Preview leading blank")}
          </label>
        )}
      </div>
      {spread && (
        <details className="preview-help">
          <summary>{t("About spread pairing")}</summary>
          <p id="spread-help">
            {t(
              "Preview spread pairing in readers that leave a blank before the first page, such as Apple Books. This only affects the preview; no blank page is added or exported.",
            )}
          </p>
        </details>
      )}
      <div className="review-actions">
        <button
          disabled={busy}
          title={t("Insert blank before this page (B)")}
          onClick={() => insertBlank(current, true)}
        >
          {t("Blank before")}
        </button>
        <button
          disabled={busy}
          title={t("Insert blank after this page (Shift+B)")}
          onClick={() => insertBlank()}
        >
          {t("Blank after")}
        </button>
        <button
          disabled={busy || !current}
          aria-pressed={[...ids].every((id) => flags.has(id))}
          title={t("Toggle page attention mark (M)")}
          onClick={() => flag()}
        >
          {[...ids].every((id) => flags.has(id))
            ? t("Clear page marks")
            : t("Mark selected pages for attention")}
        </button>
        <button
          disabled={!book.pages.some((page) => page.id !== current?.id && flags.has(page.id))}
          title={t("Next marked page (Shift+M)")}
          onClick={nextFlag}
        >
          {t("Next attention page ({0})", flags.size)}
        </button>
      </div>
      <div className="preview-scroll" ref={stage}>
        <div
          className="spread-view"
          style={{ width: previewHeight * totalAspect, height: previewHeight }}
        >
          {displayed.map((page, slot) => (
            <div
              key={page?.id || `gap-${slot}`}
              style={{ width: `${(aspects[slot] / totalAspect) * 100}%` }}
              className={`preview-page ${!page ? "virtual-gap" : ""} ${page?.id === current?.id ? "current-preview" : ""}`}
              onClick={() => page && select(page.id)}
              onContextMenu={(e) => {
                if (page) {
                  e.preventDefault();
                  contextMenu(page.id, { x: e.clientX, y: e.clientY });
                }
              }}
            >
              {page ? (
                <PageImage
                  book={book}
                  page={page}
                  host={host}
                  size={1600}
                  splitRatio={
                    splitPreview &&
                    !page.split &&
                    ids.has(page.id) &&
                    splitRatio >= 0.05 &&
                    splitRatio <= 0.95
                      ? splitRatio
                      : undefined
                  }
                />
              ) : (
                <span>{t("Preview blank (not exported)")}</span>
              )}
              {page && (
                <small>
                  {book.pages.indexOf(page) + 1}
                  {page.source_page
                    ? ` · ${t("Source page {0}", page.source_page)}`
                    : ` · ${page.kind === "blank" ? t("Blank") : t("Inserted image")}`}
                </small>
              )}
            </div>
          ))}
          {!displayed.length && (
            <p className="no-pages">{t("No pages. Insert images or undo to restore them.")}</p>
          )}
        </div>
      </div>
      <div className="preview-navigation">
        <button
          aria-label={
            leftStep > 0
              ? spread
                ? t("Next spread")
                : t("Next page")
              : spread
                ? t("Previous spread")
                : t("Previous page")
          }
          disabled={!navigatePage(book, current?.id || null, leftStep, spread, gap)}
          onClick={() => navigate(leftStep)}
        >
          ←
        </button>
        <form
          className="page-jump"
          onSubmit={(event) => {
            event.preventDefault();
            jumpToPage();
          }}
        >
          <input
            aria-label={t("Go to page")}
            type="number"
            min={1}
            max={book.pages.length || 1}
            disabled={!book.pages.length}
            value={jump ?? (current ? index + 1 : 0)}
            onChange={(event) => setJump(event.target.value)}
            onBlur={() => {
              if (jump !== null) jumpToPage();
            }}
          />
          <span> / {book.pages.length}</span>
        </form>
        <button
          aria-label={
            leftStep < 0
              ? spread
                ? t("Next spread")
                : t("Next page")
              : spread
                ? t("Previous spread")
                : t("Previous page")
          }
          disabled={!navigatePage(book, current?.id || null, -leftStep, spread, gap)}
          onClick={() => navigate(-leftStep)}
        >
          →
        </button>
        <label className="zoom-control">
          <input
            aria-label={t("Preview zoom")}
            type="range"
            min="50"
            max="200"
            step="10"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <small>{zoom}%</small>
        </label>
      </div>
    </section>
  );
}

export function Inspector({
  book,
  current,
  ids,
  busy,
  host,
  update,
  insertImages,
  remove,
  ratio,
  setRatio,
  splitPreview,
  setSplitPreview,
  split,
  exportImages,
}: {
  book: Book;
  current: Page | undefined;
  ids: Set<string>;
  busy: boolean;
  host: HostAPI;
  update: Update;
  insertImages: () => Promise<void>;
  remove: () => Promise<void>;
  ratio: string;
  setRatio: (value: string) => void;
  splitPreview: boolean;
  setSplitPreview: (value: boolean) => void;
  split: () => void;
  exportImages: () => Promise<void>;
}) {
  const index = current ? book.pages.indexOf(current) : 0;
  const [target, setTarget] = useState(1);
  const canRestore = book.pages.some(
    (page, i) =>
      isPair(page, book.pages[i + 1]) && (ids.has(page.id) || ids.has(book.pages[i + 1].id)),
  );
  return (
    <aside className="inspector">
      <fieldset disabled={busy}>
        <div className="panel-title">
          <strong>{t("Page properties and actions")}</strong>
        </div>
        <section className="page-properties">
          <dl>
            <dt>{t("Current page")}</dt>
            <dd>
              {current ? index + 1 : "—"} / {book.pages.length}
            </dd>
            <dt>{t("Source page")}</dt>
            <dd>{current?.source_page ? t("Source page {0}", current.source_page) : "—"}</dd>
            <dt>{t("Original size")}</dt>
            <dd>{current ? `${current.width} × ${current.height}` : "—"}</dd>
            <dt>{t("Page type")}</dt>
            <dd>
              {current?.kind === "blank"
                ? t("Blank page")
                : current?.split
                  ? t("Split · {0} half", current.split.side === "left" ? t("left") : t("right"))
                  : t("Full page")}
            </dd>
            <dt>{t("Rotation")}</dt>
            <dd>{current?.rotation || 0}°</dd>
          </dl>
          <button className="full-width" disabled={!book.pages.some((page) => ids.has(page.id) && page.kind === "image")}
            onClick={() => void update(rotatePages(book, ids))}>{t("Rotate selected images 90° clockwise")}</button>
        </section>
        <details className="inspector-actions">
          <summary>{t("Insert pages")}</summary>
          <section>
            <button className="full-width" onClick={() => void insertImages()}>
              {t("＋ Images")}
            </button>
            <p>{t("Insert after the current page")}</p>
          </section>
        </details>
        <details className="inspector-actions">
          <summary>{t("Order")}</summary>
          <section>
            <label>
              {t("Move before page")}
              <div className="inline-input">
                <input
                  aria-label={t("Destination page")}
                  type="number"
                  min="1"
                  max={book.pages.length + 1}
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                />
                <button
                  disabled={!ids.size}
                  onClick={() => {
                    if (!Number.isInteger(target) || target < 1 || target > book.pages.length + 1) {
                      host.report(new Error(t("Destination page is out of range")));
                      return;
                    }
                    void update({
                      pages: moveBefore(book.pages, ids, book.pages[target - 1]?.id || null),
                    });
                  }}
                >
                  {t("Move")}
                </button>
              </div>
            </label>
            <button
              className="danger full-width"
              disabled={!ids.size}
              onClick={() => void remove()}
            >
              {t("Delete selected pages")}
            </button>
          </section>
        </details>
        <details className="inspector-actions" open>
          <summary>{t("Split spreads")}</summary>
          <section>
            <label>
              {t("Left portion")}
              <div className="inline-input">
                <input
                  aria-label={t("Left split ratio")}
                  aria-describedby="split-help"
                  type="number"
                  min="5"
                  max="95"
                  value={ratio}
                  onFocus={() => setSplitPreview(true)}
                  onChange={(e) => setRatio(e.target.value)}
                />
                <span>%</span>
              </div>
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={splitPreview}
                onChange={(e) => setSplitPreview(e.target.checked)}
              />
              {t("Preview split line")}
            </label>
            <div className="two-buttons">
              <button
                disabled={
                  ![...ids].some((id) =>
                    book.pages.some((p) => p.id === id && p.kind === "image" && !p.split),
                  )
                }
                onClick={() => split()}
              >
                {t("Split")}
              </button>
              <button disabled={!canRestore} onClick={() => void update(restorePages(book, ids))}>
                {t("Restore")}
              </button>
            </div>
            <p id="split-help">
              {t("Order after split: ")}
              {book.metadata.direction === "rtl"
                ? t("Right half → left half")
                : t("Left half → right half")}
              {t(". Originals are preserved.")}
            </p>
          </section>
        </details>
        <details className="inspector-actions" open>
          <summary>{t("Cover and reading")}</summary>
          <section>
            <button
              className="full-width"
              disabled={
                !current || current.kind === "blank" || current.id === book.metadata.cover_id
              }
              onClick={() => {
                if (current) void update({ metadata: { cover_id: current.id } });
              }}
            >
              {t("Set as cover")}
            </button>
            <label>
              {t("Cover placement")}
              <select
                value={book.metadata.cover_only ? "shelf" : "both"}
                onChange={(e) =>
                  void update({ metadata: { cover_only: e.target.value === "shelf" } })
                }
              >
                <option value="both">{t("Bookshelf and book body")}</option>
                <option value="shelf">{t("Bookshelf only")}</option>
              </select>
            </label>
            <select
              aria-label={t("Reading direction")}
              value={book.metadata.direction}
              onChange={(e) =>
                void update({ metadata: { direction: e.target.value as "rtl" | "ltr" } })
              }
            >
              <option value="rtl">{t("Right to left")}</option>
              <option value="ltr">{t("Left to right")}</option>
            </select>
          </section>
        </details>
        <section>
          <button
            className="full-width"
            disabled={!book.pages.some((p) => ids.has(p.id) && p.kind === "image")}
            onClick={() => void exportImages()}
          >
            {t("Export originals from {0} selected pages", ids.size)}
          </button>
          <p>{t("Selected pages only. Split pages export their complete original images.")}</p>
        </section>
      </fieldset>
    </aside>
  );
}
