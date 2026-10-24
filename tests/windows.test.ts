import assert from "node:assert/strict";
import { test } from "node:test";
import { closeBookWindows, openToolWindow, toolWindowPosition } from "../desktop/tool-windows.ts";

test("tool windows use available space outside their parent, including scaled and negative-origin monitors", () => {
  const size = {width: 360, height: 480};
  const screen = {x: 0, y: 0, width: 2000, height: 1200, scale: 1};
  assert.deepEqual(toolWindowPosition({x: 100, y: 100, width: 1200, height: 800}, size, [screen]), {x: 1310, y: 100});
  assert.deepEqual(toolWindowPosition({x: 900, y: 100, width: 1000, height: 800}, size, [screen]), {x: 530, y: 100});
  assert.deepEqual(toolWindowPosition({x: -1500, y: 100, width: 1000, height: 800}, size,
    [{...screen, x: -1920, width: 1920}]), {x: -490, y: 100});
  assert.deepEqual(toolWindowPosition({x: 200, y: 100, width: 2000, height: 1200}, size, [
    {...screen, width: 2400, height: 2000, scale: 2},
    {...screen, x: 2400, width: 1920, height: 1080},
  ]), {x: 2410, y: 100});
  const fallback = toolWindowPosition({x: 0, y: 0, width: 2000, height: 1200}, size, [screen]);
  assert.ok(fallback.x >= 0 && fallback.y >= 0);
  assert.ok(fallback.x + size.width <= screen.width && fallback.y + size.height <= screen.height,
    "when there is no outside space, the complete tool window must remain visible");
});

test("persistent tools reuse their owner window across books without moving, while document tools stay bound", async () => {
  const windows = new Set(["main"]);
  const created: {label: string; url: string}[] = [], positioned: string[] = [], shown: string[] = [];
  const metadata = {currentWindow: {label: "main"}};
  (globalThis as any).window = {__TAURI_INTERNALS__: {metadata, invoke: async (command: string, args: any) => {
    if (command === "plugin:window|get_all_windows") return [...windows];
    if (command === "plugin:webview|create_webview_window") {created.push(args.options); windows.add(args.options.label); return;}
    if (command === "plugin:window|outer_position") return {x: 100, y: 100};
    if (command === "plugin:window|outer_size") return args.label.startsWith("tool-") ? {width: 300, height: 280} : {width: 1200, height: 800};
    if (command === "plugin:window|scale_factor") return 1;
    if (command === "plugin:window|available_monitors") return [];
    if (command === "plugin:window|set_position") {positioned.push(args.label); return;}
    if (command === "plugin:window|show") {shown.push(args.label); return;}
    if (command === "plugin:window|set_focus") return;
    assert.fail(`Unexpected window command: ${command}`);
  }}};
  const options = {plugin: "org.foluma.page-tools", view: "crop", title: "Crop", width: 300, height: 280, persistent: true};
  try {
    await openToolWindow(options, "first");
    await openToolWindow(options, "second");
    assert.equal(created.length, 1, "switching books must reuse the existing crop window");
    assert.deepEqual(positioned, [created[0].label], "reopening must keep the user's window position");
    assert.deepEqual(shown, [created[0].label, created[0].label]);
    const persistent = new URL(created[0].url, "http://foluma.local/").searchParams;
    assert.equal(persistent.get("parent"), "main");
    assert.equal(persistent.has("document"), false, "persistent controls must not retain the original book");
    for (const id of ["first", "second"]) await openToolWindow({...options, persistent: false}, id);
    assert.equal(created.length, 3);
    assert.equal(new URL(created[1].url, "http://foluma.local/").searchParams.get("document"), "first");
    assert.equal(new URL(created[2].url, "http://foluma.local/").searchParams.get("document"), "second");
    metadata.currentWindow.label = "book-other";
    await openToolWindow(options, "first");
    assert.equal(created.length, 4, "another editor must keep its own persistent crop window");
    assert.notEqual(created[0].label, created[3].label);
  } finally {delete (globalThis as any).window;}
});

test("closing peer editors waits for approval and preserves a window that cancels", async () => {
  const windows = new Set(["main", "book-one", "book-two", "tool-book-one__spreads", "tool-main__spreads"]);
  const callbacks = new Map<number, (event: any) => void>();
  const prepared: string[] = [], destroyed: string[] = [], released: string[] = [];
  let next = 0, reply = 0, allowSecond = false;
  (globalThis as any).window = {
    __TAURI_EVENT_PLUGIN_INTERNALS__: {unregisterListener: () => {}},
    __TAURI_INTERNALS__: {
      metadata: {currentWindow: {label: "main"}},
      transformCallback: (callback: (event: any) => void) => {callbacks.set(++next, callback); return next;},
      invoke: async (command: string, args: any) => {
        if (command === "plugin:window|get_all_windows") return [...windows];
        if (command === "plugin:event|listen") {
          assert.deepEqual(args.target, {kind: "AnyLabel", label: "main"});
          reply = args.handler;
          return reply;
        }
        if (command === "plugin:event|emit_to") {
          prepared.push(args.target.label);
          callbacks.get(reply)!({payload: {request: args.payload.request, accepted: allowSecond || args.target.label !== "book-two"}});
        }
        if (command === "plugin:window|destroy") {destroyed.push(args.label); windows.delete(args.label);}
        if (command === "engine_call" && args.method === "document.release_window") {
          assert.ok(!windows.has(args.params.window_id), "retention must last until the peer has actually closed");
          released.push(args.params.window_id);
        }
      },
    },
  };
  try {
    assert.equal(await closeBookWindows(), false);
    assert.deepEqual(prepared, ["book-one", "book-two"]);
    assert.deepEqual(destroyed, ["tool-book-one__spreads", "book-one"]);
    assert.deepEqual(released, ["tool-book-one__spreads", "book-one"]);
    assert.deepEqual([...windows], ["main", "book-two", "tool-main__spreads"]);
    allowSecond = true;
    assert.equal(await closeBookWindows(), true);
    assert.deepEqual([...windows], ["main"]);
    assert.deepEqual(released, ["tool-book-one__spreads", "book-one", "book-two", "tool-main__spreads"]);
  } finally {delete (globalThis as any).window;}
});
