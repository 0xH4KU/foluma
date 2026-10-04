import type { Book, HostAPI, RenderResolution } from "./types.ts";
import { documentRef } from "./types.ts";
import { t } from "./i18n.ts";

export type BatchRow = {
  path: string;
  state: "pending" | "working" | "completed" | "failed" | "cancelled" | "skipped";
  output?: string;
  error?: string;
  renderRequired?: number[];
};
export type BatchOptions = {
  paths: string[];
  entries?: { id: string; path: string }[];
  directory: string;
  render: boolean;
  dpi: RenderResolution;
  exporter?: string;
};

export function batchSummary(rows: BatchRow[]): string {
  return t(
    "{0} exported · {1} failed · {2} cancelled or skipped",
    rows.filter((row) => row.state === "completed").length,
    rows.filter((row) => row.state === "failed").length,
    rows.filter((row) => row.state === "cancelled" || row.state === "skipped").length,
  );
}

export async function runBatch(
  host: HostAPI,
  options: BatchOptions,
  signal: AbortSignal,
  update: (index: number, row: BatchRow) => void,
  prepare?: (book: Book) => Promise<Book>,
): Promise<void> {
  const cancelled = () => {
    if (signal.aborted) throw Object.assign(new Error(t("Task cancelled")), { cancelled: true });
  };
  const entries = new Map(options.entries?.map((entry) => [entry.path, entry.id]));
  let stopped = false;
  for (const [index, path] of options.paths.entries()) {
    if (signal.aborted || stopped) {
      update(index, { path, state: "skipped" });
      continue;
    }
    update(index, { path, state: "working" });
    let book: Book | undefined;
    try {
      cancelled();
      const entry = entries.get(path);
      book = await host.task<Book>({
        ...(entry ? { operation: "series.open", entry_id: entry } : { operation: "import", path }),
        background: true,
        render: options.render,
        dpi: options.dpi,
      });
      cancelled();
      if (prepare) book = await prepare(book);
      cancelled();
      const result = await host.task<{ path: string }>({
        operation: "export",
        ...documentRef(book),
        directory: options.directory,
        plugin_id: options.exporter,
      });
      update(index, { path, state: "completed", output: result.path });
    } catch (error) {
      stopped = signal.aborted || !!(error as { cancelled?: boolean })?.cancelled;
      const data = (error as { data?: { kind?: string; pages?: number[] } })?.data;
      update(index, {
        path,
        state: stopped ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(data?.kind === "render_required" ? { renderRequired: data.pages || [] } : {}),
      });
    } finally {
      if (book) await host.rpc("document.release", { document_id: book.id }).catch(host.report);
    }
  }
}
