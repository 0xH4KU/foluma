import { useEffect, useState, type KeyboardEvent } from "react";
import type { Book, HostAPI, Page } from "./types.ts";
import { pageBackground } from "./page-layout.ts";

export function useOriginalComparison() {
  const [enabled, setEnabled] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const release = () => setHeld(false);
    const keyUp = (event: globalThis.KeyboardEvent) => { if (event.key.toLowerCase() === "o") release(); };
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    return () => { window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release); };
  }, []);
  return {
    original: enabled || held,
    toggle: () => setEnabled(value => !value),
    keyDown: (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "o" &&
          !(event.target as HTMLElement).closest("input,select,textarea,[contenteditable=true]")) {
        event.preventDefault();
        setHeld(true);
      }
    },
  };
}

export function visibleRange(count: number, top: number, height: number, rowHeight: number, columns: number) {
  return {
    first: Math.max(0, Math.floor(top / rowHeight) - 2) * columns,
    last: Math.min(count, (Math.ceil((top + height) / rowHeight) + 2) * columns),
  };
}

export function previewKey(book: Book, page: Page, size: number) {
  const asset = book.assets?.[page.asset_id || ""];
  const source = book.sources?.[asset?.source_id || asset?.derived_from?.source_id || ""];
  return JSON.stringify([
    book.id, page.id, page.kind, page.asset_id, page.width, page.height, page.crop, page.rotation, page.deskew || 0,
    page.deskew ? pageBackground(book, page.id) : undefined,
    size, asset?.kind, asset?.path, asset?.xref, asset?.source_page, source?.path, source?.sha256,
  ]);
}

export function usePagePreview(book: Book, page: Page | undefined, host: HostAPI, size: number) {
  const key = page ? previewKey(book, page, size) : "";
  const [preview, setPreview] = useState({ key: "", url: "", error: "" });
  useEffect(() => {
    if (!page || page.kind === "blank") return;
    const controller = new AbortController();
    let complete = false;
    const load = async (resolution: number) => {
      const url = await host.preview(book, page, resolution, controller.signal);
      if (controller.signal.aborted) return "";
      const image = new Image();
      image.src = url;
      await image.decode();
      return url;
    };
    if (size > 320) {
      void load(320).then((url) => {
        if (!complete && !controller.signal.aborted) setPreview({ key, url, error: "" });
      }).catch(() => {});
    }
    void load(size).then((url) => {
      complete = true;
      if (!controller.signal.aborted) setPreview({ key, url, error: "" });
    }).catch((error) => {
      if (!controller.signal.aborted) setPreview((old) => ({
        key, url: old.key === key ? old.url : "", error: error instanceof Error ? error.message : String(error),
      }));
    });
    return () => controller.abort();
  }, [key, host]);
  return preview.key === key ? preview : { key, url: "", error: "" };
}
