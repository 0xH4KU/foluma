import React, {useEffect, useRef, useState} from "react";
import type {HostAPI} from "../../../sdk/types";
import {t} from "../../../sdk/i18n";
import {runBatch, type BatchRow} from "./batch";

export function BatchDialog({host, close, initialPaths = []}: {host: HostAPI; close: () => void; initialPaths?: string[]}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef(new AbortController());
  const [rows,setRows] = useState<BatchRow[]>(() => initialPaths.map(path => ({path,state: "pending"})));
  const [preset,setPreset] = useState("");
  const [directory,setDirectory] = useState("");
  const [render,setRender] = useState(false);
  const [dpi,setDpi] = useState(300);
  const [running,setRunning] = useState(false);
  const [finished,setFinished] = useState(false);
  useEffect(() => {dialog.current!.showModal(); return () => {abort.current.abort();};}, []);
  const pick = async (kind: "pdf" | "preset" | "folder") => {
    try {
      const result = await host.pickFile(kind === "folder" ? {directory: true,title: t("Choose output folder")} :
        {extensions: [kind === "pdf" ? "pdf" : "mtepreset"],multiple: kind === "pdf",title: kind === "pdf" ? t("Choose PDFs") : t("Load layout preset")});
      if (!result) return;
      if (kind === "pdf") {setRows([...new Set(Array.isArray(result) ? result : [result])].map(path => ({path,state: "pending"}))); setFinished(false);}
      else if (typeof result === "string") {if (kind === "preset") setPreset(result); else setDirectory(result);}
    } catch (error) {host.report(error);}
  };
  const start = async () => {
    const paths = rows.filter(row => row.state !== "completed").map(row => row.path);
    setRows(old => old.map(row => row.state === "completed" ? row : {...row,state: "pending",error: undefined})); setRunning(true); setFinished(false);
    abort.current = new AbortController(); host.setBusy?.(true);
    try {await runBatch(host,{paths,preset,directory,render,dpi},abort.current.signal,(_index,row) => setRows(old => old.map(value => value.path === row.path ? row : value)));}
    catch (error) {host.report(error);}
    finally {setRunning(false); setFinished(true); host.setBusy?.(false);}
  };
  const cancel = () => {abort.current.abort(); void host.cancelTask?.().catch(host.report);};
  const labels = {pending: t("Pending"),working: t("Processing"),completed: t("Exported"),failed: t("Failed"),cancelled: t("Cancelled"),skipped: t("Skipped")};
  return <dialog className="batch-dialog" ref={dialog} aria-labelledby="batch-title" onKeyDown={event => event.stopPropagation()} onCancel={event => {event.preventDefault(); if (running) cancel(); else close();}}>
    <h1 id="batch-title">{t("Batch PDF to EPUB")}</h1>
    <p>{t("Apply one layout preset to multiple PDFs. Each book is exported separately; your open book stays unchanged.")}</p>
    <fieldset disabled={running}>
      <label>{t("Layout preset")}<button title={preset} aria-label={t("Layout preset: {0}",preset.split(/[\\/]/).pop() || t("Choose preset…"))} onClick={() => void pick("preset")}>{preset.split(/[\\/]/).pop() || t("Choose preset…")}</button></label>
      <label>{t("Output folder")}<button title={directory} aria-label={t("Output folder: {0}",directory || t("Choose folder…"))} onClick={() => void pick("folder")}>{directory || t("Choose folder…")}</button></label>
      <div className="batch-render"><label><input type="checkbox" checked={render} onChange={event => setRender(event.target.checked)}/>{t("Allow rendering complex PDF pages")}</label><select aria-label={t("Render resolution")} disabled={!render} value={dpi} onChange={event => setDpi(Number(event.target.value))}>{[72,150,200,300,400,600].map(value => <option key={value} value={value}>{value} DPI</option>)}</select></div>
      <button onClick={() => void pick("pdf")}>{t("Choose PDFs…")}</button>
    </fieldset>
    <div className="batch-results" aria-live="polite"><table><thead><tr><th>{t("PDF")}</th><th>{t("Result")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.path}><td title={row.path}>{row.path.split(/[\\/]/).pop()}</td><td>{labels[row.state]}{row.output && <small>{row.output}</small>}{row.error && <small className="danger">{row.error}</small>}</td></tr>)}</tbody></table></div>
    <p>{t("Existing files are kept; duplicate names receive a number. PDFs missing pages required by the preset are reported individually.")}</p>
    {finished && <p role="status">{t("{0} exported · {1} failed · {2} cancelled or skipped",rows.filter(row => row.state === "completed").length,rows.filter(row => row.state === "failed").length,rows.filter(row => row.state === "cancelled" || row.state === "skipped").length)}</p>}
    <div className="batch-actions">{running ? <button onClick={cancel}>{t("Cancel batch")}</button> : <><button onClick={close}>{t("Close")}</button><button disabled={!preset || !directory || !rows.some(row => row.state !== "completed")} onClick={() => void start()}>{finished ? t("Retry remaining") : t("Apply and export")}</button></>}</div>
  </dialog>;
}
