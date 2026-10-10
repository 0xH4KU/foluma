import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { HostAPI, RenderResolution, Series, SeriesItem } from "../sdk/types";
import { t } from "../sdk/i18n";
import { batchStateLabel, batchSummary, runBatch, type BatchRow } from "../sdk/batch";
import { ExportVariantSelect } from "../sdk/export-variant";
import { useExportSettings } from "../sdk/export-settings";

export function useSeriesExport({ series, host, busy, removed, dpi, chosen, run }: {
  series: Series;
  host: HostAPI;
  busy: boolean;
  removed: boolean;
  dpi: RenderResolution;
  chosen: SeriesItem[];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { exporters, outputFormat, variant, variantId, setExporter, setVariantId } = useExportSettings(host);
  const [render, setRender] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [progress, setProgress] = useState<{ title: string; index: number; total: number } | null>(null);
  const [rows, setRows] = useState<Record<string, BatchRow>>({});
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);
  const canExport = !running && !removed && chosen.length > 0 && !!series.output_directory && !!outputFormat;
  const exportBooks = async (items = chosen, allowRendering = render, retrying = false) => {
    if (running || removed || busy || !items.length || !series.output_directory || !outputFormat) return;
    const cohort = items.map((item) => ({ id: item.id, path: item.path, title: item.title }));
    if (!(await run(async () => {}))) return;
    setFinished(false);
    setRunning(true);
    abort.current = new AbortController();
    setRows((old) => ({
      ...(retrying ? old : {}),
      ...Object.fromEntries(cohort.map((item) => [item.id, { path: item.path, state: "pending" as const }])),
    }));
    try {
      host.setOutputDirectory?.(series.output_directory);
      await runBatch(host, {
        paths: cohort.map((item) => item.path), entries: cohort,
        directory: series.output_directory, render: allowRendering, dpi,
        exporter: outputFormat.id, exportOptions: variant?.options,
      }, abort.current.signal, (index, row) => {
        setRows((old) => ({ ...old, [cohort[index].id]: row }));
        if (row.state === "working")
          setProgress({ title: cohort[index].title, index: index + 1, total: cohort.length });
      });
    } catch (error) {host.report(error);}
    finally {
      setRunning(false);
      setFinished(true);
      setProgress(null);
    }
  };
  const chooseOutput = () => run(async () => {
    const directory = await host.pickFile({ directory: true, title: t("Choose output folder") });
    if (typeof directory === "string") {
      await host.rpc("series.output", { directory });
      host.setOutputDirectory?.(directory);
    }
  });
  const cancel = () => {
    abort.current.abort();
  };
  const retryBook = (item: SeriesItem) => {
    const rendering = !!rows[item.id]?.renderRequired;
    if (rendering) setRender(true);
    void exportBooks([item], rendering || render, true);
  };
  const retry = series.items.filter((item) => rows[item.id] && rows[item.id].state !== "completed");
  return {
    rows, running, finished, progress, canExport, count: chosen.length, retry, exportBooks, retryBook, cancel, chooseOutput,
    exporters, outputFormat, setExporter, variantId, setVariantId, render, setRender,
  };
}

type ExportState = ReturnType<typeof useSeriesExport>;

export function SeriesExportPanel({ series, busy, dpi, batch }: {
  series: Series; busy: boolean; dpi: RenderResolution; batch: ExportState;
}) {
  const {
    running, finished, progress, rows, retry, outputFormat, exporters, exportBooks,
    render, setRender, variantId, setVariantId, setExporter, canExport, count,
  } = batch;
  return <>
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
            disabled={busy || running}
            title={series.output_directory}
            onClick={() => void batch.chooseOutput()}
          >
            {series.output_directory || t("Choose output folder…")}
          </button>
        </label>
        <label>
          {t("Output format")}
          <select
            aria-label={t("Output format")}
            disabled={busy || running || !outputFormat}
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
        <ExportVariantSelect variants={outputFormat?.format?.variants} value={variantId}
          onChange={setVariantId} disabled={busy || running} />
        <label>
          <input
            type="checkbox"
            checked={render}
            disabled={busy || running}
            onChange={(event) => setRender(event.target.checked)}
          />
          {t("Allow rendering complex pages")} (
          {dpi === "auto" ? t("Auto resolution") : t("{0} DPI", dpi)})
        </label>
        {running ? (
          <button
            onClick={batch.cancel}
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
              {t("Export {0} selected books", count)}
            </button>
          </>
        )}
        {!series.output_directory && (
          <small>{t("Choose an output folder to enable export.")}</small>
        )}
      </div>
    )}
  </>;
}

export function SeriesExportResult({ item, host, busy, removed, batch }: {
  item: SeriesItem; host: HostAPI; busy: boolean; removed: boolean; batch: ExportState;
}) {
  const row = batch.rows[item.id];
  return (
    <td aria-live="polite">
      {row && row.state !== "completed"
        ? batchStateLabel(row.state)
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
          onClick={() => batch.retryBook(item)}
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
  );
}
