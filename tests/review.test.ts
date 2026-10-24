import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import type { Book, HostAPI, SeriesItem } from "../sdk/types.ts";

test("review confirmation uses current page marks and cancellation or save failures stop completion", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
  try {
    const { setBookReviewed } = await server.ssrLoadModule("/desktop/document-actions.tsx");
    const book = {
      id: "book", pages: [{ id: "page" }],
      extensions: { "org.foluma.editor": { review: ["page", "page", "removed"] } },
    } as unknown as Book;
    const volume = { id: "volume", document_id: book.id, review_count: 0 } as SeriesItem;
    const prompts: string[] = [], requests: unknown[] = [];
    let accepted = false, fail = false;
    const host = {
      getDocument: () => book,
      confirm: async (message: string) => { prompts.push(message); return accepted; },
      rpc: async (method: string, params: unknown) => {
        if (fail) throw new Error("disk full");
        requests.push({ method, params });
      },
    } as unknown as HostAPI;

    assert.equal(await setBookReviewed(host, volume, true), false);
    assert.match(prompts[0], /^1 pages still need attention/);
    assert.deepEqual(requests, [], "cancelling must not save a reviewed state");
    accepted = true;
    assert.equal(await setBookReviewed(host, volume, true), true);
    assert.deepEqual(requests, [{ method: "series.review", params: { id: "volume", reviewed: true, allow_pending: true } }]);
    assert.equal(await setBookReviewed(host, volume, false), true);
    assert.equal(prompts.length, 2, "unmarking review needs no attention confirmation");
    assert.deepEqual(requests[1], { method: "series.review", params: { id: "volume", reviewed: false, allow_pending: false } });

    book.extensions = {};
    assert.equal(await setBookReviewed(host, volume, true), true);
    assert.equal(prompts.length, 2);
    assert.deepEqual(requests[2], { method: "series.review", params: { id: "volume", reviewed: true, allow_pending: false } });
    fail = true;
    await assert.rejects(setBookReviewed(host, volume, true), /disk full/);
  } finally {
    await server.close();
  }
});
