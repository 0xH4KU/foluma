import React, { useEffect, useRef, useState } from "react";
import type { Book, HostAPI, Page } from "../../../sdk/types";
import { t } from "../../../sdk/i18n";
import { Icon } from "../../../sdk/icons";
import { usePagePreview } from "../../../sdk/previews";
import { spreadGroups } from "./pages";

export type ViewState = {
  focus: string | null;
  selected: string[];
  spread: boolean;
  view: "list" | "grid" | "spreads";
  gap: boolean;
  zoom: number;
  scroll: number;
};

export function PageImage({
  book,
  page,
  host,
  size = 320,
  splitRatio,
}: {
  book: Book;
  page: Page;
  host: HostAPI;
  size?: number;
  splitRatio?: number;
}) {
  const { url, error } = usePagePreview(book, page, host, size);
  const image = useRef<HTMLImageElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const showGuide = splitRatio !== undefined;
  useEffect(() => {
    const node = image.current;
    if (!showGuide || !node) return;
    const observer = new ResizeObserver(() =>
      setBounds({ width: node.clientWidth, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [url, showGuide]);
  if (page.kind === "blank")
    return (
      <span
        className="blank-image"
        style={{ aspectRatio: `${page.width} / ${page.height}` }}
        aria-label={t("Blank page")}
      />
    );
  return url ? (
    <>
      <img
        ref={image}
        draggable={false}
        src={url}
        alt={page.source_page ? t("Source page {0}", page.source_page) : t("Inserted image")}
      />
      {splitRatio !== undefined && bounds.width > 0 && (
        <span className="split-guide" aria-hidden="true" style={bounds}>
          <span className="split-part" style={{ left: 0, width: `${splitRatio * 100}%` }}>
            {t("Left · ")}
            {book.metadata.direction === "rtl" ? t("second") : t("first")}
          </span>
          <span className="split-part" style={{ left: `${splitRatio * 100}%`, right: 0 }}>
            {t("Right · ")}
            {book.metadata.direction === "rtl" ? t("first") : t("second")}
          </span>
          <i style={{ left: `${splitRatio * 100}%` }} />
        </span>
      )}
    </>
  ) : (
    <span className="image-placeholder" title={error}>
      {error ? t("Preview unavailable") : "…"}
    </span>
  );
}

export function Thumbnails({
  book,
  host,
  selected,
  focus,
  select,
  move,
  view,
  busy,
  context,
  gap,
  flags,
  spreadIds,
  initialScroll,
  rememberScroll,
}: {
  book: Book;
  host: HostAPI;
  selected: Set<string>;
  focus: string | null;
  view: ViewState["view"];
  select: (id: string, event?: React.MouseEvent) => void;
  move: (ids: Set<string>, before: string | null) => void;
  busy: boolean;
  context: (id: string, at: { x: number; y: number }) => void;
  gap: boolean;
  flags: Set<string>;
  spreadIds: Set<string>;
  initialScroll: number;
  rememberScroll: (top: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 200 });
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    ids: Set<string>;
    active: boolean;
    before?: string | null;
  } | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const hitTest = () => {
    const node = container.current!,
      moving = drag.current;
    if (!moving?.active) return;
    const bounds = node.getBoundingClientRect();
    const inside =
      moving.x >= bounds.left &&
      moving.x <= bounds.right &&
      moving.y >= bounds.top &&
      moving.y <= bounds.bottom;
    if (!inside) {
      moving.before = undefined;
      setDrop(null);
      return;
    }
    const hit = (node.getRootNode() as ShadowRoot).elementFromPoint(moving.x, moving.y);
    if (hit?.closest(".empty-spread-slot")) {
      moving.before = undefined;
      setDrop(null);
      return;
    }
    const target = hit?.closest<HTMLElement>("[data-page-id]");
    if (target && node.contains(target)) {
      const rect = target.getBoundingClientRect(),
        id = target.dataset.pageId!;
      const after =
        view === "list"
          ? moving.y > rect.top + rect.height / 2
          : view === "spreads" && book.metadata.direction === "rtl"
            ? moving.x < rect.left + rect.width / 2
            : moving.x > rect.left + rect.width / 2;
      moving.before = after
        ? book.pages[book.pages.findIndex((page) => page.id === id) + 1]?.id || null
        : id;
      setDrop({ id, after });
    } else if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) {
      moving.before = null;
      setDrop({ id: book.pages.at(-1)?.id || "", after: true });
    } else {
      moving.before = undefined;
      setDrop(null);
    }
  };
  const scrollDrag = () => {
    const moving = drag.current,
      node = container.current;
    if (!moving?.active || !node) return;
    const bounds = node.getBoundingClientRect();
    if (moving.x >= bounds.left && moving.x <= bounds.right) {
      const speed = moving.y < bounds.top + 36 ? -10 : moving.y > bounds.bottom - 36 ? 10 : 0;
      if (speed) {
        node.scrollTop += speed;
        hitTest();
      }
    }
    frame.current = requestAnimationFrame(scrollDrag);
  };
  const cancelDrag = () => {
    cancelAnimationFrame(frame.current);
    drag.current = null;
    setDrop(null);
  };
  useEffect(() => {
    cancelDrag();
    return () => cancelAnimationFrame(frame.current);
  }, [book.id, view, busy]);

  const cells: (Page | null)[] =
    view === "spreads"
      ? spreadGroups(book, gap).flatMap((pair) => (pair.length === 1 ? [pair[0], null] : pair))
      : book.pages;
  const positions = new Map(book.pages.map((page, index) => [page.id, index + 1]));
  const columns =
    view === "list"
      ? 1
      : view === "spreads"
        ? 2
        : Math.max(1, Math.floor((viewport.width - 6) / 86));
  const rowHeight = view === "list" ? 29 : 166;
  const first = Math.max(0, Math.floor(viewport.top / rowHeight) - 2) * columns;
  const last = Math.min(
    cells.length,
    (Math.ceil((viewport.top + viewport.height) / rowHeight) + 2) * columns,
  );
  useEffect(() => {
    const node = container.current!;
    node.scrollTop = initialScroll;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight && node.clientWidth)
        setViewport((v) => ({ ...v, height: node.clientHeight, width: node.clientWidth }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = container.current!,
      index = cells.findIndex((p) => p?.id === focus);
    const row = Math.floor(index / columns) * rowHeight;
    if (row < node.scrollTop || row + rowHeight > node.scrollTop + node.clientHeight)
      node.scrollTop = Math.max(0, row - node.clientHeight / 2 + rowHeight / 2);
    if (focus && node.contains((node.getRootNode() as ShadowRoot).activeElement))
      node
        .querySelector<HTMLButtonElement>(`[data-page-id="${CSS.escape(focus)}"]`)
        ?.focus({ preventScroll: true });
  }, [focus, columns, rowHeight, view, gap, book.metadata.cover_only, book.metadata.direction]);
  return (
    <div
      className={`thumbnails ${view === "list" ? "list-view" : "grid-view"} ${view === "spreads" ? `paired-view ${book.metadata.direction}` : ""} ${drop ? "dragging" : ""}`}
      ref={container}
      aria-label={
        view === "list"
          ? t("Page list")
          : view === "spreads"
            ? t("Spread thumbnails")
            : t("Page thumbnails")
      }
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setViewport((v) => ({ ...v, top }));
        rememberScroll(top);
      }}
      onPointerDown={(e) => {
        if (busy || e.button !== 0 || e.altKey) return;
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
        if (id)
          drag.current = {
            id,
            x: e.clientX,
            y: e.clientY,
            startX: e.clientX,
            startY: e.clientY,
            ids: selected.has(id) ? new Set(selected) : new Set([id]),
            active: false,
          };
      }}
      onPointerMove={(e) => {
        const moving = drag.current;
        if (!moving) return;
        moving.x = e.clientX;
        moving.y = e.clientY;
        if (!moving.active && Math.hypot(moving.x - moving.startX, moving.y - moving.startY) >= 5) {
          moving.active = true;
          if (!selected.has(moving.id)) select(moving.id);
          e.currentTarget.setPointerCapture(e.pointerId);
          frame.current = requestAnimationFrame(scrollDrag);
        }
        if (moving.active) {
          e.preventDefault();
          hitTest();
        }
      }}
      onPointerUp={(e) => {
        const moving = drag.current;
        if (moving?.active) {
          suppressClick.current = true;
          if (moving.before !== undefined) move(moving.ids, moving.before);
        }
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        cancelDrag();
      }}
      onPointerCancel={cancelDrag}
      onKeyDown={(e) => {
        if (e.key === "Escape" && drag.current) {
          e.preventDefault();
          cancelDrag();
        }
      }}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      <div
        className="thumb-height"
        style={{ height: Math.ceil(cells.length / columns) * rowHeight }}
      >
        <div
          className="thumb-grid"
          style={{
            top: Math.floor(first / columns) * rowHeight,
            gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
          }}
        >
          {cells.slice(first, last).map((page, offset) =>
            page ? (
              <button
                key={page.id}
                data-page-id={page.id}
                className={`thumbnail ${view === "spreads" && book.metadata.cover_only && page.id === book.metadata.cover_id ? "shelf-cover" : ""} ${selected.has(page.id) ? "selected" : ""} ${focus === page.id ? "focused" : ""} ${drop?.id === page.id ? (drop.after ? "drop-after" : "drop-before") : ""}`}
                aria-label={
                  t(
                    "Page {0}{1}",
                    positions.get(page.id),
                    page.id === book.metadata.cover_id ? t(", cover") : "",
                  ) + (flags.has(page.id) ? ` · ${t("Page needs attention")}` : "")
                    + (spreadIds.has(page.id) ? ` · ${t("Marked spread")}` : "")
                }
                aria-pressed={selected.has(page.id)}
                draggable={false}
                onClick={(event) => select(page.id, event)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!busy) context(page.id, { x: e.clientX, y: e.clientY });
                }}
                onKeyDown={(e) => {
                  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    context(page.id, { x: r.left, y: r.bottom });
                  }
                }}
              >
                {view === "list" ? (
                  <>
                    <span className="page-number">{positions.get(page.id)}</span>
                    <span>
                      {page.source_page
                        ? t("Source page {0}", page.source_page)
                        : page.kind === "blank"
                          ? t("Blank page")
                          : t("Insert images")}
                    </span>
                    <span className="page-state">
                      {spreadIds.has(page.id) && <span className="spread-mark-inline" title={t("Marked spread")}><Icon name="book" /></span>}
                      {flags.has(page.id)
                        ? t("Review")
                        : page.id === book.metadata.cover_id
                          ? t("Cover")
                          : page.split
                            ? page.split.side === "left"
                              ? t("Left half")
                              : t("Right half")
                            : page.kind === "blank"
                              ? "—"
                              : t("Original")}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="thumb-image">
                      <PageImage book={book} page={page} host={host} />
                      {page.id === book.metadata.cover_id && <em>{t("Cover")}</em>}
                      {spreadIds.has(page.id) && <span className="spread-mark" title={t("Marked spread")}><Icon name="book" /></span>}
                      {flags.has(page.id) && (
                        <b className="review-flag" title={t("Needs review")}>
                          !
                        </b>
                      )}
                    </span>
                    <span className="thumb-label">
                      {positions.get(page.id)}
                      <small>
                        {page.kind === "blank"
                          ? t("Blank")
                          : page.split
                            ? page.split.side === "left"
                              ? t("Left half")
                              : t("Right half")
                            : ""}
                      </small>
                    </span>
                    <small className="thumb-source">
                      {page.source_page
                        ? t("Source page {0}", page.source_page)
                        : page.kind === "blank"
                          ? t("Inserted blank")
                          : t("Inserted image")}
                    </small>
                  </>
                )}
              </button>
            ) : (
              <div
                hidden={
                  book.metadata.cover_only && !!book.metadata.cover_id && first + offset === 1
                }
                className="thumbnail empty-spread-slot"
                key={`gap-${first + offset}`}
              >
                {t("Preview only")}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
