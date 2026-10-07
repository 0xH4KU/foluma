import { t } from "../../../sdk/i18n.ts";
import { REVIEW_EXTENSION_ID, reviewData } from "../../../sdk/review.ts";
import type { Book, Changes } from "../../../sdk/types.ts";
import { readingPages } from "./pages.ts";

export type SpreadMark = [string, string];

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

export function setSpreadMarks(book: Book, spreads: SpreadMark[]): Changes {
  return { extension: { id: REVIEW_EXTENSION_ID, data: { ...reviewData(book), spreads } } };
}

export function toggleSpreadMark(book: Book, ids: Set<string>): Changes {
  const marks = spreadMarks(book);
  const existing = marks.find((pair) => ids.size === 2 && pair.every((id) => ids.has(id)));
  if (existing) return setSpreadMarks(book, marks.filter((pair) => pair !== existing));
  const reading = readingPages(book);
  const chosen = reading.filter((page) => ids.has(page.id));
  if (ids.size !== 2 || chosen.length !== 2 || chosen.some((page) => page.kind !== "image") ||
      reading.indexOf(chosen[1]) !== reading.indexOf(chosen[0]) + 1)
    throw new Error(t("Choose two adjacent image pages in the reading order."));
  if (marks.some((pair) => pair.some((id) => ids.has(id))))
    throw new Error(t("A selected page already belongs to another marked spread. Remove that mark first."));
  return setSpreadMarks(book, [...marks, [chosen[0].id, chosen[1].id]]);
}

export function spreadRecommendations(book: Book, gap: boolean) {
  const reading = readingPages(book);
  const positions = new Map(reading.map((page, index) => [page.id, index]));
  const pages = new Map(book.pages.map((page) => [page.id, page]));
  const marks = spreadMarks(book);
  const uses = new Map<string, number>();
  for (const pair of marks) for (const id of pair) uses.set(id, (uses.get(id) || 0) + 1);
  const spreads = marks.map((ids) => {
    const indexes = ids.map((id) => positions.get(id) ?? -1);
    const start = Math.min(...indexes), end = Math.max(...indexes);
    let problem = "";
    if (ids.some((id) => !pages.has(id))) problem = t("A marked page was removed or split. Update or remove this mark.");
    else if (ids.some((id) => pages.get(id)!.kind !== "image")) problem = t("A spread must contain two image pages.");
    else if (start < 0) problem = t("A marked page is a bookshelf-only cover.");
    else if (ids.some((id) => uses.get(id)! > 1)) problem = t("A page belongs to more than one marked spread.");
    else if (end !== start + 1) problem = t("These pages are no longer adjacent. Move them together or remove the mark.");
    return { ids, start, end, problem, aligned: !problem && (start + Number(gap)) % 2 === 0 };
  }).sort((a, b) => a.start - b.start);
  const suggestions: { from: string; to: string }[] = [];
  if (spreads.some((spread) => spread.problem)) return { spreads, suggestions };
  let offset = Number(gap), boundary = 0;
  for (const spread of spreads) {
    if ((spread.start + offset) % 2 !== 0) {
      suggestions.push({ from: reading[boundary].id, to: reading[spread.start].id });
      offset++;
    }
    boundary = spread.end + 1;
  }
  return { spreads, suggestions };
}
