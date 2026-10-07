import assert from "node:assert/strict";
import { test } from "node:test";
import { closeBookWindows, toolWindowPosition } from "../desktop/tool-windows.ts";

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
