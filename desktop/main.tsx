import { getLocale, setLocale, subscribeLocale, t, type Locale } from "../sdk/i18n";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type {
  Book,
  HostAPI,
  Plugin,
  PluginList,
  RenderResolution,
  Series,
  Task,
} from "../sdk/types";
import { documentRef } from "../sdk/types";
import { Icon } from "../sdk/icons";
import {
  connect,
  createHost,
  dropFiles,
  resourceUrl,
  rpc,
  setDocument,
  subscribeActivity,
  subscribeSeries,
  subscribeTask,
} from "./bridge";
import { ProjectCreator, SeriesWorkspace, type SeriesSelection } from "./series";
import { useDocumentActions, UnsavedChanges, ExportEdition } from "./document-actions";
import { DocumentView } from "./document";
import { PluginManager } from "./plugin-manager";
import { Toolbar, DocumentBar, Sidebar, StatusBar } from "./shell";
import { Preferences } from "./preferences";
import { ProjectWizard } from "./project-wizard";
import "./style.css";

function PluginWorkspace({
  plugin,
  host,
  visible,
}: {
  plugin: Plugin;
  host: HostAPI;
  visible: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (visible) setVisited(true);
  }, [visible]);
  useEffect(() => {
    if (!visited) return;
    const shadow =
      container.current!.shadowRoot || container.current!.attachShadow({ mode: "open" });
    let dispose: (() => void) | undefined,
      cancelled = false;
    const root = document.createElement("div");
    root.className = "plugin-root";
    const base = `plugins/${plugin.id}/${plugin.version}/`;
    shadow.replaceChildren();
    if (plugin.ui?.style) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = resourceUrl(base + plugin.ui.style);
      shadow.append(css);
    }
    shadow.append(root);
    import(/* @vite-ignore */ resourceUrl(base + plugin.ui!.entry))
      .then((module) => {
        if (!cancelled) dispose = module.mount(root, host);
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      cancelled = true;
      dispose?.();
      shadow.replaceChildren();
    };
  }, [plugin.id, plugin.version, host, visited]);
  return (
    <div className="workspace" hidden={!visible}>
      {error && (
        <div className="notice error">
          {t("Plugin could not start: ")}
          {error}
        </div>
      )}
      <div ref={container} />
    </div>
  );
}

function App() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  useEffect(() => {
    document.documentElement.lang = locale.code;
  }, [locale.code]);
  const [book, setBook] = useState<Book | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [creatingProject, setCreatingProject] = useState<{
    migrate: boolean;
    paths?: string[];
  } | null>(null);
  const [plugins, setPlugins] = useState<PluginList>({
    items: [],
    active: [],
    errors: [],
    safe_mode: false,
    restart_required: false,
  });
  const [tab, setTab] = useState("convert");
  const [message, setMessage] = useState<{
    text: string;
    error?: boolean;
    action?: { label: string; run: () => void };
  } | null>(null);
  const [seriesSelection, setSeriesSelection] = useState<SeriesSelection>({
    count: 0,
    canExport: false,
  });
  const selectedBooks = seriesSelection.count;
  const seriesExport = useRef<(() => void) | null>(null);
  const [job, setJob] = useState<Task | null>(null);
  const [ready, setReady] = useState(false);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [dpi, setDpi] = useState<RenderResolution>(() => {
    const saved = localStorage.getItem("render-resolution");
    const legacy = localStorage.getItem("render-dpi");
    // The old default was persisted automatically, so migrate it to Auto once.
    const value = Number(saved ?? (legacy === "300" ? "auto" : legacy));
    return [72, 150, 200, 300, 400, 600].includes(value) ? value : "auto";
  });
  useEffect(() => localStorage.setItem("render-resolution", String(dpi)), [dpi]);
  const [bundled, setBundled] = useState<Plugin[]>([]);
  const host = useMemo(
    () =>
      createHost(
        (error) => {
          if (!(error as { cancelled?: boolean })?.cancelled)
            setMessage({
              text: error instanceof Error ? error.message : String(error),
              error: true,
            });
        },
        (text, action) => setMessage(text ? { text, action } : null),
      ),
    [],
  );
  const editorAvailable = plugins.active.some((plugin) => plugin.id === "org.foluma.editor");
  const {
    unsaved,
    exportEdition,
    metadataDraft,
    savingInformation,
    working,
    output,
    setOutput,
    commitInformation,
    changeInformation,
    run,
    replaceAllowed,
    importBook,
    openVolume,
    saveProject,
    exportBook,
    openProject,
  } = useDocumentActions(host, dpi, editorAvailable, setTab);
  const exportSelected = () => {
    if (seriesSelection.canExport) seriesExport.current?.();
  };
  const navigate = async (value: string) => {
    try {
      await commitInformation();
      setTab(value);
    } catch (error) {
      host.report(error);
    }
  };
  const busy = working || pluginBusy || job?.state === "running";
  const latest = useRef({ book, busy, series, tab, replaceAllowed });
  latest.current = { book, busy, series, tab, replaceAllowed };
  const importers = plugins.active.filter((plugin) => plugin.format?.direction === "import");
  const exporters = plugins.active.filter((plugin) => plugin.format?.direction === "export");
  const sourceFormats = [
    ...new Set(
      Object.values(book?.sources || {}).map((source) =>
        source.path.split(".").pop()?.toUpperCase(),
      ),
    ),
  ].join(" / ");
  const volume = series?.items.find((item) => item.document_id === book?.id);
  const nextVolume =
    series &&
    (() => {
      const index = series.items.findIndex((item) => item.id === volume?.id);
      return [...series.items.slice(index + 1), ...series.items.slice(0, index)].find(
        (item) => !item.reviewed && item.id !== volume?.id,
      );
    })();
  const importBookRef = useRef(importBook);
  importBookRef.current = importBook;
  const openFolder = async (paths?: string[]) => {
    if (!(await replaceAllowed(t("New project")))) return;
    setCreatingProject({ migrate: false, paths });
  };

  useEffect(() => {
    let mounted = true;
    const stops: (() => void)[] = [
      host.subscribe(setBook),
      subscribeTask(setJob),
      subscribeActivity(setPluginBusy),
      subscribeSeries(setSeries),
    ];
    const addStop = (fn: () => void) => {
      if (mounted) stops.push(fn);
      else fn();
    };
    connect(() => host.report(new Error(t("The document engine stopped. Please restart Foluma."))))
      .then(async (stop) => {
        addStop(stop);
        const info = await rpc<{
          document: Book | null;
          plugins: PluginList;
          locale: Locale;
          series: Series | null;
          series_error: string | null;
        }>("app.info");
        if (mounted) {
          setDocument(info.document);
          setPlugins(info.plugins);
          setLocale(info.locale);
          setSeries(info.series);
          setReady(true);
          if (info.series?.output_directory && !host.getExportPreferences?.().directory)
            host.setOutputDirectory?.(info.series.output_directory);
          if (info.series)
            setTab(
              info.document && info.plugins.active.some((p) => p.id === "org.foluma.editor")
                ? "org.foluma.editor"
                : "series",
            );
          if (info.series_error) host.report(new Error(info.series_error));
        }
        const packages = await rpc<Plugin[]>("plugins.bundled");
        if (mounted) setBundled(packages);
      })
      .catch(host.report);
    getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        setDraggingFiles(payload.type === "enter" || payload.type === "over");
        if (payload.type === "drop" && !latest.current.busy) {
          const paths = payload.paths;
          if (latest.current.series?.managed && latest.current.tab === "series") dropFiles(paths);
          else if (paths.length === 1 && /\.[a-z0-9]+$/i.test(paths[0]))
            void run(() => importBookRef.current(paths[0]), false);
          else if (paths.length) void run(() => openFolder(paths), false);
        }
      })
      .then(addStop);
    let choosingClose = false;
    const close = async (quit: boolean) => {
      if (choosingClose) return;
      choosingClose = true;
      try {
        if (
          latest.current.busy
            ? await host.confirm(t("A task is running. Closing will cancel it."), t("Close Foluma"))
            : await latest.current.replaceAllowed(t("Close Foluma"))
        )
          if (quit) await invoke("quit_app");
          else await getCurrentWindow().destroy();
      } catch (error) {
        host.report(error);
      } finally {
        choosingClose = false;
      }
    };
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await close(false);
      })
      .then(addStop);
    listen("app-quit-requested", () => void close(true)).then(addStop);
    return () => {
      mounted = false;
      stops.forEach((fn) => fn());
    };
  }, [host]);

  const refreshPlugins = async () => {
    setPlugins(await rpc<PluginList>("plugins.list"));
    setLocale(await rpc<Locale>("app.locale"));
  };
  const restart = () =>
    run(async () => {
      if (await replaceAllowed(t("Restart Foluma"))) await invoke("restart_app");
    }, false);
  const closeProject = () =>
    run(async () => {
      if (!(await replaceAllowed(t("Close project")))) return;
      await rpc("series.close", { discard: true });
      setDocument(null);
      setSeries(null);
      setSeriesSelection({ count: 0, canExport: false });
      setOutput("");
      setTab("convert");
      setPreviewGeneration((value) => value + 1);
      host.notify(t("Project closed"));
    }, false);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || busy || !ready) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (book) void saveProject();
      }
      if (key === "o") {
        event.preventDefault();
        if (event.shiftKey) void openProject();
        else void run(() => importBook(), false);
      }
      if (key === "e") {
        event.preventDefault();
        if (tab === "series") exportSelected();
        else if (book) void exportBook();
      }
    };
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  });
  return (
    <div className="app-shell">
      {unsaved && <UnsavedChanges {...unsaved} />}
      {exportEdition && <ExportEdition {...exportEdition} />}
      {draggingFiles && (
        <div className="file-drop-hint" role="status">
          {t("Drop book files or a folder")}
        </div>
      )}
      {creatingProject &&
        (creatingProject.migrate ? (
          <ProjectCreator
            host={host}
            initialName={series?.name || ""}
            migrate
            close={() => setCreatingProject(null)}
            create={async (parent, name) => {
              if (!(await replaceAllowed())) throw new Error(t("Project creation cancelled"));
              host.setBusy?.(true);
              try {
                await rpc("series.migrate", { parent, name });
                setTab("series");
                setOutput("");
              } finally {
                host.setBusy?.(false);
              }
            }}
          />
        ) : (
          <ProjectWizard
            host={host}
            initialPaths={creatingProject.paths}
            close={() => setCreatingProject(null)}
            create={async (settings) => {
              if (!(await replaceAllowed())) throw new Error(t("Project creation cancelled"));
              host.setBusy?.(true);
              try {
                await rpc("series.create", { ...settings });
                setTab("series");
                setOutput("");
              } finally {
                host.setBusy?.(false);
              }
            }}
          />
        ))}
      <Toolbar
        ready={ready}
        busy={busy}
        book={book}
        hasProject={!!series}
        hasImporters={!!importers.length}
        hasExporters={!!exporters.length}
        exportingSeries={tab === "series"}
        selectedBooks={selectedBooks}
        canExport={seriesSelection.canExport}
        onImport={() => void run(() => importBook(), false)}
        onNewProject={() => void run(() => openFolder(), false)}
        onOpenProject={openProject}
        onCloseProject={closeProject}
        onSaveProject={saveProject}
        onExport={() => {
          if (!exporters.length) {
            void navigate("plugins");
            return;
          }
          if (tab === "series") exportSelected();
          else void exportBook();
        }}
      />
      <DocumentBar
        series={series}
        book={book}
        volume={volume}
        nextVolume={nextVolume}
        busy={busy}
        savingInformation={savingInformation}
        hasMetadataDraft={Object.keys(metadataDraft).length > 0}
        output={output}
        sourceFormats={sourceFormats}
        host={host}
        run={run}
        navigate={navigate}
        openVolume={openVolume}
        showReview={tab !== "series"}
      />
      <div className="application-body">
        <Sidebar
          series={series}
          book={book}
          plugins={plugins}
          tab={tab}
          sourceFormats={sourceFormats}
          navigate={navigate}
        />
        <main>
          {message && (
            <div
              className={`notice ${message.error ? "error" : "success"}`}
              role={message.error ? "alert" : "status"}
            >
              <span>{message.text}</span>
              <div className="notice-actions">
                {message.action && (
                  <button onClick={message.action.run}>{message.action.label}</button>
                )}
                <button aria-label={t("Dismiss message")} onClick={() => setMessage(null)}>
                  ×
                </button>
              </div>
            </div>
          )}
          {job?.state === "running" && (
            <div className="job" role="status">
              <div>
                <span>{job.progress.message}</span>
                <small>
                  {job.progress.done} / {job.progress.total}
                </small>
              </div>
              <progress value={job.progress.done} max={job.progress.total || 1} />
              <button onClick={() => void rpc("task.cancel", { id: job.id }).catch(host.report)}>
                {t("Cancel")}
              </button>
            </div>
          )}
          {!book && tab === "convert" && (
            <section className="welcome">
              <Icon name="book" />
              <h1>{t("Your workspace for books and pages")}</h1>
              <p>{t("Import one book or create a project to organize a collection.")}</p>
              <div className="welcome-actions">
                <button
                  className="primary"
                  disabled={!ready || !!busy}
                  onClick={() => void run(() => importBook())}
                >
                  {t(importers.length ? "Import book…" : "Install import plugin")}
                </button>
                <button disabled={!ready || !!busy} onClick={() => void run(() => openFolder())}>
                  {t("New project")}
                </button>
              </div>
              <p>{t("Review book information and pages, then choose an enabled export format.")}</p>
              <button className="welcome-project" disabled={!ready || !!busy} onClick={openProject}>
                {t("Open existing project…")}
              </button>
            </section>
          )}
          {series && (
            <SeriesWorkspace
              key={series.id}
              series={series}
              host={host}
              busy={busy}
              hidden={tab !== "series"}
              dpi={dpi}
              openBook={openVolume}
              selectionChanged={setSeriesSelection}
              exportCommand={seriesExport}
              prepare={commitInformation}
              migrate={() => setCreatingProject({ migrate: true })}
            />
          )}
          {book && (
            <DocumentView
              previewGeneration={previewGeneration}
              book={book}
              host={host}
              hidden={tab !== "convert"}
              disabled={busy || !!savingInformation}
              dpi={dpi}
              information={{
                draft: metadataDraft,
                change: changeInformation,
                commit: commitInformation,
              }}
              relink={(id) =>
                void run(async () => {
                  const source = host.getDocument()!.sources[id];
                  const path = await host.pickFile({
                    extensions: [source.path.split(".").pop()!],
                    title: t("Relink original source"),
                  });
                  if (typeof path === "string")
                    await rpc("project.relink", {
                      ...documentRef(host.getDocument()!),
                      source_id: id,
                      path,
                    });
                })
              }
            />
          )}
          <PluginManager
            host={host}
            plugins={plugins}
            bundled={bundled}
            busy={busy}
            hidden={tab !== "plugins"}
            run={run}
            refreshPlugins={refreshPlugins}
            restart={restart}
          />
          {tab === "settings" && (
            <Preferences
              host={host}
              plugins={plugins}
              bundled={bundled}
              busy={busy}
              dpi={dpi}
              setDpi={setDpi}
              locale={locale}
              run={run}
              replaceAllowed={replaceAllowed}
              refreshPlugins={refreshPlugins}
              navigate={navigate}
              prepare={commitInformation}
              refreshPreviews={() => setPreviewGeneration((value) => value + 1)}
            />
          )}
          {plugins.active
            .filter((plugin) => plugin.ui)
            .map((plugin) => (
              <PluginWorkspace
                key={`${plugin.id}:${previewGeneration}`}
                plugin={plugin}
                host={host}
                visible={plugin.id === tab}
              />
            ))}
        </main>
      </div>
      <StatusBar
        ready={ready}
        safeMode={plugins.safe_mode}
        job={job}
        exportingSeries={tab === "series"}
        selectedBooks={selectedBooks}
        book={book}
        busy={busy}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
