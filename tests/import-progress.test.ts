import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { Task } from "../sdk/types.ts";

test("parsing progress keeps one summary for concurrent tasks and exposes each task in details", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  try {
    const { ImportProgress } = await server.ssrLoadModule("/desktop/shell.tsx");
    const task = (id: string, state: Task["state"] = "running"): Task => ({
      id, state, title: `Book ${id}`, operation: "series.open", preparse: true,
      entry_id: id, document_id: null, revision: null,
      progress: { done: 25, total: 100, message: "Preparing pages" }, result: null, error: null,
    });
    const render = (jobs: Task[]) => renderToStaticMarkup(createElement(ImportProgress, { jobs, cancel: () => {} }));
    const summary = (html: string) => html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)![1];

    assert.equal(render([]), "");
    assert.equal(render([task("finished", "completed"), { ...task("export"), operation: "export" }]), "");
    const single = summary(render([task("one")]));
    assert.match(single, /Book one/);
    assert.match(single, /25 \/ 100 · 25%/);
    assert.match(single, /<progress[^>]*value="25"[^>]*max="100"/);
    const queued = summary(render([task("waiting", "queued")]));
    assert.match(queued, /Queued/);
    assert.doesNotMatch(queued, /<progress[^>]*value=/);

    const jobs = [...Array.from({ length: 8 }, (_, i) => task(String(i))), task("queued", "queued")];
    const html = render(jobs);
    const compact = summary(html);
    assert.equal(compact.match(/<progress\b/g)?.length, 1);
    assert.match(compact, /8 running · 1 queued/);
    assert.doesNotMatch(compact, /<progress[^>]*value=/, "concurrent stages must not report a misleading combined percentage");
    assert.doesNotMatch(compact, /<article\b|<button\b/);
    assert.doesNotMatch(html, /<details[^>]*\bopen(?:[\s=>])/);
    assert.equal(html.match(/<article\b/g)?.length, 9);
    assert.equal(html.match(/<button\b/g)?.length, 9, "queued tasks must also remain cancellable");
    for (const job of jobs) assert.match(html, new RegExp(`Cancel Book ${job.id}`));
  } finally {
    await server.close();
  }
});
