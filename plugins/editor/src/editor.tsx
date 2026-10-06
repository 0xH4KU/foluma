import { getLocale, setLocale, subscribeLocale, t } from "../../../sdk/i18n.ts";
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Book, Changes, HostAPI } from "../../../sdk/types";
import { documentRef } from "../../../sdk/types";
import { createActionRunner } from "../../../sdk/actions";
import { REVIEW_EXTENSION_ID, reviewData } from "../../../sdk/review";
import {
  applyPreset,
  createPreset,
  insertBlankPage,
  isPair,
  navigatePage,
  restorePages,
  splitPages,
} from "./pages";
import { moveBefore } from "../../../sdk/order";
import type { Preset } from "./pages";
import { BatchDialog } from "./batch-dialog";
import type { ViewState } from "./thumbnails";
import { EditorToolbar, PagePanel, PreviewPanel, Inspector } from "./editor-panels";
import "./editor.css";

function readView(book: Book | null): ViewState {
  const initial: ViewState = {
    focus: book?.pages[0]?.id || null,
    selected: [],
    spread: true,
    view: "spreads",
    gap: true,
    zoom: 100,
    scroll: 0,
  };
  try {
    const value = JSON.parse(localStorage.getItem(`foluma.editor.view.${book?.id}`) || "null");
    if (!value) return initial;
    return {
      focus: book?.pages.some((p) => p.id === value.focus) ? value.focus : initial.focus,
      selected: Array.isArray(value.selected)
        ? value.selected.filter((id: unknown) => book?.pages.some((p) => p.id === id))
        : [],
      spread: typeof value.spread === "boolean" ? value.spread : true,
      view: ["list", "grid", "spreads"].includes(value.view) ? value.view : "spreads",
      gap: typeof value.gap === "boolean" ? value.gap : true,
      zoom: Number.isFinite(value.zoom) ? Math.min(200, Math.max(50, value.zoom)) : 100,
      scroll: Number.isFinite(value.scroll) ? Math.max(0, value.scroll) : 0,
    };
  } catch {
    return initial;
  }
}

function EditorHost({ host }: { host: HostAPI }) {
  useSyncExternalStore(subscribeLocale, getLocale);
  const [book, setBook] = useState<Book | null>(host.getDocument());
  useEffect(() => host.subscribe(setBook), [host]);
  return <Editor key={book?.id || "empty"} host={host} book={book} />;
}

function Editor({ host, book }: { host: HostAPI; book: Book | null }) {
  const [initial] = useState(() => readView(book));
  const previousBook = useRef(book);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial.selected));
  const [focus, setFocus] = useState<string | null>(initial.focus);
  const anchor = useRef<string | null>(null);
  const [spread, setSpread] = useState(initial.spread);
  const [view, setView] = useState<ViewState["view"]>(initial.view);
  const [gap, setGap] = useState(initial.gap);
  const [zoom, setZoom] = useState(initial.zoom);
  const scroll = useRef(initial.scroll);
  const savedView = useRef<ViewState>(initial);
  savedView.current = {
    focus,
    selected: [...selected],
    spread,
    view,
    gap,
    zoom,
    scroll: scroll.current,
  };
  const saveView = () => {
    if (book)
      try {
        localStorage.setItem(
          `foluma.editor.view.${book.id}`,
          JSON.stringify({ ...savedView.current, scroll: scroll.current }),
        );
      } catch {
        /* View preferences must not block editing. */
      }
  };
  useEffect(saveView, [focus, selected, spread, view, gap, zoom]);
  useEffect(() => {
    window.addEventListener("pagehide", saveView);
    return () => {
      saveView();
      window.removeEventListener("pagehide", saveView);
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const execute = useMemo(() => createActionRunner(host, setBusy), [host]);
  const [batch, setBatch] = useState(false);
  const [batchPaths, setBatchPaths] = useState<string[]>([]);
  useEffect(
    () =>
      host.onFileDrop?.((paths) => {
        setBatchPaths(paths);
        setBatch(true);
      }),
    [host],
  );

  const [ratio, setRatio] = useState("50");
  const [splitPreview, setSplitPreview] = useState(false);

  useEffect(() => {
    if (!book) return;
    if (!book.pages.some((p) => p.id === focus)) {
      const previousIndex =
        book.id === previousBook.current?.id
          ? previousBook.current.pages.findIndex((p) => p.id === focus)
          : 0;
      setFocus(book.pages[Math.max(0, Math.min(previousIndex, book.pages.length - 1))]?.id || null);
      anchor.current = null;
    }
    setSelected((old) => new Set([...old].filter((id) => book.pages.some((p) => p.id === id))));
    previousBook.current = book;
  }, [book?.id, book?.revision]);
  const run = async (action: () => Promise<unknown>) => {
    await execute(action);
  };
  if (!book)
    return (
      <div className="editor-empty">
        <h1>{t("No document open")}</h1>
        <p>{t("Import a book, project or series folder from the toolbar.")}</p>
      </div>
    );
  const current = book.pages.find((p) => p.id === focus) || book.pages[0];
  const index = current ? book.pages.indexOf(current) : 0;
  const ids = selected.size ? selected : new Set(current ? [current.id] : []);

  const splitRatio = Number(ratio) / 100;
  const editorData = reviewData(book);
  const flags = new Set(editorData.review);
  const update = (changes: Changes) => {
    if (changes.pages && flags.size && !changes.extension) {
      const marked = book.pages.filter((page) => flags.has(page.id));
      const review = changes.pages
        .filter((page) =>
          marked.some(
            (old) =>
              old.id === page.id ||
              page.split?.original.id === old.id ||
              old.split?.original.id === page.id,
          ),
        )
        .map((page) => page.id);
      changes = {
        ...changes,
        extension: { id: REVIEW_EXTENSION_ID, data: { ...editorData, review } },
      };
    }
    return run(() => host.apply(book, changes));
  };
  const select = (id: string, event?: React.MouseEvent) => {
    if (event?.shiftKey && anchor.current) {
      const a = book.pages.findIndex((p) => p.id === anchor.current),
        b = book.pages.findIndex((p) => p.id === id);
      setSelected(
        new Set(book.pages.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1).map((p) => p.id)),
      );
    } else if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
      anchor.current = id;
    } else {
      setSelected(new Set([id]));
      anchor.current = id;
    }
    setFocus(id);
  };
  const remove = (selection = ids) =>
    run(async () => {
      if (
        selection.size > 1 &&
        !(await host.confirm(
          t("Delete {0} selected pages? You can undo this change.", selection.size),
          t("Delete pages"),
        ))
      )
        return;
      const pages = book.pages.filter((p) => !selection.has(p.id));
      await host.apply(book, { pages });
      setFocus(
        pages[
          Math.min(
            book.pages.findIndex((p) => selection.has(p.id)),
            pages.length - 1,
          )
        ]?.id || null,
      );
      setSelected(new Set());
    });
  const history = (redo = false) =>
    run(() => host.rpc(redo ? "document.redo" : "document.undo", documentRef(book)));
  const navigate = (step: number) => {
    const page = navigatePage(book, current?.id || null, step, spread, gap);
    if (page) select(page.id);
  };

  const flag = (selection = ids) => {
    const next = new Set(flags),
      clear = [...selection].every((id) => flags.has(id));
    selection.forEach((id) => {
      if (clear) next.delete(id);
      else next.add(id);
    });
    void update({
      extension: { id: REVIEW_EXTENSION_ID, data: { ...editorData, review: [...next] } },
    });
  };
  const nextFlag = () => {
    const pages = [...book.pages.slice(index + 1), ...book.pages.slice(0, index)];
    const page = pages.find((page) => flags.has(page.id));
    if (page) select(page.id);
  };
  const exportImages = (selection = ids) =>
    run(async () => {
      const path = await host.saveFile(t("{0}-originals.zip", book.metadata.title), ["zip"]);
      if (path) {
        await host.task({
          operation: "images.export",
          ...documentRef(book),
          page_ids: [...selection],
          path,
          overwrite: true,
        });
        host.notify(t("Originals from {0} selected pages exported", selection.size));
      }
    });
  const writePreset = () =>
    run(async () => {
      const path = await host.saveFile(`${book.metadata.title}.mtepreset`, ["mtepreset"]);
      if (path) {
        await host.rpc("bundle.write", {
          ...documentRef(book),
          path,
          plugin: "org.foluma.editor",
          ...createPreset(book),
          overwrite: true,
        });
        host.notify(t("Layout preset saved"));
      }
    });
  const readPreset = () =>
    run(async () => {
      const path = await host.pickFile({
        extensions: ["mtepreset"],
        title: t("Load layout preset"),
      });
      if (
        typeof path !== "string" ||
        !(await host.confirm(
          t(
            "Apply this preset to the book?\n\nPage order and crops follow the original source page numbers. Later pages beyond the preset are kept. You can undo this change.",
          ),
          t("Apply layout preset"),
        ))
      )
        return;
      const result = await host.rpc<{
        payload: Preset;
        asset_ids: Record<string, string>;
        document: Book;
      }>("bundle.read", { ...documentRef(book), path, plugin: "org.foluma.editor" });
      await host.apply(
        result.document,
        applyPreset(result.document, result.payload, result.asset_ids),
      );
      host.notify(t("Layout preset applied"));
    });
  const insertBlank = (page = current, before = false) =>
    void update(insertBlankPage(book, page, before));
  const insertImages = (after = current) =>
    run(async () => {
      const paths = await host.pickFile({
        extensions: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
        multiple: true,
        title: t("Insert images"),
      });
      if (paths) {
        const result = await host.task<Book>({
          operation: "images.import",
          ...documentRef(book),
          paths: Array.isArray(paths) ? paths : [paths],
          position: after ? book.pages.indexOf(after) + 1 : 0,
        });
        const previousIds = new Set(book.pages.map((page) => page.id));
        const inserted = result.pages.filter((page) => !previousIds.has(page.id));
        if (inserted.length) {
          setSelected(new Set(inserted.map((page) => page.id)));
          setFocus(inserted[0].id);
          anchor.current = inserted[0].id;
        }
        host.notify(t("{0} image pages inserted", inserted.length));
      }
    });
  const split = (selection = ids) => {
    try {
      void update(splitPages(book, selection, splitRatio));
    } catch (error) {
      host.report(error);
    }
  };
  const contextMenu = (id: string, at: { x: number; y: number }) => {
    if (busy || !host.contextMenu) return;
    const page = book.pages.find((p) => p.id === id)!;
    const selection = ids.has(id) ? new Set(ids) : new Set([id]);
    setSelected(selection);
    setFocus(id);
    anchor.current = id;
    void host
      .contextMenu(
        [
          {
            text: t("Split selected pages"),
            enabled: book.pages.some((p) => selection.has(p.id) && p.kind === "image" && !p.split),
            action: () => split(selection),
          },
          {
            text: t("Restore split pages"),
            enabled: book.pages.some(
              (p, i) =>
                isPair(p, book.pages[i + 1]) &&
                (selection.has(p.id) || selection.has(book.pages[i + 1].id)),
            ),
            action: () => void update(restorePages(book, selection)),
          },
          {
            text: t("Set as cover"),
            enabled:
              selection.size === 1 && page.kind === "image" && page.id !== book.metadata.cover_id,
            action: () => void update({ metadata: { cover_id: id } }),
          },
          { text: t("Insert images after this page…"), action: () => void insertImages(page) },
          { text: t("Insert blank before this page"), action: () => insertBlank(page, true) },
          { text: t("Insert blank after this page"), action: () => insertBlank(page) },
          {
            text: [...selection].every((id) => flags.has(id))
              ? t("Clear review marks")
              : t("Mark selected pages for attention"),
            action: () => flag(selection),
          },
          {
            text: t("Move to beginning"),
            action: () =>
              void update({
                pages: moveBefore(
                  book.pages,
                  selection,
                  book.pages.find((p) => !selection.has(p.id))?.id || null,
                ),
              }),
          },
          {
            text: t("Move to end"),
            action: () => void update({ pages: moveBefore(book.pages, selection, null) }),
          },
          {
            text: t("Export originals…"),
            enabled: book.pages.some((p) => selection.has(p.id) && p.kind === "image"),
            action: () => void exportImages(selection),
          },
          { text: t("Delete selected pages"), action: () => void remove(selection) },
        ],
        at,
      )
      .catch(host.report);
  };

  return (
    <div
      className="editor"
      tabIndex={-1}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).matches("input,select,textarea") || busy) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          void history(event.shiftKey);
        } else if ((event.metaKey || event.ctrlKey) && event.key === "a") {
          event.preventDefault();
          setSelected(new Set(book.pages.map((p) => p.id)));
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          void remove();
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          navigate(book.metadata.direction === "rtl" ? -1 : 1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          navigate(book.metadata.direction === "rtl" ? 1 : -1);
        } else if (
          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
          view === "list" &&
          (event.target as HTMLElement).closest(".thumbnails")
        ) {
          event.preventDefault();
          const page = navigatePage(
            book,
            current?.id || null,
            event.key === "ArrowDown" ? 1 : -1,
            false,
            gap,
          );
          if (page) select(page.id);
        } else if (
          !event.repeat &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.key.toLowerCase() === "b"
        ) {
          event.preventDefault();
          insertBlank(current, !event.shiftKey);
        } else if (
          !event.repeat &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.key.toLowerCase() === "m"
        ) {
          event.preventDefault();
          if (event.shiftKey) nextFlag();
          else flag();
        }
      }}
    >
      {batch && (
        <BatchDialog
          key={batchPaths.join("|")}
          initialPaths={batchPaths}
          host={host}
          close={() => {
            setBatch(false);
            setBatchPaths([]);
          }}
        />
      )}
      <EditorToolbar
        book={book}
        ids={ids}
        busy={busy}
        history={history}
        readPreset={readPreset}
        writePreset={writePreset}
        openBatch={() => setBatch(true)}
      />
      <div className="editor-columns">
        <PagePanel
          book={book}
          host={host}
          ids={ids}
          current={current}
          busy={busy}
          view={view}
          setView={setView}
          setSpread={setSpread}
          select={select}
          contextMenu={contextMenu}
          gap={gap}
          flags={flags}
          initialScroll={initial.scroll}
          update={update}
          setSelected={setSelected}
          setFocus={setFocus}
          rememberScroll={(top) => {
            scroll.current = top;
            saveView();
          }}
        />
        <PreviewPanel
          book={book}
          host={host}
          current={current}
          ids={ids}
          busy={busy}
          spread={spread}
          setSpread={setSpread}
          gap={gap}
          setGap={setGap}
          zoom={zoom}
          setZoom={setZoom}
          flags={flags}
          select={select}
          navigate={navigate}
          insertBlank={insertBlank}
          flag={flag}
          nextFlag={nextFlag}
          splitRatio={splitRatio}
          splitPreview={splitPreview}
          contextMenu={contextMenu}
        />
        <Inspector
          book={book}
          current={current}
          ids={ids}
          busy={busy}
          host={host}
          update={update}
          insertImages={insertImages}
          remove={remove}
          ratio={ratio}
          setRatio={setRatio}
          splitPreview={splitPreview}
          setSplitPreview={setSplitPreview}
          split={split}
          exportImages={exportImages}
        />
      </div>
    </div>
  );
}

export function mount(container: HTMLElement, host: HostAPI): () => void {
  if (host.version !== 1) throw new Error(t("The editor requires Foluma plugin API 1"));
  const syncLocale = () => {
    if (host.getLocale) setLocale(host.getLocale());
  };
  syncLocale();
  const stopLocale = host.subscribeLocale?.(syncLocale);
  const root = createRoot(container, { onUncaughtError: host.report });
  root.render(<EditorHost host={host} />);
  return () => {
    stopLocale?.();
    root.unmount();
  };
}
