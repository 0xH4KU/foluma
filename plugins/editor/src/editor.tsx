import {getLocale, setLocale, subscribeLocale, t} from "../../../sdk/i18n.ts";
import React, {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import type {Book, Changes, HostAPI, Page} from "../../../sdk/types";
import {documentRef} from "../../../sdk/types";
import {Icon} from "../../../sdk/icons";
import {applyPreset, changeDirection, createPreset, insertBlankPage, isPair, moveBefore, navigatePage, parseRange, restorePages, splitPages, spreadGroups, spreadPages} from "./pages";
import type {Preset} from "./pages";
import {BatchDialog} from "./batch-dialog";
import "./editor.css";

type ViewState = {focus: string|null; selected: string[]; spread: boolean; view: "list"|"grid"|"spreads"; gap: boolean; zoom: number; scroll: number};
function readView(book: Book|null): ViewState {
  const initial: ViewState = {focus: book?.pages[0]?.id || null,selected: [],spread: true,view: "spreads",gap: true,zoom: 100,scroll: 0};
  try {
    const value = JSON.parse(localStorage.getItem(`foluma.editor.view.${book?.id}`) || "null");
    if (!value) return initial;
    return {focus: book?.pages.some(p => p.id === value.focus) ? value.focus : initial.focus,
      selected: Array.isArray(value.selected) ? value.selected.filter((id: unknown) => book?.pages.some(p => p.id === id)) : [],
      spread: typeof value.spread === "boolean" ? value.spread : true,view: ["list","grid","spreads"].includes(value.view) ? value.view : "spreads",
      gap: typeof value.gap === "boolean" ? value.gap : true,zoom: Number.isFinite(value.zoom) ? Math.min(200,Math.max(50,value.zoom)) : 100,
      scroll: Number.isFinite(value.scroll) ? Math.max(0,value.scroll) : 0};
  } catch {return initial;}
}

function PageImage({book, page, host, size = 320, splitRatio}: {book: Book; page: Page; host: HostAPI; size?: number; splitRatio?: number}) {
  const [url,setUrl] = useState("");
  const [error,setError] = useState("");
  const image = useRef<HTMLImageElement>(null);
  const [bounds,setBounds] = useState({width: 0, height: 0});
  const showGuide = splitRatio !== undefined;
  const asset = book.assets[page.asset_id || ""];
  const key = JSON.stringify([book.id,page.id,page.crop,size,asset?.path,book.sources[asset?.source_id || ""]?.path]);
  useEffect(() => {
    const controller = new AbortController(); setUrl(""); setError("");
    if (page.kind !== "blank") host.preview(book,page,size,controller.signal)
      .then(value => {if (!controller.signal.aborted) setUrl(value);})
      .catch(reason => {if (!controller.signal.aborted) setError(String(reason));});
    return () => controller.abort();
  }, [key]);
  useEffect(() => {
    const node = image.current;
    if (!showGuide || !node) return;
    const observer = new ResizeObserver(() => setBounds({width: node.clientWidth,height: node.clientHeight}));
    observer.observe(node); return () => observer.disconnect();
  }, [url,showGuide]);
  if (page.kind === "blank") return <span className="blank-image" style={{aspectRatio: `${page.width} / ${page.height}`}} aria-label={t("Blank page")}/>;
  return url ? <><img ref={image} draggable={false} src={url} alt={page.source_page ? t("Source page {0}", page.source_page) : t("Inserted image")}/>
    {splitRatio !== undefined && bounds.width > 0 && <span className="split-guide" aria-hidden="true" style={bounds}>
      <span className="split-part" style={{left: 0,width: `${splitRatio*100}%`}}>{t("Left · ")}{book.metadata.direction === "rtl" ? t("second") : t("first")}</span>
      <span className="split-part" style={{left: `${splitRatio*100}%`,right: 0}}>{t("Right · ")}{book.metadata.direction === "rtl" ? t("first") : t("second")}</span>
      <i style={{left: `${splitRatio*100}%`}}/>
    </span>}</> :
    <span className="image-placeholder" title={error}>{error ? t("Preview unavailable") : "…"}</span>;
}

function Thumbnails({book, host, selected, focus, select, move, view, busy, context, gap, flags, initialScroll, rememberScroll}: {
  book: Book; host: HostAPI; selected: Set<string>; focus: string | null; view: ViewState["view"];
  select: (id: string, event?: React.MouseEvent) => void; move: (ids: Set<string>, before: string | null) => void;
  busy: boolean; context: (id: string, at: {x: number; y: number}) => void;
  gap: boolean; flags: Set<string>; initialScroll: number; rememberScroll: (top: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport,setViewport] = useState({top: 0, height: 600, width: 200});
  const drag = useRef<{id: string; x: number; y: number; startX: number; startY: number; ids: Set<string>; active: boolean; before?: string | null} | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const [drop,setDrop] = useState<{id: string; after: boolean} | null>(null);
  const hitTest = () => {
    const node = container.current!, moving = drag.current;
    if (!moving?.active) return;
    const bounds = node.getBoundingClientRect();
    const inside = moving.x >= bounds.left && moving.x <= bounds.right && moving.y >= bounds.top && moving.y <= bounds.bottom;
    if (!inside) {moving.before = undefined; setDrop(null); return;}
    const hit = (node.getRootNode() as ShadowRoot).elementFromPoint(moving.x,moving.y);
    if (hit?.closest(".empty-spread-slot")) {moving.before = undefined; setDrop(null); return;}
    const target = hit?.closest<HTMLElement>("[data-page-id]");
    if (target && node.contains(target)) {
      const rect = target.getBoundingClientRect(), id = target.dataset.pageId!;
      const after = view === "list" ? moving.y > rect.top+rect.height/2 : view === "spreads" && book.metadata.direction === "rtl" ? moving.x < rect.left+rect.width/2 : moving.x > rect.left+rect.width/2;
      moving.before = after ? book.pages[book.pages.findIndex(page => page.id === id)+1]?.id || null : id;
      setDrop({id,after});
    } else if (node.scrollTop+node.clientHeight >= node.scrollHeight-4) {
      moving.before = null; setDrop({id: book.pages.at(-1)?.id || "",after: true});
    } else {moving.before = undefined; setDrop(null);}
  };
  const scrollDrag = () => {
    const moving = drag.current, node = container.current;
    if (!moving?.active || !node) return;
    const bounds = node.getBoundingClientRect();
    if (moving.x >= bounds.left && moving.x <= bounds.right) {
      const speed = moving.y < bounds.top+36 ? -10 : moving.y > bounds.bottom-36 ? 10 : 0;
      if (speed) {node.scrollTop += speed; hitTest();}
    }
    frame.current = requestAnimationFrame(scrollDrag);
  };
  const cancelDrag = () => {cancelAnimationFrame(frame.current); drag.current = null; setDrop(null);};
  useEffect(() => {cancelDrag(); return () => cancelAnimationFrame(frame.current);}, [book.id,view,busy]);

  const cells: (Page|null)[] = view === "spreads" ? spreadGroups(book,gap).flatMap(pair => pair.length === 1 ? [pair[0],null] : pair) : book.pages;
  const positions = new Map(book.pages.map((page,index) => [page.id,index+1]));
  const columns = view === "list" ? 1 : view === "spreads" ? 2 : Math.max(1,Math.floor((viewport.width-6)/86));
  const rowHeight = view === "list" ? 29 : 166;
  const first = Math.max(0,Math.floor(viewport.top/rowHeight)-2)*columns;
  const last = Math.min(cells.length,(Math.ceil((viewport.top+viewport.height)/rowHeight)+2)*columns);
  useEffect(() => {
    const node = container.current!;
    node.scrollTop = initialScroll;
    const observer = new ResizeObserver(() => {if (node.clientHeight && node.clientWidth) setViewport(v => ({...v,height: node.clientHeight,width: node.clientWidth}));});
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = container.current!, index = cells.findIndex(p => p?.id === focus);
    const row = Math.floor(index/columns)*rowHeight;
    if (row < node.scrollTop || row+rowHeight > node.scrollTop+node.clientHeight)
      node.scrollTop = Math.max(0,row-node.clientHeight/2+rowHeight/2);
    if (focus && node.contains((node.getRootNode() as ShadowRoot).activeElement))
      node.querySelector<HTMLButtonElement>(`[data-page-id="${CSS.escape(focus)}"]`)?.focus({preventScroll:true});
  }, [focus, columns, rowHeight,view,gap,book.metadata.cover_only,book.metadata.direction]);
  return <div className={`thumbnails ${view === "list" ? "list-view" : "grid-view"} ${view === "spreads" ? `paired-view ${book.metadata.direction}` : ""} ${drop ? "dragging" : ""}`} ref={container} aria-label={view === "list" ? t("Page list") : view === "spreads" ? t("Spread thumbnails") : t("Page thumbnails")}
    onScroll={e => {const top = e.currentTarget.scrollTop; setViewport(v => ({...v,top})); rememberScroll(top);}}
    onPointerDown={e => {
      if (busy || e.button !== 0) return;
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
      if (id) drag.current = {id,x: e.clientX,y: e.clientY,startX: e.clientX,startY: e.clientY,ids: selected.has(id) ? new Set(selected) : new Set([id]),active: false};
    }}
    onPointerMove={e => {
      const moving = drag.current; if (!moving) return;
      moving.x = e.clientX; moving.y = e.clientY;
      if (!moving.active && Math.hypot(moving.x-moving.startX,moving.y-moving.startY) >= 5) {
        moving.active = true; if (!selected.has(moving.id)) select(moving.id); e.currentTarget.setPointerCapture(e.pointerId); frame.current = requestAnimationFrame(scrollDrag);
      }
      if (moving.active) {e.preventDefault(); hitTest();}
    }}
    onPointerUp={e => {
      const moving = drag.current;
      if (moving?.active) {
        suppressClick.current = true;
        if (moving.before !== undefined) move(moving.ids,moving.before);
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      cancelDrag();
    }}
    onPointerCancel={cancelDrag}
    onKeyDown={e => {if (e.key === "Escape" && drag.current) {e.preventDefault(); cancelDrag();}}}
    onClickCapture={e => {if (suppressClick.current) {e.preventDefault();e.stopPropagation();suppressClick.current = false;}}}>

    <div className="thumb-height" style={{height: Math.ceil(cells.length/columns)*rowHeight}}>
      <div className="thumb-grid" style={{top: Math.floor(first/columns)*rowHeight,gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`}}>
        {cells.slice(first,last).map((page, offset) => page ? <button key={page.id} data-page-id={page.id} className={`thumbnail ${view === "spreads" && book.metadata.cover_only && page.id === book.metadata.cover_id ? "shelf-cover" : ""} ${selected.has(page.id) ? "selected" : ""} ${focus === page.id ? "focused" : ""} ${drop?.id === page.id ? drop.after ? "drop-after" : "drop-before" : ""}`}
          aria-label={t("Page {0}{1}", positions.get(page.id), page.id === book.metadata.cover_id ? t(", cover") : "")+(flags.has(page.id) ? ` · ${t("Page needs attention")}` : "")} aria-pressed={selected.has(page.id)}
          draggable={false} onClick={event => select(page.id,event)}
          onContextMenu={e => {e.preventDefault(); if (!busy) context(page.id,{x: e.clientX,y: e.clientY});}}
          onKeyDown={e => {if (e.key === "ContextMenu" || e.shiftKey && e.key === "F10") {e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); context(page.id,{x: r.left,y: r.bottom});}}}>
          {view === "list" ? <><span className="page-number">{positions.get(page.id)}</span><span>{page.source_page ? `PDF · ${page.source_page}` : page.kind === "blank" ? t("Blank page") : t("Insert images")}</span><span className="page-state">{flags.has(page.id) ? t("Review") : page.id === book.metadata.cover_id ? t("Cover") : page.split ? page.split.side === "left" ? t("Left half") : t("Right half") : page.kind === "blank" ? "—" : t("Original")}</span></> : <><span className="thumb-image"><PageImage book={book} page={page} host={host}/>{page.id === book.metadata.cover_id && <em>{t("Cover")}</em>}{flags.has(page.id) && <b className="review-flag" title={t("Needs review")}>!</b>}</span>
          <span className="thumb-label">{positions.get(page.id)}<small>{page.kind === "blank" ? t("Blank") : page.split ? page.split.side === "left" ? t("Left half") : t("Right half") : ""}</small></span><small className="thumb-source">{page.source_page ? t("PDF {0}",page.source_page) : page.kind === "blank" ? t("Inserted blank") : t("Inserted image")}</small></>}
        </button> : <div hidden={book.metadata.cover_only && !!book.metadata.cover_id && first+offset === 1} className="thumbnail empty-spread-slot" key={`gap-${first+offset}`}>{t("Preview only")}</div>)}
      </div>
    </div>
  </div>;
}

function EditorHost({host}: {host: HostAPI}) {
  useSyncExternalStore(subscribeLocale, getLocale);
  const [book,setBook] = useState<Book|null>(host.getDocument());
  useEffect(() => host.subscribe(setBook), [host]);
  return <Editor key={book?.id || "empty"} host={host} book={book}/>;
}

function Editor({host,book}: {host: HostAPI; book: Book|null}) {
  const [initial] = useState(() => readView(book));
  const previousBook = useRef(book);
  const [selected,setSelected] = useState<Set<string>>(new Set(initial.selected));
  const [focus,setFocus] = useState<string|null>(initial.focus);
  const anchor = useRef<string|null>(null);
  const [spread,setSpread] = useState(initial.spread);
  const [view,setView] = useState<ViewState["view"]>(initial.view);
  const [gap,setGap] = useState(initial.gap);
  const [zoom,setZoom] = useState(initial.zoom);
  const scroll = useRef(initial.scroll);
  const savedView = useRef<ViewState>(initial);
  savedView.current = {focus,selected: [...selected],spread,view,gap,zoom,scroll: scroll.current};
  const saveView = () => {
    if (book) try {localStorage.setItem(`foluma.editor.view.${book.id}`,JSON.stringify({...savedView.current,scroll: scroll.current}));} catch { /* View preferences must not block editing. */ }
  };
  useEffect(saveView,[focus,selected,spread,view,gap,zoom]);
  useEffect(() => {
    window.addEventListener("pagehide",saveView);
    return () => {saveView(); window.removeEventListener("pagehide",saveView);};
  }, []);
  const [busy,setBusy] = useState(false);
  const [batch,setBatch] = useState(false);
  const [batchPaths,setBatchPaths] = useState<string[]>([]);
  useEffect(() => host.onFileDrop?.(paths => {setBatchPaths(paths); setBatch(true);}), [host]);
  const [range,setRange] = useState("");
  const [target,setTarget] = useState(1);
  const [jump,setJump] = useState<string|null>(null);
  const [ratio,setRatio] = useState("50");
  const [splitPreview,setSplitPreview] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize,setStageSize] = useState({width: 400,height: 500});
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => {if (entry.contentRect.width && entry.contentRect.height) setStageSize({width: entry.contentRect.width,height: entry.contentRect.height});});
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!book) return;
    if (!book.pages.some(p => p.id === focus)) {
      const previousIndex = book.id === previousBook.current?.id ? previousBook.current.pages.findIndex(p => p.id === focus) : 0;
      setFocus(book.pages[Math.max(0,Math.min(previousIndex,book.pages.length-1))]?.id || null);
      anchor.current = null;
    }
    setSelected(old => new Set([...old].filter(id => book.pages.some(p => p.id === id))));
    previousBook.current = book;
  }, [book?.id,book?.revision]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); host.setBusy?.(true);
    try {await action();} catch (error) {host.report(error);} finally {setBusy(false); host.setBusy?.(false);}
  };
  if (!book) return <div className="editor-empty"><h1>{t("No document open")}</h1><p>{t("Open a PDF, project or series folder from the toolbar.")}</p></div>;
  const current = book.pages.find(p => p.id === focus) || book.pages[0];
  const index = current ? book.pages.indexOf(current) : 0;
  const ids = selected.size ? selected : new Set(current ? [current.id] : []);
  const displayed = spread ? spreadPages(book, current?.id || null, gap) : current ? [current] : [];
  const aspect = (page: Page) => page.width*(page.crop?.[2] || 1)/(page.height*(page.crop?.[3] || 1));
  const aspects = displayed.map(page => page ? aspect(page) : aspect(current));
  const totalAspect = aspects.reduce((sum,value) => sum+value,0) || 1;
  const previewHeight = Math.max(1,Math.min(stageSize.height-24,stageSize.width/totalAspect))*zoom/100;
  const leftStep = book.metadata.direction === "rtl" ? 1 : -1;
  const splitRatio = Number(ratio)/100;
  const editorData = book.extensions["org.foluma.editor"] as {review?: string[]} | undefined;
  const flags = new Set(Array.isArray(editorData?.review) ? editorData.review.filter(id => book.pages.some(page => page.id === id)) : []);
  const update = (changes: Changes) => {
    if (changes.pages && flags.size && !changes.extension) {
      const marked = book.pages.filter(page => flags.has(page.id));
      const review = changes.pages.filter(page => marked.some(old => old.id === page.id || page.split?.original.id === old.id || old.split?.original.id === page.id)).map(page => page.id);
      changes = {...changes,extension: {id: "org.foluma.editor",data: {...editorData,review}}};
    }
    return run(() => host.apply(book,changes));
  };
  const select = (id: string, event?: React.MouseEvent) => {
    if (event?.shiftKey && anchor.current) {
      const a = book.pages.findIndex(p => p.id === anchor.current), b = book.pages.findIndex(p => p.id === id);
      setSelected(new Set(book.pages.slice(Math.max(0,Math.min(a,b)),Math.max(a,b)+1).map(p => p.id)));
    } else if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); anchor.current = id;
    } else {setSelected(new Set([id])); anchor.current = id;}
    setFocus(id);
  };
  const remove = (selection = ids) => run(async () => {
    if (selection.size > 1 && !await host.confirm(t("Delete {0} selected pages? You can undo this change.", selection.size), t("Delete pages"))) return;
    const pages = book.pages.filter(p => !selection.has(p.id));
    await host.apply(book,{pages});
    setFocus(pages[Math.min(book.pages.findIndex(p => selection.has(p.id)),pages.length-1)]?.id || null); setSelected(new Set());
  });
  const history = (redo = false) => run(() => host.rpc(redo ? "document.redo" : "document.undo",documentRef(book)));
  const navigate = (step: number) => {const page = navigatePage(book,current?.id || null,step,spread,gap); if (page) select(page.id);};
  const jumpToPage = () => {
    const position = Number(jump ?? index+1);
    if (!Number.isInteger(position) || position < 1 || position > book.pages.length) {host.report(new Error(t("Destination page is out of range"))); return;}
    select(book.pages[position-1].id); setJump(null);
  };
  const flag = (selection = ids) => {
    const next = new Set(flags), clear = [...selection].every(id => flags.has(id));
    selection.forEach(id => {if (clear) next.delete(id); else next.add(id);});
    void update({extension: {id: "org.foluma.editor",data: {...editorData,review: [...next]}}});
  };
  const nextFlag = () => {
    const pages = [...book.pages.slice(index+1),...book.pages.slice(0,index)];
    const page = pages.find(page => flags.has(page.id)); if (page) select(page.id);
  };
  const exportImages = (selection = ids) => run(async () => {
    const path = await host.saveFile(t("{0}-originals.zip", book.metadata.title),["zip"]);
    if (path) {await host.task({operation: "images.export",...documentRef(book),page_ids: [...selection],path,overwrite: true});host.notify(t("Originals from {0} selected pages exported",selection.size));}
  });
  const writePreset = () => run(async () => {
    const path = await host.saveFile(`${book.metadata.title}.mtepreset`,["mtepreset"]);
    if (path) {await host.rpc("bundle.write",{...documentRef(book),path,plugin: "org.foluma.editor",...createPreset(book),overwrite: true});host.notify(t("Layout preset saved"));}
  });
  const readPreset = () => run(async () => {
    const path = await host.pickFile({extensions: ["mtepreset"],title: t("Load layout preset")});
    if (typeof path !== "string" || !await host.confirm(t("Apply this preset to the book?\n\nPage order and crops follow the original PDF page numbers. Later pages beyond the preset are kept. You can undo this change."),t("Apply layout preset"))) return;
    const result = await host.rpc<{payload: Preset; asset_ids: Record<string,string>; document: Book}>("bundle.read",{...documentRef(book),path,plugin: "org.foluma.editor"});
    await host.apply(result.document,applyPreset(result.document,result.payload,result.asset_ids));
    host.notify(t("Layout preset applied"));
  });
  const insertBlank = (page = current, before = false) => void update(insertBlankPage(book,page,before));
  const insertImages = (after = current) => run(async () => {
    const paths = await host.pickFile({extensions: ["jpg","jpeg","png","webp","tif","tiff","bmp"],multiple: true,title: t("Insert images")});
    if (paths) {
      const result = await host.task<Book>({operation: "images.import",...documentRef(book),paths: Array.isArray(paths) ? paths : [paths],position: after ? book.pages.indexOf(after)+1 : 0});
      const previousIds = new Set(book.pages.map(page => page.id));
      const inserted = result.pages.filter(page => !previousIds.has(page.id));
      if (inserted.length) {setSelected(new Set(inserted.map(page => page.id))); setFocus(inserted[0].id); anchor.current = inserted[0].id;}
      host.notify(t("{0} image pages inserted",inserted.length));
    }
  });
  const split = (selection = ids) => {try {void update(splitPages(book,selection,splitRatio));}catch(error){host.report(error);}};
  const contextMenu = (id: string, at: {x: number; y: number}) => {
    if (busy || !host.contextMenu) return;
    const page = book.pages.find(p => p.id === id)!;
    const selection = ids.has(id) ? new Set(ids) : new Set([id]);
    setSelected(selection); setFocus(id); anchor.current = id;
    void host.contextMenu([
      {text: t("Split selected pages"), enabled: book.pages.some(p => selection.has(p.id) && p.kind === "image" && !p.split), action: () => split(selection)},
      {text: t("Restore split pages"), enabled: book.pages.some((p,i) => isPair(p,book.pages[i+1]) && (selection.has(p.id) || selection.has(book.pages[i+1].id))), action: () => void update(restorePages(book,selection))},
      {text: t("Set as cover"), enabled: selection.size === 1 && page.kind === "image" && page.id !== book.metadata.cover_id, action: () => void update({metadata: {cover_id: id}})},
      {text: t("Insert images after this page…"), action: () => void insertImages(page)},
      {text: t("Insert blank before this page"), action: () => insertBlank(page,true)},
      {text: t("Insert blank after this page"), action: () => insertBlank(page)},
      {text: [...selection].every(id => flags.has(id)) ? t("Clear review marks") : t("Mark selected pages for attention"), action: () => flag(selection)},
      {text: t("Move to beginning"), action: () => void update({pages: moveBefore(book.pages,selection,book.pages.find(p => !selection.has(p.id))?.id || null)})},
      {text: t("Move to end"), action: () => void update({pages: moveBefore(book.pages,selection,null)})},
      {text: t("Export originals…"), enabled: book.pages.some(p => selection.has(p.id) && p.kind === "image"), action: () => void exportImages(selection)},
      {text: t("Delete selected pages"), action: () => void remove(selection)},
    ],at).catch(host.report);
  };
  const canRestore = book.pages.some((page,i) => isPair(page,book.pages[i+1]) && (ids.has(page.id) || ids.has(book.pages[i+1].id)));
  return <div className="editor" tabIndex={-1} onKeyDown={event => {
    if ((event.target as HTMLElement).matches("input,select,textarea") || busy) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {event.preventDefault(); void history(event.shiftKey);}
    else if ((event.metaKey || event.ctrlKey) && event.key === "a") {event.preventDefault(); setSelected(new Set(book.pages.map(p => p.id)));}
    else if (event.key === "Delete" || event.key === "Backspace") {event.preventDefault(); void remove();}
    else if (event.key === "ArrowRight") {event.preventDefault(); navigate(book.metadata.direction === "rtl" ? -1 : 1);}
    else if (event.key === "ArrowLeft") {event.preventDefault(); navigate(book.metadata.direction === "rtl" ? 1 : -1);}
    else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && view === "list" && (event.target as HTMLElement).closest(".thumbnails")) {
      event.preventDefault(); const page = navigatePage(book,current?.id || null,event.key === "ArrowDown" ? 1 : -1,false,gap); if (page) select(page.id);
    }
    else if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "b") {event.preventDefault(); insertBlank(current,!event.shiftKey);}
    else if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {event.preventDefault(); if(event.shiftKey) nextFlag(); else flag();}
  }}>
    {batch && <BatchDialog key={batchPaths.join("|")} initialPaths={batchPaths} host={host} close={() => {setBatch(false); setBatchPaths([]);}}/>}
    <div className="editor-toolbar"><div><strong>{t("Page editor")}</strong><span>{ids.size} / {book.pages.length} {t(" pages selected")}</span></div><div className="toolbar-actions"><button title={t("Undo ⌘Z")} disabled={busy || !book.can_undo} onClick={() => void history()}>{t("↶ Undo")}</button><button title={t("Redo ⇧⌘Z")} disabled={busy || !book.can_redo} onClick={() => void history(true)}>{t("↷ Redo")}</button><details className="preset-menu" onClickCapture={event => {if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false;}}><summary>{t("Presets")}</summary><div><button disabled={busy} onClick={readPreset}>{t("Load preset")}</button><button disabled={busy} onClick={writePreset}>{t("Save preset")}</button><button disabled={busy} onClick={() => setBatch(true)}>{t("Apply preset to PDFs…")}</button></div></details></div></div>
    <div className="editor-columns"><aside className="pages-panel"><div className="panel-title"><strong>{t("Pages")}</strong><div className="view-switch"><button title={t("List")} aria-label={t("List view")} aria-pressed={view === "list"} onClick={() => setView("list")}><Icon name="list"/></button><button title={t("Thumbnails")} aria-label={t("Thumbnail view")} aria-pressed={view === "grid"} onClick={() => setView("grid")}><Icon name="grid"/></button><button title={t("Spread thumbnails")} aria-label={t("Spread thumbnails")} aria-pressed={view === "spreads"} onClick={() => {setView("spreads");setSpread(true);}}><Icon name="book"/></button></div></div>
      <form className="range-form" onSubmit={event => {event.preventDefault();try {const parsed = parseRange(range,book.pages);setSelected(new Set(parsed));setFocus(parsed[0]);}catch(error){host.report(error);}}}><input aria-label={t("Select page range")} placeholder={t("Pages: 1-3, 5")} value={range} onChange={e => setRange(e.target.value)}/><button>{t("Select")}</button></form>
      {view === "list" && <div className="page-list-header"><span>{t("Page")}</span><span>{t("Source")}</span><span>{t("Status")}</span></div>}
      <Thumbnails view={view} book={book} host={host} selected={ids} focus={current?.id || null} select={select} busy={busy} context={contextMenu} gap={gap} flags={flags} initialScroll={initial.scroll} rememberScroll={top => {scroll.current = top;saveView();}} move={(moving,before) => void update({pages: moveBefore(book.pages,moving,before)})}/>
      <div className="panel-foot">{ids.size}{t(" selected · Shift / ⌘ to select multiple")}<br/>{t("Drag to reorder · Right-click for actions")}</div>
    </aside><section className="preview-panel" aria-label={t("Page preview")}><div className="preview-options"><strong>{t("Preview")}</strong><div className="segmented"><button className={!spread ? "active" : ""} aria-pressed={!spread} onClick={() => setSpread(false)}>{t("Single")}</button><button className={spread ? "active" : ""} aria-pressed={spread} onClick={() => setSpread(true)}>{t("Spread")}</button></div>{spread && <label><input type="checkbox" checked={gap} aria-describedby="spread-help" onChange={e => setGap(e.target.checked)}/>{t("Preview leading blank")}</label>}</div>
      {spread && <details className="preview-help"><summary>{t("About spread pairing")}</summary><p id="spread-help">{t("Preview spread pairing in readers that leave a blank before the first page, such as Apple Books. This only affects the preview; no blank page is added or exported.")}</p></details>}
      <div className="review-actions"><button disabled={busy} title={t("Insert blank before this page (B)")} onClick={() => insertBlank(current,true)}>{t("Blank before")}</button><button disabled={busy} title={t("Insert blank after this page (Shift+B)")} onClick={() => insertBlank()}>{t("Blank after")}</button><button disabled={busy || !current} aria-pressed={[...ids].every(id => flags.has(id))} title={t("Toggle page attention mark (M)")} onClick={() => flag()}>{[...ids].every(id => flags.has(id)) ? t("Clear page marks") : t("Mark selected pages for attention")}</button><button disabled={!book.pages.some(page => page.id !== current?.id && flags.has(page.id))} title={t("Next marked page (Shift+M)")} onClick={nextFlag}>{t("Next attention page ({0})",flags.size)}</button></div>
      <div className="preview-scroll" ref={stage}><div className="spread-view" style={{width: previewHeight*totalAspect,height: previewHeight}}>
        {displayed.map((page,slot) => <div key={page?.id || `gap-${slot}`} style={{width: `${aspects[slot]/totalAspect*100}%`}} className={`preview-page ${!page ? "virtual-gap" : ""} ${page?.id === current?.id ? "current-preview" : ""}`} onClick={() => page && select(page.id)} onContextMenu={e => {if (page) {e.preventDefault(); contextMenu(page.id,{x: e.clientX,y: e.clientY});}}}>
          {page ? <PageImage book={book} page={page} host={host} size={1600} splitRatio={splitPreview && !page.split && ids.has(page.id) && splitRatio >= .05 && splitRatio <= .95 ? splitRatio : undefined}/> : <span>{t("Preview blank (not exported)")}</span>}
          {page && <small>{book.pages.indexOf(page)+1}{page.source_page ? ` · ${t("PDF {0}",page.source_page)}` : ` · ${page.kind === "blank" ? t("Blank") : t("Inserted image")}`}</small>}
        </div>)}
        {!displayed.length && <p className="no-pages">{t("No pages. Insert images or undo to restore them.")}</p>}
      </div></div>
      <div className="preview-navigation"><button aria-label={leftStep > 0 ? spread ? t("Next spread") : t("Next page") : spread ? t("Previous spread") : t("Previous page")} disabled={!navigatePage(book,current?.id || null,leftStep,spread,gap)} onClick={() => navigate(leftStep)}>←</button><form className="page-jump" onSubmit={event => {event.preventDefault(); jumpToPage();}}><input aria-label={t("Go to page")} type="number" min={1} max={book.pages.length || 1} disabled={!book.pages.length} value={jump ?? (current ? index+1 : 0)} onChange={event => setJump(event.target.value)} onBlur={() => {if (jump !== null) jumpToPage();}}/><span> / {book.pages.length}</span></form><button aria-label={leftStep < 0 ? spread ? t("Next spread") : t("Next page") : spread ? t("Previous spread") : t("Previous page")} disabled={!navigatePage(book,current?.id || null,-leftStep,spread,gap)} onClick={() => navigate(-leftStep)}>→</button><label className="zoom-control"><input aria-label={t("Preview zoom")} type="range" min="50" max="200" step="10" value={zoom} onChange={e => setZoom(Number(e.target.value))}/><small>{zoom}%</small></label></div>
    </section><aside className="inspector"><fieldset disabled={busy}><div className="panel-title"><strong>{t("Page properties and actions")}</strong></div>
      <section className="page-properties"><dl><dt>{t("Current page")}</dt><dd>{current ? index+1 : "—"} / {book.pages.length}</dd><dt>{t("Source page")}</dt><dd>{current?.source_page ? t("PDF page {0}", current.source_page) : "—"}</dd><dt>{t("Original size")}</dt><dd>{current ? `${current.width} × ${current.height}` : "—"}</dd><dt>{t("Page type")}</dt><dd>{current?.kind === "blank" ? t("Blank page") : current?.split ? t("Split · {0} half", current.split.side === "left" ? t("left") : t("right")) : t("Full page")}</dd></dl></section>
      <details className="inspector-actions"><summary>{t("Insert pages")}</summary><section><button className="full-width" onClick={() => void insertImages()}>{t("＋ Images")}</button><p>{t("Insert after the current page")}</p></section></details>
      <details className="inspector-actions"><summary>{t("Order")}</summary><section><label>{t("Move before page")}<div className="inline-input"><input aria-label={t("Destination page")} type="number" min="1" max={book.pages.length+1} value={target} onChange={e => setTarget(Number(e.target.value))}/><button disabled={!ids.size} onClick={() => {if (!Number.isInteger(target) || target < 1 || target > book.pages.length+1) {host.report(new Error(t("Destination page is out of range")));return;}void update({pages: moveBefore(book.pages,ids,book.pages[target-1]?.id || null)});}}>{t("Move")}</button></div></label><button className="danger full-width" disabled={!ids.size} onClick={() => void remove()}>{t("Delete selected pages")}</button></section></details>
      <details className="inspector-actions" open><summary>{t("Split spreads")}</summary><section><label>{t("Left portion")}<div className="inline-input"><input aria-label={t("Left split ratio")} aria-describedby="split-help" type="number" min="5" max="95" value={ratio} onFocus={() => setSplitPreview(true)} onChange={e => setRatio(e.target.value)}/><span>%</span></div></label><label className="check-label"><input type="checkbox" checked={splitPreview} onChange={e => setSplitPreview(e.target.checked)}/>{t("Preview split line")}</label><div className="two-buttons"><button disabled={![...ids].some(id => book.pages.some(p => p.id === id && p.kind === "image" && !p.split))} onClick={() => split()}>{t("Split")}</button><button disabled={!canRestore} onClick={() => void update(restorePages(book,ids))}>{t("Restore")}</button></div><p id="split-help">{t("Order after split: ")}{book.metadata.direction === "rtl" ? t("Right half → left half") : t("Left half → right half")}{t(". Originals are preserved.")}</p></section></details>
      <details className="inspector-actions" open><summary>{t("Cover and reading")}</summary><section><button className="full-width" disabled={!current || current.kind === "blank" || current.id === book.metadata.cover_id} onClick={() => void update({metadata: {cover_id: current.id}})}>{t("Set as cover")}</button><label>{t("Cover placement")}<select value={book.metadata.cover_only ? "shelf" : "both"} onChange={e => void update({metadata:{cover_only:e.target.value === "shelf"}})}><option value="both">{t("Bookshelf and book body")}</option><option value="shelf">{t("Bookshelf only")}</option></select></label><select aria-label={t("Reading direction")} value={book.metadata.direction} onChange={e => void update(changeDirection(book,e.target.value as "rtl"|"ltr"))}><option value="rtl">{t("Right to left")}</option><option value="ltr">{t("Left to right")}</option></select></section></details>
      <section><button className="full-width" disabled={!book.pages.some(p => ids.has(p.id) && p.kind === "image")} onClick={() => void exportImages()}>{t("Export originals from {0} selected pages",ids.size)}</button><p>{t("Selected pages only. Split pages export their complete original images.")}</p></section>
    </fieldset></aside></div>
  </div>;
}

export function mount(container: HTMLElement, host: HostAPI): () => void {
  if (host.version !== 1) throw new Error(t("The editor requires Foluma plugin API 1"));
  const syncLocale = () => {if (host.getLocale) setLocale(host.getLocale());};
  syncLocale();
  const stopLocale = host.subscribeLocale?.(syncLocale);
  const root = createRoot(container, {onUncaughtError: host.report});
  root.render(<EditorHost host={host}/>);
  return () => {stopLocale?.(); root.unmount();};
}
