import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { HostAPI, RenderResolution, Series, SeriesItem } from "../sdk/types";
import { t } from "../sdk/i18n";
import { createActionRunner } from "../sdk/actions";
import { SeriesExportPanel, SeriesExportResult, useSeriesExport } from "./series-export";
import { openBookWindow } from "./tool-windows";
import { moveBefore } from "../sdk/order";
import { formatBytes } from "./storage";
import { BookInformationDialog, type InformationChange } from "./book-information-dialog";

export function ProjectCreator({
  host,
  initialName,
  create,
  close,
}: {
  host: HostAPI;
  initialName: string;
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
      <h1 id="project-dialog-title">{t("Save series as folder project")}</h1>
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
  const extensions = [...new Set(importers.flatMap((plugin) => plugin.format!.extensions))];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState("all");
  const [groupDialog, setGroupDialog] = useState<{ previous?: string } | null>(null);
  const [destination, setDestination] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [information, setInformation] = useState<{ visible: string[]; selected: string[] } | null>(
    null,
  );
  const [moving, setMoving] = useState<{ item: SeriesItem; position: number } | null>(null);
  const moveDialog = useRef<HTMLDialogElement>(null);
  const execute = useMemo(() => createActionRunner(host), [host]);
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
  const visibleIds = new Set(visible.map((item) => item.id));
  const hiddenSelected = (removed ? series.removed : series.items).filter(
    (item) => selected.has(item.id) && !visibleIds.has(item.id),
  ).length;
  const run = async (action: () => Promise<unknown>, reportError = true) => {
    if (busy) return false;
    return execute(async () => {
      await prepare();
      await action();
    }, reportError);
  };
  const batch = useSeriesExport({ series, host, busy, removed, dpi, chosen, run });
  const { canExport, exportBooks } = batch;
  useEffect(() => {
    selectionChanged({ count: chosen.length, canExport });
  }, [chosen.length, canExport, selectionChanged]);
  useEffect(() => {
    if (moving) moveDialog.current?.showModal();
  }, [!!moving]);
  useEffect(() => {
    if (activeGroup && !series.groups.includes(activeGroup)) setGroup("all");
    if (destination && !series.groups.includes(destination)) setDestination("");
    const ids = new Set([...series.items, ...series.removed].map((item) => item.id));
    setSelected((old) => new Set([...old].filter((id) => ids.has(id))));
  }, [series]);
  const chooseGroup = (value: string) => {
    setGroup(value);
    if (removed || value === "removed") setSelected(new Set());
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
      setSelected((old) => new Set([...old].filter((id) => !ids.includes(id))));
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
  const openInformation = () =>
    setInformation({
      visible: visible.map((item) => item.id),
      selected: chosen.map((item) => item.id),
    });
  const applyInformation = async (books: InformationChange[]) => {
    const applied = await run(async () => {
      const results = await host.rpc<{ id: string; error: string | null }[]>("series.configure", {
        ids: books.map((book) => book.id),
        books,
      });
      const errors = results.filter((result) => result.error);
      if (errors.length)
        throw new Error(
          errors
            .map(
              (result) =>
                `${series.items.find((item) => item.id === result.id)?.title || result.id}: ${result.error}`,
            )
            .join("\n"),
        );
      host.notify(t("Book information updated for {0} books", books.length));
    }, false);
    if (!applied) throw new Error(t("Complete or cancel the current background task first"));
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
  return (
    <section className="series-workspace" hidden={hidden}>
      {information && (
        <BookInformationDialog
          name={series.name}
          items={series.items}
          visibleIds={information.visible}
          selectedIds={information.selected}
          apply={applyInformation}
          close={() => setInformation(null)}
        />
      )}
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
        <button disabled={busy || removed || !series.items.length} onClick={openInformation}>
          {t("Batch book information…")}
        </button>
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
          }}
        />
        <label>
          {t("Show")}
          <select
            value={filter}
            disabled={busy}
            onChange={(event) => {
              setFilter(event.target.value);
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
      {(visible.length > 0 || selected.size > 0) && (
        <div className="series-selection">
          <button
            disabled={busy || !visible.length}
            onClick={() => setSelected((old) => new Set([...old, ...visible.map((item) => item.id)]))}
          >
            {t("Select visible")}
          </button>
          {!removed && visible.some((item) => item.reviewed && !item.exported) && (
            <button
              disabled={busy}
              onClick={() =>
                setSelected((old) => new Set([...old, ...visible
                  .filter((item) => item.reviewed && !item.exported)
                  .map((item) => item.id)]))
              }
            >
              {t("Select reviewed for export")}
            </button>
          )}
          {!!selected.size && <>
            <button disabled={busy} onClick={() => setSelected(new Set())}>{t("Clear selection")}</button>
            <span aria-live="polite">{t("{0} selected", chosen.length)}
              {!!hiddenSelected && ` · ${t("{0} selected books hidden by filters", hiddenSelected)}`}
            </span>
            {!!hiddenSelected && <small className="selection-scope">{t("Export selected, move and remove apply only to visible selected books.")}</small>}
          </>}
          {!!chosen.length && (
            <>
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
                    {!removed && <button className="open-book-window" disabled={busy || item.changed || item.missing}
                      onClick={() => void prepare().then(() => openBookWindow(item, series.id)).catch(host.report)}>
                      {t("Open in new window")}
                    </button>}
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
                  <SeriesExportResult item={item} host={host} busy={busy} removed={removed} batch={batch} />
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
      {!removed && <SeriesExportPanel series={series} busy={busy} dpi={dpi} batch={batch} />}
    </section>
  );
}
