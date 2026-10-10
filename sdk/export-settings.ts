import { useSyncExternalStore } from "react";
import type { HostAPI, Plugin } from "./types.ts";

function readSettings(raw: string | null): { format?: string; variants: Record<string, string> } {
  try {
    const saved = JSON.parse(raw || "{}");
    return {
      format: typeof saved?.format === "string" ? saved.format : undefined,
      variants: Object.fromEntries(Object.entries(saved?.variants || {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )),
    };
  } catch {
    return { variants: {} };
  }
}

export function exportSelection(formats: Plugin[], raw: string | null) {
  const saved = readSettings(raw);
  const exporters = formats.filter((plugin) => plugin.format?.direction === "export");
  const outputFormat = exporters.find((plugin) => plugin.id === saved.format) || exporters[0];
  const variants = outputFormat?.format?.variants;
  const variant = variants?.find((item) => item.id === saved.variants[outputFormat!.id]) || variants?.[0];
  return { exporters, outputFormat, variant };
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("foluma-export-settings", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("foluma-export-settings", listener);
  };
}

export function useExportSettings(host: Pick<HostAPI, "getFormats">) {
  const raw = useSyncExternalStore(subscribe, () => localStorage.getItem("export-settings"));
  const selection = exportSelection(host.getFormats?.() || [], raw);
  const save = (format: string, variant?: string) => {
    const saved = readSettings(localStorage.getItem("export-settings"));
    localStorage.setItem("export-settings", JSON.stringify({
      format,
      variants: variant === undefined ? saved.variants : { ...saved.variants, [format]: variant },
    }));
    window.dispatchEvent(new Event("foluma-export-settings"));
  };
  return {
    ...selection,
    variantId: selection.variant?.id || "",
    setExporter: (format: string) => save(format),
    setVariantId: (variant: string) => { if (selection.outputFormat) save(selection.outputFormat.id, variant); },
  };
}
