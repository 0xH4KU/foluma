import assert from "node:assert/strict";
import {test} from "node:test";
import type {Book} from "../sdk/types.ts";
import type {Task} from "../sdk/types.ts";

test("document RPC acknowledgements update the active revision before notifications arrive", async () => {
  const before = {schema:1,id:"active",revision:0,pages:[],metadata:{title:"Before"}} as unknown as Book;
  const after = {...before,revision:1,metadata:{...before.metadata,title:"After"}};
  (globalThis as any).window = {__TAURI_INTERNALS__:{invoke:async () => after}};
  const {createHost,rpc,setDocument} = await import("../desktop/bridge.ts");
  const host = createHost(error => {throw error;},()=>{});
  setDocument(before,true);
  await host.apply(before,{metadata:{title:"After"}});
  assert.equal(host.getDocument()!.revision,1,"Save must immediately see the acknowledged revision");
  setDocument(before);
  assert.equal(host.getDocument()!.metadata.title,"After","late notifications cannot restore an older revision");
  const saved = {...after,dirty:false,project_path:"saved.mteproj"};
  (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => saved;
  await rpc("project.save",{document_id:after.id,base_revision:after.revision});
  setDocument({...after,dirty:true,project_path:null});
  assert.equal(host.getDocument()!.dirty,false,"late edit notifications cannot undo the acknowledged save");
  assert.equal(host.getDocument()!.project_path,"saved.mteproj");
  const background = {...after,id:"background",revision:2};
  (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => background;
  await rpc("document.apply",{document_id:background.id});
  assert.equal(host.getDocument()!.id,"active","background edits cannot replace the active book");
  (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => before;
  await rpc("project.open",{path:"saved.mteproj"});
  assert.equal(host.getDocument()!.revision,0,"explicitly reopening a saved book can restore its saved revision");
  const importer = {id:"test.import",format:{direction:"import",name:"SCAN",extensions:["scan"]}};
  (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => ({plugins:{active:[importer,{id:"test.workspace"}]}});
  await rpc("app.info");
  assert.deepEqual(host.getFormats!(),[importer],"format menus use active providers rather than all installed plugins");
  (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => ({active:[]});
  await rpc("plugins.list");
  assert.deepEqual(host.getFormats!(),[],"removing providers cannot leave a hidden built-in format available");
  delete (globalThis as any).window;
});

test("window documents filter events and abort cancels only the task that owns its signal", async () => {
  const callbacks = new Map<number, (event: any) => void>(), events = new Map<string, number>();
  const targets = new Map<string, unknown>();
  const jobs = new Map<string, Task>(), cancelled: string[] = [];
  let next = 0;
  const publish = (method: string, params: unknown) => callbacks.get(events.get("engine-event")!)!({payload: {method, params}});
  (globalThis as any).window = {
    location: {search: ""},
    __TAURI_EVENT_PLUGIN_INTERNALS__: {unregisterListener: () => {}},
    __TAURI_INTERNALS__: {
      metadata: {currentWindow: {label: "main"}},
      transformCallback: (callback: (event: any) => void) => {const id = ++next; callbacks.set(id, callback); return id;},
      invoke: async (command: string, args: any) => {
        if (command === "plugin:event|listen") {events.set(args.event, args.handler); targets.set(args.event, args.target); return args.handler;}
        if (command !== "engine_call") return;
        if (args.method === "task.start") {
          const job = {id: `job-${++next}`, state: "queued", operation: "export", progress: {done: 0, total: 1, message: "Preparing"}, error: null, result: null} as Task;
          jobs.set(job.id, job);
          return job;
        }
        if (args.method === "task.cancel") {
          cancelled.push(args.params.id);
          publish("task.changed", {...jobs.get(args.params.id), state: "cancelled"});
        }
      },
    },
  };
  const {bindDocument, connect, createHost, setDocument} = await import("../desktop/bridge.ts");
  const host = createHost(error => {throw error;}, () => {});
  const stop = await connect(() => {});
  assert.deepEqual(targets.get("ui-select-page"), {kind: "AnyLabel", label: "main"}, "targeted selection cannot reach another editor for the same document");
  const first = {schema: 1, id: "first", revision: 0, pages: [], dirty: false} as unknown as Book;
  const second = {...first, id: "second"};
  setDocument(first, true);
  publish("document.changed", second);
  assert.equal(host.getDocument()!.id, first.id);
  publish("document.activated", second);
  publish("document.changed", {...second, revision: 1});
  publish("document.activated", second);
  assert.equal(host.getDocument()!.revision, 1, "late activation cannot roll back acknowledged edits");
  bindDocument(first.id);
  setDocument(first, true);
  publish("document.activated", second);
  publish("document.changed", {...first, revision: 1});
  assert.equal(host.getDocument()!.id, first.id);
  assert.equal(host.getDocument()!.revision, 1);
  const abort = new AbortController();
  const aborted = assert.rejects(host.task({operation: "export"}, abort.signal), error => !!(error as {cancelled?: boolean}).cancelled);
  const remaining = host.task<{path: string}>({operation: "export"});
  await Promise.resolve();
  await Promise.resolve();
  const [a, b] = [...jobs.values()];
  abort.abort();
  await aborted;
  assert.deepEqual(cancelled, [a.id]);
  publish("task.changed", {...b, state: "completed", result: {path: "second.epub"}});
  assert.equal((await remaining).path, "second.epub");
  stop();
  delete (globalThis as any).window;
});
