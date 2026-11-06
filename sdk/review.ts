import type { Book, ReviewData } from "./types.ts";

// Shared document contract; retain the original storage key for API 1 plugins.
export const REVIEW_EXTENSION_ID = "org.foluma.editor";

export function reviewData(book: Book): ReviewData {
  const value = book.extensions[REVIEW_EXTENSION_ID];
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const pages = new Set(book.pages.map((page) => page.id));
  const review = Array.isArray(data.review)
    ? data.review.filter((id): id is string => typeof id === "string" && pages.has(id)) : [];
  return { ...data, review: [...new Set(review)] };
}

export type SpreadMark = [string, string];

export type Chapter = { page_id: string; title: string };

export function chapters(book: Book): Chapter[] {
  const value = reviewData(book).chapters;
  if (!Array.isArray(value)) return [];
  const positions = new Map(book.pages.map((page, index) => [page.id, index]));
  const seen = new Set<string>();
  return value.filter((entry): entry is Chapter => {
    if (!entry || typeof entry !== "object" || !positions.has(entry.page_id) ||
        typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 4096) return false;
    const key = JSON.stringify([entry.page_id, entry.title]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ page_id, title }) => ({ page_id, title }))
    .sort((a, b) => positions.get(a.page_id)! - positions.get(b.page_id)!);
}

export function spreadMarks(book: Book): SpreadMark[] {
  const value = reviewData(book).spreads;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((pair): pair is SpreadMark => {
    if (!Array.isArray(pair) || pair.length !== 2 ||
        !pair.every((id) => typeof id === "string" && id.length > 0) || pair[0] === pair[1]) return false;
    const key = JSON.stringify([...pair].sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
