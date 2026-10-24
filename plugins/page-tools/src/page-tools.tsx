import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createActionRunner } from "../../../sdk/actions.ts";
import { getLocale, setLocale, subscribeLocale, t } from "../../../sdk/i18n.ts";
import { usePagePreview, visibleRange } from "../../../sdk/previews.ts";
import { PAGE_TOOLS_ID, appearanceData, cropFromMargins, imagePlacement, joinedSpread, pageColors, pageSize, pagesWithoutMargins, spreadGroups, validDeskew,
  type CropMargins, type PageColor } from "../../../sdk/page-layout.ts";
import type { Book, HostAPI, Page } from "../../../sdk/types.ts";
import { CropControls, CropTool, useCropChannel, type CropEdit, type CropState } from "./crop-controls.tsx";
import { detectColor } from "./detect-color.ts";
import "./page-tools.css";

function Thumbnail({ book, page, host, position, selected, color, uncertain, select }: {
  book: Book; page: Page; host: HostAPI; position: number; selected: boolean; color: PageColor; uncertain: boolean; select: () => void;
}) {
  const { url, error } = usePagePreview(book, page, host, 320);
  return <button className={`thumbnail ${selected ? "selected" : ""}`} aria-pressed={selected}
    title={uncertain ? t("Check this page's margin color") : undefined} onClick={select}>
    <span className="thumbnail-image" style={{ background: color, color: color === "black" ? "white" : "#25282c" }}>
      {page.kind === "blank" ? <span className="blank-image" /> : url ? <img src={url} alt="" draggable={false} />
        : <span title={error}>{error ? t("Preview unavailable") : "…"}</span>}
    </span>
    <span>{t("Page {0}", position)}
      <i className={`color-dot ${color}`} aria-label={t(color === "black" ? "Black margins" : "White margins")} />
      {uncertain && <small>{t("Check color")}</small>}</span>
  </button>;
}

function PreviewPage({ book, page, edited, host, viewport, side, heightRatio, noMargins, color, selected, select }: {
  book: Book; page: Page; edited: Page; host: HostAPI; viewport: [number, number]; side?: "left" | "right";
  heightRatio: number; noMargins: boolean; color: PageColor; selected: boolean; select: () => void;
}) {
  const { url, error } = usePagePreview(book, edited, host, 1600);
  const [width, height] = pageSize(edited);
  const placement = imagePlacement(width, height, viewport, side, heightRatio, noMargins);
  return <button className={`preview-page ${selected ? "selected" : ""}`} style={{ background: color, color: color === "black" ? "white" : "#25282c" }}
    aria-pressed={selected} aria-label={t("Select page {0}", book.pages.indexOf(page) + 1)} onClick={select}>
    <svg viewBox={`0 0 ${viewport[0]} ${viewport[1]}`} role="img" aria-label={t("Page {0}", book.pages.indexOf(page) + 1)}>
      {page.kind === "blank" ? <rect width="100%" height="100%" fill="white" /> : url &&
        <svg {...placement} viewBox={`0 0 ${width} ${height}`} overflow="hidden">
          <image href={url} width={width} height={height} preserveAspectRatio="none" />
        </svg>}
    </svg>
    {!url && page.kind === "image" && <span className="preview-message">{error || t("Loading preview…")}</span>}
  </button>;
}

function PageTools({ book, host }: { book: Book; host: HostAPI }) {
  const [focus, setFocus] = useState(book.pages[0]?.id);
  const [edits, setEdits] = useState<Record<string, CropEdit>>({});
  const [colors, setColors] = useState<Record<string, PageColor>>({});
  const [noMargins, setNoMargins] = useState<Record<string, boolean>>({});
  const [uncertain, setUncertain] = useState<string[]>([]);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [cropping, setCropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState("");
  const [viewport, setViewport] = useState<[number, number]>([1750, 2480]);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const stage = useRef<HTMLDivElement>(null);
  const thumbnails = useRef<HTMLDivElement>(null);
  const [thumbnailViewport, setThumbnailViewport] = useState({ top: 0, height: 600 });
  const scanner = useRef<AbortController | null>(null);
  const execute = useMemo(() => createActionRunner(host, setBusy), [host]);
  const current = book.pages.find(page => page.id === focus) || book.pages[0];
  const pageIndex = book.pages.indexOf(current);
  const groups = useMemo(() => spreadGroups(book, true), [book.pages, book.metadata.direction, book.metadata.cover_id, book.metadata.cover_only]);
  const cells = useMemo(() => groups.flatMap(pair => pair.length === 1 ? [pair[0], null] : pair), [groups]);
  const positions = useMemo(() => new Map(book.pages.map((page, index) => [page.id, index + 1])), [book.pages]);
  const { first, last } = visibleRange(cells.length, thumbnailViewport.top, thumbnailViewport.height, 176, 2);
  const groupIndex = Math.max(0, groups.findIndex(group => group.some(page => page?.id === current?.id)));
  const group = groups[groupIndex] || [];
  const joined = joinedSpread(book, group);
  const editedPage = (page: Page): Page => edits[page.id]
    ? { ...page, crop: cropFromMargins(page, edits[page.id].margins), deskew: edits[page.id].angle } : page;
  const heightRatio = joined ? Math.min(1, ...group.map(page => {
    if (!page) return 1;
    const [width, height] = pageSize(editedPage(page));
    return viewport[0] * height / (viewport[1] * width);
  })) : 1;
  const dirty = Object.keys(edits).length > 0 || Object.keys(colors).length > 0 || Object.keys(noMargins).length > 0;
  const stale = baseRevision !== null && baseRevision !== book.revision;
  const editable = !busy && !stale && current?.kind === "image";
  const savedColors = pageColors(book);
  const savedAppearance = appearanceData(book);
  const previewBook = { ...book, extensions: { ...book.extensions,
    [PAGE_TOOLS_ID]: { ...savedAppearance, colors: { ...savedColors, ...colors } } } };
  const savedNoMargins = new Set(pagesWithoutMargins(book));
  const pageIds = new Set(book.pages.map(page => page.id));
  const colorFor = (page: Page) => page.kind === "blank" ? "white" : colors[page.id] || savedColors[page.id] || "white";
  const noMarginsFor = (page: Page) => noMargins[page.id] ?? savedNoMargins.has(page.id);
  const beginDraft = () => setBaseRevision(old => old ?? book.revision);
  const clear = () => { setEdits({}); setColors({}); setNoMargins({}); setUncertain([]); setBaseRevision(null); setStatus(""); };
  const changeCrop = (margins: CropMargins, angle: number) => {
    if (!current || !editable) return;
    cropFromMargins(current, margins);
    if (!validDeskew(angle)) throw new Error(t("Fine rotation must be between -10° and 10°."));
    beginDraft(); setEdits(old => ({ ...old, [current.id]: { margins, angle } }));
    setUncertain(old => [...new Set([...old, current.id])]); setStatus("");
  };
  const channel = useCropChannel(host);
  const navigatePage = (step: -1 | 1) => {
    const page = book.pages[pageIndex + step];
    if (!busy && page) setFocus(page.id);
  };
  const cropState: CropState = {
    documentId: book.id, pageId: current?.id || null, revision: book.revision,
    title: current ? t("Page {0}", book.pages.indexOf(current) + 1) : t("No pages"),
    margins: current && edits[current.id]?.margins || [0, 0, 0, 0],
    angle: current ? edits[current.id]?.angle ?? current.deskew ?? 0 : 0, disabled: !editable,
    canPrevious: !busy && pageIndex > 0, canNext: !busy && pageIndex >= 0 && pageIndex < book.pages.length - 1,
  };
  const latestCrop = useRef({ state: cropState, change: changeCrop, navigate: navigatePage, dirty, clear });
  latestCrop.current = { state: cropState, change: changeCrop, navigate: navigatePage, dirty, clear };
  const scrollThumbnail = (id: string | null | undefined) => {
    const node = thumbnails.current;
    if (!node?.clientHeight) return;
    const index = cells.findIndex(page => page?.id === id);
    if (index < 0) return;
    const top = Math.floor(index / 2) * 176;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + 176 > node.scrollTop + node.clientHeight) node.scrollTop = top + 176 - node.clientHeight;
  };
  useEffect(() => { scrollThumbnail(current?.id); }, [current?.id, cells]);
  useEffect(() => {
    const node = thumbnails.current;
    if (!node) return;
    let visible = false;
    const observer = new ResizeObserver(() => {
      if (!node.clientHeight) { visible = false; return; }
      if (!visible) scrollThumbnail(latestCrop.current.state.pageId);
      visible = true;
      setThumbnailViewport({ top: node.scrollTop, height: node.clientHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cells]);
  useEffect(() => host.onBeforeDocumentReplace?.(async () => {
    if (!latestCrop.current.dirty) return true;
    if (!(await host.confirm(
      t("Discard the crop and margin preview edits before continuing? Apply them in Crop and margins to keep them."),
      t("Discard preview edits"), t("Discard preview edits"),
    ))) return false;
    latestCrop.current.clear();
    return true;
  }), [host]);
  useEffect(() => {
    if (!channel) return;
    channel.onmessage = ({ data }) => {
      const { state, change, navigate } = latestCrop.current;
      if (data?.type === "request") channel.postMessage({ type: "state", state });
      if (data?.type === "navigate") {
        if (data.documentId === state.documentId && data.pageId === state.pageId && data.revision === state.revision &&
            (data.step === -1 && state.canPrevious || data.step === 1 && state.canNext)) {
          navigate(data.step);
        } else channel.postMessage({ type: "state", state });
        return;
      }
      if (data?.type !== "change") return;
      if (data.documentId === state.documentId && data.pageId === state.pageId && data.revision === state.revision && !state.disabled &&
          Array.isArray(data.margins) && data.margins.length === 4) {
        try { change(data.margins as CropMargins, data.angle); return; } catch (error) { host.report(error); }
      }
      channel.postMessage({ type: "state", state });
    };
    return () => { channel.onmessage = null; };
  }, [channel, host]);
  useEffect(() => { channel?.postMessage({ type: "state", state: cropState }); },
    [channel, book.id, book.revision, current?.id, edits, editable, cropState.title, cropState.canPrevious, cropState.canNext]);
  useEffect(() => () => scanner.current?.abort(), []);
  useEffect(() => host.onPageSelect?.(setFocus), [host]);
  useEffect(() => {
    if (!stage.current) return;
    let active = true, visible = false;
    const readCanvas = () => void host.rpc<[number, number]>("epub.canvas.get")
      .then(size => { if (active) setViewport(size); }).catch(host.report);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width || !entry.contentRect.height) { visible = false; return; }
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      if (!visible) { visible = true; readCanvas(); }
    });
    observer.observe(stage.current);
    window.addEventListener("focus", readCanvas);
    return () => { active = false; observer.disconnect(); window.removeEventListener("focus", readCanvas); };
  }, [host]);
  const detectAll = () => void execute(async () => {
    const controller = new AbortController();
    scanner.current = controller;
    const pages = book.pages.filter(page => page.kind === "image");
    const detected: Record<string, PageColor> = {}, checks: string[] = [];
    let cursor = 0, done = 0;
    setProgress({ done, total: pages.length }); setStatus("");
    const scan = async () => {
      while (cursor < pages.length && !controller.signal.aborted) {
        const page = pages[cursor++];
        const url = await host.preview(previewBook, editedPage(page), 320, controller.signal);
        const image = new Image(); image.crossOrigin = "anonymous"; image.src = url;
        await image.decode();
        if (controller.signal.aborted) return;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error(t("Preview unavailable"));
        context.drawImage(image, 0, 0);
        const result = detectColor(context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width, canvas.height);
        detected[page.id] = result.color;
        if (!result.certain) checks.push(page.id);
        setProgress({ done: ++done, total: pages.length });
      }
    };
    try {
      await Promise.all([scan(), scan()]);
      if (controller.signal.aborted) { setStatus(t("Color detection cancelled. No changes applied.")); return; }
      beginDraft(); setColors(detected); setUncertain(checks);
      setStatus(t("{0} pages checked. Review the preview, then Apply. {1} need a color check.", pages.length, checks.length));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      setStatus(t("Color detection cancelled. No changes applied."));
    } finally { controller.abort(); scanner.current = null; setProgress(null); }
  });
  const apply = () => void execute(async () => {
    await host.apply({ ...book, revision: baseRevision ?? book.revision }, {
      ...(Object.keys(edits).length ? { pages: book.pages.map(editedPage) } : {}),
      extension: { id: PAGE_TOOLS_ID, data: {
        ...savedAppearance, colors: { ...savedAppearance.colors, ...colors },
        no_margins: [...savedAppearance.no_margins.filter(id => !pageIds.has(id)),
          ...book.pages.filter(page => page.kind === "image" && noMarginsFor(page)).map(page => page.id)],
      } },
    });
    clear(); setStatus(t("Crop and margin changes applied."));
  });
  const chooseColor = (color: PageColor) => {
    if (!current) return;
    beginDraft(); setColors(old => ({ ...old, [current.id]: color }));
    setUncertain(old => old.filter(id => id !== current.id));
    setStatus("");
  };
  const navigate = (step: number) => {
    const page = groups[groupIndex + step]?.find(page => page !== null);
    if (page) setFocus(page.id);
  };
  const previewHeight = Math.max(1, Math.min(stageSize.height - 32, (stageSize.width - 32) / (viewport[0] / viewport[1] * Math.max(1, group.length))));
  return <div className="page-tools">
    <header className="toolbar"><strong>{t("Crop and margins")}</strong>
      <button disabled={busy || stale || !book.pages.some(page => page.kind === "image")} onClick={detectAll}>{t("Detect all page colors")}</button>
      <button disabled={busy || stale || !book.pages.some(page => page.kind === "image" && !noMarginsFor(page))} onClick={() => {
        beginDraft();
        setNoMargins(Object.fromEntries(book.pages.filter(page => page.kind === "image").map(page => [page.id, true])));
        setStatus("");
      }}>{t("Turn off all page margins")}</button>
      <span className="toolbar-space" />
      <button disabled={busy || dirty || !book.can_undo} onClick={() => void execute(() => host.rpc("document.undo", { document_id: book.id }))}>{t("↶ Undo")}</button>
      <button disabled={busy || dirty || !book.can_redo} onClick={() => void execute(() => host.rpc("document.redo", { document_id: book.id }))}>{t("↷ Redo")}</button>
      <button disabled={busy || !dirty && !stale} onClick={clear}>{t("Discard preview edits")}</button>
      <button className="primary" disabled={busy || !dirty || stale} onClick={apply}>{t("Apply")}</button>
    </header>
    {progress && <div className="scan-progress" role="status"><span>{t("Detecting page colors… {0}/{1}", progress.done, progress.total)}</span>
      <progress max={progress.total || 1} value={progress.done} aria-label={t("Color detection progress")} />
      <button onClick={() => scanner.current?.abort()}>{t("Cancel")}</button></div>}
    {stale && <p className="draft-warning" role="alert">{t("The book changed. Discard these preview edits and try again.")}</p>}
    <div className="workspace">
      <aside className="page-list" aria-label={t("Pages")}><div className="panel-title">{t("Pages")} · {book.pages.length}</div>
        <div className="thumbnails" ref={thumbnails} onScroll={event => {
          const top = event.currentTarget.scrollTop;
          setThumbnailViewport(old => ({ ...old, top }));
        }}><div className="thumbnail-height" style={{ height: Math.ceil(cells.length / 2) * 176 }}>
          <div className="thumbnail-grid" style={{ top: Math.floor(first / 2) * 176 }}>
          {cells.slice(first, last).map((page, offset) => page ?
          <Thumbnail key={page.id} book={previewBook} page={page} host={host} position={positions.get(page.id)!} selected={current?.id === page.id}
            color={colorFor(page)} uncertain={uncertain.includes(page.id)} select={() => { if (!busy) setFocus(page.id); }} />
          : <div className="thumbnail-gap" key={`gap-${first + offset}`}>{t("Preview only")}</div>)}
          </div></div></div>
      </aside>
      <section className="preview-panel" aria-label={t("Spread preview with margins")}>
        <div className="page-controls"><strong>{current ? t("Page {0}", book.pages.indexOf(current) + 1) : t("No pages")}</strong>
          <button disabled={!editable} aria-haspopup="dialog" onClick={() => {
            if (channel && host.openWindow) void execute(() => host.openWindow!({ plugin: PAGE_TOOLS_ID, view: "crop",
              title: t("Crop"), width: 300, height: 330, persistent: true }));
            else setCropping(true);
          }}>{t("Crop…")}</button>
          <label className="margin-toggle"><input type="checkbox" disabled={!editable || joined}
            checked={!!current && !joined && !noMarginsFor(current)} onChange={event => {
              if (!current) return;
              const noMargin = !event.target.checked;
              beginDraft(); setNoMargins(old => ({ ...old, [current.id]: noMargin })); setStatus("");
            }} />{t("Add page margins")}</label>
          <div className="margin-colors" role="group" aria-labelledby="margin-color-label"><span id="margin-color-label">{t("Margin color")}</span>
            <button disabled={!editable} aria-pressed={!!current && colorFor(current) === "white"} onClick={() => chooseColor("white")}>{t("White")}</button>
            <button disabled={!editable} aria-pressed={!!current && colorFor(current) === "black"} onClick={() => chooseColor("black")}>{t("Black")}</button>
          </div>
          {joined && <span className="spread-label">{t("Marked spread")}</span>}
        </div>
        <p className="preview-note">{t("EPUB page size: {0} × {1}. Turning off margins removes the 2% inset; space needed to keep image proportions remains.", viewport[0], viewport[1])}</p>
        <div className="preview-stage" ref={stage}>
          <div className="spread-preview" style={{ height: previewHeight, width: previewHeight * viewport[0] / viewport[1] * group.length }}>
            {group.map((page, slot) => page ? <PreviewPage key={page.id} book={previewBook} page={page} edited={editedPage(page)} host={host} viewport={viewport}
              side={joined ? slot === 0 ? "left" : "right" : undefined} heightRatio={heightRatio}
              noMargins={noMarginsFor(page)}
              color={colorFor(page)} selected={current?.id === page.id} select={() => { if (!busy) setFocus(page.id); }} />
              : <div className="virtual-gap" key={slot}>{t("Preview only")}</div>)}
          </div>
        </div>
        <footer className="preview-navigation"><button disabled={busy || groupIndex === 0} onClick={() => navigate(-1)}>{t("Previous spread")}</button>
          <span>{groupIndex + 1} / {groups.length}</span>
          <button disabled={busy || groupIndex >= groups.length - 1} onClick={() => navigate(1)}>{t("Next spread")}</button></footer>
      </section>
    </div>
    <footer className="status" role="status">{status || (dirty ? t("Preview edits are not saved. Apply to keep them.") : t("Select a page to crop. Detect all colors when ready."))}</footer>
    {cropping && <CropControls {...cropState} close={() => setCropping(false)} change={changeCrop} navigate={navigatePage} />}
  </div>;
}

function ToolsHost({ host }: { host: HostAPI }) {
  useSyncExternalStore(subscribeLocale, getLocale);
  const [book, setBook] = useState(host.getDocument());
  useEffect(() => host.subscribe(setBook), [host]);
  return host.view === "crop" ? <CropTool host={host} />
    : book ? <PageTools key={book.id} book={book} host={host} /> : <p className="empty">{t("Open a book first")}</p>;
}

export function mount(element: HTMLElement, host: HostAPI) {
  if (host.getLocale) setLocale(host.getLocale());
  const stopLocale = host.subscribeLocale?.(() => { if (host.getLocale) setLocale(host.getLocale()); });
  const root = createRoot(element);
  root.render(<ToolsHost host={host} />);
  return () => { stopLocale?.(); root.unmount(); };
}
