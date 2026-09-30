import React, {useEffect, useRef, useState} from "react";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import type {HostAPI, Metadata, RenderResolution, Series, SeriesItem} from "../sdk/types";
import {t} from "../sdk/i18n";
import {runBatch, type BatchRow} from "../plugins/editor/src/batch";

export function ProjectCreator({host, initialName, migrate, create, close}: {
  host: HostAPI; initialName: string; migrate: boolean;
  create: (parent: string, name: string) => Promise<void>; close: () => void;
}) {
  const [name,setName] = useState(initialName);
  const [parent,setParent] = useState("");
  const [working,setWorking] = useState(false);
  const [error,setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {dialog.current?.showModal();}, []);
  return <dialog ref={dialog} aria-labelledby="project-dialog-title" className="project-dialog" onCancel={event => {event.preventDefault(); if (!working) close();}}>
    <h1 id="project-dialog-title">{t(migrate ? "Save series as folder project" : "New project")}</h1>
    <p>{t("A new folder will hold your PDF copies, groups and saved edits.")}</p>
    <form onSubmit={event => {event.preventDefault(); if (working) return; setWorking(true); setError(""); void create(parent,name.trim()).then(close).catch(reason => setError(String(reason))).finally(() => setWorking(false));}}>
      <fieldset disabled={working}>
        <label>{t("Project name")}<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
        <label>{t("Location")}<input readOnly value={parent} placeholder={t("Choose a location…")}/></label>
        <button type="button" onClick={() => void host.pickFile({directory: true,title: t("Choose a location for the new project")}).then(value => {if (typeof value === "string") setParent(value);}).catch(host.report)}>{t("Choose location…")}</button>
        {parent && <p className="project-location">{parent}/{name.trim()}</p>}
        {error && <p role="alert" className="series-error">{error}</p>}
        <div className="project-dialog-actions"><button type="button" onClick={close}>{t("Cancel")}</button><button className="primary" disabled={!parent || !name.trim()}>{working ? t("Creating project…") : t("Create project")}</button></div>
      </fieldset>
    </form>
  </dialog>;
}

export function SeriesWorkspace({series,host,busy,hidden,dpi,openBook,migrate}: {
  series: Series; host: HostAPI; busy: boolean; hidden: boolean; dpi: RenderResolution;
  openBook: (item: SeriesItem) => void; migrate: () => void;
}) {
  const [selected,setSelected] = useState<Set<string>>(new Set());
  const [group,setGroup] = useState("all");
  const [groupName,setGroupName] = useState("");
  const [destination,setDestination] = useState("");
  const [filter,setFilter] = useState("all");
  const [direction,setDirection] = useState("");
  const [cover,setCover] = useState("");
  const [render,setRender] = useState(false);
  const [running,setRunning] = useState(false);
  const [rows,setRows] = useState<Record<string,BatchRow>>({});
  const abort = useRef(new AbortController());
  const removed = group === "removed";
  const activeGroup = group.startsWith("group/") ? group.slice(6) : "";
  const visible = (removed ? series.removed : series.items).filter(item =>
    (removed || group === "all" || item.group === activeGroup) && (filter === "all" || (filter === "review" ? !item.reviewed : !item.exported)));
  const chosen = visible.filter(item => selected.has(item.id));
  useEffect(() => () => abort.current.abort(), []);
  useEffect(() => {
    if (activeGroup && !series.groups.includes(activeGroup)) setGroup("all");
    if (destination && !series.groups.includes(destination)) setDestination("");
    const ids = new Set([...series.items,...series.removed].map(item => item.id));
    setSelected(old => new Set([...old].filter(id => ids.has(id))));
  }, [series]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    host.setBusy?.(true);
    try {await action();} catch (error) {host.report(error);} finally {host.setBusy?.(false);}
  };
  const addPaths = (paths: string[]) => run(async () => {
    await host.rpc("series.add",{paths,group: activeGroup});
    host.notify(t("Books added to the project"));
  });
  useEffect(() => {
    if (hidden || !series.managed) return;
    return host.onFileDrop?.(paths => void addPaths(paths));
  }, [hidden,series.managed,group,busy]);
  const add = (kind: "pdf" | "folder" | "book") => run(async () => {
    const picked = await host.pickFile(kind === "pdf" ? {extensions: ["pdf"],multiple: true,title: t("Add PDFs to project")} :
      {directory: true,title: t(kind === "book" ? "Choose a .mteproj project folder" : "Import PDFs from folder")});
    if (picked) await host.rpc("series.add",{paths: Array.isArray(picked) ? picked : [picked],group: activeGroup});
  });
  const chooseGroup = (value: string) => {setGroup(value); setSelected(new Set()); setGroupName(value.startsWith("group/") ? value.slice(6) : "");};
  const applySettings = () => run(async () => {
    const metadata: Partial<Metadata> = {};
    if (direction) metadata.direction = direction as "rtl"|"ltr";
    if (cover) metadata.cover_only = cover === "exclude";
    if (!await host.confirm(t("Apply shared settings to {0} selected books?\n\n{1}",chosen.length,chosen.map(item => item.title).join("\n")))) return;
    const results = await host.rpc<{id: string; error: string|null}[]>("series.configure",{ids: chosen.map(item => item.id),metadata});
    const errors = results.filter(result => result.error);
    if (errors.length) host.report(new Error(errors.map(result => `${series.items.find(item => item.id === result.id)!.title}: ${result.error}`).join("\n")));
    else host.notify(t("Shared settings applied to {0} books",chosen.length));
  });
  const exportBooks = async (items = chosen) => {
    if (busy || !items.length || !series.output_directory) return;
    const cohort = items.map(item => ({id: item.id,path: item.path}));
    setRows(Object.fromEntries(cohort.map(item => [item.id,{path: item.path,state: "pending" as const}])));
    setRunning(true); host.setBusy?.(true); abort.current = new AbortController();
    try {
      await runBatch(host,{paths: cohort.map(item => item.path),entries: cohort,directory: series.output_directory,render,dpi},abort.current.signal,
        (index,row) => setRows(old => ({...old,[cohort[index].id]: row})));
    } catch (error) {host.report(error);}
    finally {setRunning(false); host.setBusy?.(false);}
  };
  const reorder = (item: SeriesItem, offset: number) => run(async () => {
    const other = visible[visible.indexOf(item)+offset];
    if (!other) return;
    const ids = series.items.map(entry => entry.id), a = ids.indexOf(item.id), b = ids.indexOf(other.id);
    [ids[a],ids[b]] = [ids[b],ids[a]];
    await host.rpc("series.reorder",{ids});
  });
  const retry = visible.filter(item => rows[item.id] && rows[item.id].state !== "completed");
  const labels = {pending: t("Pending"),working: t("Processing"),completed: t("Exported"),failed: t("Failed"),cancelled: t("Cancelled"),skipped: t("Skipped")};
  const realGroup = !!activeGroup;
  return <section className="series-workspace" hidden={hidden}>
    <div className="series-heading"><div><h1>{series.name}</h1><p>{t("{0} books · {1} reviewed · {2} exported",series.items.length,series.items.filter(item => item.reviewed).length,series.items.filter(item => item.exported).length)}</p></div>
      {series.managed ? <div className="project-actions"><button disabled={busy} onClick={() => void run(() => host.rpc("series.refresh"))}>{t("Refresh folder")}</button><button onClick={() => void revealItemInDir(series.directory).catch(host.report)}>{t("Show project folder")}</button></div> : <button disabled={busy} className="primary" onClick={migrate}>{t("Save series as folder project")}</button>}
    </div>
    <p className="series-help">{t(series.managed ? "PDFs and saved edits live in this project folder. Groups match its subfolders." : "This legacy series links to external files. Save it as a folder project to organize your books.")}</p>
    {series.managed && <div className="project-tools">
      <button disabled={busy} onClick={() => void add("pdf")}>{t("Add PDFs…")}</button><button disabled={busy} onClick={() => void add("folder")}>{t("Import folder…")}</button><button disabled={busy} onClick={() => void add("book")}>{t("Import book project…")}</button>
      <label>{t("Group name")}<input disabled={busy} value={groupName} maxLength={120} onChange={event => setGroupName(event.target.value)}/></label>
      <button disabled={busy || !groupName.trim()} onClick={() => void run(async () => {await host.rpc("series.group",{name: groupName.trim()}); chooseGroup("group/"+groupName.trim());})}>{t("New group")}</button>
      {realGroup && <><button disabled={busy || !groupName.trim() || groupName.trim() === activeGroup} onClick={() => void run(async () => {await host.rpc("series.group",{name: groupName.trim(),previous: activeGroup}); chooseGroup("group/"+groupName.trim());})}>{t("Rename group")}</button><button disabled={busy} onClick={() => void run(async () => {if (await host.confirm(t("Remove group “{0}”? Its books will move to Ungrouped.",activeGroup))) {await host.rpc("series.delete_group",{name: activeGroup}); chooseGroup("group/");}})}>{t("Remove group")}</button></>}
    </div>}
    <div className="project-filters">
      <label>{t("Group")}<select value={group} disabled={busy} onChange={event => chooseGroup(event.target.value)}><option value="all">{t("All books")}</option><option value="group/">{t("Ungrouped")}</option>{series.groups.map(name => <option key={name} value={"group/"+name}>{name}</option>)}{series.managed && <option value="removed">{t("Removed ({0})",series.removed.length)}</option>}</select></label>
      <label>{t("Show")}<select value={filter} disabled={busy} onChange={event => {setFilter(event.target.value); setSelected(new Set());}}><option value="all">{t("All books")}</option><option value="review">{t("Needs review")}</option><option value="export">{t("Needs export")}</option></select></label>
    </div>
    <div className="series-selection"><button disabled={busy} onClick={() => setSelected(new Set(visible.map(item => item.id)))}>{t("Select visible")}</button><button disabled={busy || removed} onClick={() => setSelected(new Set(visible.filter(item => item.reviewed && !item.exported).map(item => item.id)))}>{t("Select reviewed for export")}</button><button disabled={busy} onClick={() => setSelected(new Set())}>{t("Clear selection")}</button><span>{t("{0} selected",chosen.length)}</span>
      {series.managed && (removed ? <button disabled={busy || !chosen.length} onClick={() => void run(() => host.rpc("series.restore",{ids: chosen.map(item => item.id)}))}>{t("Restore selected")}</button> : <>
        <select aria-label={t("Move selected books to group")} disabled={busy} value={destination} onChange={event => setDestination(event.target.value)}><option value="">{t("Ungrouped")}</option>{series.groups.map(name => <option key={name}>{name}</option>)}</select>
        <button disabled={busy || !chosen.length} onClick={() => void run(() => host.rpc("series.move",{ids: chosen.map(item => item.id),group: destination}))}>{t("Move selected")}</button>
        <button disabled={busy || !chosen.length} onClick={() => void run(async () => {await host.rpc("series.remove",{ids: chosen.map(item => item.id)}); host.notify(t("Books moved to Removed. Restore them from the group menu."));})}>{t("Remove selected")}</button>
      </>)}
    </div>
    <div className="series-table-scroll"><table className="series-table"><thead><tr><th>{t("Select")}</th><th>{t("Volume")}</th><th>{t("Pages")}</th><th>{t("Review")}</th><th>{t("Export")}</th>{series.managed && !removed && <th>{t("Order")}</th>}</tr></thead><tbody>{visible.map((item,index) => {
      const row = rows[item.id];
      return <tr key={item.id} className={item.id === series.current_id ? "current-volume" : ""}>
        <td><input type="checkbox" aria-label={t("Select {0}",item.title)} disabled={busy} checked={selected.has(item.id)} onChange={event => {const next = new Set(selected); if(event.target.checked) next.add(item.id); else next.delete(item.id); setSelected(next);}}/></td>
        <td><button className="volume-link" disabled={busy || removed || item.changed || item.missing} title={item.path} onClick={() => openBook(item)}>{item.title}</button><small>{item.group || t("Ungrouped")} · {item.path.split(/[\\/]/).pop()}{item.missing ? ` · ${t("Source missing")}` : item.changed ? ` · ${t("Source changed")}` : ""}</small>
          {series.managed && !removed && (item.missing || item.changed) && <button onClick={() => void run(async () => {const path = await host.pickFile({extensions: ["pdf"],title: t("Locate the original PDF")}); if (typeof path === "string") await host.rpc("series.relink",{id: item.id,path});})} disabled={busy}>{t("Relink…")}</button>}
        </td>
        <td>{item.page_count ?? "—"}</td><td>{item.reviewed ? t("Reviewed") : item.revision === null ? t("Not started") : t("Editing")}</td>
        <td aria-live="polite">{row && row.state !== "completed" ? labels[row.state] : item.exported ? t("Exported") : item.needs_export ? t("Needs re-export") : "—"}{row?.error && <small className="series-error">{row.error}</small>}{(row?.output || item.output) && <button className="export-link" onClick={() => void revealItemInDir(row?.output || item.output!).catch(host.report)}>{t("Show file")}</button>}</td>
        {series.managed && !removed && <td className="project-order"><button aria-label={t("Move {0} up",item.title)} disabled={busy || index === 0} onClick={() => void reorder(item,-1)}>↑</button><button aria-label={t("Move {0} down",item.title)} disabled={busy || index === visible.length-1} onClick={() => void reorder(item,1)}>↓</button></td>}
      </tr>;
    })}</tbody></table>{!visible.length && <p className="empty-row">{t("No books match this filter")}</p>}</div>
    {!removed && <><details className="shared-settings"><summary>{t("Shared settings for selected books")}</summary><fieldset disabled={busy}>
      <label>{t("Reading direction")}<select value={direction} onChange={event => setDirection(event.target.value)}><option value="">{t("Keep each book's setting")}</option><option value="rtl">{t("Right to left")}</option><option value="ltr">{t("Left to right")}</option></select></label>
      <label>{t("Cover in body")}<select value={cover} onChange={event => setCover(event.target.value)}><option value="">{t("Keep each book's setting")}</option><option value="include">{t("Include")}</option><option value="exclude">{t("Exclude")}</option></select></label>
      <button disabled={!chosen.length || !direction && !cover} onClick={() => void applySettings()}>{t("Apply to {0} books",chosen.length)}</button>
    </fieldset><p>{t("Only selected books are affected. Page order, blanks and crops remain individual to each volume.")}</p></details>
    <div className="series-export"><button className="output-folder" disabled={busy} title={series.output_directory} onClick={() => void run(async () => {const directory = await host.pickFile({directory: true,title: t("Choose output folder")}); if(typeof directory === "string") await host.rpc("series.output",{directory});})}>{series.output_directory || t("Choose output folder")}</button>
      <label><input type="checkbox" checked={render} disabled={busy} onChange={event => setRender(event.target.checked)}/>{t("Allow rendering complex PDF pages")} ({dpi === "auto" ? t("Auto resolution") : `${dpi} DPI`})</label>
      {running ? <button onClick={() => {abort.current.abort(); void host.cancelTask?.().catch(host.report);}}>{t("Cancel batch")}</button> : <><button disabled={busy || !retry.length || !series.output_directory} onClick={() => void exportBooks(retry)}>{t("Retry remaining")}</button><button className="primary" disabled={busy || !chosen.length || !series.output_directory} onClick={() => void exportBooks()}>{t("Export {0} books",chosen.length)}</button></>}
    </div>
    <p className="series-help">{t("Each book exports its own saved layout. Existing output files are kept; duplicate names receive a number.")}</p></>}
  </section>;
}
