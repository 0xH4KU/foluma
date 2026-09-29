import type {Book, HostAPI} from "../../../sdk/types.ts";
import {documentRef} from "../../../sdk/types.ts";
import {t} from "../../../sdk/i18n.ts";
import {applyPreset, type Preset} from "./pages.ts";

export type BatchRow = {path: string; state: "pending" | "working" | "completed" | "failed" | "cancelled" | "skipped"; output?: string; error?: string};
export type BatchOptions = {paths: string[]; preset?: string; entries?: {id: string; path: string}[]; directory: string; render: boolean; dpi: number};

export async function runBatch(host: HostAPI, options: BatchOptions, signal: AbortSignal, update: (index: number, row: BatchRow) => void): Promise<void> {
  const cancelled = () => {if (signal.aborted) throw Object.assign(new Error(t("Task cancelled")), {cancelled: true});};
  const entries = new Map(options.entries?.map(entry => [entry.path,entry.id]));
  let stopped = false;
  for (const [index,path] of options.paths.entries()) {
    if (signal.aborted || stopped) {update(index,{path,state: "skipped"}); continue;}
    update(index,{path,state: "working"});
    let book: Book | undefined;
    try {
      cancelled();
      const entry = entries.get(path);
      book = await host.task<Book>({...entry ? {operation: "series.open",entry_id: entry} : {operation: "import",path},background: true,render: options.render,dpi: options.dpi});
      cancelled();
      if (options.preset) {
        const preset = await host.rpc<{payload: Preset; asset_ids: Record<string,string>; document: Book}>("bundle.read",{...documentRef(book),path: options.preset,plugin: "org.foluma.editor"});
        cancelled();
        book = await host.apply(preset.document,applyPreset(preset.document,preset.payload,preset.asset_ids));
      }
      cancelled();
      const result = await host.task<{path: string}>({operation: "export",...documentRef(book),directory: options.directory});
      update(index,{path,state: "completed",output: result.path});
    } catch (error) {
      stopped = signal.aborted || !!(error as {cancelled?: boolean})?.cancelled;
      update(index,{path,state: stopped ? "cancelled" : "failed",error: error instanceof Error ? error.message : String(error)});
    } finally {
      if (book) await host.rpc("document.release",{document_id: book.id}).catch(host.report);
    }
  }
}
