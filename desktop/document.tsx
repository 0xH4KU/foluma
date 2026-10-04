import { useEffect, useRef, useState } from "react";
import type { Book, HostAPI, Metadata, Page, RenderResolution } from "../sdk/types";
import { t } from "../sdk/i18n";
import { Icon } from "../sdk/icons";
import type { MetadataEditor } from "./document-actions";

function Preview({ book, page, host }: { book: Book; page: Page | undefined; host: HostAPI }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setUrl("");
    if (page)
      host
        .preview(book, page, 1024, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setUrl(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) host.report(error);
        });
    return () => controller.abort();
  }, [book.id, page, host]);
  return (
    <div className="cover-stage">
      {url ? (
        <img src={url} alt={t("Selected page preview")} />
      ) : (
        <span>{page ? t("Loading preview…") : t("No pages")}</span>
      )}
    </div>
  );
}

function MetadataForm({
  book,
  host,
  disabled,
  information,
}: {
  book: Book;
  host: HostAPI;
  disabled: boolean;
  information: MetadataEditor;
}) {
  const meta = { ...book.metadata, ...information.draft };
  const commit = (patch: Partial<Metadata>) => {
    information.change(patch);
    void information.commit().catch(host.report);
  };
  return (
    <fieldset
      className="metadata"
      disabled={disabled}
      onBlur={() => void information.commit().catch(host.report)}
    >
      <label>
        {t("Title")}
        <input
          required
          value={meta.title}
          aria-invalid={!meta.title.trim()}
          onChange={(e) => information.change({ title: e.target.value })}
        />
      </label>
      <label>
        {t("Author")}
        <input
          placeholder={t("Optional")}
          value={meta.author}
          onChange={(e) => information.change({ author: e.target.value })}
        />
      </label>
      <div className="form-pair">
        <label>
          {t("Book language")}
          <input
            required
            list="book-languages"
            value={meta.language}
            onChange={(e) => information.change({ language: e.target.value })}
          />
          <datalist id="book-languages">
            <option value="zh-Hant">繁體中文</option>
            <option value="zh-Hans">简体中文</option>
            <option value="ja">日本語</option>
            <option value="en">English</option>
            <option value="ko">한국어</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
          </datalist>
        </label>
        <label>
          {t("Reading direction")}
          <select
            value={meta.direction}
            onChange={(e) => commit({ direction: e.target.value as "rtl" | "ltr" })}
          >
            <option value="rtl">{t("Right to left")}</option>
            <option value="ltr">{t("Left to right")}</option>
          </select>
        </label>
      </div>
      <p>{t("Used in book metadata. You can enter a custom language code.")}</p>
      <label>
        {t("Cover placement")}
        <select
          value={meta.cover_only ? "shelf" : "both"}
          onChange={(e) => commit({ cover_only: e.target.value === "shelf" })}
        >
          <option value="both">{t("Bookshelf and book body")}</option>
          <option value="shelf">{t("Bookshelf only")}</option>
        </select>
      </label>
    </fieldset>
  );
}

export function DocumentView({
  book,
  host,
  disabled,
  dpi,
  relink,
  hidden,
  information,
  previewGeneration,
}: {
  book: Book;
  host: HostAPI;
  disabled: boolean;
  dpi: RenderResolution;
  relink: (id: string) => void;
  hidden: boolean;
  information: MetadataEditor;
  previewGeneration: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const list = useRef<HTMLDivElement>(null);
  const page = book.pages.find((p) => p.id === selected) || book.pages[0];
  useEffect(() => {
    const node = list.current!;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight) setViewport((v) => ({ ...v, height: node.clientHeight }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setSelected(null);
    if (list.current) list.current.scrollTop = 0;
  }, [book.id]);
  const first = Math.max(0, Math.floor(viewport.top / 29) - 4);
  const last = Math.min(book.pages.length, Math.ceil((viewport.top + viewport.height) / 29) + 4);
  return (
    <section className="document-workspace" hidden={hidden}>
      <div className="document-list">
        <div className="panel-heading">
          <strong>{t("Pages")}</strong>
          <span>
            {book.pages.length} {t(" pages")}
          </span>
        </div>
        <div
          className="page-table-scroll"
          ref={list}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setViewport((v) => ({ ...v, top }));
          }}
        >
          <table className="page-table" aria-label={t("Document pages")}>
            <colgroup>
              <col className="col-number" />
              <col />
              <col className="col-size" />
              <col className="col-format" />
              <col className="col-status" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("Page")}</th>
                <th>{t("Source")}</th>
                <th>{t("Image size")}</th>
                <th>{t("Format")}</th>
                <th>{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {first > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={5} style={{ height: first * 29, padding: 0 }} />
                </tr>
              )}
              {book.pages.slice(first, last).map((item, offset) => {
                const asset = book.assets[item.asset_id || ""];
                const sourceId = asset?.source_id || asset?.derived_from?.source_id;
                const source = sourceId ? book.sources[sourceId]?.path : asset?.path;
                return (
                  <tr
                    key={item.id}
                    tabIndex={0}
                    aria-selected={item.id === page?.id}
                    onClick={() => setSelected(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(item.id);
                      }
                    }}
                  >
                    <td>{first + offset + 1}</td>
                    <td title={source}>
                      {item.kind === "blank"
                        ? t("Blank page")
                        : `${source?.split(/[\\/]/).pop() || t("Image")}${item.source_page ? ` · ${item.source_page}` : ""}`}
                    </td>
                    <td>
                      {item.width} × {item.height}
                    </td>
                    <td>{asset?.ext.toUpperCase() || "—"}</td>
                    <td>
                      {item.id === book.metadata.cover_id
                        ? t("Cover")
                        : item.split
                          ? item.split.side === "left"
                            ? t("Split · left")
                            : t("Split · right")
                          : asset?.derived_from
                            ? t("Rendered")
                            : item.kind === "blank"
                              ? t("Blank")
                              : t("Original")}
                    </td>
                  </tr>
                );
              })}
              {last < book.pages.length && (
                <tr aria-hidden="true">
                  <td colSpan={5} style={{ height: (book.pages.length - last) * 29, padding: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="panel-heading source-heading">
          <strong>{t("Source files")}</strong>
          <span>
            {Object.keys(book.sources).length} {t(" files")}
          </span>
        </div>
        <div className="source-list">
          {Object.entries(book.sources).map(([id, source]) => (
            <div key={id}>
              <Icon name="book" />
              <span title={source.path}>
                {source.path.split(/[\\/]/).pop()}
                <small>
                  {source.page_count} {t(" pages ·")}
                  {source.path}
                </small>
              </span>
              <button disabled={disabled} onClick={() => relink(id)}>
                {t("Relink…")}
              </button>
            </div>
          ))}
        </div>
        <div className="list-footer">
          {t("Selected page {0}", page ? book.pages.indexOf(page) + 1 : 0)}
          <span>
            {(host.getFormats?.() || [])
              .filter((plugin) => plugin.format?.direction === "export")
              .map((plugin) => plugin.format!.name)
              .join(" / ") || t("No export plugins enabled")}
          </span>
        </div>
      </div>
      <aside className="book-inspector">
        <div className="panel-heading">
          <strong>{t("Book information")}</strong>
          <span>{page ? t("Page {0} preview", book.pages.indexOf(page) + 1) : ""}</span>
        </div>
        {!hidden && <Preview key={previewGeneration} book={book} page={page} host={host} />}
        <div className="output-settings">
          <MetadataForm book={book} host={host} disabled={disabled} information={information} />
          <dl className="export-details">
            <div>
              <dt>{t("Output format")}</dt>
              <dd>
                {(host.getFormats?.() || [])
                  .filter((plugin) => plugin.format?.direction === "export")
                  .map((plugin) => plugin.format!.name)
                  .join(" / ") || t("No export plugins enabled")}
              </dd>
            </div>
            <div>
              <dt>{t("Image handling")}</dt>
              <dd>{t("Preserve originals")}</dd>
            </div>
            <div>
              <dt>{t("Complex pages")}</dt>
              <dd>{dpi === "auto" ? t("Auto · ask first") : `${dpi} ${t("DPI · ask first")}`}</dd>
            </div>
          </dl>
        </div>
      </aside>
    </section>
  );
}
