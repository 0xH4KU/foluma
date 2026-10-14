import { REVIEW_EXTENSION_ID, reviewData, spreadMarks } from "./review.ts";
import type { Book, Page } from "./types.ts";

export const PAGE_TOOLS_ID = "org.foluma.page-tools";
export const PAGE_MARGIN = 0.02;
export type PageColor = "white" | "black";
export type CropMargins = [number, number, number, number]; // left, top, right, bottom in displayed orientation

export function appearanceData(book: Book) {
  const value = book.extensions[PAGE_TOOLS_ID];
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pages = new Set(book.pages.flatMap(page => page.kind === "image"
    ? [page.id, ...(page.split ? [page.split.original.id] : [])] : []));
  const colors = data.colors && typeof data.colors === "object" && !Array.isArray(data.colors)
    ? Object.fromEntries(Object.entries(data.colors).filter(([id, color]) =>
      pages.has(id) && (color === "white" || color === "black"))) as Record<string, PageColor> : {};
  const ids = new Set(Array.isArray(data.no_margins) ? data.no_margins : []);
  return { ...data, colors, no_margins: [...pages].filter(id => ids.has(id)) };
}

export function pageColors(book: Book): Record<string, PageColor> {
  const colors = appearanceData(book).colors;
  return Object.fromEntries(book.pages.filter(page => page.kind === "image" && colors[page.id])
    .map(page => [page.id, colors[page.id]]));
}

export function pagesWithoutMargins(book: Book): string[] {
  const ids = new Set(appearanceData(book).no_margins);
  return book.pages.filter(page => page.kind === "image" && ids.has(page.id)).map(page => page.id);
}

export function remapPageData(book: Book, pages: Page[], origins: Map<string, string[]>): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  const targets = new Map<string, string[]>();
  for (const page of pages) for (const id of origins.get(page.id) || [page.id]) {
    const ids = targets.get(id) || [];
    ids.push(page.id);
    targets.set(id, ids);
  }
  if (book.extensions[REVIEW_EXTENSION_ID]) {
    const data = reviewData(book), marked = new Set(data.review);
    extensions[REVIEW_EXTENSION_ID] = {
      ...data,
      review: pages.filter(page => (origins.get(page.id) || [page.id]).some(id => marked.has(id))).map(page => page.id),
      ...(Array.isArray(data.spreads) ? { spreads: spreadMarks(book).map(pair => {
        const mapped = pair.map(id => targets.get(id)?.length === 1 ? targets.get(id)![0] : id);
        return mapped[0] === mapped[1] ? pair : mapped;
      }) } : {}),
    };
  }
  if (book.extensions[PAGE_TOOLS_ID]) {
    const data = appearanceData(book), colors = { ...data.colors }, savedMargins = new Set(data.no_margins), noMargins = new Set(savedMargins);
    const originals = new Set(book.pages.flatMap(page => page.split ? [page.split.original.id] : []));
    for (const page of [...pages, ...pages.flatMap(page => page.split ? [page.split.original] : [])]) {
      if (page.kind !== "image") continue;
      const ids = origins.get(page.id) || [page.id];
      const original = [page.id, ...ids].find(id => originals.has(id));
      const color = original ? data.colors[original] || "white" : colors[page.id] || ids.map(id => data.colors[id]).find(Boolean);
      if (color) colors[page.id] = color;
      if (original ? savedMargins.has(original) : ids.some(id => savedMargins.has(id))) noMargins.add(page.id);
      else noMargins.delete(page.id);
    }
    extensions[PAGE_TOOLS_ID] = appearanceData({ ...book, pages,
      extensions: { ...book.extensions, [PAGE_TOOLS_ID]: { ...data, colors, no_margins: [...noMargins] } } });
  }
  return extensions;
}

export function cropBox(page: Page): [number, number, number, number] {
  // Match Python's ties-to-even rounding in crop_box.
  const round = (value: number) => value % 1 === 0.5 ? Math.floor(value) + Math.floor(value) % 2 : Math.round(value);
  const [x, y, w, h] = page.crop || [0, 0, 1, 1];
  const left = Math.min(page.width - 1, round(x * page.width)), top = Math.min(page.height - 1, round(y * page.height));
  return [left, top, Math.min(page.width, Math.max(left + 1, round((x + w) * page.width))),
    Math.min(page.height, Math.max(top + 1, round((y + h) * page.height)))];
}

export function pageSize(page: Page): [number, number] {
  const [left, top, right, bottom] = cropBox(page), width = right - left, height = bottom - top;
  return (page.rotation || 0) % 180 ? [height, width] : [width, height];
}

export function readingPages(book: Book): Page[] {
  return book.pages.filter(page => !book.metadata.cover_only || page.id !== book.metadata.cover_id);
}

export function spreadGroups(book: Book, gap: boolean): (Page | null)[][] {
  const reading = readingPages(book);
  const display: (Page | null)[] = gap && reading.length ? [null, ...reading] : reading;
  const groups: (Page | null)[][] = [];
  const cover = book.pages.find(page => page.id === book.metadata.cover_id);
  if (book.metadata.cover_only && cover) groups.push([cover]);
  for (let i = 0; i < display.length; i += 2) {
    const pair = [display[i] || null, display[i + 1] || null];
    groups.push(book.metadata.direction === "rtl" ? pair.reverse() : pair);
  }
  return groups;
}

export function joinedSpread(book: Book, group: (Page | null)[]): boolean {
  return group.length === 2 && group.every(page => page?.kind === "image") &&
    spreadMarks(book).some(ids => ids.every(id => group.some(page => page?.id === id)));
}

export function cropFromMargins(page: Page, margins: CropMargins): Page["crop"] {
  if (margins.some(value => !Number.isFinite(value) || value < 0) ||
      margins[0] + margins[2] >= 100 || margins[1] + margins[3] >= 100)
    throw new Error("Invalid crop bounds");
  let [left, top, right, bottom] = margins.map(value => value / 100);
  if (page.rotation === 90) [left, top, right, bottom] = [top, right, bottom, left];
  else if (page.rotation === 180) [left, top, right, bottom] = [right, bottom, left, top];
  else if (page.rotation === 270) [left, top, right, bottom] = [bottom, left, top, right];
  const [x, y, width, height] = page.crop || [0, 0, 1, 1];
  return [x + width * left, y + height * top, width * (1 - left - right), height * (1 - top - bottom)];
}

export function imagePlacement(width: number, height: number, viewport: [number, number], side?: "left" | "right", heightRatio = 1,
  noMargins = false) {
  const [vw, vh] = viewport;
  const margin = side || noMargins ? 0 : PAGE_MARGIN;
  const availableWidth = vw * (1 - 2 * margin), availableHeight = vh * (side ? heightRatio : 1 - 2 * margin);
  const scale = Math.min(availableWidth / width, availableHeight / height);
  const w = width * scale, h = height * scale;
  return { x: side === "left" ? vw - w : side === "right" ? 0 : (vw - w) / 2, y: (vh - h) / 2, width: w, height: h };
}
