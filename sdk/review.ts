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
