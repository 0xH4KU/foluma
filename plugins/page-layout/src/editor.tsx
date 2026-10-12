import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createActionRunner } from "../../../sdk/actions.ts";
import { getLocale, setLocale, subscribeLocale, t } from "../../../sdk/i18n.ts";
import { spreadPages } from "../../../sdk/pages.ts";
import { usePagePreview } from "../../../sdk/previews.ts";
import { documentRef } from "../../../sdk/types.ts";
import type { Book, HostAPI, Page } from "../../../sdk/types.ts";
import { DEFAULT_SETTINGS, dragFrame, initialCanvas, layoutData, pageSettings, pageSide, placement, PLUGIN_ID, rotatedSize, selectedEdits, validCanvas, validSettings } from "./layout.ts";
import type { Frame, FrameHandle, Settings, Source } from "./layout.ts";
import "./editor.css";

function PageRow({ book, page, host, index, current, checked, select, toggle }: {
  book: Book; page: Page; host: HostAPI; index: number; current: boolean; checked: boolean;
  select: () => void; toggle: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!row.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(row.current);
    return () => observer.disconnect();
  }, []);
  const preview = usePagePreview(book, visible ? page : undefined, host, 128);
  return <div ref={row} className={`layout-page-row${current ? " current" : ""}`}>
    <input type="checkbox" aria-label={t("Select page {0}", index + 1)} checked={checked}
      disabled={page.kind !== "image"} onChange={toggle} />
    <button onClick={select} aria-current={current ? "page" : undefined}>
      {preview.url ? <img src={preview.url} alt="" /> : <span className="layout-page-placeholder" />}
      <span>{t("Page {0}", index + 1)}<small>{layoutData(book).pages[page.id] ? t("Adjusted") : t("Source")}</small></span>
    </button>
  </div>;
}

function SourceFrame({ source, settings, change }: { source: Source; settings: Settings; change: (frame: Frame) => void }) {
  const [width, height] = rotatedSize(source, settings.angle);
  const [x, y, fw, fh] = settings.frame;
  const drag = useRef<{ frame: Frame; x: number; y: number; handle: FrameHandle } | null>(null);
  const point = (event: React.PointerEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return [0, 0];
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [position.x / width, position.y / height];
  };
  return <svg className="layout-source-image" viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={t("Source image and editable frame reference")}
    onPointerDown={event => {
      const handle = (event.target as Element).getAttribute("data-handle") as FrameHandle | null;
      if (!handle) return;
      event.preventDefault();
      const [px, py] = point(event);
      drag.current = { frame: [...settings.frame], x: px, y: py, handle };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      const [px, py] = point(event), start = drag.current;
      change(dragFrame(start.frame, px - start.x, py - start.y, start.handle));
    }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    <rect width={width} height={height} fill="white" />
    <g transform={`translate(${width / 2} ${height / 2}) rotate(${settings.angle}) translate(${-source.width / 2} ${-source.height / 2})`}>
      <image href={source.url} width={source.width} height={source.height} />
    </g>
    <rect className="layout-frame" data-handle="move" x={x * width} y={y * height} width={fw * width} height={fh * height}
      vectorEffect="non-scaling-stroke" />
    {(["nw", "ne", "sw", "se"] as const).map(handle => <rect key={handle} className="layout-frame-handle" data-handle={handle}
      x={(x + (handle.endsWith("e") ? fw : 0)) * width - width * 0.022}
      y={(y + (handle.startsWith("s") ? fh : 0)) * height - height * 0.022}
      width={width * 0.044} height={height * 0.044} vectorEffect="non-scaling-stroke" />)}
  </svg>;
}

function OutputPage({ source, settings, canvas, side, label, blank }: {
  source?: Source; settings: Settings; canvas: [number, number]; side: "left" | "right" | "center";
  label: string; blank: boolean;
}) {
  const matrix = source ? placement(source, canvas, settings, side) : null;
  return <figure className="layout-output-page">
    <svg viewBox={`0 0 ${canvas[0]} ${canvas[1]}`} role="img" aria-label={label}>
      <rect width={canvas[0]} height={canvas[1]} fill="white" />
      {source && matrix && <g transform={`matrix(${matrix.join(" ")})`}>
        <image href={source.url} width={source.width} height={source.height} />
      </g>}
      {!source && !blank && <text x="50%" y="50%" textAnchor="middle" fontSize={canvas[0] / 20}>{t("Loading preview…")}</text>}
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

function NumberControl({ label, value, min, max, step = 1, suffix = "", change }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; change: (value: number) => void;
}) {
  const formatted = String(Number(value.toFixed(2)));
  const [text, setText] = useState(formatted);
  useEffect(() => setText(formatted), [formatted]);
  return <label className="layout-number"><span>{label}{suffix && <small>{suffix}</small>}</span>
    <input type="number" value={text} min={min} max={max} step={step} onChange={event => {
      const input = event.target.value;
      setText(input);
      const next = Number(input);
      if (input !== "" && Number.isFinite(next) && next >= min && next <= max) change(next);
    }} onBlur={() => {
      const parsed = Number(text);
      const next = text !== "" && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
      setText(String(Number(next.toFixed(2))));
      change(next);
    }} />
  </label>;
}

function Workspace({ book, host }: { book: Book; host: HostAPI }) {
  const [focus, setFocus] = useState(book.pages[0]?.id || "");
  const [selection, setSelection] = useState(new Set<string>());
  const [drafts, setDrafts] = useState<Record<string, Settings>>({});
  const [canvas, setCanvas] = useState<[number, number]>(() => initialCanvas(book));
  const [sources, setSources] = useState<{ key: string; images: Record<string, Source>; error: string }>({ key: "", images: {}, error: "" });
  const [busy, setBusy] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [showSource, setShowSource] = useState(true);
  useEffect(() => {
    if (!workspace.current) return;
    const observer = new ResizeObserver(([entry]) => setVisible(entry.contentRect.width > 0 && entry.contentRect.height > 0));
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const [workerSupport, setWorkerSupport] = useState<"checking" | "ready" | "unsupported">("checking");
  useEffect(() => {
    let active = true;
    void host.rpc<{ plugin_worker_api?: number }>("app.info").then(info => {
      if (active) setWorkerSupport((info.plugin_worker_api || 0) >= 2 ? "ready" : "unsupported");
    }).catch(error => { if (active) { setWorkerSupport("unsupported"); host.report(error); } });
    return () => { active = false; };
  }, [host]);
  const execute = useMemo(() => createActionRunner(host, setBusy), [host]);
  const current = book.pages.find(page => page.id === focus) || book.pages[0];
  const index = current ? book.pages.indexOf(current) : -1;
  const data = layoutData(book);
  const reference = data.reference && validSettings(data.reference.settings) ? data.reference : undefined;
  const adjustment = current ? drafts[current.id] || pageSettings(book, current.id) : pageSettings(book, "");
  const selected = selection.size ? selection : new Set(current?.kind === "image" ? [current.id] : []);
  const pair = spreadPages(book, current?.id || null, true);
  const previewIds = [...new Set([current, ...pair].filter((page): page is Page => !!page && page.kind === "image").map(page => page.id))];
  const sourceKey = JSON.stringify([book.id, book.revision, previewIds]);
  const available = sources.key === sourceKey ? sources.images : {};
  const source = current ? available[current.id] : undefined;
  const edits = selectedEdits(book, selected, drafts, adjustment);
  const marked = (book.extensions["org.foluma.editor"] as { spreads?: unknown } | undefined)?.spreads;
  const markedPair = Array.isArray(marked) && marked.some(ids => Array.isArray(ids) && ids.length === 2 &&
    pair.filter(Boolean).length === 2 && ids.every(id => pair.some(page => page?.id === id)));

  useEffect(() => {
    setDrafts({});
    setCanvas(initialCanvas(book));
    setSelection(previous => new Set([...previous].filter(id => book.pages.some(page => page.id === id && page.kind === "image"))));
  }, [book.revision]);
  useEffect(() => host.onPageSelect?.(id => setFocus(id)), [host]);
  useEffect(() => {
    if (!previewIds.length || workerSupport !== "ready" || !visible) return;
    const controller = new AbortController();
    void host.task<Record<string, Source>>({ operation: "plugin", plugin_id: PLUGIN_ID, ...documentRef(book),
      input: { action: "inspect", page_ids: previewIds } }, controller.signal).then(images => {
      if (!controller.signal.aborted) setSources({ key: sourceKey, images, error: "" });
    }).catch(error => {
      if (!controller.signal.aborted) setSources({ key: sourceKey, images: {}, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [sourceKey, host, workerSupport, visible]);

  const update = (changes: Partial<Settings>) => {
    if (current) setDrafts(previous => ({ ...previous, [current.id]: { ...adjustment, ...changes } }));
  };
  const apply = (targets: Record<string, Settings>, reference = false) => void execute(async () => {
    const input = { canvas, edits: targets };
    const checked = await host.task<{ clipped: string[] }>({ operation: "plugin", plugin_id: PLUGIN_ID,
      ...documentRef(book), input: { action: "check", ...input } });
    if (checked.clipped.length && !await host.confirm(t(
      "Content may be clipped on pages {0}. Check their two-page previews. Apply these adjustments anyway? Original source images are retained.",
      checked.clipped.map(id => book.pages.findIndex(page => page.id === id) + 1).join(", "),
    ), t("Review clipped content"), t("Apply adjustments"))) return;
    await host.task<Book>({ operation: "plugin", plugin_id: PLUGIN_ID, ...documentRef(book),
      input: { action: "apply", ...input, allow_clipping: checked.clipped.length > 0,
        ...(reference && current ? { reference_id: current.id } : {}) } });
    host.notify(t("Adjusted {0} pages", Object.keys(targets).length));
  });
  const restore = () => void execute(async () => {
    const ids = [...selected].filter(id => data.pages[id]);
    if (!ids.length || !await host.confirm(t(
      "Restore source images for {0} pages? Page adjustments and subsequent crop or rotation edits on these pages will be removed. You can undo this change.", ids.length,
    ), t("Restore source images"), t("Restore"))) return;
    await host.task<Book>({ operation: "plugin", plugin_id: PLUGIN_ID, ...documentRef(book), input: { action: "reset", page_ids: ids } });
  });
  const toggle = (id: string) => setSelection(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectSpread = () => setSelection(new Set(pair.filter((page): page is Page => page?.kind === "image").map(page => page.id)));
  const referenceIndex = reference ? book.pages.findIndex(page => page.id === reference.page_id) : -1;
  const canApply = !busy && !!source && current?.kind === "image" && Object.keys(edits).length > 0;

  return <div className="layout-editor" ref={workspace}>
    {workerSupport === "unsupported" && <p className="layout-empty" role="alert">{t("Update Foluma to use this editor.")}</p>}
    <header className="layout-toolbar">
      <strong>{t("Advanced page editor")}</strong>
      <div>
        <button onClick={() => setShowSource(value => !value)}>{showSource ? t("Hide source") : t("Show source")}</button>
        <button disabled={busy || !book.can_undo} onClick={() => void execute(() => host.rpc("document.undo", { document_id: book.id }))}>{t("Undo")}</button>
        <button disabled={busy || !book.can_redo} onClick={() => void execute(() => host.rpc("document.redo", { document_id: book.id }))}>{t("Redo")}</button>
        <button disabled={!canApply} onClick={() => current && apply({ [current.id]: adjustment }, true)}>{t("Apply and use as reference")}</button>
        <button className="layout-primary" disabled={!canApply} onClick={() => apply(edits)}>{t("Apply to {0} pages", Object.keys(edits).length)}</button>
      </div>
    </header>
    <div className="layout-workspace">
      <aside className="layout-page-list" aria-label={t("Pages")}>
        <div className="layout-selection">
          <button disabled={busy} onClick={() => setSelection(new Set(book.pages.filter(page => page.kind === "image").map(page => page.id)))}>{t("Select all")}</button>
          <button disabled={busy} onClick={() => setSelection(new Set())}>{t("Clear selection")}</button>
        </div>
        {book.pages.map((page, pageIndex) => <PageRow key={page.id} book={book} page={page} host={host} index={pageIndex}
          current={page.id === current?.id} checked={selected.has(page.id)} select={() => { if (!busy) setFocus(page.id); }} toggle={() => { if (!busy) toggle(page.id); }} />)}
      </aside>
      <main className="layout-preview-area" data-source={showSource}>
        <section className="layout-preview-section" hidden={!showSource}>
          <div className="layout-section-title"><h2>{t("Source and frame reference")}</h2>
            <span>{current ? t("Page {0}", index + 1) : t("No pages")}</span></div>
          <p>{t("Drag the blue frame around the comic artwork. It controls scale and alignment; content outside it is still included.")}</p>
          {source ? <SourceFrame source={source} settings={adjustment} change={frame => { if (!busy) update({ frame }); }} /> :
            <p className="layout-empty" role={sources.error ? "alert" : undefined}>{sources.key === sourceKey && sources.error ? sources.error :
              current?.kind === "blank" ? t("Choose an image page to adjust") : t("Loading preview…")}</p>}
        </section>
        <section className="layout-preview-section">
          <div className="layout-section-title"><h2>{t("Two-page adjustment preview")}</h2>
            <button disabled={busy} onClick={selectSpread}>{t("Select this spread")}</button></div>
          <div className="layout-spread">
            {pair.map((page, slot) => {
              const saved = page ? data.pages[page.id] : undefined;
              const active = page ? edits[page.id] : undefined;
              return <OutputPage key={page?.id || `gap-${slot}`} source={page ? available[page.id] : undefined}
                settings={active || (saved && page ? pageSettings(book, page.id) : { ...DEFAULT_SETTINGS, height: 100, inner: 0 })}
                canvas={active ? canvas : validCanvas(saved?.canvas) ? saved.canvas : canvas}
                side={active && page ? pageSide(book, page.id) : saved?.side || "center"}
                blank={!page || page.kind === "blank"} label={page ? t("Page {0}", book.pages.indexOf(page) + 1) : t("Leading blank (preview)")} />;
            })}
          </div>
          <p>{markedPair ? t("Marked spread: select both pages to adjust their scale together and check the center seam.") :
            t("Selected pages preview the current scale and margins. Other pages show their saved adjustments.")}</p>
        </section>
      </main>
      <aside className="layout-inspector">
        <fieldset disabled={busy || current?.kind !== "image" || workerSupport !== "ready"}>
          <legend>{t("Page adjustments")}</legend>
          <p>{referenceIndex >= 0 ? t("Reference: page {0}", referenceIndex + 1) : t("Apply a comfortable page as the reference for other pages.")}</p>
          {reference && <button onClick={() => update({ height: reference.settings.height, inner: reference.settings.inner,
            offset_x: reference.settings.offset_x, offset_y: reference.settings.offset_y })}>{t("Use reference scale and margins")}</button>}
          <NumberControl label={t("Straighten")} suffix="°" value={adjustment.angle} min={-5} max={5} step={0.1} change={angle => update({ angle })} />
          <NumberControl label={t("Frame height")} suffix="%" value={adjustment.height} min={20} max={100} change={height => update({ height })} />
          <input type="range" aria-label={t("Frame height")} value={adjustment.height} min={20} max={100} step={1} onChange={event => update({ height: Number(event.target.value) })} />
          <NumberControl label={t("Inner margin")} suffix="%" value={adjustment.inner} min={0} max={40} step={0.5} change={inner => update({ inner })} />
          <NumberControl label={t("Horizontal offset")} suffix="%" value={adjustment.offset_x} min={-30} max={30} step={0.5} change={offset_x => update({ offset_x })} />
          <NumberControl label={t("Vertical offset")} suffix="%" value={adjustment.offset_y} min={-30} max={30} step={0.5} change={offset_y => update({ offset_y })} />
          <details><summary>{t("Frame bounds")}</summary>
            {([t("Left"), t("Top"), t("Width"), t("Height")]).map((label, position) => <NumberControl key={position} label={label} suffix="%"
              value={adjustment.frame[position] * 100} min={position < 2 ? 0 : 1} max={100} step={0.5} change={value => {
                const frame: Frame = [...adjustment.frame];
                frame[position] = value / 100;
                if (position < 2) frame[position] = Math.min(frame[position], 1 - frame[position + 2]);
                else frame[position] = Math.min(frame[position], 1 - frame[position - 2]);
                update({ frame });
              }} />)}
          </details>
          <details><summary>{t("Page canvas")}</summary>
            <NumberControl label={t("Width")} suffix="px" value={canvas[0]} min={64} max={10000} change={width => setCanvas([Math.round(width), canvas[1]])} />
            <NumberControl label={t("Height")} suffix="px" value={canvas[1]} min={64} max={10000} change={height => setCanvas([canvas[0], Math.round(height)])} />
          </details>
          <button disabled={!source} onClick={() => update({ frame: [0, 0, 1, 1], angle: 0 })}>{t("Reset frame and angle")}</button>
          <button disabled={![...selected].some(id => data.pages[id])} onClick={restore}>{t("Restore source images")}</button>
          <p>{t("Applying to selected pages shares scale and margins, keeping each page's own frame and angle. Original images stay available for later adjustments.")}</p>
        </fieldset>
      </aside>
    </div>
  </div>;
}

function EditorHost({ host }: { host: HostAPI }) {
  useSyncExternalStore(subscribeLocale, getLocale);
  const [book, setBook] = useState(host.getDocument());
  useEffect(() => host.subscribe(setBook), [host]);
  return book ? <Workspace key={book.id} book={book} host={host} /> : <div className="layout-empty"><h1>{t("No document open")}</h1>
    <p>{t("Import a book or open a project to adjust its pages.")}</p></div>;
}

export function mount(element: HTMLElement, host: HostAPI) {
  if (host.version !== 1) throw new Error(t("The editor requires Foluma plugin API 1"));
  const syncLocale = () => { if (host.getLocale) setLocale(host.getLocale()); };
  syncLocale();
  const unsubscribe = host.subscribeLocale?.(syncLocale);
  const root = createRoot(element, { onUncaughtError: host.report });
  root.render(<EditorHost host={host} />);
  return () => { unsubscribe?.(); root.unmount(); };
}
