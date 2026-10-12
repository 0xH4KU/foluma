import assert from "node:assert/strict";
import { test } from "node:test";
import type { Book } from "../sdk/types.ts";
import { DEFAULT_SETTINGS, dragFrame, initialCanvas, pageSettings, pageSide, placement, PLUGIN_ID, rotatedSize, selectedEdits, validSettings } from "../plugins/page-layout/src/layout.ts";

const book: Book = {
  schema: 1, id: "book", revision: 0, assets: {}, sources: {}, extensions: {}, project_path: null,
  dirty: false, can_undo: false, can_redo: false,
  metadata: { title: "Comic", author: "", language: "ja", direction: "rtl", cover_id: "one", cover_only: false },
  pages: ["one", "two", "three"].map(id => ({ id, kind: "image", asset_id: id, width: 200, height: 300, crop: [0, 0, 1, 1] })),
};

test("batch targets retain individual frame bounds and angles while sharing reading scale", () => {
  const first = { ...DEFAULT_SETTINGS, frame: [0.1, 0.2, 0.7, 0.6] as [number, number, number, number], angle: 2 };
  const second = { ...DEFAULT_SETTINGS, frame: [0.05, 0.08, 0.9, 0.8] as [number, number, number, number], angle: -1 };
  const target = structuredClone(book);
  target.extensions[PLUGIN_ID] = { schema: 1, pages: { two: { settings: second } } };
  const before = structuredClone(target);
  const edits = selectedEdits(target, new Set(["one", "two"]), { one: first }, { ...first, height: 70, inner: 5 });
  assert.deepEqual(edits.one.frame, first.frame);
  assert.deepEqual(edits.two.frame, second.frame);
  assert.equal(edits.one.angle, 2);
  assert.equal(edits.two.angle, -1);
  assert.equal(edits.two.height, 70);
  assert.equal(edits.two.inner, 5);
  assert.deepEqual(target, before);
});

test("frame handles stay inside the source and never produce empty or reversed rectangles", () => {
  const frame: [number, number, number, number] = [0.2, 0.1, 0.6, 0.8];
  assert.deepEqual(dragFrame(frame, 10, -10, "move"), [0.4, 0, 0.6, 0.8]);
  for (const handle of ["nw", "ne", "sw", "se"] as const) {
    for (const delta of [-10, 10]) {
      const [x, y, width, height] = dragFrame(frame, delta, delta, handle);
      assert.ok(x >= 0 && y >= 0 && width >= 0.0099 && height >= 0.0099);
      assert.ok(x + width <= 1.000001 && y + height <= 1.000001);
    }
  }
});

test("frame placement is isotropic, aligns the inner edge and follows the current reading order", () => {
  const source = { width: 200, height: 300 }, canvas: [number, number] = [200, 300];
  const settings = { ...DEFAULT_SETTINGS, height: 80, frame: [0.2, 0.1, 0.6, 0.8] as [number, number, number, number] };
  assert.deepEqual(placement(source, canvas, settings, "left"), [1, 0, -0, 1, 32, 0]);
  assert.deepEqual(placement(source, canvas, settings, "right"), [1, 0, -0, 1, -32, 0]);
  for (const angle of [-5, -2.5, 0, 2.5, 5]) {
    const [a, b, c, d] = placement(source, canvas, { ...settings, angle }, "left");
    assert.ok(Math.abs(a * c + b * d) < 1e-10);
    assert.ok(Math.abs(Math.hypot(a, b) - Math.hypot(c, d)) < 1e-10);
    assert.ok(rotatedSize(source, angle).every(size => Number.isInteger(size) && size > 0));
  }
  assert.deepEqual(book.pages.map(page => pageSide(book, page.id)), ["left", "right", "left"]);
  const changed = structuredClone(book);
  changed.pages.unshift({ id: "blank", kind: "blank", width: 200, height: 300 });
  assert.equal(pageSide(changed, "two"), "left", "inserted blanks change the actual outer edge");
  changed.metadata.cover_only = true;
  assert.equal(pageSide(changed, "one"), "center");
  assert.equal(pageSide(changed, "two"), "right");
  changed.metadata.direction = "ltr";
  assert.equal(pageSide(changed, "two"), "left");
});

test("malformed saved adjustment values stay out of previews and use editable defaults", () => {
  for (const invalid of [null, [], {}, { ...DEFAULT_SETTINGS, angle: NaN }, { ...DEFAULT_SETTINGS, height: "81" },
    { ...DEFAULT_SETTINGS, frame: [0.5, 0, 1, 1] }, { ...DEFAULT_SETTINGS, offset_y: Infinity }]) {
    assert.equal(validSettings(invalid), false);
    const saved = structuredClone(book);
    saved.extensions[PLUGIN_ID] = { schema: 1, canvas: [0, "bad"], reference: { settings: invalid }, pages: { two: { settings: invalid } } };
    assert.deepEqual(pageSettings(saved, "two"), DEFAULT_SETTINGS);
    assert.deepEqual(initialCanvas(saved), [200, 300]);
  }
  assert.equal(validSettings(DEFAULT_SETTINGS), true);
});
