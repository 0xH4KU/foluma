import { useEffect, useState } from "react";
import type { Book, HostAPI, Page } from "./types.ts";

export function previewKey(book: Book, page: Page, size: number) {
  const asset = book.assets?.[page.asset_id || ""];
  const source = book.sources?.[asset?.source_id || asset?.derived_from?.source_id || ""];
  return JSON.stringify([
    book.id, page.id, page.kind, page.asset_id, page.width, page.height, page.crop, page.rotation,
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
