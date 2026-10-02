import type {Book, HostAPI, Page} from "../sdk/types.ts";

type Waiter = {resolve: (url: string) => void; reject: (error: unknown) => void};
type Preview = {size: number; started: boolean; load: () => Promise<string>; waiters: Set<Waiter>};

export function createPreviewLoader(load: (book: Book, page: Page, size: number) => Promise<string>): HostAPI["preview"] {
  const pending = new Map<string, Preview>();
  let running = 0;

  function pump() {
    // ponytail: two running previews finish; add worker cancellation if active decodes still block navigation.
    while (running < 2) {
      const next = [...pending.entries()].filter(([, preview]) => !preview.started)
        .sort((a,b) => b[1].size-a[1].size)[0];
      if (!next) return;
      const [key, preview] = next;
      preview.started = true; running++;
      Promise.resolve().then(preview.load).then(url => {
        pending.delete(key);
        preview.waiters.forEach(waiter => waiter.resolve(url));
      }, error => {
        pending.delete(key);
        preview.waiters.forEach(waiter => waiter.reject(error));
      }).finally(() => {running--; pump();});
    }
  }

  return (book, page, size = 320, signal) => new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason); return;}
    const asset = book.assets?.[page.asset_id || ""];
    const source = book.sources?.[asset?.source_id || ""];
    const key = JSON.stringify([book.id,page.id,page.asset_id,page.width,page.height,page.crop,size,asset?.path,source?.path]);
    let preview = pending.get(key);
    if (!preview) {
      preview = {size,started: false,load: () => load(book,page,size),waiters: new Set()};
      pending.set(key,preview);
    }
    const waiter: Waiter = {
      resolve: url => {signal?.removeEventListener("abort",cancel); resolve(url);},
      reject: error => {signal?.removeEventListener("abort",cancel); reject(error);},
    };
    function cancel() {
      preview!.waiters.delete(waiter);
      if (!preview!.started && !preview!.waiters.size) pending.delete(key);
      reject(signal!.reason);
    }
    preview.waiters.add(waiter);
    signal?.addEventListener("abort",cancel,{once: true});
    // Batch a render's requests so the large page preview starts before thumbnails.
    queueMicrotask(pump);
  });
}
