import React, {useEffect, useRef, useState} from "react";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import type {HostAPI, RenderResolution} from "../../../sdk/types";
import {t} from "../../../sdk/i18n";
import {batchSummary, runBatch, type BatchRow} from "./batch";

export function BatchDialog({host, close, initialPaths = []}: {host: HostAPI; close: () => void; initialPaths?: string[]}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef(new AbortController());
  const [rows,setRows] = useState<BatchRow[]>(() => initialPaths.map(path => ({path,state:"pending"})));
  const [preset,setPreset] = useState("");
  const [directory,setDirectory] = useState(() => host.getExportPreferences?.().directory || "");
  const [render,setRender] = useState(false);
  const [dpi,setDpi] = useState<RenderResolution>(() => host.getExportPreferences?.().dpi || "auto");
  const [running,setRunning] = useState(false);
  const [finished,setFinished] = useState(false);
  const [progress,setProgress] = useState<{index: number; total: number; name: string} | null>(null);
  useEffect(() => {dialog.current!.showModal(); return () => {abort.current.abort();};}, []);
  const pick = async (kind: "pdf" | "preset" | "folder") => {
    try {
      const result = await host.pickFile(kind === "folder" ? {directory:true,title:t("Choose output folder")} :
        {extensions:[kind === "pdf" ? "pdf" : "mtepreset"],multiple:kind === "pdf",title:kind === "pdf" ? t("Choose PDFs") : t("Load layout preset")});
      if (!result) return;
      if (kind === "pdf") {
        const paths = [...new Set(Array.isArray(result) ? result : [result])];
        setRows(old => [...old,...paths.filter(path => !old.some(row => row.path === path)).map(path => ({path,state:"pending" as const}))]); setFinished(false);
      } else if (typeof result === "string") {
        if (kind === "preset") setPreset(result);
        else {setDirectory(result); host.setOutputDirectory?.(result);}
      }
    } catch (error) {host.report(error);}
  };
  const start = async (only?: BatchRow, allowRendering = render) => {
    if (running) return;
    const paths = (only ? [only] : rows.filter(row => row.state !== "completed")).map(row => row.path);
    setRows(old => old.map(row => paths.includes(row.path) ? {path:row.path,state:"pending"} : row)); setRunning(true); setFinished(false);
    abort.current = new AbortController(); host.setBusy?.(true);
    host.notify(""); host.setOutputDirectory?.(directory);
    try {
      await runBatch(host,{paths,preset,directory,render:allowRendering,dpi},abort.current.signal,(index,row) => {
        setRows(old => old.map(value => value.path === row.path ? row : value));
        if (row.state === "working") setProgress({index:index+1,total:paths.length,name:row.path.split(/[\\/]/).pop() || row.path});
      });
    } catch (error) {host.report(error);}
    finally {setRunning(false); setFinished(true); setProgress(null); host.setBusy?.(false);}
  };
  const cancel = () => {abort.current.abort(); void host.cancelTask?.().catch(host.report);};
  const labels = {pending:t("Pending"),working:t("Processing"),completed:t("Exported"),failed:t("Failed"),cancelled:t("Cancelled"),skipped:t("Skipped")};
  return <dialog className="batch-dialog" ref={dialog} aria-labelledby="batch-title" onKeyDown={event => event.stopPropagation()} onCancel={event => {event.preventDefault(); if (running) cancel(); else close();}}>
    <h1 id="batch-title">{t("Apply one preset and export PDFs")}</h1>
    <p>{t("Apply one layout preset to multiple PDFs. Each book is exported separately; your open book stays unchanged.")}</p>
    <fieldset disabled={running}>
      <label>{t("Layout preset")}<button title={preset} aria-label={t("Layout preset: {0}",preset.split(/[\\/]/).pop() || t("Choose preset…"))} onClick={() => void pick("preset")}>{preset.split(/[\\/]/).pop() || t("Choose preset…")}</button></label>
      <label>{t("Output folder")}<button title={directory} aria-label={t("Output folder: {0}",directory || t("Choose folder…"))} onClick={() => void pick("folder")}>{directory || t("Choose folder…")}</button></label>
      <div className="batch-render"><label><input type="checkbox" checked={render} onChange={event => setRender(event.target.checked)}/>{t("Allow rendering complex PDF pages")}</label><select aria-label={t("Render resolution")} disabled={!render} value={dpi} onChange={event => setDpi(event.target.value === "auto" ? "auto" : Number(event.target.value))}><option value="auto">{t("Auto (recommended)")}</option>{[72,150,200,300,400,600].map(value => <option key={value} value={value}>{value} DPI</option>)}</select></div>
      <button onClick={() => void pick("pdf")}>{t("Add PDFs…")}</button>
    </fieldset>
    <div className="batch-results" aria-live="polite"><table><thead><tr><th>{t("PDF")}</th><th>{t("Result")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.path}>
      <td title={row.path}>{row.path.split(/[\\/]/).pop()}</td><td>{labels[row.state]}
        {row.output && <button title={row.output} onClick={() => void revealItemInDir(row.output!).catch(host.report)}>{t("Show file")}</button>}
        {row.error && <small className="danger">{row.renderRequired ? t("{0} pages need rendering before export",row.renderRequired.length) : row.error}</small>}
        {row.state === "failed" && <button disabled={running} onClick={() => {if (row.renderRequired) setRender(true); void start(row,!!row.renderRequired || render);}}>{t(row.renderRequired ? "Allow rendering and retry this book" : "Retry this book")}</button>}
      </td></tr>)}</tbody></table></div>
    <p>{t("Existing files are kept; duplicate names receive a number. PDFs missing pages required by the preset are reported individually.")}</p>
    {progress && <p role="status">{t("Book {0} of {1}: {2}",progress.index,progress.total,progress.name)}</p>}
    {finished && <p role="status">{batchSummary(rows)}</p>}
    {!directory && <p>{t("Choose an output folder to enable export.")}</p>}
    <div className="batch-actions">{running ? <button onClick={cancel}>{t("Cancel batch")}</button> : <><button onClick={close}>{t("Close")}</button><button disabled={!preset || !directory || !rows.some(row => row.state !== "completed")} onClick={() => void start()}>{finished ? t("Retry remaining") : t("Apply and export")}</button></>}</div>
  </dialog>;
}
