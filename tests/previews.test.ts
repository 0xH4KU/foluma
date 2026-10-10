import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import {test} from "node:test";
import {createPreviewLoader} from "../desktop/previews.ts";
import {previewKey} from "../sdk/previews.ts";
import type {Book, Page} from "../sdk/types.ts";

test("previews drop obsolete work, prioritize the current page, share requests and retry failures", async () => {
  const book = {id: "book"} as Book;
  const page = (id: string): Page => ({id,kind: "image",asset_id: id,width: 240,height: 320,crop: [0,0,1,1]});
  const started: string[] = [];
  const work = new Map<string, {resolve: (url: string) => void; reject: (error: Error) => void}>();
  const preview = createPreviewLoader((_book, page) => new Promise((resolve,reject) => {
    started.push(page.id); work.set(page.id,{resolve,reject});
  }));
  const first = preview(book,page("first")), second = preview(book,page("second"));
  const sharedController = new AbortController();
  const shared = preview(book,page("first"),320,sharedController.signal);
  const sharedAborted = assert.rejects(shared,{name: "AbortError"});
  await setImmediate();
  assert.deepEqual(started,["first","second"]);
  sharedController.abort();
  await sharedAborted;
  for (let i=0; i<100; i++) {
    const controller = new AbortController();
    const obsolete = preview(book,page(`obsolete-${i}`),320,controller.signal);
    const aborted = assert.rejects(obsolete,{name: "AbortError"});
    controller.abort(); await aborted;
  }
  const thumbnail = preview(book,page("thumbnail"));
  const current = preview(book,page("current"),1024);
  work.get("first")!.resolve("first.png");
  assert.equal(await first,"first.png");
  await setImmediate();
  assert.deepEqual(started,["first","second","current"]);
  work.get("second")!.resolve("second.png"); await second;
  await setImmediate();
  assert.deepEqual(started,["first","second","current","thumbnail"]);
  work.get("current")!.resolve("current.png");
  work.get("thumbnail")!.resolve("thumbnail.png");
  await Promise.all([current,thumbnail]);
  const reloaded = preview(book,page("current"),1024);
  await setImmediate(); work.get("current")!.resolve("regenerated.png");
  assert.equal(await reloaded,"regenerated.png","disk previews may have been evicted between requests");
  assert.equal(started.length,5);
  const relocated = {id: "book", assets: {current: {kind: "pdf",source_id: "source"}}, sources: {source: {path: "/new/group/book.pdf"}}} as unknown as Book;
  const fresh = preview(relocated,page("current"),1024);
  await setImmediate(); work.get("current")!.resolve("relocated.png");
  assert.equal(await fresh,"relocated.png");
  assert.equal(started.length,6,"a moved source must not reuse work queued with the old path");
  const failed = preview(book,page("retry"));
  const rejected = assert.rejects(failed,/decode failed/);
  await setImmediate(); work.get("retry")!.reject(new Error("decode failed"));
  await rejected;
  const retry = preview(book,page("retry"));
  await setImmediate(); work.get("retry")!.resolve("retry.png");
  assert.equal(await retry,"retry.png");
  assert.deepEqual(started.slice(-2),["retry","retry"]);
});

test("preview requests for different rotations do not share stale work", async () => {
  const book = { id: "book" } as Book;
  const page: Page = {id:"page",kind:"image",asset_id:"asset",width:20,height:30,crop:[0,0,1,1]};
  const calls: number[] = [];
  const preview = createPreviewLoader(async (_book, candidate) => {
    calls.push(candidate.rotation || 0);
    return `${candidate.rotation || 0}.png`;
  });
  assert.deepEqual(await Promise.all([preview(book,page),preview(book,{...page,rotation:90})]), ["0.png","90.png"]);
  assert.deepEqual(calls,[0,90]);
});

test("preview identity survives metadata saves and changes when image content or geometry changes", () => {
  const page: Page = {id:"page",kind:"image",asset_id:"asset",width:20,height:30,crop:[0,0,1,1]};
  const book = { id:"book", revision:0, metadata:{title:"Before"}, pages:[page],
    assets:{asset:{kind:"pdf",source_id:"source",xref:4}}, sources:{source:{path:"book.pdf",sha256:"before"}},
  } as unknown as Book;
  const key = previewKey(book, page, 1024);
  const saved = structuredClone(book);
  saved.revision++;
  saved.metadata.title = "After";
  assert.equal(previewKey(saved, saved.pages[0], 1024), key);
  for (const changed of [{rotation:90 as const}, {crop:[0,0,0.5,1] as Page["crop"]}, {width:30}, {kind:"blank" as const}]) {
    assert.notEqual(previewKey(book, {...page,...changed}, 1024), key);
  }
  assert.notEqual(previewKey(book, page, 320), key);
  saved.sources.source.sha256 = "replacement";
  assert.notEqual(previewKey(saved, page, 1024), key);
  saved.sources.source.sha256 = "before";
  saved.assets.asset.xref = 5;
  assert.notEqual(previewKey(saved, page, 1024), key);
});
