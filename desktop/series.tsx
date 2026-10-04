import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { HostAPI, Metadata, RenderResolution, Series, SeriesItem } from "../sdk/types";
import { t } from "../sdk/i18n";
import { batchSummary, runBatch, type BatchRow } from "../sdk/batch";
import { moveBefore } from "../sdk/order";
import { formatBytes } from "./storage";

export function ProjectCreator({
  host,
  initialName,
  migrate,
  create,
  close,
}: {
  host: HostAPI;
  initialName: string;
  migrate: boolean;
  create: (parent: string, name: string) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [parent, setParent] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="project-dialog-title"
      className="project-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <h1 id="project-dialog-title">
        {t(migrate ? "Save series as folder project" : "New project")}
      </h1>
      <p>{t("A new folder will hold your source copies, groups and saved edits.")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (working) return;
          setWorking(true);
          setError("");
          void create(parent, name.trim())
            .then(close)
            .catch((reason) => setError(String(reason)))
            .finally(() => setWorking(false));
        }}
      >
        <fieldset disabled={working}>
          <label>
            {t("Project name")}
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("Location")}
            <input readOnly value={parent} placeholder={t("Choose a location…")} />
          </label>
          <button
            type="button"
            onClick={() =>
              void host
                .pickFile({ directory: true, title: t("Choose a location for the new project") })
                .then((value) => {
                  if (typeof value === "string") setParent(value);
                })
                .catch(host.report)
            }
          >
            {t("Choose location…")}
          </button>
          {parent && (
            <p className="project-location">
              {parent}/{name.trim()}
            </p>
          )}
          {error && (
            <p role="alert" className="series-error">
              {error}
            </p>
          )}
          <div className="project-dialog-actions">
            <button type="button" onClick={close}>
              {t("Cancel")}
            </button>
            <button className="primary" disabled={!parent || !name.trim()}>
              {working ? t("Creating project…") : t("Create project")}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

function GroupDialog({
  initialName,
  count,
  rename,
  create,
  close,
}: {
  initialName: string;
  count: number;
  rename: boolean;
  create: (name: string, move: boolean) => Promise<unknown>;
  close: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [move, setMove] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="group-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <h1 id="group-title">{t(rename ? "Rename group" : "New group")}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (working) return;
          setWorking(true);
          setError("");
          void create(name.trim(), move)
            .then((result) => {
              if (result !== false) close();
            })
            .catch((reason) => setError(String(reason)))
            .finally(() => setWorking(false));
        }}
      >
        <fieldset disabled={working}>
          <label>
            {t("Group name")}
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!rename && count > 0 && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={move}
                onChange={(event) => setMove(event.target.checked)}
              />
              {t("Move the {0} selected books into this group", count)}
            </label>
          )}
          {error && (
            <p role="alert" className="series-error">
              {error}
            </p>
          )}
          <div className="project-dialog-actions">
            <button type="button" onClick={close}>
              {t("Cancel")}
            </button>
            <button className="primary" disabled={!name.trim()}>
              {t(rename ? "Rename group" : move ? "Create group and move books" : "Create group")}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

export type SeriesSelection = { count: number; canExport: boolean };

export function SeriesWorkspace({
  series,
  host,
  busy,
  hidden,
  dpi,
  openBook,
  migrate,
  selectionChanged,
  prepare,
  exportCommand,
}: {
  series: Series;
  host: HostAPI;
  busy: boolean;
  hidden: boolean;
  dpi: RenderResolution;
  openBook: (item: SeriesItem) => void;
  migrate: () => void;
  selectionChanged: (selection: SeriesSelection) => void;
  prepare: () => Promise<void>;
  exportCommand: React.Ref<() => void>;
}) {
  const formats = host.getFormats?.() || [];
  const importers = formats.filter((plugin) => plugin.format?.direction === "import");
  const exporters = formats.filter((plugin) => plugin.format?.direction === "export");
  const extensions = [...new Set(importers.flatMap((plugin) => plugin.format!.extensions))];
  const [exporter, setExporter] = useState(() => exporters[0]?.id || "");
  const outputFormat = exporters.find((plugin) => plugin.id === exporter) || exporters[0];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState("all");
  const [groupDialog, setGroupDialog] = useState<{ previous?: string } | null>(null);
  const [destination, setDestination] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState("");
  const [cover, setCover] = useState("");
  const [render, setRender] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [progress, setProgress] = useState<{ title: string; index: number; total: number } | null>(
    null,
  );
  const [rows, setRows] = useState<Record<string, BatchRow>>({});
  const [moving, setMoving] = useState<{ item: SeriesItem; position: number } | null>(null);
  const moveDialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const abort = useRef(new AbortController());
  const removed = group === "removed";
  const activeGroup = group.startsWith("group/") ? group.slice(6) : "";
  const visible = (removed ? series.removed : series.items).filter(
    (item) =>
      (removed || group === "all" || item.group === activeGroup) &&
      (filter === "all" ||
        (filter === "review" ? !item.reviewed || !!item.review_count : !item.exported)) &&
      (item.title + " " + item.path.split(/[\\/]/).pop())
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const chosen = visible.filter((item) => selected.has(item.id));
  const canExport = !removed && chosen.length > 0 && !!series.output_directory && !!outputFormat;
  useEffect(() => {
    selectionChanged({ count: chosen.length, canExport });
  }, [chosen.length, canExport, selectionChanged]);
  useEffect(() => () => abort.current.abort(), []);
  useEffect(() => {
    if (moving) moveDialog.current?.showModal();
  }, [!!moving]);
  useEffect(() => {
    if (activeGroup && !series.groups.includes(activeGroup)) setGroup("all");
    if (destination && !series.groups.includes(destination)) setDestination("");
    const ids = new Set([...series.items, ...series.removed].map((item) => item.id));
    setSelected((old) => new Set([...old].filter((id) => ids.has(id))));
  }, [series]);
  const run = async (action: () => Promise<unknown>, reportError = true) => {
    if (busy || working.current) return false;
    working.current = true;
    host.notify("");
    host.setBusy?.(true);
    try {
      await prepare();
      await action();
      return true;
    } catch (error) {
      if (!reportError) throw error;
      host.report(error);
      return false;
    } finally {
      working.current = false;
      host.setBusy?.(false);
    }
  };
  const chooseGroup = (value: string) => {
    setGroup(value);
    setSelected(new Set());
  };
  const addPaths = (paths: string[]) =>
    run(async () => {
      const result = await host.rpc<Series>("series.add", { paths, group: activeGroup });
      const summary = result.summary;
      host.notify(
        t(
          "{0} books added to {1} · {2} duplicates skipped · {3} subfolders skipped",
          summary?.added || 0,
          activeGroup || t("Ungrouped"),
          summary?.skipped || 0,
          summary?.folders_skipped || 0,
        ),
      );
      if (removed) setGroup("all");
      setFilter("all");
      setSearch("");
    });
  useEffect(() => {
    if (hidden || !series.managed) return;
    return host.onFileDrop?.((paths) => void addPaths(paths));
  }, [hidden, series.managed, group, busy]);
  const add = async (kind: "files" | "folder" | "book") => {
    try {
      const picked = await host.pickFile(
        kind === "files"
          ? { extensions, multiple: true, title: t("Add books to project") }
          : {
              directory: true,
              title: t(
                kind === "book"
                  ? "Choose a .mteproj book folder"
                  : "Import supported books from this folder only",
              ),
            },
      );
      if (picked) await addPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (error) {
      host.report(error);
    }
  };
  const refresh = () =>
    run(async () => {
      const result = await host.rpc<Series>("series.refresh"),
        summary = result.summary;
      host.notify(
        t(
          "Folder refreshed · {0} added · {1} renamed · {2} missing · {3} changed",
          summary?.added || 0,
          summary?.renamed || 0,
          summary?.missing || 0,
          summary?.changed || 0,
        ),
      );
    });
  const restore = (ids: string[]) =>
    run(async () => {
      await host.rpc("series.restore", { ids });
      setGroup("all");
      setFilter("all");
      setSearch("");
      setSelected(new Set(ids));
      host.notify(t("{0} books restored", ids.length));
    });
  const remove = () =>
    run(async () => {
      const ids = chosen.map((item) => item.id);
      await host.rpc("series.remove", { ids });
      setSelected(new Set());
      host.notify(t("{0} books moved to Removed", ids.length), {
        label: t("Undo removal"),
        run: () => void restore(ids),
      });
    });
  const deleteBooks = (ids: string[]) =>
    run(async () => {
      const info = await host.rpc<{ count: number; bytes: number }>("series.delete_info", { ids });
      if (
        !(await host.confirm(
          t(
            "Permanently delete {0} removed books ({1})? Their project source copies and saved edits will be deleted. Import sources and exported files are kept. This cannot be undone.",
            info.count,
            formatBytes(info.bytes),
          ),
          t("Permanently delete books"),
          t("Delete permanently"),
        ))
      )
        return;
      const result = await host.rpc<
        Series & { summary: { deleted: number; cleanup_pending: boolean } }
      >("series.delete", { ids });
      setSelected(new Set());
      host.notify(
        result.summary.cleanup_pending
          ? t(
              "Books deleted. Some files could not be cleaned; Foluma will retry when this project is opened.",
            )
          : t("{0} books permanently deleted", result.summary.deleted),
      );
    });
  const applySettings = () =>
    run(async () => {
      const metadata: Partial<Metadata> = {};
      if (direction) metadata.direction = direction as "rtl" | "ltr";
      if (cover) metadata.cover_only = cover === "shelf";
      const changes = [
        direction && t(direction === "rtl" ? "Right to left" : "Left to right"),
        cover && t(cover === "shelf" ? "Bookshelf only" : "Bookshelf and book body"),
      ]
        .filter(Boolean)
        .join(" · ");
      if (
        !(await host.confirm(
          t(
            "Apply {0} to {1} selected books?\n\n{2}",
            changes,
            chosen.length,
            chosen.map((item) => item.title).join("\n"),
          ),
          t("Apply shared settings"),
          t("Apply settings"),
        ))
      )
        return;
      const results = await host.rpc<{ id: string; error: string | null }[]>("series.configure", {
        ids: chosen.map((item) => item.id),
        metadata,
      });
      const errors = results.filter((result) => result.error);
      if (errors.length)
        host.report(
          new Error(
            errors
              .map(
                (result) =>
                  (series.items.find((item) => item.id === result.id)?.title || result.id) +
                  ": " +
                  result.error,
              )
              .join("\n"),
          ),
        );
      else host.notify(t("Shared settings applied to {0} books", chosen.length));
    });
  const exportBooks = async (items = chosen, allowRendering = render, retrying = false) => {
    if (
      removed ||
      busy ||
      working.current ||
      !items.length ||
      !series.output_directory ||
      !outputFormat
    )
      return;
    const cohort = items.map((item) => ({ id: item.id, path: item.path, title: item.title }));
    working.current = true;
    host.notify("");
    host.setBusy?.(true);
    setFinished(false);
    setRunning(true);
    abort.current = new AbortController();
    setRows((old) => ({
      ...(retrying ? old : {}),
      ...Object.fromEntries(
        cohort.map((item) => [item.id, { path: item.path, state: "pending" as const }]),
      ),
    }));
    try {
      await prepare();
      host.setOutputDirectory?.(series.output_directory);
      await runBatch(
        host,
        {
          paths: cohort.map((item) => item.path),
          entries: cohort,
          directory: series.output_directory,
          render: allowRendering,
          dpi,
          exporter: outputFormat.id,
        },
        abort.current.signal,
        (index, row) => {
          setRows((old) => ({ ...old, [cohort[index].id]: row }));
          if (row.state === "working")
            setProgress({ title: cohort[index].title, index: index + 1, total: cohort.length });
        },
      );
    } catch (error) {
      host.report(error);
    } finally {
      setRunning(false);
      setFinished(true);
      setProgress(null);
      working.current = false;
      host.setBusy?.(false);
    }
  };
  useImperativeHandle(exportCommand, () => () => {
    void exportBooks();
  });
  const reorder = (item: SeriesItem, offset: number) =>
    run(async () => {
      const other = visible[visible.indexOf(item) + offset];
      if (!other) return;
      const ids = series.items.map((entry) => entry.id),
        a = ids.indexOf(item.id),
        b = ids.indexOf(other.id);
      [ids[a], ids[b]] = [ids[b], ids[a]];
      await host.rpc("series.reorder", { ids });
    });
  const moveTo = () =>
    run(async () => {
      if (
        !moving ||
        !Number.isInteger(moving.position) ||
        moving.position < 1 ||
        moving.position > visible.length
      )
        throw new Error(t("Destination position is out of range"));
      const index = visible.findIndex((item) => item.id === moving.item.id),
        target = moving.position - 1;
      if (target !== index) {
        const before = target < index ? visible[target].id : visible[target + 1]?.id || null;
        await host.rpc("series.reorder", {
          ids: moveBefore(series.items, new Set([moving.item.id]), before).map((item) => item.id),
        });
        host.notify(t("Book moved to position {0}", moving.position));
      }
      setMoving(null);
    });
  const retry = series.items.filter((item) => rows[item.id] && rows[item.id].state !== "completed");
  const labels = {
    pending: t("Pending"),
    working: t("Processing"),
    completed: t("Exported"),
    failed: t("Failed"),
    cancelled: t("Cancelled"),
    skipped: t("Skipped"),
  };
  return (
    <section className="series-workspace" hidden={hidden}>
      {groupDialog && (
        <GroupDialog
          initialName={groupDialog.previous || ""}
          count={chosen.length}
          rename={!!groupDialog.previous}
          close={() => setGroupDialog(null)}
          create={(name, move) =>
            run(async () => {
              await host.rpc("series.group", {
                name,
                ...(groupDialog.previous ? { previous: groupDialog.previous } : {}),
                ...(move ? { ids: chosen.map((item) => item.id) } : {}),
              });
              if (groupDialog.previous || move) setGroup("group/" + name);
              if (!groupDialog.previous || destination === groupDialog.previous)
                setDestination(name);
              host.notify(
                move
                  ? t("Group {0} created · {1} books moved", name, chosen.length)
                  : t(groupDialog.previous ? "Group renamed to {0}" : "Group {0} created", name),
              );
            }, false)
          }
        />
      )}
      {moving && (
        <dialog
          ref={moveDialog}
          className="project-dialog"
          aria-labelledby="move-book-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setMoving(null);
          }}
        >
          <h1 id="move-book-title">{t("Move book to position")}</h1>
          <p>{moving.item.title}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void moveTo();
            }}
          >
            <fieldset disabled={busy}>
              <label>
                {t("Position in this list")}
                <input
                  autoFocus
                  type="number"
                  required
                  min={1}
                  max={visible.length}
                  value={moving.position}
                  onChange={(event) =>
                    setMoving({ ...moving, position: Number(event.target.value) })
                  }
                />
              </label>
              <div className="project-dialog-actions">
                <button type="button" onClick={() => setMoving(null)}>
                  {t("Cancel")}
                </button>
                <button className="primary">{t("Move book")}</button>
              </div>
            </fieldset>
          </form>
        </dialog>
      )}
      <div className="series-heading">
        <div>
          <h1>{series.name}</h1>
          <p>
            {t(
              "{0} books · {1} reviewed · {2} exported",
              series.items.length,
              series.items.filter((item) => item.reviewed).length,
              series.items.filter((item) => item.exported).length,
            )}
          </p>
        </div>
        {series.managed ? (
          <div className="project-actions">
            <button disabled={busy} onClick={() => void refresh()}>
              {t("Refresh folder")}
            </button>
            <button onClick={() => void revealItemInDir(series.directory).catch(host.report)}>
              {t("Show project folder")}
            </button>
          </div>
        ) : (
          <button disabled={busy} className="primary" onClick={migrate}>
            {t("Save series as folder project")}
          </button>
        )}
      </div>
      {series.managed ? (
        <div className="project-tools">
          <button
            className="primary"
            disabled={busy || removed || !extensions.length}
            onClick={() => void add("files")}
          >
            {t("Add books…")}
          </button>
          <details
            className="group-menu"
            onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false;
            }}
          >
            <summary>{t("More import options")}</summary>
            <div>
              <button
                disabled={busy || removed || !extensions.length}
                onClick={() => void add("folder")}
              >
                {t("Import folder · this level only…")}
              </button>
              <button disabled={busy || removed} onClick={() => void add("book")}>
                {t("Import book project…")}
              </button>
            </div>
          </details>
          <button disabled={busy} onClick={() => setGroupDialog({})}>
            {t("New group…")}
          </button>
          {!!activeGroup && (
            <details
              className="group-menu"
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest("button"))
                  event.currentTarget.open = false;
              }}
            >
              <summary>{t("Group actions")}</summary>
              <div>
                <button disabled={busy} onClick={() => setGroupDialog({ previous: activeGroup })}>
                  {t("Rename group…")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (
                        await host.confirm(
                          t("Remove group “{0}”? Its books will move to Ungrouped.", activeGroup),
                          t("Remove group"),
                          t("Remove group"),
                        )
                      ) {
                        await host.rpc("series.delete_group", { name: activeGroup });
                        setGroup("group/");
                        host.notify(t("Group removed · books moved to Ungrouped"));
                      }
                    })
                  }
                >
                  {t("Remove group")}
                </button>
              </div>
            </details>
          )}
          {series.refreshed_at && (
            <small className="refresh-time">
              {t(
                "Refreshed at {0}",
                new Date(series.refreshed_at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              )}
            </small>
          )}
        </div>
      ) : (
        <p className="series-help">
          {t(
            "This legacy series links to external files. Save it as a folder project to organize your books.",
          )}
        </p>
      )}
      <nav className="project-groups" aria-label={t("Book groups")}>
        <button aria-pressed={group === "all"} disabled={busy} onClick={() => chooseGroup("all")}>
          {t("All books")}
        </button>
        <button
          aria-pressed={group === "group/"}
          disabled={busy}
          onClick={() => chooseGroup("group/")}
        >
          {t("Ungrouped")}
        </button>
        {series.groups.map((name) => (
          <button
            key={name}
            aria-pressed={group === "group/" + name}
            disabled={busy}
            onClick={() => chooseGroup("group/" + name)}
          >
            {name}
          </button>
        ))}
        {series.managed && (
          <button aria-pressed={removed} disabled={busy} onClick={() => chooseGroup("removed")}>
            {t("Removed ({0})", series.removed.length)}
          </button>
        )}
      </nav>
      <div className="project-filters">
        <input
          type="search"
          aria-label={t("Search books")}
          placeholder={t("Search title or filename…")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(new Set());
          }}
        />
        <label>
          {t("Show")}
          <select
            value={filter}
            disabled={busy}
            onChange={(event) => {
              setFilter(event.target.value);
              setSelected(new Set());
            }}
          >
            <option value="all">{t("All books")}</option>
            <option value="review">{t("Needs review")}</option>
            <option value="export">{t("Needs export")}</option>
          </select>
        </label>
        <span>{t("{0} books shown", visible.length)}</span>
        {removed && !!series.removed.length && (
          <button
            disabled={busy}
            onClick={() => void deleteBooks(series.removed.map((item) => item.id))}
          >
            {t("Empty Removed…")}
          </button>
        )}
      </div>
      {visible.length > 0 && (
        <div className="series-selection">
          <button
            disabled={busy}
            onClick={() => setSelected(new Set(visible.map((item) => item.id)))}
          >
            {t("Select visible")}
          </button>
          {!removed && visible.some((item) => item.reviewed && !item.exported) && (
            <button
              disabled={busy}
              onClick={() =>
                setSelected(
                  new Set(
                    visible
                      .filter((item) => item.reviewed && !item.exported)
                      .map((item) => item.id),
                  ),
                )
              }
            >
              {t("Select reviewed for export")}
            </button>
          )}
          {!!chosen.length && (
            <>
              <button disabled={busy} onClick={() => setSelected(new Set())}>
                {t("Clear selection")}
              </button>
              <span>{t("{0} selected", chosen.length)}</span>
              {series.managed &&
                (removed ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => void restore(chosen.map((item) => item.id))}
                    >
                      {t("Restore selected")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void deleteBooks(chosen.map((item) => item.id))}
                    >
                      {t("Delete selected permanently…")}
                    </button>
                  </>
                ) : (
                  <>
                    <label>
                      {t("Move to")}
                      <select
                        aria-label={t("Move selected books to group")}
                        disabled={busy}
                        value={destination}
                        onChange={(event) => setDestination(event.target.value)}
                      >
                        <option value="">{t("Ungrouped")}</option>
                        {series.groups.map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await host.rpc("series.move", {
                            ids: chosen.map((item) => item.id),
                            group: destination,
                          });
                          host.notify(
                            t(
                              "{0} books moved to {1}",
                              chosen.length,
                              destination || t("Ungrouped"),
                            ),
                          );
                        })
                      }
                    >
                      {t("Move selected")}
                    </button>
                    <button disabled={busy} onClick={() => void remove()}>
                      {t("Remove selected")}
                    </button>
                  </>
                ))}
            </>
          )}
        </div>
      )}
      <div className="series-table-scroll">
        <table className="series-table">
          <thead>
            <tr>
              <th>{t("Select")}</th>
              <th>{t("Volume")}</th>
              <th>{t("Pages")}</th>
              <th>{t("Review")}</th>
              <th>{t("Export")}</th>
              {series.managed && !removed && <th>{t("Order")}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((item, index) => {
              const row = rows[item.id];
              return (
                <tr key={item.id} className={item.id === series.current_id ? "current-volume" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t("Select {0}", item.title)}
                      disabled={busy}
                      checked={selected.has(item.id)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="volume-link"
                      disabled={busy || removed || item.changed || item.missing}
                      title={t("Edit pages: {0}", item.title)}
                      onClick={() => openBook(item)}
                    >
                      {item.title}
                    </button>
                    <small>
                      {item.group || t("Ungrouped")} · {item.path.split(/[\\/]/).pop()}
                      {item.missing
                        ? " · " + t("Source missing")
                        : item.changed
                          ? " · " + t("Source changed")
                          : ""}
                    </small>
                    {series.managed && !removed && (item.missing || item.changed) && (
                      <button
                        onClick={() =>
                          void run(async () => {
                            const path = await host.pickFile({
                              extensions: [item.path.split(".").pop()!],
                              title: t("Locate the original source"),
                            });
                            if (typeof path === "string") {
                              await host.rpc("series.relink", { id: item.id, path });
                              host.notify(t("Source relinked: {0}", item.title));
                            }
                          })
                        }
                        disabled={busy}
                      >
                        {t("Relink…")}
                      </button>
                    )}
                  </td>
                  <td>{item.page_count ?? "—"}</td>
                  <td>
                    {item.reviewed
                      ? t("Book reviewed")
                      : item.revision === null
                        ? t("Not started")
                        : t("Not reviewed")}
                    {!!item.review_count && (
                      <small className="review-pending">
                        {t("{0} pages need attention", item.review_count)}
                      </small>
                    )}
                    {item.review_count === null && <small>{t("Open to check page marks")}</small>}
                  </td>
                  <td aria-live="polite">
                    {row && row.state !== "completed"
                      ? labels[row.state]
                      : item.exported
                        ? t("Exported")
                        : item.needs_export
                          ? t("Needs re-export")
                          : "—"}
                    {row?.error && (
                      <small className="series-error">
                        {row.renderRequired
                          ? t("{0} pages need rendering before export", row.renderRequired.length)
                          : row.error}
                      </small>
                    )}
                    {!removed && row?.state === "failed" && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (row.renderRequired) setRender(true);
                          void exportBooks([item], !!row.renderRequired || render, true);
                        }}
                      >
                        {t(
                          row.renderRequired
                            ? "Allow rendering and retry this book"
                            : "Retry this book",
                        )}
                      </button>
                    )}
                    {(row?.output || item.output) && (
                      <button
                        className="export-link"
                        onClick={() =>
                          void revealItemInDir(row?.output || item.output!).catch(host.report)
                        }
                      >
                        {t("Show file")}
                      </button>
                    )}
                  </td>
                  {series.managed && !removed && (
                    <td className="project-order">
                      <button
                        aria-label={t("Move {0} up", item.title)}
                        disabled={busy || index === 0}
                        onClick={() => void reorder(item, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={t("Move {0} down", item.title)}
                        disabled={busy || index === visible.length - 1}
                        onClick={() => void reorder(item, 1)}
                      >
                        ↓
                      </button>
                      <button
                        aria-label={t("Move {0} to position…", item.title)}
                        disabled={busy}
                        onClick={() => setMoving({ item, position: index + 1 })}
                      >
                        …
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && (
          <div className="project-empty">
            <h2>
              {t(
                removed
                  ? "No removed books"
                  : !series.items.length
                    ? "Add your first book"
                    : "No books match this filter",
              )}
            </h2>
            <p>
              {t(
                removed
                  ? "Removed books will appear here. Restore them or permanently delete them to free space."
                  : !series.items.length
                    ? "Add supported books or drop files here. Copies and saved edits stay in this project."
                    : "Try another group, clear the search or show all books.",
              )}
            </p>
            {series.managed && !removed && !series.items.length && (
              <button
                className="primary"
                disabled={busy || !extensions.length}
                onClick={() => void add("files")}
              >
                {t("Add books…")}
              </button>
            )}
          </div>
        )}
      </div>
      {!removed && (
        <>
          {!!chosen.length && (
            <details className="shared-settings">
              <summary>{t("Shared settings for {0} selected books", chosen.length)}</summary>
              <fieldset disabled={busy}>
                <label>
                  {t("Reading direction")}
                  <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                    <option value="">{t("Keep each book's setting")}</option>
                    <option value="rtl">{t("Right to left")}</option>
                    <option value="ltr">{t("Left to right")}</option>
                  </select>
                </label>
                <label>
                  {t("Cover placement")}
                  <select value={cover} onChange={(event) => setCover(event.target.value)}>
                    <option value="">{t("Keep each book's setting")}</option>
                    <option value="both">{t("Bookshelf and book body")}</option>
                    <option value="shelf">{t("Bookshelf only")}</option>
                  </select>
                </label>
                <button disabled={!direction && !cover} onClick={() => void applySettings()}>
                  {t("Apply to {0} books", chosen.length)}
                </button>
              </fieldset>
              <p>
                {t(
                  "Only selected books are affected. Page order, blanks and crops remain individual to each volume.",
                )}
              </p>
            </details>
          )}
          {running && progress && (
            <p className="batch-summary" role="status">
              {t("Book {0} of {1}: {2}", progress.index, progress.total, progress.title)}
            </p>
          )}
          {finished && (
            <p className="batch-summary" role="status">
              {batchSummary(Object.values(rows))}
            </p>
          )}
          {!!series.items.length && (
            <div className="series-export">
              <label className="output-directory">
                {t("Output folder")}
                <button
                  className="output-folder"
                  disabled={busy}
                  title={series.output_directory}
                  onClick={() =>
                    void run(async () => {
                      const directory = await host.pickFile({
                        directory: true,
                        title: t("Choose output folder"),
                      });
                      if (typeof directory === "string") {
                        await host.rpc("series.output", { directory });
                        host.setOutputDirectory?.(directory);
                      }
                    })
                  }
                >
                  {series.output_directory || t("Choose output folder…")}
                </button>
              </label>
              <label>
                {t("Output format")}
                <select
                  aria-label={t("Output format")}
                  disabled={busy || !outputFormat}
                  value={outputFormat?.id || ""}
                  onChange={(event) => setExporter(event.target.value)}
                >
                  {exporters.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.format!.name}
                    </option>
                  ))}
                  {!outputFormat && <option value="">{t("No export plugins enabled")}</option>}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={render}
                  disabled={busy}
                  onChange={(event) => setRender(event.target.checked)}
                />
                {t("Allow rendering complex pages")} (
                {dpi === "auto" ? t("Auto resolution") : t("{0} DPI", dpi)})
              </label>
              {running ? (
                <button
                  onClick={() => {
                    abort.current.abort();
                    void host.cancelTask?.().catch(host.report);
                  }}
                >
                  {t("Cancel batch")}
                </button>
              ) : (
                <>
                  <button
                    disabled={busy || !retry.length || !series.output_directory || !outputFormat}
                    onClick={() => void exportBooks(retry, render, true)}
                  >
                    {t("Retry remaining")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !canExport}
                    onClick={() => void exportBooks()}
                  >
                    {t("Export {0} selected books", chosen.length)}
                  </button>
                </>
              )}
              {!series.output_directory && (
                <small>{t("Choose an output folder to enable export.")}</small>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
