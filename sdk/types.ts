export type RenderResolution = "auto" | number;
export type Page = {
  id: string; kind: "image" | "blank"; width: number; height: number;
  asset_id?: string; crop?: [number, number, number, number]; source_page?: number | null;
  split?: { group: string; original: Page; side: "left" | "right" };
};
export type Asset = {
  kind: "pdf" | "file"; width: number; height: number; ext: "png" | "jpg";
  path?: string; source_id?: string; xref?: number; source_page?: number;
  derived_from?: { source_id: string; page: number; dpi: number };
};
export type Metadata = {
  title: string; author: string; language: string; direction: "rtl" | "ltr";
  cover_id: string | null; cover_only: boolean;
};
export type BookInformation = Partial<Pick<Metadata, "title" | "author" | "language" | "direction" | "cover_only">>;
export type BookCandidate = {path: string; title: string; filename?: string; metadata: BookInformation};
export type ProjectCreation = {parent: string; name: string; paths: string[]; books: {path: string; metadata: BookInformation}[]};
export type Book = {
  schema: 1; id: string; revision: number; metadata: Metadata; pages: Page[];
  assets: Record<string, Asset>; sources: Record<string, {path: string; sha256: string; page_count: number}>;
  extensions: Record<string, unknown>; project_path: string | null;
  dirty: boolean; can_undo: boolean; can_redo: boolean;
};
export type Changes = {pages?: Page[]; metadata?: Partial<Metadata>; extension?: {id: string; data: unknown}};
export type Task = {
  id: string; state: "running" | "completed" | "cancelled" | "failed"; operation: string;
  document_id: string | null; revision: number | null;
  progress: {done: number; total: number; message: string}; result: unknown;
  error: {message: string; data?: unknown} | null;
};
export type Plugin = {
  id: string; name: string; version: string; description?: string; api_version: number;
  platforms: string[]; ui?: {entry: string; style?: string; title: string}; workers?: Record<string, string>;
  language?: {locale: string; name: string; messages: string};
  format?: {direction: "import" | "export"; name: string; extensions: string[]; rendering?: boolean};
  enabled?: boolean; active?: boolean; active_version?: string; pending?: boolean;
};
export type PluginList = {items: Plugin[]; active: Plugin[]; safe_mode: boolean; errors: string[]; restart_required: boolean};
export type FileOptions = {extensions?: string[]; multiple?: boolean; directory?: boolean; title?: string};
export type SeriesItem = {
  id: string; path: string; title: string; document_id: string | null; page_count: number | null;
  revision: number | null; reviewed: boolean; exported: boolean; needs_export: boolean; missing: boolean;
  group: string; changed: boolean; review_count?: number | null;
  metadata?: BookInformation;
  output: string | null; settings: BookInformation;
};
export type ProjectSummary = {added?: number; skipped?: number; folders_skipped?: number; renamed?: number; missing?: number; changed?: number};
export type Series = {id: string; name: string; roots: string[]; current_id: string | null; output_directory: string; items: SeriesItem[]; managed: boolean; directory: string; groups: string[]; removed: SeriesItem[]; refreshed_at?: string; summary?: ProjectSummary};
export interface HostAPI {
  version: 1;
  getLocale?(): import("./i18n").Locale;
  subscribeLocale?(listener: () => void): () => void;
  contextMenu?(items: {text: string; enabled?: boolean; action: () => void}[], at?: {x: number; y: number}): Promise<void>;
  setBusy?(busy: boolean): void;
  cancelTask?(): Promise<void>;
  onFileDrop?(listener: (paths: string[]) => void): () => void;
  getExportPreferences?(): {directory: string; dpi: RenderResolution};
  getFormats?(): Plugin[];
  setOutputDirectory?(directory: string): void;
  getDocument(): Book | null;
  subscribe(listener: (book: Book | null) => void): () => void;
  apply(book: Book, changes: Changes): Promise<Book>;
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  task<T = unknown>(params: Record<string, unknown>): Promise<T>;
  preview(book: Book, page: Page, size?: number, signal?: AbortSignal): Promise<string>;
  pickFile(options: FileOptions): Promise<string | string[] | null>;
  saveFile(name: string, extensions: string[]): Promise<string | null>;
  confirm(message: string, title?: string, okLabel?: string): Promise<boolean>;
  report(error: unknown): void;
  notify(message: string, action?: {label: string; run: () => void}): void;
}
export const documentRef = (book: Book) => ({document_id: book.id, base_revision: book.revision});
