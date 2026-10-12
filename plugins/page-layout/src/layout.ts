import type { Book, Page } from "../../../sdk/types.ts";
import { pageSize, readingPages } from "../../../sdk/pages.ts";

export const PLUGIN_ID = "org.foluma.page-layout";
export type Frame = [number, number, number, number];
export type Settings = { frame: Frame; angle: number; height: number; inner: number; offset_x: number; offset_y: number };
export type Source = { width: number; height: number; url: string };
export type PageRecord = { source: Page; rendered: Page; settings: Settings; canvas: [number, number]; side?: "left" | "right" | "center" };
export type LayoutData = {
  schema: 1; pages: Record<string, PageRecord>; canvas?: [number, number];
  reference?: { page_id: string; settings: Settings; canvas: [number, number] };
};
export const DEFAULT_SETTINGS: Settings = {
  frame: [0, 0, 1, 1], angle: 0, height: 81, inner: 4, offset_x: 0, offset_y: 0,
};

export function validCanvas(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(number =>
    typeof number === "number" && Number.isInteger(number) && number >= 64 && number <= 10000);
}

export function validSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>, frame = data.frame;
  if (!Array.isArray(frame) || frame.length !== 4 || !frame.every(number => typeof number === "number" && Number.isFinite(number))) return false;
  const [x, y, width, height] = frame as number[];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.0000001 || y + height > 1.0000001) return false;
  return ([ ["angle", -5, 5], ["height", 20, 100], ["inner", 0, 40],
    ["offset_x", -30, 30], ["offset_y", -30, 30] ] as const).every(([key, min, max]) => {
    const number = data[key];
    return typeof number === "number" && Number.isFinite(number) && number >= min && number <= max;
  });
}

export function layoutData(book: Book): LayoutData {
  const value = book.extensions[PLUGIN_ID];
  if (value && typeof value === "object" && "schema" in value && value.schema === 1 &&
      "pages" in value && value.pages && typeof value.pages === "object" && !Array.isArray(value.pages))
    return value as LayoutData;
  return { schema: 1, pages: {} };
}

export function initialCanvas(book: Book): [number, number] {
  const saved = layoutData(book).canvas;
  if (validCanvas(saved)) return saved;
  const page = book.pages.find(page => page.kind === "image");
  const [width, height] = page ? pageSize(page) : [1750, 2480];
  const scale = Math.min(1, 6000 / Math.max(width, height));
  return [Math.max(64, Math.round(width * scale)), Math.max(64, Math.round(height * scale))];
}

export function pageSettings(book: Book, id: string): Settings {
  const data = layoutData(book), saved = data.pages[id]?.settings;
  if (validSettings(saved)) return structuredClone(saved);
  const reference = validSettings(data.reference?.settings) ? data.reference!.settings : DEFAULT_SETTINGS;
  return { ...reference, frame: [0, 0, 1, 1], angle: 0 };
}

export function selectedEdits(book: Book, ids: Set<string>, drafts: Record<string, Settings>, template: Settings) {
  return Object.fromEntries(book.pages.filter(page => page.kind === "image" && ids.has(page.id)).map(page => {
    const own = drafts[page.id] || pageSettings(book, page.id);
    return [page.id, { ...own, height: template.height, inner: template.inner,
      offset_x: template.offset_x, offset_y: template.offset_y }];
  }));
}

export function pageSide(book: Book, id: string): "left" | "right" | "center" {
  if (book.metadata.cover_only && id === book.metadata.cover_id) return "center";
  const index = readingPages(book).findIndex(page => page.id === id);
  return index % 2 === (book.metadata.direction === "rtl" ? 0 : 1) ? "left" : "right";
}

export function rotatedSize(source: Pick<Source, "width" | "height">, angle: number): [number, number] {
  const radians = angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return [Math.ceil(Math.abs(source.width * cosine) + Math.abs(source.height * sine)),
    Math.ceil(Math.abs(source.width * sine) + Math.abs(source.height * cosine))];
}

export function placement(source: Pick<Source, "width" | "height">, canvas: [number, number], settings: Settings,
  side: "left" | "right" | "center"): [number, number, number, number, number, number] {
  const radians = settings.angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const [width, height] = rotatedSize(source, settings.angle);
  const [x, y, fw, fh] = settings.frame, [cw, ch] = canvas;
  const frameX = (x + fw / 2) * width, frameY = (y + fh / 2) * height;
  const inner = settings.inner / 100 * cw;
  const scale = Math.min(ch * settings.height / 100 / (fh * height), (cw - 2 * inner) / (fw * width));
  const targetWidth = fw * width * scale;
  const centerX = (side === "left" ? cw - inner - targetWidth / 2 : side === "right" ? inner + targetWidth / 2 : cw / 2)
    + cw * settings.offset_x / 100;
  const centerY = ch * (0.5 + settings.offset_y / 100), a = scale * cosine, b = scale * sine;
  return [a, b, -b, a,
    centerX + scale * (width / 2 - frameX) - a * source.width / 2 + b * source.height / 2,
    centerY + scale * (height / 2 - frameY) - b * source.width / 2 - a * source.height / 2];
}

export type FrameHandle = "move" | "nw" | "ne" | "sw" | "se";
export function dragFrame(frame: Frame, dx: number, dy: number, handle: FrameHandle): Frame {
  const [x, y, width, height] = frame;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  if (handle === "move") return [clamp(x + dx, 0, 1 - width), clamp(y + dy, 0, 1 - height), width, height];
  const left = handle.endsWith("w") ? clamp(x + dx, 0, x + width - 0.01) : x;
  const top = handle.startsWith("n") ? clamp(y + dy, 0, y + height - 0.01) : y;
  const right = handle.endsWith("e") ? clamp(x + width + dx, left + 0.01, 1) : x + width;
  const bottom = handle.startsWith("s") ? clamp(y + height + dy, top + 0.01, 1) : y + height;
  return [left, top, right - left, bottom - top];
}
