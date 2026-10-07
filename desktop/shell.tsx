import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Book, HostAPI, PluginList, Series, SeriesItem, Task } from "../sdk/types";
import { t } from "../sdk/i18n";
import { Icon } from "../sdk/icons";

type RunAction = (action: () => Promise<unknown>, commit?: boolean) => Promise<void>;

export function Toolbar({
  documentWindow = false,
  ready,
  busy,
  book,
  hasProject,
  hasImporters,
  hasExporters,
  exportingSeries,
  selectedBooks,
  canExport,
  onImport,
  onNewProject,
  onOpenProject,
  onCloseProject,
  onSaveProject,
  onExport,
}: {
  documentWindow?: boolean;
  ready: boolean;
  busy: boolean;
  book: Book | null;
  hasProject: boolean;
  hasImporters: boolean;
  hasExporters: boolean;
  exportingSeries: boolean;
  selectedBooks: number;
  canExport: boolean;
  onImport: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onCloseProject: () => void;
  onSaveProject: () => void;
  onExport: () => void;
}) {
  return (
    <header className="command-bar" aria-label={t("Main toolbar")}>
      {!documentWindow && <>
      <button
        className="command"
        title={t("Import book (⌘O)")}
        disabled={!ready || busy}
        onClick={onImport}
      >
        <Icon name="book" />
        <span>{t(hasImporters ? "Import book" : "Install import plugin")}</span>
      </button>
      <button className="command" disabled={!ready || busy} onClick={onNewProject}>
        <Icon name="folder" />
        <span>{t("New project")}</span>
      </button>
      <button
        className="command"
        title={t("Open project (⇧⌘O)")}
        disabled={!ready || busy}
        onClick={onOpenProject}
      >
        <Icon name="folder" />
        <span>{t("Open project")}</span>
      </button>
      {hasProject && (
        <button className="command" disabled={!ready || busy} onClick={onCloseProject}>
          <Icon name="folder" />
          <span>{t("Close project")}</span>
        </button>
      )}
      </>}
      <button
        className="command"
        title={t("Save current book project (⌘S)")}
        disabled={!book || busy}
        onClick={onSaveProject}
      >
        <Icon name="save" />
        <span>{t("Save book project")}</span>
      </button>
      <span className="toolbar-divider" />
      <button
        className="command primary"
        title={
          exportingSeries
            ? t("Export selected books (⌘E)")
            : t("Export current book: {0} (⌘E)", book?.metadata.title || "")
        }
        disabled={busy || (!!hasExporters && (exportingSeries ? !canExport : !book))}
        onClick={onExport}
      >
        <Icon name="export" />
        <span>
          {!hasExporters
            ? t("Install export plugin")
            : exportingSeries
              ? t("Export {0} selected books", selectedBooks)
              : t("Export current book")}
        </span>
      </button>
      <div className="toolbar-caption">
        <strong>Foluma</strong>
        <span>{t("Book conversion and editing")}</span>
      </div>
    </header>
  );
}

export function DocumentBar({
  series,
  book,
  volume,
  nextVolume,
  busy,
  savingInformation,
  hasMetadataDraft,
  output,
  sourceFormats,
  host,
  run,
  navigate,
  openVolume,
  showReview,
}: {
  series: Series | null;
  book: Book | null;
  volume: SeriesItem | undefined;
  nextVolume: SeriesItem | null | undefined;
  busy: boolean;
  savingInformation: number;
  hasMetadataDraft: boolean;
  output: string;
  sourceFormats: string;
  host: HostAPI;
  run: RunAction;
  navigate: (tab: string) => Promise<void>;
  openVolume: (item: SeriesItem) => void;
  showReview: boolean;
}) {
  return (
    <div className="document-bar">
      {series && (
        <>
          <button
            className="breadcrumb"
            title={series.directory}
            onClick={() => void navigate("series")}
          >
            {series.name}
          </button>
          <span aria-hidden="true">›</span>
        </>
      )}
      <Icon name="book" />
      <strong title={book?.project_path || book?.metadata.title}>
        {book?.metadata.title || t("No book open")}
      </strong>
      <span>
        {savingInformation
          ? t("Saving book information…")
          : hasMetadataDraft
            ? t("Book information · not saved yet")
            : book?.dirty
              ? t("Modified · unsaved")
              : volume
                ? t("Changes saved")
                : book?.project_path
                  ? t("Book project saved")
                  : book
                    ? t("Standalone book")
                    : ""}
      </span>
      {book && series && !volume && (
        <span className="outside-project">{t("Not added to this project")}</span>
      )}
      {volume && showReview && (
        <>
          <label className="review-volume">
            <input
              type="checkbox"
              checked={volume.reviewed}
              disabled={busy}
              onChange={(event) => {
                const reviewed = event.target.checked;
                void run(async () => {
                  const marks = volume.review_count || 0;
                  if (
                    reviewed &&
                    marks &&
                    !(await host.confirm(
                      t("{0} pages still need attention. Mark this book reviewed anyway?", marks),
                      t("Complete book review"),
                      t("Mark book reviewed"),
                    ))
                  )
                    return;
                  await host.rpc("series.review", {
                    id: volume.id,
                    reviewed,
                    allow_pending: reviewed && marks > 0,
                  });
                });
              }}
            />
            {t("Book reviewed")}
          </label>
          {!!volume.review_count && (
            <span>{t("{0} pages need attention", volume.review_count)}</span>
          )}
          <button
            disabled={busy || !nextVolume}
            onClick={() => nextVolume && openVolume(nextVolume)}
          >
            {t("Next unreviewed")}
          </button>
        </>
      )}
      {output && (
        <button onClick={() => void revealItemInDir(output).catch(host.report)}>
          {t("Show exported file")}
        </button>
      )}
      <span className="document-format">{sourceFormats || t("Book workspace")}</span>
    </div>
  );
}

export function Sidebar({
  series,
  book,
  plugins,
  tab,
  sourceFormats,
  navigate,
}: {
  series: Series | null;
  book: Book | null;
  plugins: PluginList;
  tab: string;
  sourceFormats: string;
  navigate: (tab: string) => Promise<void>;
}) {
  return (
    <aside className="sidebar">
      <nav aria-label={t("Main navigation")}>
        <div className="tree-heading">{t("▾ Workspace")}</div>
        {series && (
          <button
            className={tab === "series" ? "selected" : ""}
            onClick={() => void navigate("series")}
          >
            <Icon name="folder" />
            {t("Project")}
            <span className="nav-count">{series.items.length}</span>
          </button>
        )}
        <button
          className={tab === "convert" ? "selected" : ""}
          aria-current={tab === "convert" ? "page" : undefined}
          onClick={() => void navigate("convert")}
        >
          <Icon name="book" />
          {t("Book information")}
        </button>
        {plugins.active
          .filter((p) => p.ui)
          .map((p) => (
            <button
              key={p.id}
              className={tab === p.id ? "selected" : ""}
              onClick={() => void navigate(p.id)}
            >
              <Icon name="edit" />
              {t(p.ui!.title)}
            </button>
          ))}
        <div className="tree-heading">{t("▾ Tools")}</div>
        <button
          className={tab === "plugins" ? "selected" : ""}
          onClick={() => void navigate("plugins")}
        >
          <Icon name="plugin" />
          {t("Plugins")}
          <span className="nav-count">{plugins.items.length}</span>
        </button>
        <button
          className={tab === "settings" ? "selected" : ""}
          onClick={() => void navigate("settings")}
        >
          <Icon name="settings" />
          {t("Preferences")}
        </button>
      </nav>
      <div className="document-summary">
        <div className="tree-heading">{t("▾ Document summary")}</div>
        <dl>
          <dt>{t("Source")}</dt>
          <dd>{book ? sourceFormats || t("Images") : "—"}</dd>
          <dt>{t("Pages")}</dt>
          <dd>{book?.pages.length || "—"}</dd>
          <dt>{t("Direction")}</dt>
          <dd>
            {book
              ? book.metadata.direction === "rtl"
                ? t("Right to left")
                : t("Left to right")
              : "—"}
          </dd>
          <dt>{t("Book language")}</dt>
          <dd>{book?.metadata.language || "—"}</dd>
        </dl>
      </div>
      <div className="sidebar-foot">
        <span>Foluma 0.1.0</span>
        <span>{t("Loaded plugins: {0}", plugins.active.length)}</span>
      </div>
    </aside>
  );
}

export function StatusBar({
  ready,
  safeMode,
  jobs,
  prepared,
  cancel,
  exportingSeries,
  selectedBooks,
  book,
  busy,
}: {
  ready: boolean;
  safeMode: boolean;
  jobs: Task[];
  prepared: Set<string>;
  cancel: (id: string) => void;
  exportingSeries: boolean;
  selectedBooks: number;
  book: Book | null;
  busy: boolean;
}) {
  const active = jobs.filter(job => job.state === "running" || job.state === "queued");
  const parsing = [...new Map(jobs.filter(job => job.preparse).map(job => [job.entry_id, job])).values()];
  const exports = active.filter(job => job.operation === "export" || job.operation === "images.export");
  const renderRequired = (job: Task) => (job.error?.data as {kind?: string})?.kind === "render_required" && !prepared.has(job.entry_id || "");
  const summaries = [];
  if (parsing.length) {
    summaries.push(t("Preparse {0}/{1} · {2} running", parsing.filter(job => job.state === "completed" || prepared.has(job.entry_id || "")).length,
      parsing.length, parsing.filter(job => job.state === "running").length));
    const waiting = parsing.filter(renderRequired).length;
    if (waiting) summaries.push(t("{0} need rendering confirmation", waiting));
  }
  if (exports.length) summaries.push(t("Export · {0} running · {1} queued",
    exports.filter(job => job.state === "running").length, exports.filter(job => job.state === "queued").length));
  if (!summaries.length && active.length) summaries.push(active.find(job => job.state === "running")?.progress.message || t("Queued"));
  const recent = [...active, ...jobs.filter(job => !active.includes(job)).slice(-20).reverse()];
  return (
    <footer className="statusbar">
      <span className={`status-dot ${ready ? "online" : ""}`} />
      <details className="task-status">
      <summary role="status" aria-label={t("Background tasks")}>
        {safeMode
          ? t("Safe mode")
          : !ready
            ? t("Starting engine")
            : summaries.length
              ? summaries.join(" · ")
              : t("Ready")}
      </summary>
      <div className="task-list">
        <strong>{t("Background tasks")}</strong>
        {!recent.length && <p>{t("No background tasks")}</p>}
        {recent.map(job => <article key={job.id}>
          <div><strong>{job.title || job.operation}</strong><span>{renderRequired(job) ? t("Waiting for rendering confirmation") :
            job.state === "running" ? job.progress.message : t({queued: "Queued", completed: "Completed", cancelled: "Cancelled", failed: "Failed"}[job.state])}</span></div>
          {job.state === "running" && <progress aria-label={job.title || job.operation} value={job.progress.done} max={job.progress.total || 1}/>}
          {(job.state === "queued" || job.state === "running") && <button onClick={() => cancel(job.id)}>{t("Cancel")}</button>}
          {job.state === "failed" && !renderRequired(job) && <p>{job.error?.message}</p>}
        </article>)}
      </div>
      </details>
      <span className="status-right">
        {exportingSeries
          ? t("{0} selected", selectedBooks)
          : book
            ? t(
                "{0} pages · {1}",
                book.pages.length,
                book.metadata.direction === "rtl" ? t("RTL") : t("LTR"),
              )
            : t("Book workspace")}
        <span>
          {t("Tasks: ")}
          {active.length || (busy ? 1 : 0)}
        </span>
        <span>{t("Processed locally")}</span>
      </span>
    </footer>
  );
}
