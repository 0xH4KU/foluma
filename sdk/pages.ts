import type { Book, Page } from "./types.ts";

export function pageSize(page: Page): [number, number] {
  const width = page.width * (page.crop?.[2] || 1), height = page.height * (page.crop?.[3] || 1);
  return (page.rotation || 0) % 180 ? [height, width] : [width, height];
}

export function readingPages(book: Book): Page[] {
  return book.pages.filter((page) => !book.metadata.cover_only || page.id !== book.metadata.cover_id);
}

export function spreadGroups(book: Book, gap: boolean): (Page | null)[][] {
  const reading = readingPages(book);
  const display: (Page | null)[] = gap && reading.length ? [null, ...reading] : reading;
  const groups: (Page | null)[][] = [];
  const cover = book.pages.find((page) => page.id === book.metadata.cover_id);
  if (book.metadata.cover_only && cover) groups.push([cover]);
  for (let index = 0; index < display.length; index += 2) {
    const pair = [display[index] || null, display[index + 1] || null];
    groups.push(book.metadata.direction === "rtl" ? pair.reverse() : pair);
  }
  return groups;
}

export function spreadPages(book: Book, selectedId: string | null, gap: boolean): (Page | null)[] {
  const groups = spreadGroups(book, gap);
  return groups.find((pair) => pair.some((page) => page?.id === selectedId)) || groups[0] || [];
}
