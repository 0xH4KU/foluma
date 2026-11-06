import { useEffect, useRef, useState } from "react";
import { t } from "../../../sdk/i18n.ts";
import { PAGE_TOOLS_ID, appearanceData, type PageColor } from "../../../sdk/page-layout.ts";
import { REVIEW_EXTENSION_ID, chapters, reviewData, spreadMarks, type Chapter } from "../../../sdk/review.ts";
import type { Book, Changes, HostAPI, Page } from "../../../sdk/types.ts";
import { reviewIssues } from "./spreads.ts";

export function ReviewTools({ mode, book, current, busy, host, select, save, close }: {
  mode: "review" | "chapters"; book: Book; current?: Page; busy: boolean; host: HostAPI;
  select: (id: string) => void; save: (changes: Changes) => Promise<boolean>; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<Chapter | null>(null);
  useEffect(() => {
    const previous = (dialog.current!.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
    dialog.current!.querySelector<HTMLElement>(mode === "chapters" ? "input" : "button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const entries = chapters(book), issues = reviewIssues(book);
  const positions = new Map(book.pages.map((page, index) => [page.id, index + 1]));
  const label = (id: string) => positions.has(id) ? t("Page {0}", positions.get(id)) : t("Missing page");
  const saveChapters = (next: Chapter[]) => save({ extension: {
    id: REVIEW_EXTENSION_ID, data: { ...reviewData(book), chapters: next },
  } });
  const confirmColor = (id: string, color: PageColor) => {
    const appearance = appearanceData(book);
    void save({ extension: { id: PAGE_TOOLS_ID, data: {
      ...appearance, colors: { ...appearance.colors, [id]: color }, color_checks: appearance.color_checks.filter(pageId => pageId !== id),
    } } });
  };
  return <dialog open ref={dialog} className="review-tools" aria-labelledby="review-tools-title"
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }}>
    <header><strong id="review-tools-title">{mode === "review" ? t("Review checklist") : t("Chapters and bookmarks")}</strong>
      <button onClick={close}>{t("Close")}</button></header>
    {mode === "review" ? <>
      <p>{t("{0} issues · Spread checks use the exported EPUB pairing.", issues.length)}</p>
      {!issues.length && <p className="tool-empty">{t("No pending review issues.")}</p>}
      <ul className="tool-list">{issues.map((issue, index) => <li key={`${issue.kind}-${index}`}>
        <div className="tool-page-links">{issue.ids.map(id => <button key={id} disabled={!positions.has(id)} onClick={() => select(id)}>{label(id)}</button>)}</div>
        <p>{issue.message}</p>
        {issue.kind === "attention" && <button disabled={busy} onClick={() => void save({ extension: {
          id: REVIEW_EXTENSION_ID, data: { ...reviewData(book), review: reviewData(book).review.filter(id => !issue.ids.includes(id)) },
        } })}>{t("Clear review marks")}</button>}
        {issue.kind === "spread" && <button disabled={busy} onClick={() => void save({ extension: {
          id: REVIEW_EXTENSION_ID, data: { ...reviewData(book), spreads: spreadMarks(book).filter(pair => !pair.every(id => issue.ids.includes(id))) },
        } })}>{t("Remove spread mark")}</button>}
        {issue.kind === "color" && <div className="tool-page-links">
          <button disabled={busy} onClick={() => confirmColor(issue.ids[0], "white")}>{t("White")}</button>
          <button disabled={busy} onClick={() => confirmColor(issue.ids[0], "black")}>{t("Black")}</button>
        </div>}
      </li>)}</ul>
    </> : <>
      <p>{t("Chapters follow their pages and export as EPUB navigation and PDF bookmarks.")}</p>
      <form className="chapter-form" onSubmit={event => {
        event.preventDefault();
        if (busy || !title.trim() || !current) return;
        const page_id = editing?.page_id || current.id;
        if (!positions.has(page_id) || editing && !entries.some(entry => entry.page_id === editing.page_id && entry.title === editing.title)) {
          host.report(new Error(t("Document changed. Please retry with the latest revision.")));
          return;
        }
        const next = entries.filter(entry => !editing || entry.page_id !== editing.page_id || entry.title !== editing.title);
        void saveChapters([...next, { page_id, title: title.trim() }]).then(saved => {
          if (saved) { setTitle(""); setEditing(null); }
        });
      }}>
        <label>{editing ? t("Rename chapter at {0}", label(editing.page_id)) : t("Add chapter at {0}", current ? label(current.id) : t("No pages"))}
          <input aria-label={t("Chapter title")} required maxLength={4096} value={title} disabled={busy || !current} onChange={event => setTitle(event.target.value)} />
        </label>
        <div className="tool-page-links"><button disabled={busy || !current || !title.trim()}>{editing ? t("Save") : t("Add chapter")}</button>
          {editing && <button type="button" onClick={() => { setEditing(null); setTitle(""); }}>{t("Cancel")}</button>}</div>
      </form>
      {!entries.length && <p className="tool-empty">{t("No chapters yet. Select a page and add its chapter title.")}</p>}
      <ol className="tool-list">{entries.map((entry, index) => <li key={`${entry.page_id}-${index}`}>
        <button className="chapter-link" onClick={() => select(entry.page_id)}>{label(entry.page_id)} · {entry.title}</button>
        <div className="tool-page-links">
          <button disabled={busy} onClick={() => { select(entry.page_id); setEditing(entry); setTitle(entry.title); dialog.current?.querySelector("input")?.focus(); }}>{t("Rename")}</button>
          <button disabled={busy} onClick={() => void saveChapters(entries.filter((_, position) => position !== index)).then(saved => {
            if (saved && editing?.page_id === entry.page_id && editing.title === entry.title) { setEditing(null); setTitle(""); }
          })}>{t("Remove chapter")}</button>
        </div>
      </li>)}</ol>
    </>}
  </dialog>;
}
