import { useEffect, useRef } from "react";
import type { Book, HostAPI, Page } from "../../../sdk/types";
import { t } from "../../../sdk/i18n";
import { spreadGroups } from "./pages";
import { spreadRecommendations, type SpreadMark } from "./spreads";
import { PageImage } from "./thumbnails";

export function SpreadSuggestions({ book, host, gap, busy, select, unmark, close }: {
  book: Book;
  host: HostAPI;
  gap: boolean;
  busy: boolean;
  select: (id: string) => void;
  unmark: (ids: SpreadMark) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const previous = (node.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
    node.show();
    return () => {
      node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const { spreads, suggestions } = spreadRecommendations(book, gap);
  const groups = spreadGroups(book, gap);
  const pairs = new Map(groups.flatMap((group) => group.flatMap((page) => page ? [[page.id, group] as const] : [])));
  const positions = new Map(book.pages.map((page, index) => [page.id, index + 1]));
  const pages = new Map(book.pages.map((page) => [page.id, page]));
  const label = (id: string) => {
    const page = pages.get(id);
    if (!page) return t("Missing page");
    return page.source_page
      ? t("Page {0} · Source page {1}", positions.get(id), page.source_page)
      : t("Page {0}", positions.get(id));
  };
  const preview = (page: Page | null, ids: SpreadMark, slot: number) => page ? (
    <button key={page.id} className={`spread-suggestion-page ${ids.includes(page.id) ? "marked" : ""}`}
      aria-label={label(page.id)} onClick={() => select(page.id)}>
      <span><PageImage book={book} page={page} host={host} size={640} /></span>
      <small>{positions.get(page.id)}{page.source_page ? ` · ${t("Source page {0}", page.source_page)}` : ""}</small>
    </button>
  ) : <div key={`gap-${slot}`} className="spread-suggestion-gap">{t("Preview only")}</div>;
  return (
    <dialog className="spread-suggestions" ref={dialog} aria-labelledby="spread-suggestions-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <header><strong id="spread-suggestions-title">{t("Blank suggestions")}</strong><button onClick={close}>{t("Close")}</button></header>
      <p>{t("Current pairing · Updates as you edit")}</p>
      <p>{book.metadata.direction === "rtl" ? t("Right to left") : t("Left to right")}
        {` · ${book.metadata.cover_only ? t("Bookshelf only") : t("Bookshelf and book body")}`}
        {` · ${gap ? t("Preview leading blank") : t("No leading preview blank")}`}</p>
      {!spreads.length ? <p className="spread-suggestion-summary">{t("Select a page, then Option-click an adjacent image page to mark a spread. You can also use the context menu.")}</p> : <>
        <section className="spread-suggestion-summary">
          <strong aria-live="polite">{spreads.some((spread) => spread.problem)
            ? t("Resolve the marked-page issues before calculating blank suggestions.")
            : suggestions.length ? t("Add {0} blank pages to align the marked spreads.", suggestions.length)
              : t("All marked spreads are aligned. No blanks needed.")}</strong>
          {suggestions.map(({ from, to }) => <div key={to}>
            <span>{from === to ? t("Insert before {0}", label(to)) : t("Insert anywhere from before {0} through before {1}", label(from), label(to))}</span>
            <button onClick={() => select(to)}>{t("Reference position: before {0}", label(to))}</button>
          </div>)}
        </section>
        {spreads.map(({ ids, problem, aligned }) => <section className="spread-suggestion" key={JSON.stringify(ids)}>
          <header><span>{ids.map(label).join(" ↔ ")}</span><button disabled={busy} onClick={() => unmark(ids)}>{t("Remove spread mark")}</button></header>
          <p>{problem || (aligned ? t("Aligned") : t("Pairing is offset"))}</p>
          <div className="spread-suggestion-previews">{[...new Set(ids.flatMap((id) => pairs.has(id) ? [pairs.get(id)!] : []))]
            .map((group) => <div className="spread-suggestion-pair" key={group.map((page) => page?.id || "gap").join("|")}>{group.map((page, slot) => preview(page, ids, slot))}</div>)}</div>
        </section>)}
      </>}
    </dialog>
  );
}
