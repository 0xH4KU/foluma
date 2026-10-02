import {getLocale, setLocale, subscribeLocale, t, type Locale} from "../sdk/i18n";
import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {listen} from "@tauri-apps/api/event";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import type {Book, HostAPI, Metadata, Page, Plugin, PluginList, RenderResolution, Series, SeriesItem, Task} from "../sdk/types";
import {documentRef} from "../sdk/types";
import {Icon} from "../sdk/icons";
import {connect, createHost, dropFiles, resourceUrl, rpc, setDocument, subscribeActivity, subscribeSeries, subscribeTask} from "./bridge";
import {ProjectCreator, SeriesWorkspace} from "./series";
import {flushMetadata, type MetadataDraft} from "./metadata";
import "./style.css";

function Preview({book, page, host}: {book: Book; page: Page | undefined; host: HostAPI}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setUrl("");
    if (page) host.preview(book, page, 1024, controller.signal)
      .then(value => {if (!controller.signal.aborted) setUrl(value);})
      .catch(error => {if (!controller.signal.aborted) host.report(error);});
    return () => controller.abort();
  }, [book.id, page, host]);
  return <div className="cover-stage">{url ? <img src={url} alt={t("Selected page preview")}/> : <span>{page ? t("Loading preview…") : t("No pages")}</span>}</div>;
}

type MetadataEditor = {draft: Partial<Metadata>; change: (patch: Partial<Metadata>) => void; commit: () => Promise<void>};
function MetadataForm({book, host, disabled, information}: {book: Book; host: HostAPI; disabled: boolean; information: MetadataEditor}) {
  const meta = {...book.metadata,...information.draft};
  const commit = (patch: Partial<Metadata>) => {information.change(patch); void information.commit().catch(host.report);};
  return <fieldset className="metadata" disabled={disabled} onBlur={() => void information.commit().catch(host.report)}>
    <label>{t("Title")}<input required value={meta.title} aria-invalid={!meta.title.trim()} onChange={e => information.change({title: e.target.value})}/></label>
    <label>{t("Author")}<input placeholder={t("Optional")} value={meta.author} onChange={e => information.change({author: e.target.value})}/></label>
    <div className="form-pair"><label>{t("Book language")}<input required list="book-languages" value={meta.language} onChange={e => information.change({language: e.target.value})}/>
      <datalist id="book-languages"><option value="zh-Hant">繁體中文</option><option value="zh-Hans">简体中文</option><option value="ja">日本語</option><option value="en">English</option><option value="ko">한국어</option><option value="fr">Français</option><option value="de">Deutsch</option></datalist></label>
      <label>{t("Reading direction")}<select value={meta.direction} onChange={e => commit({direction: e.target.value as "rtl" | "ltr"})}>
        <option value="rtl">{t("Right to left")}</option><option value="ltr">{t("Left to right")}</option></select></label></div>
    <p>{t("Used in EPUB metadata. You can enter a custom language code.")}</p>
    <label>{t("Cover placement")}<select value={meta.cover_only ? "shelf" : "both"} onChange={e => commit({cover_only: e.target.value === "shelf"})}><option value="both">{t("Bookshelf and book body")}</option><option value="shelf">{t("Bookshelf only")}</option></select></label>
  </fieldset>;
}

function DocumentView({book, host, disabled, dpi, relink, hidden, information}: {book: Book; host: HostAPI; disabled: boolean; dpi: RenderResolution; relink: (id: string) => void; hidden: boolean; information: MetadataEditor}) {
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
      <div className="list-footer">{t("Selected page {0}",page ? book.pages.indexOf(page) + 1 : 0)}<span>{t("Output: EPUB 3 / fixed layout")}</span></div>
    </div>
    <aside className="book-inspector"><div className="panel-heading"><strong>{t("Book information")}</strong><span>{page ? t("Page {0} preview", book.pages.indexOf(page) + 1) : ""}</span></div>
      <Preview book={book} page={page} host={host}/>
      <div className="output-settings"><MetadataForm book={book} host={host} disabled={disabled} information={information}/>
        <dl className="export-details"><div><dt>{t("Output format")}</dt><dd>{t("EPUB 3 · fixed layout")}</dd></div><div><dt>{t("Image handling")}</dt><dd>{t("Preserve originals")}</dd></div><div><dt>{t("Complex pages")}</dt><dd>{dpi === "auto" ? t("Auto · ask first") : `${dpi} ${t("DPI · ask first")}`}</dd></div></dl>
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

type UnsavedChoice = "save" | "discard" | "cancel";
function UnsavedChanges({title,respond}: {title: string; respond: (choice: UnsavedChoice) => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {dialog.current?.showModal();}, []);
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="unsaved-title" onCancel={event => {event.preventDefault(); respond("cancel");}}>
    <h1 id="unsaved-title">{title}</h1><p>{t("Save your changes before continuing?")}</p>
    <div className="project-dialog-actions"><button autoFocus onClick={() => respond("cancel")}>{t("Cancel")}</button><button onClick={() => respond("discard")}>{t("Discard changes")}</button><button className="primary" onClick={() => respond("save")}>{t("Save and continue")}</button></div>
  </dialog>;
}

function App() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  useEffect(() => {document.documentElement.lang = locale.code;}, [locale.code]);
  const [book, setBook] = useState<Book | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [creatingProject, setCreatingProject] = useState<{migrate: boolean; paths?: string[]} | null>(null);
  const [plugins, setPlugins] = useState<PluginList>({items: [], active: [], errors: [], safe_mode: false, restart_required: false});
  const [tab, setTab] = useState("convert");
  const [message, setMessage] = useState<{text: string; error?: boolean; action?: {label: string; run: () => void}} | null>(null);
  const [unsaved,setUnsaved] = useState<{title: string; respond: (choice: UnsavedChoice) => void} | null>(null);
  const inputDraft = useRef<MetadataDraft>({bookId: null,values: {},pending: null});
  const [metadataDraft,setMetadataDraft] = useState<Partial<Metadata>>({});
  const [savingInformation,setSavingInformation] = useState(0);
  const [selectedBooks,setSelectedBooks] = useState(0);
  const [job, setJob] = useState<Task | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [dpi, setDpi] = useState<RenderResolution>(() => {
    const saved = localStorage.getItem("render-resolution");
    const legacy = localStorage.getItem("render-dpi");
    // The old default was persisted automatically, so migrate it to Auto once.
    const value = Number(saved ?? (legacy === "300" ? "auto" : legacy));
    return [72,150,200,300,400,600].includes(value) ? value : "auto";
  });
  useEffect(() => localStorage.setItem("render-resolution", String(dpi)), [dpi]);
  const [catalog, setCatalog] = useState<{plugins: (Plugin & {url: string; sha256: string})[]; offline?: boolean; message?: string} | null>(null);
  const [loadingCatalog,setLoadingCatalog] = useState(false);
  const [bundled, setBundled] = useState<Plugin[]>([]);
  const [output, setOutput] = useState("");
  const host = useMemo(() => createHost(
    error => {if (!(error as {cancelled?: boolean})?.cancelled) setMessage({text: error instanceof Error ? error.message : String(error), error: true});},
    (text,action) => setMessage(text ? {text,action} : null),
  ), []);
  const commitInformation = useCallback(async () => {
    setSavingInformation(value => value+1);
    try {await flushMetadata(host,inputDraft.current,setMetadataDraft);} finally {setSavingInformation(value => value-1);}
  }, [host]);
  const changeInformation = (patch: Partial<Metadata>) => {
    setMessage(null);
    inputDraft.current.values = {...inputDraft.current.values,...patch};
    setMetadataDraft(inputDraft.current.values);
  };
  const navigate = async (value: string) => {
    try {await commitInformation(); setTab(value);} catch (error) {host.report(error);}
  };
  const busy = working || pluginBusy || job?.state === "running";
  const editorAvailable = plugins.active.some(plugin => plugin.id === "org.foluma.editor");
  const volume = series?.items.find(item => item.document_id === book?.id);
  const nextVolume = series && (() => {
    const index = series.items.findIndex(item => item.id === volume?.id);
    return [...series.items.slice(index+1),...series.items.slice(0,index)].find(item => !item.reviewed && item.id !== volume?.id);
  })();
  const run = async (action: () => Promise<unknown>, commit = true) => {
    setWorking(true); setMessage(null);
    try {if (commit) await commitInformation(); await action();} catch (error) {host.report(error);} finally {setWorking(false);}
  };
  const saveBook = useCallback(async () => {
    await commitInformation();
    const current = host.getDocument(); if (!current) return false;
    const path = current.project_path || await host.saveFile(`${current.metadata.title}.mteproj`,["mteproj"]);
    if (!path) return false;
    await rpc("project.save",{...documentRef(host.getDocument()!),path}); host.notify(t("Book project saved"));
    return true;
  }, [host,commitInformation]);
  const replaceAllowed = useCallback(async (title = t("Open another book")) => {
    let failed = false;
    try {await commitInformation();} catch {failed = true;}
    if (!failed && !host.getDocument()?.dirty) return true;
    const choice = await new Promise<UnsavedChoice>(resolve => setUnsaved({title,respond: value => {setUnsaved(null); resolve(value);}}));
    if (choice === "discard") {inputDraft.current.values = {}; setMetadataDraft({}); return true;}
    return choice === "save" && await saveBook();
  }, [host,commitInformation,saveBook]);
  const latest = useRef({book,busy,series,tab,replaceAllowed}); latest.current = {book,busy,series,tab,replaceAllowed};
  const openPdf = useCallback(async (path?: string) => {
    if (!await replaceAllowed(t("Open standalone PDF"))) return;
    const picked = path || await host.pickFile({extensions: ["pdf"], title: t("Open PDF")});
    if (typeof picked !== "string") return;
    try {await host.task<Book>({operation: "import", path: picked});}
    catch (error) {
      const data = (error as {data?: {kind: string; pages: number[]}}).data;
      if (data?.kind !== "render_required") throw error;
      if (!await host.confirm(t("{0} pages require rendering (pages {1}{2}).\n\nRender these pages as PNG using {3}? Other pages will keep their original images.", data.pages.length, data.pages.slice(0, 20).join(", "), data.pages.length > 20 ? "…" : "", dpi === "auto" ? t("Auto resolution") : `${dpi} DPI`), t("Some pages require rendering"))) return;
      await host.task<Book>({operation: "import", path: picked, render: true, dpi});
    }
    setTab("convert"); setOutput("");
  }, [host, replaceAllowed, dpi]);
  const openPdfRef = useRef(openPdf); openPdfRef.current = openPdf;
  const openFolder = async (paths?: string[]) => {
    if (!await replaceAllowed(t("New project"))) return;
    setCreatingProject({migrate: false,paths});
  };
  const openVolume = (item: SeriesItem) => void run(async () => {
    if (!await replaceAllowed()) return;
    try {await host.task<Book>({operation: "series.open",entry_id: item.id});}
    catch (error) {
      const data = (error as {data?: {kind: string; pages: number[]}}).data;
      if (data?.kind !== "render_required") throw error;
      if (!await host.confirm(t("{0} pages in this book require rendering. Render them as PNG using {1}?",data.pages.length,dpi === "auto" ? t("Auto resolution") : `${dpi} DPI`))) return;
      await host.task<Book>({operation: "series.open",entry_id: item.id,render: true,dpi});
    }
    setTab(editorAvailable ? "org.foluma.editor" : "convert"); setOutput("");
  },false);

  useEffect(() => {
    let mounted = true;
    const stops: (() => void)[] = [host.subscribe(value => {
      if (inputDraft.current.bookId !== (value?.id || null)) {
        inputDraft.current = {bookId: value?.id || null,values: {},pending: null}; setMetadataDraft({});
      }
      setBook(value);
    }), subscribeTask(setJob), subscribeActivity(setPluginBusy),subscribeSeries(setSeries)];
    const addStop = (fn: () => void) => {if (mounted) stops.push(fn); else fn();};
    connect(() => host.report(new Error(t("The conversion engine stopped. Please restart Foluma.")))).then(async stop => {
      addStop(stop);
      const info = await rpc<{document: Book | null; plugins: PluginList; locale: Locale; series: Series|null; series_error: string|null}>("app.info");
      if (mounted) {
        setDocument(info.document); setPlugins(info.plugins); setLocale(info.locale); setSeries(info.series); setReady(true);
        if (info.series?.output_directory && !host.getExportPreferences?.().directory) host.setOutputDirectory?.(info.series.output_directory);
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
        if (latest.current.series?.managed && latest.current.tab === "series") dropFiles(paths);
        else if (paths.length === 1 && paths[0].toLowerCase().endsWith(".pdf")) void run(() => openPdfRef.current(paths[0]),false);
        else if (paths.length) void run(() => openFolder(paths),false);
      }
    }).then(addStop);
    let choosingClose = false;
    const close = async (quit: boolean) => {
      if (choosingClose) return;
      choosingClose = true;
      try {
        if (latest.current.busy ? await host.confirm(t("A task is running. Closing will cancel it."),t("Close Foluma")) : await latest.current.replaceAllowed(t("Close Foluma")))
          if (quit) await invoke("quit_app"); else await getCurrentWindow().destroy();
      } catch (error) {host.report(error);} finally {choosingClose = false;}
    };
    getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault(); await close(false);
    }).then(addStop);
    listen("app-quit-requested",() => void close(true)).then(addStop);
    return () => {mounted = false; stops.forEach(fn => fn());};
  }, [host]);

  const refreshPlugins = async () => {
    setPlugins(await rpc<PluginList>("plugins.list"));
    setLocale(await rpc<Locale>("app.locale"));
  };
  const loadCatalog = async () => {
    setMessage(null);
    setLoadingCatalog(true);
    try {setCatalog(await rpc("plugins.catalog"));}
    catch (error) {setCatalog({plugins:[],offline:true,message:error instanceof Error ? error.message : String(error)});}
    finally {setLoadingCatalog(false);}
  };
  const useLanguage = (code: string) => run(async () => {
    if (!locale.available.some(item => item.code === code)) {
      const pack = bundled.find(item => item.language?.locale === code);
      if (!pack) throw new Error(t("Interface language is not available"));
      if (!plugins.items.some(item => item.id === pack.id)) await rpc("plugins.install_bundled",{id:pack.id});
      await rpc("plugins.set_enabled",{id:pack.id,enabled:true}); await refreshPlugins();
    }
    setLocale(await rpc<Locale>("app.locale",{code})); host.notify(t("Interface language changed"));
  });
  const installLocal = () => run(async () => {
    const path = await host.pickFile({extensions: ["mte-plugin", "zip"], title: t("Install plugin")});
    if (typeof path !== "string") return;
    const plugin = await rpc<Plugin>("plugins.inspect", {path});
    if (!plugin.language && !await host.confirm(t("Install “{0}” {1}?\n\nPlugins can run local code and access your files. Only install plugins from sources you trust.", plugin.name, plugin.version), t("Install plugin"))) return;
    await rpc("plugins.install", {path}); await refreshPlugins();
  });
  const restart = () => run(async () => {
    if (await replaceAllowed(t("Restart Foluma"))) await invoke("restart_app");
  },false);
  const saveProject = () => run(saveBook);
  const exportBook = () => run(async () => {
    const current = host.getDocument(); if (!current) return;
    const path = await host.saveFile(`${current.metadata.title}.epub`, ["epub"]);
    if (!path) return;
    const result = await host.task<{path: string}>({operation: "export", ...documentRef(host.getDocument()!), path, overwrite: true});
    host.setOutputDirectory?.(result.path.slice(0,Math.max(result.path.lastIndexOf("/"),result.path.lastIndexOf("\\"))+1));
    setOutput(result.path); host.notify(t("EPUB exported and structure validated"));
  });
  const openProject = () => run(async () => {
    if (!await replaceAllowed(t("Open project"))) return;
    const path = await host.pickFile({directory: true, title: t("Choose a project folder")});
    if (typeof path === "string") {
      const result = await rpc<Book | Series>("project.open", {path});
      setTab("managed" in result ? "series" : "convert"); setOutput("");
    }
  },false);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || busy || !ready) return;
      const key = event.key.toLowerCase();
      if (key === "s") {event.preventDefault(); if (book) void saveProject();}
      if (key === "o") {event.preventDefault(); if (event.shiftKey) void openProject(); else void run(() => openPdf(),false);}
      if (key === "e") {event.preventDefault(); if (tab === "series") document.getElementById("export-selected-books")?.click(); else if (book) void exportBook();}
    };
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  });
  return <div className="app-shell">
    {unsaved && <UnsavedChanges {...unsaved}/>}
    {draggingFiles && <div className="file-drop-hint" role="status">{t("Drop PDFs or a folder")}</div>}
    {creatingProject && <ProjectCreator host={host} initialName={creatingProject.migrate ? series?.name || "" : ""} migrate={creatingProject.migrate}
      close={() => setCreatingProject(null)} create={async (parent,name) => {
        if (!await replaceAllowed()) throw new Error(t("Project creation cancelled"));
        host.setBusy?.(true);
        try {
          await rpc(creatingProject.migrate ? "series.migrate" : "series.create",{parent,name});
          setTab("series"); setOutput("");
          if (creatingProject.paths?.length) await rpc("series.add",{paths: creatingProject.paths}).catch(host.report);
        } finally {host.setBusy?.(false);}
      }}/>}
    <header className="command-bar" aria-label={t("Main toolbar")}>
      <button className="command" title={t("Open standalone PDF (⌘O)")} disabled={!ready || busy} onClick={() => void run(() => openPdf(),false)}><Icon name="pdf"/><span>{t("Open standalone PDF")}</span></button>
      <button className="command" disabled={!ready || busy} onClick={() => void run(() => openFolder(),false)}><Icon name="folder"/><span>{t("New project")}</span></button>
      <button className="command" title={t("Open project (⇧⌘O)")} disabled={!ready || busy} onClick={openProject}><Icon name="folder"/><span>{t("Open project")}</span></button>
      <button className="command" title={t("Save current book project (⌘S)")} disabled={!book || busy} onClick={saveProject}><Icon name="save"/><span>{t("Save book project")}</span></button>
      <span className="toolbar-divider"/>
      <button className="command primary" title={tab === "series" ? t("Export selected books (⌘E)") : t("Export current book: {0} (⌘E)",book?.metadata.title || "")}
        disabled={busy || (tab === "series" ? !selectedBooks || !series?.output_directory : !book)} onClick={() => {if (tab === "series") document.getElementById("export-selected-books")?.click(); else void exportBook();}}><Icon name="export"/><span>{tab === "series" ? t("Export {0} selected books",selectedBooks) : t("Export current book")}</span></button>
      <div className="toolbar-caption"><strong>Foluma</strong><span>{t("Book conversion and editing")}</span></div>
    </header>
    <div className="document-bar">{series && <><button className="breadcrumb" title={series.directory} onClick={() => void navigate("series")}>{series.name}</button><span aria-hidden="true">›</span></>}<Icon name="book"/><strong title={book?.project_path || book?.metadata.title}>{book?.metadata.title || t("No book open")}</strong>
      <span>{savingInformation ? t("Saving book information…") : Object.keys(metadataDraft).length ? t("Book information · not saved yet") : book?.dirty ? t("Modified · unsaved") : volume ? t("Changes saved") : book?.project_path ? t("Book project saved") : book ? t("Standalone PDF") : ""}</span>
      {book && series && !volume && <span className="outside-project">{t("Not added to this project")}</span>}
      {volume && tab !== "series" && <><label className="review-volume"><input type="checkbox" checked={volume.reviewed} disabled={busy} onChange={event => {const reviewed = event.target.checked; void run(async () => {
        const marks = volume.review_count || 0;
        if (reviewed && marks && !await host.confirm(t("{0} pages still need attention. Mark this book reviewed anyway?",marks),t("Complete book review"),t("Mark book reviewed"))) return;
        await rpc("series.review",{id: volume.id,reviewed,allow_pending: reviewed && marks > 0});
      });}}/>{t("Book reviewed")}</label>{!!volume.review_count && <span>{t("{0} pages need attention",volume.review_count)}</span>}<button disabled={busy || !nextVolume} onClick={() => nextVolume && openVolume(nextVolume)}>{t("Next unreviewed")}</button></>}
      {output && <button onClick={() => void revealItemInDir(output).catch(host.report)}>{t("Show exported file")}</button>}<span className="document-format">PDF → EPUB</span></div>
    <div className="application-body"><aside className="sidebar">
      <nav aria-label={t("Main navigation")}><div className="tree-heading">{t("▾ Workspace")}</div>
        {series && <button className={tab === "series" ? "selected" : ""} onClick={() => void navigate("series")}><Icon name="folder"/>{t("Project")}<span className="nav-count">{series.items.length}</span></button>}
        <button className={tab === "convert" ? "selected" : ""} aria-current={tab === "convert" ? "page" : undefined} onClick={() => void navigate("convert")}><Icon name="book"/>{t("Book information")}</button>
        {plugins.active.filter(p => p.ui).map(p => <button key={p.id} className={tab === p.id ? "selected" : ""} onClick={() => void navigate(p.id)}><Icon name="edit"/>{t(p.ui!.title)}</button>)}
        <div className="tree-heading">{t("▾ Tools")}</div>
        <button className={tab === "plugins" ? "selected" : ""} onClick={() => void navigate("plugins")}><Icon name="plugin"/>{t("Plugins")}<span className="nav-count">{plugins.items.length}</span></button>
        <button className={tab === "settings" ? "selected" : ""} onClick={() => void navigate("settings")}><Icon name="settings"/>{t("Preferences")}</button>
      </nav>
      <div className="document-summary"><div className="tree-heading">{t("▾ Document summary")}</div><dl><dt>{t("Source")}</dt><dd>{book ? "PDF" : "—"}</dd><dt>{t("Pages")}</dt><dd>{book?.pages.length || "—"}</dd><dt>{t("Direction")}</dt><dd>{book ? book.metadata.direction === "rtl" ? t("Right to left") : t("Left to right") : "—"}</dd><dt>{t("Book language")}</dt><dd>{book?.metadata.language || "—"}</dd></dl></div>
      <div className="sidebar-foot"><span>Foluma 0.1.0</span><span>{t("Loaded plugins: {0}",plugins.active.length)}</span></div>
    </aside><main>
      {message && <div className={`notice ${message.error ? "error" : "success"}`} role={message.error ? "alert" : "status"}><span>{message.text}</span><div className="notice-actions">{message.action && <button onClick={message.action.run}>{message.action.label}</button>}<button aria-label={t("Dismiss message")} onClick={() => setMessage(null)}>×</button></div></div>}
      {job?.state === "running" && <div className="job" role="status"><div><span>{job.progress.message}</span><small>{job.progress.done} / {job.progress.total}</small></div><progress value={job.progress.done} max={job.progress.total || 1}/><button onClick={() => void rpc("task.cancel", {id: job.id}).catch(host.report)}>{t("Cancel")}</button></div>}
      {!book && tab === "convert" && <section className="welcome"><Icon name="pdf"/><h1>{t("Convert PDF to EPUB")}</h1><p>{t("Open one PDF or create a project to organize multiple books.")}</p><div className="welcome-actions"><button className="primary" disabled={!ready || !!busy} onClick={() => void run(() => openPdf())}>{t("Open PDF…")}</button><button disabled={!ready || !!busy} onClick={() => void run(() => openFolder())}>{t("New project")}</button></div><p>{t("Review book information and pages, then export a fixed-layout EPUB.")}</p><button className="welcome-project" disabled={!ready || !!busy} onClick={openProject}>{t("Open existing project…")}</button></section>}
      {series && <SeriesWorkspace key={series.id} series={series} host={host} busy={busy} hidden={tab !== "series"} dpi={dpi} openBook={openVolume} selectionChanged={setSelectedBooks} prepare={commitInformation} migrate={() => setCreatingProject({migrate: true})}/>}
      {book && <DocumentView book={book} host={host} hidden={tab !== "convert"} disabled={busy || !!savingInformation} dpi={dpi} information={{draft:metadataDraft,change:changeInformation,commit:commitInformation}} relink={id => void run(async () => {const path = await host.pickFile({extensions: ["pdf"], title: t("Relink original PDF")}); if (typeof path === "string") await rpc("project.relink", {...documentRef(host.getDocument()!), source_id: id, path});})}/>}
      {tab === "plugins" && <section className="content"><div className="page-heading"><h1>{t("Plugins")}</h1><button disabled={busy} onClick={installLocal}>{t("Install local package…")}</button></div>
        {plugins.restart_required && <div className="restart-banner"><span>{t("Plugin changes take effect after restarting.")}</span><button disabled={busy} onClick={restart}>{t("Restart")}</button></div>}
        {plugins.safe_mode && <div className="notice">{t("Safe mode: plugins were not loaded for this session.")}<button onClick={restart}>{t("Restart normally")}</button></div>}
        <div className="section-title"><h2>{t("Installed")}</h2><span>{t("Installed: {0}",plugins.items.length)}</span></div>
        <div className="plugin-table"><div className="plugin-table-head"><span>{t("Name")}</span><span>{t("Version")}</span><span>{t("Status")}</span><span>{t("Actions")}</span></div>
          {!plugins.items.length && <div className="empty-row">{t("No plugins installed")}</div>}
          {plugins.items.map(plugin => <div className="plugin-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span className="version">{plugin.version}</span><label className="switch-label"><input type="checkbox" checked={plugin.enabled} disabled={busy} onChange={e => void run(async () => {await rpc("plugins.set_enabled", {id: plugin.id, enabled: e.target.checked}); await refreshPlugins();})}/>{plugin.pending ? t("Restart needed") : plugin.enabled ? t("Enabled") : t("Disabled")}</label><button disabled={busy} onClick={() => void run(async () => {if (await host.confirm(t("Remove “{0}”? Saved plugin data will be kept.", plugin.name))) {await rpc("plugins.remove", {id: plugin.id}); await refreshPlugins();}})}>{t("Remove")}</button></div>)}
        </div>
        <div className="section-title"><h2>{t("Included packages")}</h2><span>{t("Available offline")}</span></div>
        {bundled.map(plugin => <div className="catalog-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span>{plugin.version}</span><button disabled={busy || plugins.items.some(p => p.id === plugin.id && p.version === plugin.version)} onClick={() => void run(async () => {await rpc("plugins.install_bundled", {id: plugin.id}); await refreshPlugins();})}>{t(plugins.items.some(p => p.id === plugin.id && p.version === plugin.version) ? "Installed" : plugins.items.some(p => p.id === plugin.id) ? "Update" : "Install")}</button></div>)}
        <div className="section-title"><h2>{t("Official catalog")}</h2><button disabled={loadingCatalog} onClick={() => void loadCatalog()}>{t(loadingCatalog ? "Loading catalog…" : "Load catalog")}</button></div>
        {loadingCatalog && <p role="status">{t("Loading the official catalog. You can keep working on your book.")}</p>}
        {!loadingCatalog && !catalog && <div className="empty-row bordered">{t("Catalog not loaded")}</div>}
        {!loadingCatalog && catalog?.offline && <div className="catalog-offline"><p>{t("The official catalog could not be loaded. Included and local packages are still available.")}</p>{!!catalog.plugins.length && <p>{t("Showing the last downloaded catalog.")}</p>}<details><summary>{t("Technical details")}</summary><p>{catalog.message}</p></details></div>}
        {!loadingCatalog && catalog && !catalog.offline && !catalog.plugins.length && <div className="empty-row bordered">{t("No plugins are available for download. You can install a local package.")}</div>}
        {catalog?.plugins.map(plugin => <div className="catalog-row" key={plugin.id}><div><strong>{t(plugin.name)}</strong><p>{t(plugin.description || "")}</p></div><span>{plugin.version}</span><button disabled={busy || plugins.items.some(p => p.id === plugin.id && p.version === plugin.version)} onClick={() => void run(async () => {await rpc("plugins.install_official", {id: plugin.id}); await refreshPlugins();})}>{t(plugins.items.some(p => p.id === plugin.id && p.version === plugin.version) ? "Installed" : plugins.items.some(p => p.id === plugin.id) ? "Update" : "Install")}</button></div>)}
        {!!plugins.errors.length && <div className="notice error">{plugins.errors.join("\n")}</div>}
      </section>}
      {tab === "settings" && <section className="content settings"><div className="page-heading"><h1>{t("Preferences")}</h1></div><article className="settings-row"><div><h2>{t("Complex page rendering")}</h2><p>{t("Auto follows the main image’s resolution, up to 6000 pixels on the longest edge. Text and vector pages use 200 DPI within that limit. Rendering requires confirmation.")}</p></div><label>{t("Resolution")}<select value={dpi} onChange={e => setDpi(e.target.value === "auto" ? "auto" : Number(e.target.value))}><option value="auto">{t("Auto (recommended)")}</option>{[72, 150, 200, 300, 400, 600].map(value => <option key={value} value={value}>{value} DPI</option>)}</select></label></article>
        <article className="settings-row"><div><h2>{t("Interface language")}</h2><p>{t("Changes menus and buttons. Book language controls EPUB metadata separately.")}</p><button onClick={() => void navigate("plugins")}>{t("Manage language packs")}</button></div><label>{t("Interface language")}<select value={locale.code} disabled={busy} onChange={e => void useLanguage(e.target.value)}>{locale.available.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}{bundled.filter(item => item.language && !locale.available.some(value => value.code === item.language!.locale)).map(item => <option key={item.id} value={item.language!.locale}>{t(plugins.items.some(value => value.id === item.id) ? "Enable and use {0}" : "Install and use {0}",item.language!.name)}</option>)}</select></label></article>
        <article className="settings-row"><div><h2>{t("Safe mode")}</h2><p>{t("Skip all plugins on the next launch to troubleshoot plugin issues.")}</p></div><button disabled={busy} onClick={() => void run(async () => {if (await replaceAllowed(t("Restart in safe mode"))) {await rpc("app.safe_mode"); await invoke("restart_app");}})}>{t("Restart in safe mode")}</button></article>
      </section>}
      {plugins.active.filter(plugin => plugin.ui).map(plugin => <PluginWorkspace key={plugin.id} plugin={plugin} host={host} visible={plugin.id === tab}/>)}
    </main></div><footer className="statusbar"><span className={`status-dot ${ready ? "online" : ""}`}/><span>{plugins.safe_mode ? t("Safe mode") : !ready ? t("Starting engine") : job?.state === "running" ? job.progress.message : t("Ready")}</span><span className="status-right">{tab === "series" ? t("{0} selected",selectedBooks) : book ? t("{0} pages · {1}",book.pages.length,book.metadata.direction === "rtl" ? t("RTL") : t("LTR")) : "PDF → EPUB"}<span>{t("Tasks: ")}{busy ? 1 : 0}</span><span>{t("Processed locally")}</span></span></footer>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
