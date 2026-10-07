import {getLocale, setLocale, subscribeLocale, t, type Locale} from "../sdk/i18n.ts";
import {Menu, MenuItem} from "@tauri-apps/api/menu";
import {LogicalPosition} from "@tauri-apps/api/dpi";
import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {emit, emitTo, listen} from "@tauri-apps/api/event";
import {getCurrentWindow, Window} from "@tauri-apps/api/window";
import {ask, open, save} from "@tauri-apps/plugin-dialog";
import type {Book, FileOptions, HostAPI, Plugin, PluginList, ProcessingSettings, Series, Task} from "../sdk/types";
import {documentRef} from "../sdk/types.ts";
import {createPreviewLoader} from "./previews.ts";
import {openToolWindow} from "./tool-windows.ts";

let book: Book | null = null;
let project: Series | null = null;
let formats: Plugin[] = [];
let processing: ProcessingSettings = {preparse: true, parse_concurrency: 2, parallel_export: true, export_concurrency: 2};
const windowParams = new URLSearchParams(globalThis.window?.location?.search || "");
let boundDocument = windowParams.get("document") || (windowParams.has("entry") ? "loading" : null);
export const bindDocument = (id: string) => {boundDocument = id;};
const listeners = new Set<(book: Book | null) => void>();
const pageListeners = new Set<(id: string) => void>();
const taskListeners = new Set<(task: Task) => void>();
const seriesListeners = new Set<(series: Series | null) => void>();
export const subscribeSeries = (fn: (series: Series | null) => void) => {seriesListeners.add(fn); return () => {seriesListeners.delete(fn);};};
const latestTasks = new Map<string, Task>();
const ownedTasks = new Set<string>();
export const getTasks = () => [...latestTasks.values()].map(task => ({...task, result: null}));
const activityListeners = new Set<(busy: boolean) => void>();
const dropListeners = new Set<(paths: string[]) => void>();
let pendingDrop: string[] | null = null;
export const dropFiles = (paths: string[]) => {
  if (dropListeners.size) dropListeners.forEach(listener => listener(paths));
  else pendingDrop = paths;
};
export const subscribeActivity = (fn: (busy: boolean) => void) => {activityListeners.add(fn); return () => {activityListeners.delete(fn);};};
export const setDocument = (value: Book | null, opening = false) => {
  if (!opening && value && value.id === book?.id && (value.revision < book.revision ||
      value.revision === book.revision && book.dirty === false && value.dirty === true)) return;
  book = value; listeners.forEach(fn => fn(value));
};
export const subscribeTask = (fn: (task: Task) => void) => {taskListeners.add(fn); return () => {taskListeners.delete(fn);};};
export const resourceUrl = (path: string) => convertFileSrc(path, "foluma");

function asError(value: unknown): Error & {data?: unknown} {
  if (value instanceof Error) return value;
  const v = value as {message?: string; data?: unknown};
  return Object.assign(new Error(v?.message || String(value)), {data: v?.data});
}
export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    const result = await invoke<T>("engine_call", {method, params});
    if (method === "plugins.list" || method === "app.info") {
      const plugins = method === "plugins.list" ? result as PluginList : (result as {plugins: PluginList}).plugins;
      formats = plugins.active.filter(plugin => plugin.format);
    }
    if (method === "app.locale") await emit("ui-locale", result);
    if (method === "processing.get" || method === "processing.configure") processing = result as ProcessingSettings;
    if (method === "app.info") {
      const info = result as {processing?: ProcessingSettings; tasks?: Task[]};
      if (info.processing) processing = info.processing;
      info.tasks?.forEach(task => {if (!latestTasks.has(task.id)) latestTasks.set(task.id, task);});
    }
    if (["document.apply","document.undo","document.redo","project.save","project.relink","project.open"].includes(method)) {
      const snapshot = result as Book | null;
      if (snapshot?.schema === 1 && Array.isArray(snapshot.pages) && (method === "project.open" || snapshot.id === book?.id))
        setDocument(snapshot,method === "project.open");
    }
    return result;
  }
  catch (error) {throw asError(error);}
}
export async function connect(onExit: () => void) {
  const stop = await listen<{method: string; params: Book | Task | Series | null}>("engine-event", ({payload}) => {
    if (payload.method === "document.changed") {
      const next = payload.params as Book | null;
      if (next && next.id === (boundDocument || book?.id)) setDocument(next);
    }
    if (payload.method === "document.activated" && !boundDocument) {
      const next = payload.params as Book | null;
      setDocument(next, next?.id !== book?.id);
    }
    if (payload.method === "processing.changed") processing = payload.params as unknown as ProcessingSettings;
    if (payload.method === "series.changed") {
      const next = payload.params as Series | null;
      if (next?.output_directory && (next.id !== project?.id || next.output_directory !== project?.output_directory)) localStorage.setItem("output-directory",next.output_directory);
      project = next; seriesListeners.forEach(fn => fn(project));
    }
    if (payload.method === "task.changed") {
      const task = payload.params as Task;
      latestTasks.set(task.id, task);
      const completed = [...latestTasks.values()].filter(item => !item.preparse && !["queued", "running"].includes(item.state));
      completed.slice(0, -30).forEach(item => latestTasks.delete(item.id));
      taskListeners.forEach(fn => fn(task));
    }
  });
  const stopExit = await listen("engine-exit", () => {
    for (const id of ownedTasks) {
      const task = latestTasks.get(id);
      if (task) {
        const failed = {...task, state: "failed" as const, error: {message: t("The document engine stopped. Please restart Foluma.")}};
        latestTasks.set(id, failed);
        taskListeners.forEach(listener => listener(failed));
      }
    }
    onExit();
  });
  const stopSelection = await listen<{document_id: string; page_id: string}>("ui-select-page", ({payload}) => {
    if (payload && typeof payload.page_id === "string" && payload.document_id === book?.id && book?.pages.some(page => page.id === payload.page_id))
      pageListeners.forEach(listener => listener(payload.page_id));
  }, {target: getCurrentWindow().label});
  const stopLocale = await listen<Locale>("ui-locale", ({payload}) => setLocale(payload));
  return () => {stop(); stopExit(); stopSelection(); stopLocale();};
}
export async function task<T>(params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw Object.assign(new Error(t("Task cancelled")), {cancelled: true});
  const started = await rpc<Task>("task.start", params);
  ownedTasks.add(started.id);
  if (!latestTasks.has(started.id)) latestTasks.set(started.id, started);
  return new Promise<T>((resolve, reject) => {
    const stop = () => {taskListeners.delete(check); signal?.removeEventListener("abort", abort); ownedTasks.delete(started.id);};
    const abort = () => {void rpc("task.cancel", {id: started.id}).catch(error => {stop(); reject(error);});};
    const check = (state: Task) => {
      if (state.id !== started.id) return;
      if (state.state !== "running" && state.state !== "queued") {
        stop();
        if (state.state === "completed") {
          if ((params.operation === "import" || params.operation === "series.open") && !params.background) {
            const next = state.result as Book;
            setDocument(next, next.id !== book?.id);
          }
          resolve(state.result as T);
        }
        else reject(Object.assign(new Error(state.state === "cancelled" ? t("Task cancelled") : state.error?.message || t("Task failed")),
                                  {data: state.error?.data, cancelled: state.state === "cancelled"}));
      }
    };
    taskListeners.add(check);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) abort();
    const latest = latestTasks.get(started.id) || started;
    taskListeners.forEach(fn => fn(latest));
  });
}
const preview = createPreviewLoader((current, page, size) =>
  rpc<string>("document.preview", {document_id: current.id, page_id: page.id, size}).then(resourceUrl));
export function createHost(report: HostAPI["report"], notify: HostAPI["notify"]): HostAPI {
  let contextMenu: Menu | undefined;
  let contextItems: MenuItem[] = [];
  let activities = 0;
  return {
    version: 1, getDocument: () => book,
    view: new URLSearchParams(window.location?.search || "").get("view") || undefined,
    openWindow: async options => {
      if (!/^[a-z0-9-]{1,64}$/.test(options.view) || !Number.isFinite(options.width) || !Number.isFinite(options.height) ||
          options.width < 280 || options.width > 1200 || options.height < 260 || options.height > 1200 ||
          typeof options.title !== "string" || options.title.length > 256)
        throw new Error(t("Invalid tool window options"));
      const plugins = await rpc<PluginList>("plugins.list");
      if (!plugins.active.some(plugin => plugin.id === options.plugin && plugin.ui)) throw new Error(t("Plugin is not active"));
      await openToolWindow(options, book?.id);
    },
    closeWindow: () => getCurrentWindow().close(),
    selectPage: async id => {
      if (!book?.pages.some(page => page.id === id)) return;
      const parent = new URLSearchParams(window.location.search).get("parent") || getCurrentWindow().label;
      await emitTo(parent, "ui-select-page", {document_id: book.id, page_id: id});
      await (await Window.getByLabel(parent))?.setFocus();
    },
    onPageSelect: listener => {pageListeners.add(listener); return () => {pageListeners.delete(listener);};},
    getLocale, subscribeLocale, getFormats: () => formats,
    getExportPreferences: () => {
      const value = Number(localStorage.getItem("render-resolution"));
      return {directory: localStorage.getItem("output-directory") || project?.output_directory || "",dpi: [72,150,200,300,400,600].includes(value) ? value : "auto",
        concurrency: processing.parallel_export ? processing.export_concurrency : 1};
    },
    setOutputDirectory: directory => localStorage.setItem("output-directory",directory),
    onFileDrop: listener => {
      dropListeners.add(listener);
      if (pendingDrop) {const paths = pendingDrop; pendingDrop = null; queueMicrotask(() => listener(paths));}
      return () => {dropListeners.delete(listener);};
    },
    setBusy: value => {activities = Math.max(0,activities+(value ? 1 : -1)); activityListeners.forEach(fn => fn(activities > 0));},
    cancelTask: async id => {
      const active = id ? latestTasks.get(id) : [...latestTasks.values()].reverse().find(task =>
        ownedTasks.has(task.id) && (task.state === "running" || task.state === "queued"));
      if (active) await rpc("task.cancel", {id: active.id});
    },
    contextMenu: async (items, at) => {
      await contextMenu?.close();
      await Promise.all(contextItems.map(item => item.close()));
      contextItems = await Promise.all(items.map(item => MenuItem.new({...item})));
      contextMenu = await Menu.new({items: contextItems});
      await contextMenu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
    },
    subscribe: fn => {listeners.add(fn); return () => {listeners.delete(fn);};},
    apply: (current, changes) => rpc<Book>("document.apply", {...documentRef(current), changes}),
    rpc, task, preview, report, notify,
    pickFile: (options: FileOptions) => open({
      title: options.title, multiple: options.multiple, directory: options.directory,
      filters: options.extensions ? [{name: t("Files"), extensions: options.extensions}] : undefined,
    }),
    saveFile: (name, extensions) => save({defaultPath: name, filters: [{name: extensions.join(" / "), extensions}]}),
    confirm: (message, title = "Foluma", okLabel = t("Continue")) => ask(message, {title, kind: "warning", okLabel, cancelLabel: t("Cancel")}),
  };
}
