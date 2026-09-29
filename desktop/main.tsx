import {getLocale, setLocale, subscribeLocale, t, type Locale} from "../sdk/i18n";
import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import type {Book, HostAPI, Metadata, Page, Plugin, PluginList, Series, SeriesItem, Task} from "../sdk/types";
import {documentRef} from "../sdk/types";
import {Icon} from "../sdk/icons";
import {connect, createHost, resourceUrl, rpc, setDocument, subscribeActivity, subscribeSeries, subscribeTask} from "./bridge";
import {SeriesWorkspace} from "./series";
import "./style.css";

function Preview({book, page, host}: {book: Book; page: Page | undefined; host: HostAPI}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true; setUrl("");
    if (page) host.preview(book, page, 1024).then(value => {if (active) setUrl(value);}).catch(host.report);
    return () => {active = false;};
  }, [book.id, page, host]);
  return <div className="cover-stage">{url ? <img src={url} alt={t("Selected page preview")}/> : <span>{page ? t("Loading preview…") : t("No pages")}</span>}</div>;
}

function MetadataForm({book, host, disabled}: {book: Book; host: HostAPI; disabled: boolean}) {
  const [meta, setMeta] = useState(book.metadata);
  useEffect(() => setMeta(book.metadata), [book.metadata]);
  const commit = (patch: Partial<Metadata>) => host.apply(book, {metadata: patch}).catch(host.report);
  return <fieldset className="metadata" disabled={disabled}>
    <label>{t("Title")}<input value={meta.title} onChange={e => setMeta({...meta, title: e.target.value})}
      onBlur={() => {if (meta.title !== book.metadata.title) void commit({title: meta.title});}}/></label>
    <label>{t("Author")}<input placeholder={t("Optional")} value={meta.author} onChange={e => setMeta({...meta, author: e.target.value})}
      onBlur={() => {if (meta.author !== book.metadata.author) void commit({author: meta.author});}}/></label>
    <div className="form-pair"><label>{t("Book language")}<input value={meta.language} onChange={e => setMeta({...meta, language: e.target.value})}
      onBlur={() => {if (meta.language !== book.metadata.language) void commit({language: meta.language});}}/></label>
      <label>{t("Reading direction")}<select value={meta.direction} onChange={e => void commit({direction: e.target.value as "rtl" | "ltr"})}>
        <option value="rtl">{t("Right to left")}</option><option value="ltr">{t("Left to right")}</option></select></label></div>
    <label className="checkbox"><input type="checkbox" checked={meta.cover_only}
      onChange={e => void commit({cover_only: e.target.checked})}/>{t("Use cover on bookshelf only")}</label>
  </fieldset>;
}

function DocumentView({book, host, disabled, dpi, relink, hidden}: {book: Book; host: HostAPI; disabled: boolean; dpi: number; relink: (id: string) => void; hidden: boolean}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState({top: 0, height: 600});
  const list = useRef<HTMLDivElement>(null);
  const page = book.pages.find(p => p.id === selected) || book.pages[0];
  useEffect(() => {
    const node = list.current!;
    const observer = new ResizeObserver(() => {if (node.clientHeight) setViewport(v => ({...v, height: node.clientHeight}));});
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {setSelected(null); if (list.current) list.current.scrollTop = 0;}, [book.id]);
  const first = Math.max(0, Math.floor(viewport.top / 29) - 4);
  const last = Math.min(book.pages.length, Math.ceil((viewport.top + viewport.height) / 29) + 4);
  return <section className="document-workspace" hidden={hidden}>
    <div className="document-list"><div className="panel-heading"><strong>{t("Pages")}</strong><span>{book.pages.length} {t(" pages")}</span></div>
      <div className="page-table-scroll" ref={list} onScroll={e => {const top = e.currentTarget.scrollTop; setViewport(v => ({...v, top}));}}>
        <table className="page-table" aria-label={t("Document pages")}><colgroup><col className="col-number"/><col/><col className="col-size"/><col className="col-format"/><col className="col-status"/></colgroup><thead><tr><th>{t("Page")}</th><th>{t("Source")}</th><th>{t("Image size")}</th><th>{t("Format")}</th><th>{t("Status")}</th></tr></thead>
          <tbody>{first > 0 && <tr aria-hidden="true"><td colSpan={5} style={{height: first * 29, padding: 0}}/></tr>}
            {book.pages.slice(first, last).map((item, offset) => {
              const asset = book.assets[item.asset_id || ""];
              const sourceId = asset?.source_id || asset?.derived_from?.source_id;
              const source = sourceId ? book.sources[sourceId]?.path : asset?.path;
              return <tr key={item.id} tabIndex={0} aria-selected={item.id === page?.id} onClick={() => setSelected(item.id)} onKeyDown={event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); setSelected(item.id);}}}>
                <td>{first + offset + 1}</td><td title={source}>{item.kind === "blank" ? t("Blank page") : `${source?.split(/[\\/]/).pop() || t("Image")}${item.source_page ? ` · ${item.source_page}` : ""}`}</td>
                <td>{item.width} × {item.height}</td><td>{asset?.ext.toUpperCase() || "—"}</td><td>{item.id === book.metadata.cover_id ? t("Cover") : item.split ? item.split.side === "left" ? t("Split · left") : t("Split · right") : asset?.derived_from ? t("Rendered") : item.kind === "blank" ? t("Blank") : t("Original")}</td>
              </tr>;
            })}
            {last < book.pages.length && <tr aria-hidden="true"><td colSpan={5} style={{height: (book.pages.length - last) * 29, padding: 0}}/></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel-heading source-heading"><strong>{t("Source files")}</strong><span>{Object.keys(book.sources).length} {t(" files")}</span></div>
      <div className="source-list">{Object.entries(book.sources).map(([id, source]) => <div key={id}><Icon name="pdf"/><span title={source.path}>{source.path.split(/[\\/]/).pop()}<small>{source.page_count} {t(" pages ·")}{source.path}</small></span><button disabled={disabled} onClick={() => relink(id)}>{t("Relink…")}</button></div>)}</div>
      <div className="list-footer">{t("Selected page ")}{page ? book.pages.indexOf(page) + 1 : 0} {t(" pages")}<span>{t("Output: EPUB 3 / fixed layout")}</span></div>
    </div>
    <aside className="book-inspector"><div className="panel-heading"><strong>{t("Book information")}</strong><span>{page ? t("Page {0} preview", book.pages.indexOf(page) + 1) : ""}</span></div>
      <Preview book={book} page={page} host={host}/>
      <div className="output-settings"><MetadataForm book={book} host={host} disabled={disabled}/>
        <dl className="export-details"><div><dt>{t("Output format")}</dt><dd>{t("EPUB 3 · fixed layout")}</dd></div><div><dt>{t("Image handling")}</dt><dd>{t("Preserve originals")}</dd></div><div><dt>{t("Complex pages")}</dt><dd>{dpi} {t("DPI · ask first")}</dd></div></dl>
      </div>
    </aside>
  </section>;
}

function PluginWorkspace({plugin, host, visible}: {plugin: Plugin; host: HostAPI; visible: boolean}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [visited, setVisited] = useState(false);
  useEffect(() => {if (visible) setVisited(true);}, [visible]);
  useEffect(() => {
    if (!visited) return;
    const shadow = container.current!.shadowRoot || container.current!.attachShadow({mode: "open"});
    let dispose: (() => void) | undefined, cancelled = false;
    const root = document.createElement("div"); root.className = "plugin-root";
    const base = `plugins/${plugin.id}/${plugin.version}/`;
    shadow.replaceChildren();
    if (plugin.ui?.style) {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = resourceUrl(base + plugin.ui.style);
      shadow.append(css);
    }
    shadow.append(root);
    import(/* @vite-ignore */ resourceUrl(base + plugin.ui!.entry)).then(module => {
      if (!cancelled) dispose = module.mount(root, host);
    }).catch(reason => setError(String(reason)));
    return () => {cancelled = true; dispose?.(); shadow.replaceChildren();};
  }, [plugin.id, plugin.version, host, visited]);
  return <div className="workspace" hidden={!visible}>{error && <div className="notice error">{t("Plugin could not start: ")}{error}</div>}<div ref={container}/></div>;
}

function App() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  useEffect(() => {document.documentElement.lang = locale.code;}, [locale.code]);
  const [book, setBook] = useState<Book | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [plugins, setPlugins] = useState<PluginList>({items: [], active: [], errors: [], safe_mode: false, restart_required: false});
  const [tab, setTab] = useState("convert");
  const [message, setMessage] = useState<{text: string; error?: boolean} | null>(null);
  const [job, setJob] = useState<Task | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [dpi, setDpi] = useState(() => {
    const value = Number(localStorage.getItem("render-dpi"));
    return [72,150,200,300,400,600].includes(value) ? value : 300;
  });
  useEffect(() => localStorage.setItem("render-dpi", String(dpi)), [dpi]);
  const [catalog, setCatalog] = useState<{plugins: (Plugin & {url: string; sha256: string})[]; message?: string} | null>(null);
  const [bundled, setBundled] = useState<Plugin[]>([]);
  const [output, setOutput] = useState("");
  const host = useMemo(() => createHost(
    error => {if (!(error as {cancelled?: boolean})?.cancelled) setMessage({text: error instanceof Error ? error.message : String(error), error: true});},
    text => setMessage({text}),
  ), []);
  const busy = working || pluginBusy || job?.state === "running";
  const editorAvailable = plugins.active.some(plugin => plugin.id === "org.foluma.editor");
  const volume = series?.items.find(item => item.document_id === book?.id);
  const nextVolume = series && (() => {
    const index = series.items.findIndex(item => item.id === volume?.id);
    return [...series.items.slice(index+1),...series.items.slice(0,index)].find(item => !item.reviewed && item.id !== volume?.id);
  })();
  const latest = useRef({book, busy, editorAvailable}); latest.current = {book, busy, editorAvailable};
  const run = async (action: () => Promise<unknown>) => {
    setWorking(true); setMessage(null);
    try {await action();} catch (error) {host.report(error);} finally {setWorking(false);}
  };
  const replaceAllowed = useCallback(async () => !host.getDocument()?.dirty ||
    await host.confirm(t("This project has unsaved changes. Continuing will discard them."), t("Open another book")), [host]);
  const openPdf = useCallback(async (path?: string) => {
    if (!await replaceAllowed()) return;
    const picked = path || await host.pickFile({extensions: ["pdf"], title: t("Open PDF")});
    if (typeof picked !== "string") return;
    try {await host.task<Book>({operation: "import", path: picked});}
    catch (error) {
      const data = (error as {data?: {kind: string; pages: number[]}}).data;
      if (data?.kind !== "render_required") throw error;
      if (!await host.confirm(t("{0} pages require rendering (pages {1}{2}).\n\nRender these pages as PNG at {3} DPI? Other pages will keep their original images.", data.pages.length, data.pages.slice(0, 20).join(", "), data.pages.length > 20 ? "…" : "", dpi), t("Some pages require rendering"))) return;
      await host.task<Book>({operation: "import", path: picked, render: true, dpi});
    }
    setTab("convert"); setOutput("");
  }, [host, replaceAllowed, dpi]);
  const openPdfRef = useRef(openPdf); openPdfRef.current = openPdf;
  const openFolder = async (paths?: string[]) => {
    const picked = paths || await host.pickFile({directory: true,title: t("Open series folder")});
    if (!picked) return;
    setSeries(await rpc<Series>("series.scan",{paths: Array.isArray(picked) ? picked : [picked]}));
    setTab("series");
  };
  const openVolume = (item: SeriesItem) => void run(async () => {
    if (!await replaceAllowed()) return;
    try {await host.task<Book>({operation: "series.open",entry_id: item.id});}
    catch (error) {
      const data = (error as {data?: {kind: string; pages: number[]}}).data;
      if (data?.kind !== "render_required") throw error;
      if (!await host.confirm(t("{0} pages in this book require rendering. Render them as PNG at {1} DPI?",data.pages.length,dpi))) return;
      await host.task<Book>({operation: "series.open",entry_id: item.id,render: true,dpi});
    }
    setTab(editorAvailable ? "org.foluma.editor" : "convert"); setOutput("");
  });

  useEffect(() => {
    let mounted = true;
    const stops: (() => void)[] = [host.subscribe(setBook), subscribeTask(setJob), subscribeActivity(setPluginBusy),subscribeSeries(setSeries)];
    const addStop = (fn: () => void) => {if (mounted) stops.push(fn); else fn();};
    connect(() => host.report(new Error(t("The conversion engine stopped. Please restart Foluma.")))).then(async stop => {
      addStop(stop);
      const info = await rpc<{document: Book | null; plugins: PluginList; locale: Locale; series: Series|null; series_error: string|null}>("app.info");
      if (mounted) {
        setDocument(info.document); setPlugins(info.plugins); setLocale(info.locale); setSeries(info.series); setReady(true);
        if (info.series) setTab(info.document && info.plugins.active.some(p => p.id === "org.foluma.editor") ? "org.foluma.editor" : "series");
        if (info.series_error) host.report(new Error(info.series_error));
      }
      const packages = await rpc<Plugin[]>("plugins.bundled");
      if (mounted) setBundled(packages);
    }).catch(host.report);
    getCurrentWindow().onDragDropEvent(({payload}) => {
      setDraggingFiles(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop" && !latest.current.busy) {
        const paths = payload.paths;
        if (paths.length === 1 && paths[0].toLowerCase().endsWith(".pdf")) void run(() => openPdfRef.current(paths[0]));
        else if (paths.length) void run(() => openFolder(paths));
      }
    }).then(addStop);
    getCurrentWindow().onCloseRequested(async event => {
      if (latest.current.book?.dirty || latest.current.busy) {
        event.preventDefault();
        if (await host.confirm(latest.current.busy ? t("A task is running. Closing will cancel it.") : t("This project has unsaved changes. Close anyway?"), t("Close Foluma")))
          await getCurrentWindow().destroy();
      }
    }).then(addStop);
    return () => {mounted = false; stops.forEach(fn => fn());};
  }, [host]);

  const refreshPlugins = async () => {
    setPlugins(await rpc<PluginList>("plugins.list"));
    setLocale(await rpc<Locale>("app.locale"));
  };
  const installLocal = () => run(async () => {
    const path = await host.pickFile({extensions: ["mte-plugin", "zip"], title: t("Install plugin")});
    if (typeof path !== "string") return;
    const plugin = await rpc<Plugin>("plugins.inspect", {path});
    if (!plugin.language && !await host.confirm(t("Install “{0}” {1}?\n\nPlugins can run local code and access your files. Only install plugins from sources you trust.", plugin.name, plugin.version), t("Install plugin"))) return;
    await rpc("plugins.install", {path}); await refreshPlugins();
  });
  const restart = () => run(async () => {
    if (await replaceAllowed()) await invoke("restart_app");
  });
  const saveProject = () => run(async () => {
    if (!book) return;
    const path = book.project_path || await host.saveFile(`${book.metadata.title}.mteproj`, ["mteproj"]);
    if (path) {await rpc("project.save", {...documentRef(host.getDocument()!), path}); host.notify(t("Project saved"));}
  });
  const exportBook = () => run(async () => {
    const current = host.getDocument(); if (!current) return;
    const path = await host.saveFile(`${current.metadata.title}.epub`, ["epub"]);
    if (!path) return;
    const result = await host.task<{path: string}>({operation: "export", ...documentRef(host.getDocument()!), path, overwrite: true});
    setOutput(result.path); host.notify(t("EPUB exported and structure validated"));
  });
  const openProject = () => run(async () => {
    if (!await replaceAllowed()) return;
    const path = await host.pickFile({directory: true, title: t("Choose a .mteproj project folder")});
    if (typeof path === "string") {await rpc("project.open", {path}); setTab("convert"); setOutput("");}
  });
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || busy || !ready) return;
      const key = event.key.toLowerCase();
      if (key === "s") {event.preventDefault(); if (book) void saveProject();}
      if (key === "o") {event.preventDefault(); if (event.shiftKey) void openProject(); else void run(() => openPdf());}
      if (key === "e") {event.preventDefault(); if (book) void exportBook();}
    };
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  });
  return <div className="app-shell">
    {draggingFiles && <div className="file-drop-hint" role="status">{t("Drop a PDF or a series folder")}</div>}
    <header className="command-bar" aria-label={t("Main toolbar")}>
      <button className="command" title={t("Open PDF (⌘O)")} disabled={!ready || busy} onClick={() => void run(() => openPdf())}><Icon name="pdf"/><span>{t("Open PDF")}</span></button>
      <button className="command" disabled={!ready || busy} onClick={() => void run(() => openFolder())}><Icon name="folder"/><span>{t("Open folder")}</span></button>
      <button className="command" title={t("Open project (⇧⌘O)")} disabled={!ready || busy} onClick={openProject}><Icon name="folder"/><span>{t("Open project")}</span></button>
      <button className="command" title={t("Save project (⌘S)")} disabled={!book || busy} onClick={saveProject}><Icon name="save"/><span>{t("Save project")}</span></button>
      <span className="toolbar-divider"/>
      <button className={`command ${book ? "primary" : ""}`} title={t("Export EPUB (⌘E)")} disabled={!book || busy} onClick={exportBook}><Icon name="export"/><span>{t("Export EPUB")}</span></button>
      <div className="toolbar-caption"><strong>Foluma</strong><span>{t("Book conversion and editing")}</span></div>
    </header>
    <div className="document-bar"><Icon name="book"/><strong title={book?.project_path || book?.metadata.title}>{book?.metadata.title || t("No book open")}</strong><span>{book?.dirty ? t("Modified · unsaved") : volume ? t("Changes saved") : book?.project_path ? t("Project saved") : book ? t("PDF document") : ""}</span>{volume && <><label className="review-volume"><input type="checkbox" checked={volume.reviewed} disabled={busy} onChange={event => void run(() => rpc("series.review",{id: volume.id,reviewed: event.target.checked}))}/>{t("Reviewed")}</label><button disabled={busy || !nextVolume} onClick={() => nextVolume && openVolume(nextVolume)}>{t("Next unreviewed")}</button></>}{output && <button onClick={() => void revealItemInDir(output).catch(host.report)}>{t("Show exported file")}</button>}<span className="document-format">PDF → EPUB</span></div>
    <div className="application-body"><aside className="sidebar">
      <nav aria-label={t("Main navigation")}><div className="tree-heading">{t("▾ Workspace")}</div>
        {series && <button className={tab === "series" ? "selected" : ""} onClick={() => setTab("series")}><Icon name="folder"/>{t("Series")}<span className="nav-count">{series.items.length}</span></button>}
        <button className={tab === "convert" ? "selected" : ""} aria-current={tab === "convert" ? "page" : undefined} onClick={() => setTab("convert")}><Icon name="book"/>{t("Book information")}</button>
        {plugins.active.filter(p => p.ui).map(p => <button key={p.id} className={tab === p.id ? "selected" : ""} onClick={() => setTab(p.id)}><Icon name="edit"/>{t(p.ui!.title)}</button>)}
        <div className="tree-heading">{t("▾ Tools")}</div>
        <button className={tab === "plugins" ? "selected" : ""} onClick={() => setTab("plugins")}><Icon name="plugin"/>{t("Plugins")}<span className="nav-count">{plugins.items.length}</span></button>
        <button className={tab === "settings" ? "selected" : ""} onClick={() => setTab("settings")}><Icon name="settings"/>{t("Preferences")}</button>
      </nav>
      <div className="document-summary"><div className="tree-heading">{t("▾ Document summary")}</div><dl><dt>{t("Source")}</dt><dd>{book ? "PDF" : "—"}</dd><dt>{t("Pages")}</dt><dd>{book?.pages.length || "—"}</dd><dt>{t("Direction")}</dt><dd>{book ? book.metadata.direction === "rtl" ? t("Right to left") : t("Left to right") : "—"}</dd><dt>{t("Book language")}</dt><dd>{book?.metadata.language || "—"}</dd></dl></div>
      <div className="sidebar-foot"><span>Foluma 0.1.0</span><span>{t("Loaded plugins: {0}",plugins.active.length)}</span></div>
    </aside><main>
      {message && <div className={`notice ${message.error ? "error" : "success"}`} role={message.error ? "alert" : "status"}>{message.text}<button aria-label={t("Dismiss message")} onClick={() => setMessage(null)}>×</button></div>}
      {job?.state === "running" && <div className="job" role="status"><div><span>{job.progress.message}</span><small>{job.progress.done} / {job.progress.total}</small></div><progress value={job.progress.done} max={job.progress.total || 1}/><button onClick={() => void rpc("task.cancel", {id: job.id}).catch(host.report)}>{t("Cancel")}</button></div>}
      {!book && tab === "convert" && <section className="welcome"><Icon name="pdf"/><h1>{t("Convert PDF to EPUB")}</h1><p>{t("Drop a PDF or a series folder into this window.")}</p><div className="welcome-actions"><button className="primary" disabled={!ready || !!busy} onClick={() => void run(() => openPdf())}>{t("Open PDF…")}</button><button disabled={!ready || !!busy} onClick={() => void run(() => openFolder())}>{t("Open folder…")}</button></div><p>{t("Review book information and pages, then export a fixed-layout EPUB.")}</p><button className="welcome-project" disabled={!ready || !!busy} onClick={openProject}>{t("Open existing project…")}</button></section>}
      {series && <SeriesWorkspace key={series.id} series={series} host={host} busy={busy} hidden={tab !== "series"} dpi={dpi} openBook={openVolume}/>}
      {book && <DocumentView book={book} host={host} hidden={tab !== "convert"} disabled={!!busy} dpi={dpi} relink={id => void run(async () => {const path = await host.pickFile({extensions: ["pdf"], title: t("Relink original PDF")}); if (typeof path === "string" && book) await rpc("project.relink", {...documentRef(book), source_id: id, path});})}/>}
      {tab === "plugins" && <section className="content"><div className="page-heading"><h1>{t("Plugins")}</h1><button disabled={busy} onClick={installLocal}>{t("Install local package…")}</button></div>
        {plugins.restart_required && <div className="restart-banner"><span>{t("Plugin changes take effect after restarting.")}</span><button disabled={busy} onClick={restart}>{t("Restart")}</button></div>}
        {plugins.safe_mode && <div className="notice">{t("Safe mode: plugins were not loaded for this session.")}<button onClick={restart}>{t("Restart normally")}</button></div>}
        <div className="section-title"><h2>{t("Installed")}</h2><span>{t("Installed: {0}",plugins.items.length)}</span></div>
        <div className="plugin-table"><div className="plugin-table-head"><span>{t("Name")}</span><span>{t("Version")}</span><span>{t("Status")}</span><span>{t("Actions")}</span></div>
          {!plugins.items.length && <div className="empty-row">{t("No plugins installed")}</div>}
          {plugins.items.map(plugin => <div className="plugin-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span className="version">{plugin.version}</span><label className="switch-label"><input type="checkbox" checked={plugin.enabled} disabled={busy} onChange={e => void run(async () => {await rpc("plugins.set_enabled", {id: plugin.id, enabled: e.target.checked}); await refreshPlugins();})}/>{plugin.pending ? t("Restart needed") : plugin.enabled ? t("Enabled") : t("Disabled")}</label><button disabled={busy} onClick={() => void run(async () => {if (await host.confirm(t("Remove “{0}”? Saved plugin data will be kept.", plugin.name))) {await rpc("plugins.remove", {id: plugin.id}); await refreshPlugins();}})}>{t("Remove")}</button></div>)}
        </div>
        <div className="section-title"><h2>{t("Included packages")}</h2><span>{t("Available offline")}</span></div>
        {bundled.map(plugin => <div className="catalog-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span>{plugin.version}</span><button disabled={busy || plugins.items.some(p => p.id === plugin.id && p.version === plugin.version)} onClick={() => void run(async () => {await rpc("plugins.install_bundled", {id: plugin.id}); await refreshPlugins();})}>{t("Install")}</button></div>)}
        <div className="section-title"><h2>{t("Official catalog")}</h2><button disabled={busy} onClick={() => void run(async () => setCatalog(await rpc("plugins.catalog")))}>{t("Load catalog")}</button></div>
        {catalog?.message && <p className="muted">{catalog.message}</p>}
        {!catalog && <div className="empty-row bordered">{t("Catalog not loaded")}</div>}
        {catalog && !catalog.plugins.length && <div className="empty-row bordered">{t("No plugins are available for download. You can install a local package.")}</div>}
        {catalog?.plugins.map(plugin => <div className="catalog-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span>{plugin.version}</span><button disabled={busy || plugins.items.some(p => p.id === plugin.id && p.version === plugin.version)} onClick={() => void run(async () => {await rpc("plugins.install_official", {id: plugin.id}); await refreshPlugins();})}>{t("Install")}</button></div>)}
        {!!plugins.errors.length && <div className="notice error">{plugins.errors.join("\n")}</div>}
      </section>}
      {tab === "settings" && <section className="content settings"><div className="page-heading"><h1>{t("Preferences")}</h1></div><article className="settings-row"><div><h2>{t("Complex page rendering")}</h2><p>{t("PDF pages requiring compositing or rotation are rendered as PNG after confirmation.")}</p></div><label>{t("Resolution")}<select value={dpi} onChange={e => setDpi(Number(e.target.value))}>{[72, 150, 200, 300, 400, 600].map(value => <option key={value} value={value}>{value} DPI</option>)}</select></label></article>
        <article className="settings-row"><div><h2>{t("Interface language")}</h2><p>{t("English is built in. Install or remove other languages in Plugins.")}</p><button onClick={() => setTab("plugins")}>{t("Manage language packs")}</button></div><label>{t("Interface language")}<select value={locale.code} disabled={busy} onChange={e => void run(async () => setLocale(await rpc<Locale>("app.locale", {code: e.target.value})))}>{locale.available.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label></article>
        <article className="settings-row"><div><h2>{t("Safe mode")}</h2><p>{t("Skip all plugins on the next launch to troubleshoot plugin issues.")}</p></div><button disabled={busy} onClick={() => void run(async () => {if (await replaceAllowed()) {await rpc("app.safe_mode"); await invoke("restart_app");}})}>{t("Restart in safe mode")}</button></article>
      </section>}
      {plugins.active.filter(plugin => plugin.ui).map(plugin => <PluginWorkspace key={plugin.id} plugin={plugin} host={host} visible={plugin.id === tab}/>)}
    </main></div><footer className="statusbar"><span className={`status-dot ${ready ? "online" : ""}`}/><span>{plugins.safe_mode ? t("Safe mode") : !ready ? t("Starting engine") : job?.state === "running" ? job.progress.message : t("Ready")}</span><span className="status-right">{book ? t("{0} pages · {1}", book.pages.length, book.metadata.direction === "rtl" ? t("RTL") : t("LTR")) : "PDF → EPUB"}<span>{t("Tasks: ")}{busy ? 1 : 0}</span><span>{t("Processed locally")}</span></span></footer>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
