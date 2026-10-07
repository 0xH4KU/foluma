import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { HostAPI, SeriesItem } from "../sdk/types";

type Rect = {x: number; y: number; width: number; height: number};
type Screen = Rect & {scale: number};
export function toolWindowPosition(parent: Rect, size: {width: number; height: number}, screens: Screen[]) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  for (const screen of screens) {
    const width = size.width * screen.scale, height = size.height * screen.scale, gap = 10 * screen.scale;
    const y = clamp(parent.y, screen.y, screen.y + screen.height - height);
    const x = clamp(parent.x, screen.x, screen.x + screen.width - width);
    const candidates = [
      {x: parent.x + parent.width + gap, y}, {x: parent.x - width - gap, y},
      {x, y: parent.y + parent.height + gap}, {x, y: parent.y - height - gap},
      {x: screen.x + gap, y},
    ];
    for (const point of candidates) {
      const inside = point.x >= screen.x && point.y >= screen.y &&
        point.x + width <= screen.x + screen.width && point.y + height <= screen.y + screen.height;
      const outside = point.x + width <= parent.x || point.x >= parent.x + parent.width ||
        point.y + height <= parent.y || point.y >= parent.y + parent.height;
      if (inside && outside) return point;
    }
  }
  const screen = screens[0];
  return screen ? {
    x: clamp(parent.x + parent.width + 10 * screen.scale, screen.x, screen.x + screen.width - size.width * screen.scale),
    y: clamp(parent.y, screen.y, screen.y + screen.height - size.height * screen.scale),
  } : {x: parent.x + parent.width + 10, y: parent.y};
}

export async function openToolWindow(options: Parameters<NonNullable<HostAPI["openWindow"]>>[0], documentId?: string) {
  const parent = getCurrentWindow();
  const label = `tool-${parent.label}__${options.plugin.replaceAll(".", "_")}__${options.view}${documentId ? `__${documentId}` : ""}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) { await existing.show(); await existing.setFocus(); return; }
  const window = new WebviewWindow(label, {
    url: `index.html?${new URLSearchParams({plugin: options.plugin, view: options.view, parent: parent.label,
      ...(documentId ? {document: documentId} : {})})}`,
    title: options.title, width: options.width, height: options.height,
    minWidth: 280, minHeight: 260, maximizable: false, minimizable: false,
    visible: false, skipTaskbar: true, parent: parent.label,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once("tauri://created", () => resolve());
    void window.once("tauri://error", ({payload}) => reject(new Error(String(payload))));
  });
  const [position, parentSize, size, scale, monitors] = await Promise.all([
    parent.outerPosition(), parent.outerSize(), window.outerSize(), window.scaleFactor(), availableMonitors(),
  ]);
  const screens = monitors.map((monitor) => ({...monitor.workArea.position, ...monitor.workArea.size, scale: monitor.scaleFactor}));
  const center = {x: position.x + parentSize.width / 2, y: position.y + parentSize.height / 2};
  const contains = (screen: Screen) => center.x >= screen.x && center.x < screen.x + screen.width && center.y >= screen.y && center.y < screen.y + screen.height;
  screens.sort((a, b) => Number(!contains(a)) - Number(!contains(b)));
  const point = toolWindowPosition({...position, ...parentSize}, {width: size.width / scale, height: size.height / scale}, screens);
  await window.setPosition(new PhysicalPosition(Math.round(point.x), Math.round(point.y)));
  await window.show();
  await window.setFocus();
}

export async function openBookWindow(item: SeriesItem, projectId: string) {
  const label = `book-${projectId}-${item.id}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {await existing.show(); await existing.setFocus(); return;}
  const window = new WebviewWindow(label, {
    url: `index.html?${new URLSearchParams({entry: item.id, project: projectId})}`,
    title: `${item.title} — Foluma`, width: 1180, height: 820, minWidth: 860, minHeight: 600,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once("tauri://created", () => resolve());
    void window.once("tauri://error", ({payload}) => reject(new Error(String(payload))));
  });
  await window.setFocus();
}

export async function closeBookWindows(includeMain = false) {
  const parent = getCurrentWindow();
  const destroy = async (window: WebviewWindow) => {
    await window.destroy();
    await invoke("engine_call", {method: "document.release_window", params: {window_id: window.label}});
  };
  for (const window of await getAllWebviewWindows()) {
    if ((!window.label.startsWith("book-") && !(includeMain && window.label === "main")) || window.label === parent.label) continue;
    const request = crypto.randomUUID();
    let respond: (accepted: boolean) => void = () => {};
    const answer = new Promise<boolean>(resolve => {respond = resolve;});
    const stop = await listen<{request: string; accepted: boolean}>("ui-close-prepared", ({payload}) => {
      if (payload.request === request) respond(payload.accepted);
    }, {target: parent.label});
    try {
      if (!(await WebviewWindow.getByLabel(window.label))) continue;
      await emitTo(window.label, "ui-prepare-close", {request, parent: parent.label});
      if (!(await answer)) return false;
      for (const child of await getAllWebviewWindows()) {
        if (child.label.startsWith(`tool-${window.label}__`)) await destroy(child);
      }
      await destroy(window);
    } finally {stop();}
  }
  for (const window of await getAllWebviewWindows()) {
    if (window.label.startsWith(`tool-${parent.label}__`)) await destroy(window);
  }
  return true;
}
