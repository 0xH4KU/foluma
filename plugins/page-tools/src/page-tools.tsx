import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createActionRunner } from "../../../sdk/actions.ts";
import { getLocale, setLocale, subscribeLocale, t } from "../../../sdk/i18n.ts";
import { usePagePreview } from "../../../sdk/previews.ts";
import { PAGE_TOOLS_ID, cropBox, cropFromMargins, imagePlacement, joinedSpread, pageColors, pageSize, pagesWithoutMargins, spreadGroups,
  type CropMargins, type PageColor } from "../../../sdk/page-layout.ts";
import type { Book, HostAPI, Page } from "../../../sdk/types.ts";
import { CropControls, CropTool, useCropChannel, type CropState } from "./crop-controls.tsx";
import { detectColor } from "./detect-color.ts";
import "./page-tools.css";

function Thumbnail({ book, page, host, selected, color, uncertain, select }: {
  book: Book; page: Page; host: HostAPI; selected: boolean; color: PageColor; uncertain: boolean; select: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (button.current) observer.observe(button.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (selected) button.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const { url, error } = usePagePreview(book, visible ? page : undefined, host, 320);
  return <button ref={button} className={`thumbnail ${selected ? "selected" : ""}`} aria-pressed={selected}
    title={uncertain ? t("Check this page's margin color") : undefined} onClick={select}>
    <span className="thumbnail-image" style={{ background: color }}>
      {page.kind === "blank" ? <span className="blank-image" /> : url ? <img src={url} alt="" draggable={false} />
        : <span title={error}>{error ? t("Preview unavailable") : "…"}</span>}
    </span>
    <span>{t("Page {0}", book.pages.indexOf(page) + 1)}
      <i className={`color-dot ${color}`} aria-label={t(color === "black" ? "Black margins" : "White margins")} />
      {uncertain && <small>{t("Check color")}</small>}</span>
  </button>;
}

function PreviewPage({ book, page, host, viewport, side, heightRatio, margins, noMargins, color, selected, select }: {
  book: Book; page: Page; host: HostAPI; viewport: [number, number]; side?: "left" | "right";
  heightRatio: number; margins: CropMargins; noMargins: boolean; color: PageColor; selected: boolean; select: () => void;
}) {
  const { url, error } = usePagePreview(book, page, host, 1600);
  const [width, height] = pageSize(page);
  const cropped = { ...page, crop: cropFromMargins(page, margins) };
  const [croppedWidth, croppedHeight] = pageSize(cropped);
  const [x, y, right, bottom] = cropBox(page), [cx, cy, cr, cb] = cropBox(cropped);
  const [left, top] = page.rotation === 90 ? [bottom - cb, cx - x] : page.rotation === 180 ? [right - cr, bottom - cb]
    : page.rotation === 270 ? [cy - y, right - cr] : [cx - x, cy - y];
  const placement = imagePlacement(croppedWidth, croppedHeight, viewport, side, heightRatio, noMargins);
  return <button className={`preview-page ${selected ? "selected" : ""}`} style={{ background: color }}
    aria-pressed={selected} aria-label={t("Select page {0}", book.pages.indexOf(page) + 1)} onClick={select}>
    <svg viewBox={`0 0 ${viewport[0]} ${viewport[1]}`} role="img" aria-label={t("Page {0}", book.pages.indexOf(page) + 1)}>
      {page.kind === "blank" ? <rect width="100%" height="100%" fill="white" /> : url &&
        <svg {...placement} viewBox={`${left} ${top} ${croppedWidth} ${croppedHeight}`} overflow="hidden">
          <image href={url} width={width} height={height} preserveAspectRatio="none" />
        </svg>}
    </svg>
    {!url && page.kind === "image" && <span className="preview-message">{error || t("Loading preview…")}</span>}
  </button>;
}

function PageTools({ book, host }: { book: Book; host: HostAPI }) {
  const [focus, setFocus] = useState(book.pages[0]?.id);
  const [crops, setCrops] = useState<Record<string, CropMargins>>({});
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
  const scanner = useRef<AbortController | null>(null);
  const execute = useMemo(() => createActionRunner(host, setBusy), [host]);
  const current = book.pages.find(page => page.id === focus) || book.pages[0];
  const groups = spreadGroups(book, true);
  const groupIndex = Math.max(0, groups.findIndex(group => group.some(page => page?.id === current?.id)));
  const group = groups[groupIndex] || [];
  const joined = joinedSpread(book, group);
  const heightRatio = joined ? Math.min(1, ...group.map(page => {
    if (!page) return 1;
    const cropped = crops[page.id] ? { ...page, crop: cropFromMargins(page, crops[page.id]) } : page;
    const [width, height] = pageSize(cropped);
    return viewport[0] * height / (viewport[1] * width);
  })) : 1;
  const dirty = Object.keys(crops).length > 0 || Object.keys(colors).length > 0 || Object.keys(noMargins).length > 0;
  const stale = baseRevision !== null && baseRevision !== book.revision;
  const editable = !busy && !stale && current?.kind === "image";
  const savedColors = pageColors(book);
  const savedNoMargins = pagesWithoutMargins(book);
  const colorFor = (page: Page) => page.kind === "blank" ? "white" : colors[page.id] || savedColors[page.id] || "white";
  const noMarginsFor = (page: Page) => noMargins[page.id] ?? savedNoMargins.includes(page.id);
  const beginDraft = () => setBaseRevision(old => old ?? book.revision);
  const clear = () => { setCrops({}); setColors({}); setNoMargins({}); setUncertain([]); setBaseRevision(null); setStatus(""); };
  const changeCrop = (margins: CropMargins) => {
    if (!current || !editable) return;
    cropFromMargins(current, margins);
    beginDraft(); setCrops(old => ({ ...old, [current.id]: margins }));
    setUncertain(old => [...new Set([...old, current.id])]); setStatus("");
  };
  const channel = useCropChannel(book, host);
  const cropState: CropState = {
    pageId: current?.id || null, revision: book.revision,
    title: current ? t("Page {0}", book.pages.indexOf(current) + 1) : t("No pages"),
    margins: current && crops[current.id] || [0, 0, 0, 0], disabled: !editable,
  };
  const latestCrop = useRef({ state: cropState, change: changeCrop });
  latestCrop.current = { state: cropState, change: changeCrop };
  useEffect(() => {
    if (!channel) return;
    channel.onmessage = ({ data }) => {
      const { state, change } = latestCrop.current;
      if (data?.type === "request") channel.postMessage({ type: "state", state });
      if (data?.type !== "change") return;
      if (data.pageId === state.pageId && data.revision === state.revision && !state.disabled &&
          Array.isArray(data.margins) && data.margins.length === 4) {
        try { change(data.margins as CropMargins); return; } catch (error) { host.report(error); }
      }
      channel.postMessage({ type: "state", state });
    };
    return () => { channel.onmessage = null; };
  }, [channel, host]);
  useEffect(() => { channel?.postMessage({ type: "state", state: cropState }); },
    [channel, book.revision, current?.id, crops, editable, cropState.title]);
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
        const url = await host.preview(book, page, 320, controller.signal);
        const image = new Image(); image.crossOrigin = "anonymous"; image.src = url;
        await image.decode();
        if (controller.signal.aborted) return;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error(t("Preview unavailable"));
        context.drawImage(image, 0, 0);
        const result = detectColor(context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width, canvas.height, crops[page.id]);
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
    const data = book.extensions[PAGE_TOOLS_ID];
    await host.apply({ ...book, revision: baseRevision ?? book.revision }, {
      ...(Object.keys(crops).length ? { pages: book.pages.map(page => crops[page.id]
        ? { ...page, crop: cropFromMargins(page, crops[page.id]) } : page) } : {}),
      extension: { id: PAGE_TOOLS_ID, data: {
        ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}), colors: { ...savedColors, ...colors },
        no_margins: book.pages.filter(page => page.kind === "image" && noMarginsFor(page)).map(page => page.id),
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
        <div className="thumbnails">{groups.flatMap(pair => pair.length === 1 ? [pair[0], null] : pair).map((page, slot) => page ?
          <Thumbnail key={page.id} book={book} page={page} host={host} selected={current?.id === page.id}
            color={colorFor(page)} uncertain={uncertain.includes(page.id)} select={() => { if (!busy) setFocus(page.id); }} />
          : <div className="thumbnail-gap" key={`gap-${slot}`}>{t("Preview only")}</div>)}</div>
      </aside>
      <section className="preview-panel" aria-label={t("Spread preview with margins")}>
        <div className="page-controls"><strong>{current ? t("Page {0}", book.pages.indexOf(current) + 1) : t("No pages")}</strong>
          <button disabled={!editable} aria-haspopup="dialog" onClick={() => {
            if (channel && host.openWindow) void execute(() => host.openWindow!({ plugin: PAGE_TOOLS_ID, view: "crop",
              title: t("Crop"), width: 300, height: 280 }));
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
            {group.map((page, slot) => page ? <PreviewPage key={page.id} book={book} page={page} host={host} viewport={viewport}
              side={joined ? slot === 0 ? "left" : "right" : undefined} heightRatio={heightRatio} margins={crops[page.id] || [0, 0, 0, 0]}
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
    {cropping && <CropControls {...cropState} close={() => setCropping(false)} change={changeCrop} />}
  </div>;
}

function ToolsHost({ host }: { host: HostAPI }) {
  useSyncExternalStore(subscribeLocale, getLocale);
  const [book, setBook] = useState(host.getDocument());
  useEffect(() => host.subscribe(setBook), [host]);
  return book ? host.view === "crop" ? <CropTool key={book.id} book={book} host={host} />
    : <PageTools key={book.id} book={book} host={host} /> : <p className="empty">{t("Open a book first")}</p>;
}

export function mount(element: HTMLElement, host: HostAPI) {
  if (host.getLocale) setLocale(host.getLocale());
  const stopLocale = host.subscribeLocale?.(() => { if (host.getLocale) setLocale(host.getLocale()); });
  const root = createRoot(element);
  root.render(<ToolsHost host={host} />);
  return () => { stopLocale?.(); root.unmount(); };
}
