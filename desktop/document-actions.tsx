import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Book, ExportVariant, HostAPI, Metadata, RenderResolution, Series, SeriesItem } from "../sdk/types";
import { ExportVariantSelect } from "../sdk/export-variant";
import { documentRef } from "../sdk/types";
import { t } from "../sdk/i18n";
import { flushMetadata, type MetadataDraft } from "./metadata";
import { createActionRunner } from "../sdk/actions";
import { closeBookWindows } from "./tool-windows";

export type MetadataEditor = {
  draft: Partial<Metadata>;
  change: (patch: Partial<Metadata>) => void;
  commit: () => Promise<void>;
};

type UnsavedChoice = "save" | "discard" | "cancel";
export function ExportEdition({ variants, respond }: {
  variants: ExportVariant[];
  respond: (variant: ExportVariant | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(variants[0].id);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="export-edition-title"
    onCancel={(event) => { event.preventDefault(); respond(null); }}>
    <h1 id="export-edition-title">{t("Export edition")}</h1>
    <fieldset>
      <ExportVariantSelect variants={variants} value={selected} onChange={setSelected} />
    </fieldset>
    <div className="project-dialog-actions">
      <button onClick={() => respond(null)}>{t("Cancel")}</button>
      <button className="primary" onClick={() => respond(variants.find((variant) => variant.id === selected)!)}>
        {t("Continue")}
      </button>
    </div>
  </dialog>;
}

export function UnsavedChanges({
  title,
  respond,
}: {
  title: string;
  respond: (choice: UnsavedChoice) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="unsaved-title"
      onCancel={(event) => {
        event.preventDefault();
        respond("cancel");
      }}
    >
      <h1 id="unsaved-title">{title}</h1>
      <p>{t("Save your changes before continuing?")}</p>
      <div className="project-dialog-actions">
        <button autoFocus onClick={() => respond("cancel")}>
          {t("Cancel")}
        </button>
        <button onClick={() => respond("discard")}>{t("Discard changes")}</button>
        <button className="primary" onClick={() => respond("save")}>
          {t("Save and continue")}
        </button>
      </div>
    </dialog>
  );
}

export function useDocumentActions(
  host: HostAPI,
  dpi: RenderResolution,
  editorAvailable: boolean,
  setTab: (tab: string) => void,
) {
  const [exportEdition, setExportEdition] = useState<{
    variants: ExportVariant[];
    respond: (variant: ExportVariant | null) => void;
  } | null>(null);
  const [unsaved, setUnsaved] = useState<{
    title: string;
    respond: (choice: UnsavedChoice) => void;
  } | null>(null);
  const inputDraft = useRef<MetadataDraft>({
    bookId: host.getDocument()?.id || null,
    values: {},
    pending: null,
  });
  const [metadataDraft, setMetadataDraft] = useState<Partial<Metadata>>({});
  const [savingInformation, setSavingInformation] = useState(0);
  const [working, setWorking] = useState(false);
  const execute = useMemo(() => createActionRunner(host, setWorking), [host]);
  const runExport = useMemo(() => createActionRunner({...host, setBusy: undefined}), [host]);
  const [output, setOutput] = useState("");
  useEffect(
    () =>
      host.subscribe((value) => {
        if (inputDraft.current.bookId !== (value?.id || null)) {
          inputDraft.current = { bookId: value?.id || null, values: {}, pending: null };
          setMetadataDraft({});
        }
      }),
    [host],
  );
  const commitInformation = useCallback(async () => {
    setSavingInformation((value) => value + 1);
    try {
      await flushMetadata(host, inputDraft.current, setMetadataDraft);
    } finally {
      setSavingInformation((value) => value - 1);
    }
  }, [host]);
  const changeInformation = (patch: Partial<Metadata>) => {
    host.notify("");
    inputDraft.current.values = { ...inputDraft.current.values, ...patch };
    setMetadataDraft(inputDraft.current.values);
  };
  const run = useCallback(
    async (action: () => Promise<unknown>, commit = true) => {
      await execute(async () => {
        if (commit) await commitInformation();
        await action();
      });
    },
    [execute, commitInformation],
  );
  const saveBook = useCallback(async () => {
    await commitInformation();
    const current = host.getDocument();
    if (!current) return false;
    const path =
      current.project_path ||
      (await host.saveFile(`${current.metadata.title}.mteproj`, ["mteproj"]));
    if (!path) return false;
    await host.rpc("project.save", { ...documentRef(host.getDocument()!), path });
    host.notify(t("Book project saved"));
    return true;
  }, [host, commitInformation]);
  const replaceAllowed = useCallback(
    async (title = t("Open another book")) => {
      let failed = false;
      try {
        await commitInformation();
      } catch {
        failed = true;
      }
      if (!failed && !host.getDocument()?.dirty) return true;
      const choice = await new Promise<UnsavedChoice>((resolve) =>
        setUnsaved({
          title,
          respond: (value) => {
            setUnsaved(null);
            resolve(value);
          },
        }),
      );
      if (choice === "discard") {
        inputDraft.current.values = {};
        setMetadataDraft({});
        return true;
      }
      return choice === "save" && (await saveBook());
    },
    [host, commitInformation, saveBook],
  );
  const importBook = useCallback(
    async (path?: string, pluginId?: string) => {
      const extension = path?.split(".").pop()?.toLowerCase();
      const candidates = (host.getFormats?.() || []).filter(
        (plugin) =>
          plugin.format?.direction === "import" &&
          (!pluginId || plugin.id === pluginId) &&
          (!path || plugin.format.extensions.includes(extension || "")),
      );
      if (!candidates.length) {
        setTab("plugins");
        host.notify(t("Install and enable an import plugin to open this file"));
        return;
      }
      if (candidates.length > 1) {
        await host.contextMenu?.(
          candidates.map((plugin) => ({
            text: t("Import {0}", plugin.format!.name),
            action: () => void importBook(path, plugin.id),
          })),
        ).catch(host.report);
        return;
      }
      await run(async () => {
        const provider = candidates[0];
        if (!(await replaceAllowed(t("Import book")))) return;
        const picked =
          path ||
          (await host.pickFile({
            extensions: provider.format!.extensions,
            title: t("Import {0}", provider.format!.name),
          }));
        if (typeof picked !== "string") return;
        try {
          await host.task<Book>({ operation: "import", plugin_id: provider.id, path: picked });
        } catch (error) {
          const data = (error as { data?: { kind: string; pages: number[] } }).data;
          if (data?.kind !== "render_required") throw error;
          if (
            !(await host.confirm(
              t(
                "{0} pages require rendering (pages {1}{2}).\n\nRender these pages as PNG using {3}? Other pages will keep their original images.",
                data.pages.length,
                data.pages.slice(0, 20).join(", "),
                data.pages.length > 20 ? "…" : "",
                dpi === "auto" ? t("Auto resolution") : `${dpi} DPI`,
              ),
              t("Some pages require rendering"),
            ))
          )
            return;
          await host.task<Book>({
            operation: "import",
            plugin_id: provider.id,
            path: picked,
            render: true,
            dpi,
          });
        }
        setTab("convert");
        setOutput("");
      }, false);
    },
    [host, replaceAllowed, dpi, run],
  );
  const openVolume = (item: SeriesItem) =>
    void run(async () => {
      if (!(await replaceAllowed())) return;
      try {
        await host.task<Book>({ operation: "series.open", entry_id: item.id });
      } catch (error) {
        const data = (error as { data?: { kind: string; pages: number[] } }).data;
        if (data?.kind !== "render_required") throw error;
        if (
          !(await host.confirm(
            t(
              "{0} pages in this book require rendering. Render them as PNG using {1}?",
              data.pages.length,
              dpi === "auto" ? t("Auto resolution") : `${dpi} DPI`,
            ),
          ))
        )
          return;
        await host.task<Book>({ operation: "series.open", entry_id: item.id, render: true, dpi });
      }
      setTab(editorAvailable ? "org.foluma.editor" : "convert");
      setOutput("");
    }, false);
  const saveProject = () => run(saveBook);
  const exportBook = async (pluginId?: string): Promise<void> => {
    const candidates = (host.getFormats?.() || []).filter(
      (plugin) => plugin.format?.direction === "export" && (!pluginId || plugin.id === pluginId),
    );
    if (candidates.length > 1) {
      await host.contextMenu?.(
        candidates.map((plugin) => ({
          text: t("Export {0}", plugin.format!.name),
          action: () => void exportBook(plugin.id),
        })),
      ).catch(host.report);
      return;
    }
    await runExport(async () => {
      await commitInformation();
      if (!candidates.length) {
        setTab("plugins");
        host.notify(t("Install and enable an export plugin to export books"));
        return;
      }
      const provider = candidates[0];
      const current = host.getDocument();
      if (!current) return;
      const variants = provider.format?.variants;
      let variant: ExportVariant | null = null;
      if (variants?.length) {
        variant = await new Promise<ExportVariant | null>((resolve) => {
          setExportEdition({ variants, respond: (value) => { setExportEdition(null); resolve(value); } });
        });
        if (!variant) return;
      }
      const path = await host.saveFile(
        `${current.metadata.title}${variant && variant.id !== variants?.[0].id ? ` (${t(variant.name)})` : ""}.${provider.format!.extensions[0]}`,
        provider.format!.extensions,
      );
      if (!path) return;
      const exporting = host.getDocument();
      if (!exporting || exporting.id !== current.id) return;
      const result = await host.task<{ path: string }>({
        operation: "export",
        plugin_id: provider.id,
        options: variant?.options,
        ...documentRef(exporting),
        path,
        overwrite: true,
      });
      host.setOutputDirectory?.(
        result.path.slice(
          0,
          Math.max(result.path.lastIndexOf("/"), result.path.lastIndexOf("\\")) + 1,
        ),
      );
      if (host.getDocument()?.id === current.id) setOutput(result.path);
      host.notify(t("{0} exported", provider.format!.name));
    });
  };
  const openProject = () =>
    run(async () => {
      if (!(await replaceAllowed(t("Open project")))) return;
      const path = await host.pickFile({ directory: true, title: t("Choose a project folder") });
      if (typeof path === "string") {
        if (!(await closeBookWindows())) return;
        const result = await host.rpc<Book | Series>("project.open", { path });
        setTab("managed" in result ? "series" : "convert");
        setOutput("");
      }
    }, false);
  return {
    exportEdition,
    unsaved,
    metadataDraft,
    savingInformation,
    working,
    output,
    setOutput,
    commitInformation,
    changeInformation,
    run,
    replaceAllowed,
    importBook,
    openVolume,
    saveProject,
    exportBook,
    openProject,
  };
}
