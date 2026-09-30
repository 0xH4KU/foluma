import {getLocale, subscribeLocale, t} from "../sdk/i18n";
import {Menu, MenuItem} from "@tauri-apps/api/menu";
import {LogicalPosition} from "@tauri-apps/api/dpi";
import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {ask, open, save} from "@tauri-apps/plugin-dialog";
import type {Book, FileOptions, HostAPI, Series, Task} from "../sdk/types";
import {documentRef} from "../sdk/types";
import {createPreviewLoader} from "./previews";

let book: Book | null = null;
const listeners = new Set<(book: Book | null) => void>();
const taskListeners = new Set<(task: Task) => void>();
const seriesListeners = new Set<(series: Series | null) => void>();
export const subscribeSeries = (fn: (series: Series | null) => void) => {seriesListeners.add(fn); return () => {seriesListeners.delete(fn);};};
const latestTasks = new Map<string, Task>();
const activityListeners = new Set<(busy: boolean) => void>();
const dropListeners = new Set<(paths: string[]) => void>();
let pendingDrop: string[] | null = null;
export const dropFiles = (paths: string[]) => {
  if (dropListeners.size) dropListeners.forEach(listener => listener(paths));
  else pendingDrop = paths;
};
export const subscribeActivity = (fn: (busy: boolean) => void) => {activityListeners.add(fn); return () => {activityListeners.delete(fn);};};
export const setDocument = (value: Book | null) => {book = value; listeners.forEach(fn => fn(value));};
export const subscribeTask = (fn: (task: Task) => void) => {taskListeners.add(fn); return () => {taskListeners.delete(fn);};};
export const resourceUrl = (path: string) => convertFileSrc(path, "foluma");

function asError(value: unknown): Error & {data?: unknown} {
  if (value instanceof Error) return value;
  const v = value as {message?: string; data?: unknown};
  return Object.assign(new Error(v?.message || String(value)), {data: v?.data});
}
export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {return await invoke<T>("engine_call", {method, params});}
  catch (error) {throw asError(error);}
}
export async function connect(onExit: () => void) {
  const stop = await listen<{method: string; params: Book | Task | Series | null}>("engine-event", ({payload}) => {
    if (payload.method === "document.changed") setDocument(payload.params as Book);
    if (payload.method === "series.changed") seriesListeners.forEach(fn => fn(payload.params as Series | null));
    if (payload.method === "task.changed") {
      const task = payload.params as Task;
      latestTasks.set(task.id, task);
      if (latestTasks.size > 30) latestTasks.delete(latestTasks.keys().next().value!);
      taskListeners.forEach(fn => fn(task));
    }
  });
  const stopExit = await listen("engine-exit", onExit);
  return () => {stop(); stopExit();};
}
export async function task<T>(params: Record<string, unknown>): Promise<T> {
  const started = await rpc<Task>("task.start", params);
  return new Promise<T>((resolve, reject) => {
    const check = (state: Task) => {
      if (state.id !== started.id) return;
      if (state.state !== "running") {
        taskListeners.delete(check);
        if (state.state === "completed") resolve(state.result as T);
        else reject(Object.assign(new Error(state.state === "cancelled" ? t("Task cancelled") : state.error?.message || t("Task failed")),
                                  {data: state.error?.data, cancelled: state.state === "cancelled"}));
      }
    };
    taskListeners.add(check);
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
    getLocale, subscribeLocale,
    onFileDrop: listener => {
      dropListeners.add(listener);
      if (pendingDrop) {const paths = pendingDrop; pendingDrop = null; queueMicrotask(() => listener(paths));}
      return () => {dropListeners.delete(listener);};
    },
    setBusy: value => {activities = Math.max(0,activities+(value ? 1 : -1)); activityListeners.forEach(fn => fn(activities > 0));},
    cancelTask: async () => {
      const active = [...latestTasks.values()].reverse().find(task => task.state === "running");
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
    confirm: (message, title = "Foluma") => ask(message, {title, kind: "warning", okLabel: t("Continue"), cancelLabel: t("Cancel")}),
  };
}
