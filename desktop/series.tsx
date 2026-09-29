import React, {useEffect, useRef, useState} from "react";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import type {HostAPI, Metadata, Series, SeriesItem} from "../sdk/types";
import {t} from "../sdk/i18n";
import {runBatch, type BatchRow} from "../plugins/editor/src/batch";

export function SeriesWorkspace({series,host,busy,hidden,dpi,openBook}: {
  series: Series; host: HostAPI; busy: boolean; hidden: boolean; dpi: number; openBook: (item: SeriesItem) => void;
}) {
  const [selected,setSelected] = useState<Set<string>>(new Set());
  const choseSelection = useRef(false);
  const [filter,setFilter] = useState("all");
  const [direction,setDirection] = useState("");
  const [cover,setCover] = useState("");
  const [render,setRender] = useState(false);
  const [running,setRunning] = useState(false);
  const [rows,setRows] = useState<Record<string,BatchRow>>({});
  const abort = useRef(new AbortController());
  const reviewed = () => new Set(series.items.filter(item => item.reviewed && !item.exported).map(item => item.id));
  useEffect(() => {if (!choseSelection.current) setSelected(reviewed());}, [series]);
  useEffect(() => () => abort.current.abort(), []);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    host.setBusy?.(true);
    try {await action();} catch (error) {host.report(error);} finally {host.setBusy?.(false);}
  };
  const choose = (ids: Set<string>) => {choseSelection.current = true; setSelected(ids);};
  const chosen = series.items.filter(item => selected.has(item.id));
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
    setRows(Object.fromEntries(cohort.map(item => [item.path,{path: item.path,state: "pending" as const}])));
    setRunning(true); host.setBusy?.(true); abort.current = new AbortController();
    try {
      await runBatch(host,{paths: cohort.map(item => item.path),entries: cohort,directory: series.output_directory,render,dpi},abort.current.signal,
        (_index,row) => setRows(old => ({...old,[row.path]: row})));
    } catch (error) {host.report(error);}
    finally {setRunning(false); host.setBusy?.(false);}
  };
  const retry = series.items.filter(item => rows[item.path] && rows[item.path].state !== "completed");
  const labels = {pending: t("Pending"),working: t("Processing"),completed: t("Exported"),failed: t("Failed"),cancelled: t("Cancelled"),skipped: t("Skipped")};
  const visible = series.items.filter(item => filter === "all" || (filter === "review" ? !item.reviewed : !item.exported));
  return <section className="series-workspace" hidden={hidden}>
    <div className="series-heading"><div><h1>{series.name}</h1><p>{t("{0} books · {1} reviewed · {2} exported",series.items.length,series.items.filter(item => item.reviewed).length,series.items.filter(item => item.exported).length)}</p></div>
      <label>{t("Show")}<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t("All books")}</option><option value="review">{t("Needs review")}</option><option value="export">{t("Needs export")}</option></select></label>
    </div>
    <p className="series-help">{t("Open a book to edit it. Each volume saves its own changes automatically; original PDFs are preserved.")}</p>
    <div className="series-selection"><button disabled={busy} onClick={() => choose(new Set(series.items.map(item => item.id)))}>{t("Select all")}</button><button disabled={busy} onClick={() => choose(reviewed())}>{t("Select reviewed for export")}</button><button disabled={busy} onClick={() => choose(new Set())}>{t("Clear selection")}</button><span>{t("{0} selected",chosen.length)}</span></div>
    <div className="series-table-scroll"><table className="series-table"><thead><tr><th>{t("Select")}</th><th>{t("Volume")}</th><th>{t("Pages")}</th><th>{t("Review")}</th><th>{t("Export")}</th></tr></thead><tbody>{visible.map(item => {
      const row = rows[item.path];
      return <tr key={item.id} className={item.id === series.current_id ? "current-volume" : ""}>
        <td><input type="checkbox" aria-label={t("Select {0}",item.title)} disabled={busy} checked={selected.has(item.id)} onChange={event => {const next = new Set(selected); if(event.target.checked) next.add(item.id); else next.delete(item.id); choose(next);}}/></td>
        <td><button className="volume-link" disabled={busy} title={item.path} onClick={() => openBook(item)}>{item.title}</button><small>{item.path.split(/[\\/]/).pop()}{item.missing ? ` · ${t("Source missing")}` : ""}</small></td>
        <td>{item.page_count ?? "—"}</td><td>{item.reviewed ? t("Reviewed") : item.revision === null ? t("Not started") : t("Editing")}</td>
        <td aria-live="polite">{row && row.state !== "completed" ? labels[row.state] : item.exported ? t("Exported") : item.needs_export ? t("Needs re-export") : "—"}{row?.error && <small className="series-error">{row.error}</small>}{(row?.output || item.output) && <button className="export-link" onClick={() => void revealItemInDir(row?.output || item.output!).catch(host.report)}>{t("Show file")}</button>}</td>
      </tr>;
    })}</tbody></table>{!visible.length && <p className="empty-row">{t("No books match this filter")}</p>}</div>
    <details className="shared-settings"><summary>{t("Shared settings for selected books")}</summary><fieldset disabled={busy}>
      <label>{t("Reading direction")}<select value={direction} onChange={event => setDirection(event.target.value)}><option value="">{t("Keep each book's setting")}</option><option value="rtl">{t("Right to left")}</option><option value="ltr">{t("Left to right")}</option></select></label>
      <label>{t("Cover in body")}<select value={cover} onChange={event => setCover(event.target.value)}><option value="">{t("Keep each book's setting")}</option><option value="include">{t("Include")}</option><option value="exclude">{t("Exclude")}</option></select></label>
      <button disabled={!chosen.length || !direction && !cover} onClick={() => void applySettings()}>{t("Apply to {0} books",chosen.length)}</button>
    </fieldset><p>{t("Only selected books are affected. Page order, blanks and crops remain individual to each volume.")}</p></details>
    <div className="series-export"><button className="output-folder" disabled={busy} title={series.output_directory} onClick={() => void run(async () => {const directory = await host.pickFile({directory: true,title: t("Choose output folder")}); if(typeof directory === "string") await host.rpc("series.output",{directory});})}>{series.output_directory || t("Choose output folder")}</button>
      <label><input type="checkbox" checked={render} disabled={busy} onChange={event => setRender(event.target.checked)}/>{t("Allow rendering complex PDF pages")} ({dpi} DPI)</label>
      {running ? <button onClick={() => {abort.current.abort(); void host.cancelTask?.().catch(host.report);}}>{t("Cancel batch")}</button> : <><button disabled={busy || !retry.length || !series.output_directory} onClick={() => void exportBooks(retry)}>{t("Retry remaining")}</button><button className="primary" disabled={busy || !chosen.length || !series.output_directory} onClick={() => void exportBooks()}>{t("Export {0} books",chosen.length)}</button></>}
    </div>
    <p className="series-help">{t("Each book exports its own saved layout. Existing output files are kept; duplicate names receive a number.")}</p>
  </section>;
}
