import assert from "node:assert/strict";
import { test } from "node:test";
import { cropBox, cropFromMargins, imagePlacement, joinedSpread, pageColors, pageSize, pagesWithoutMargins, spreadGroups } from "../sdk/page-layout.ts";
import { detectColor } from "../plugins/page-tools/src/detect-color.ts";
import type { Book, Page } from "../sdk/types.ts";

function fixture(): Book {
  return {
    schema: 1, id: "book", revision: 1, metadata: { title: "Book", author: "", language: "en", direction: "rtl", cover_only: false, cover_id: "a" },
    pages: ["a", "b", "c"].map(id => ({ id, kind: "image", asset_id: id, width: 200, height: 100, crop: [0, 0, 1, 1] })),
    assets: {}, sources: {}, extensions: { "org.foluma.editor": { spreads: [["b", "c"]] } }, project_path: null,
    dirty: false, can_undo: false, can_redo: false,
  };
}

test("crop percentages follow the displayed orientation and compose with an existing crop", () => {
  const page = fixture().pages[0];
  const expected = [[0.1, 0.2, 0.6, 0.4], [0.2, 0.3, 0.4, 0.6], [0.3, 0.4, 0.6, 0.4], [0.4, 0.1, 0.4, 0.6]];
  for (const [index, rotation] of ([0, 90, 180, 270] as const).entries()) {
    const crop = cropFromMargins({ ...page, rotation }, [10, 20, 30, 40])!;
    crop.forEach((value, i) => assert.ok(Math.abs(value - expected[index][i]) < 1e-10));
  }
  assert.deepEqual(cropFromMargins({ ...page, crop: [0.25, 0.1, 0.5, 0.8] }, [10, 0, 10, 0]), [0.3, 0.1, 0.4, 0.8]);
  for (const margins of [[50, 0, 50, 0], [0, -1, 0, 0], [0, 0, 0, NaN]] as [number, number, number, number][])
    assert.throws(() => cropFromMargins(page, margins), /Invalid crop/);
});

test("ordinary pages have four margins while marked facing pages meet at the spine", () => {
  const normal = imagePlacement(1000, 1000, [1000, 1000]);
  assert.deepEqual(normal, { x: 20, y: 20, width: 960, height: 960 });
  const left = imagePlacement(500, 1000, [1000, 1000], "left");
  const right = imagePlacement(500, 1000, [1000, 1000], "right");
  assert.equal(left.x + left.width, 1000);
  assert.equal(right.x, 0);
  const shortLeft = imagePlacement(1200, 1000, [1000, 1000], "left", 1000 / 1200);
  const shortRight = imagePlacement(500, 1000, [1000, 1000], "right", 1000 / 1200);
  assert.equal(shortLeft.height, shortRight.height);
  assert.equal(shortLeft.y, shortRight.y);
  assert.equal(shortLeft.x + shortLeft.width, 1000);
  assert.equal(shortRight.x, 0);
  const book = fixture();
  assert.equal(joinedSpread(book, spreadGroups(book, true)[0]), false);
  assert.equal(joinedSpread(book, spreadGroups(book, true)[1]), true);
  book.metadata.direction = "ltr";
  assert.equal(joinedSpread(book, spreadGroups(book, true)[1]), true);
  assert.equal(joinedSpread(book, [book.pages[0], book.pages[1]]), false);
  assert.equal(joinedSpread(book, [book.pages[1], { id: "c", kind: "blank", width: 200, height: 100 }]), false);
});

test("disabling a page's extra margins keeps the canvas and image proportions", () => {
  assert.deepEqual(imagePlacement(1000, 1000, [1000, 1000], undefined, 1, true),
    { x: 0, y: 0, width: 1000, height: 1000 });
  assert.deepEqual(imagePlacement(1000, 500, [1000, 1000], undefined, 1, true),
    { x: 0, y: 250, width: 1000, height: 500 });
  const book = fixture();
  book.extensions["org.foluma.page-tools"] = { no_margins: ["a", "a", "b", "gone", 1, null] };
  assert.deepEqual(pagesWithoutMargins(book), ["a", "b"]);
  book.pages[0] = { id: "a", kind: "blank", width: 100, height: 100 };
  assert.deepEqual(pagesWithoutMargins(book), ["b"]);
  for (const value of [null, [], "bad", { no_margins: "b" }, { no_margins: {} }]) {
    book.extensions["org.foluma.page-tools"] = value;
    assert.deepEqual(pagesWithoutMargins(book), []);
  }
});

test("preview crop dimensions match the export's integer bounds, rounding and rotation", () => {
  const page: Page = { ...fixture().pages[0], width: 17, height: 13, crop: [0.13, 0.17, 0.53, 0.41] };
  assert.deepEqual(cropBox(page), [2, 2, 11, 8]);
  assert.deepEqual(pageSize(page), [9, 6]);
  assert.deepEqual(pageSize({ ...page, rotation: 90 }), [6, 9]);
  assert.deepEqual(cropBox({ ...page, width: 10, height: 10, crop: [0.05, 0.25, 0.8, 0.4] }), [0, 2, 8, 6]);
  assert.deepEqual(pageSize({ ...page, width: 1, height: 1, crop: [0.99, 0.99, 0.01, 0.01] }), [1, 1]);
});

test("confirmed page colors survive without the tool and ignore malformed or stale entries", () => {
  const book = fixture();
  book.extensions["org.foluma.page-tools"] = { colors: { a: "black", b: "white", c: "red", gone: "black" } };
  assert.deepEqual(pageColors(book), { a: "black", b: "white" });
  book.pages[0] = { id: "a", kind: "blank", width: 100, height: 100 } as Page;
  assert.deepEqual(pageColors(book), { b: "white" });
  for (const value of [null, [], "bad", { colors: [] }, { colors: 3 }]) {
    book.extensions["org.foluma.page-tools"] = value;
    assert.deepEqual(pageColors(book), {});
  }
});

function pixels(edge: number, inside: number) {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const offset = (y * 100 + x) * 4, value = x < 5 || y < 5 || x >= 95 || y >= 95 ? edge : inside;
    data.set([value, value, value, 255], offset);
  }
  return data;
}

test("color detection uses the visible border, tolerates noise and flags mixed edges", () => {
  assert.deepEqual(detectColor(pixels(245, 10), 100, 100), { color: "white", certain: true });
  assert.deepEqual(detectColor(pixels(10, 245), 100, 100), { color: "black", certain: true });
  assert.deepEqual(detectColor(pixels(245, 10), 100, 100, [10, 10, 10, 10]), { color: "black", certain: true });
  assert.deepEqual(detectColor(pixels(128, 128), 100, 100), { color: "white", certain: false });
  const mixed = pixels(0, 0);
  for (let offset = mixed.length / 2; offset < mixed.length; offset += 4) mixed.set([255, 255, 255, 255], offset);
  assert.deepEqual(detectColor(mixed, 100, 100), { color: "white", certain: false });
  assert.deepEqual(detectColor(new Uint8ClampedArray(100 * 100 * 4), 100, 100), { color: "white", certain: true });
});

test("opposite black borders remain black when the other edges contain light artwork", () => {
  for (const horizontal of [false, true]) {
    const data = pixels(128, 245);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const [across, along] = horizontal ? [y, x] : [x, y];
      if (across >= 95 || across < 5 && along < 63) data.set([0, 0, 0, 255], (y * 100 + x) * 4);
    }
    assert.deepEqual(detectColor(data, 100, 100), { color: "black", certain: true });
    assert.deepEqual(detectColor(data, 100, 100, [10, 10, 10, 10]), { color: "white", certain: true });
  }
  const scannerLine = pixels(245, 0);
  for (let y = 0; y < 100; y++) scannerLine.set([0, 0, 0, 255], y * 100 * 4);
  assert.deepEqual(detectColor(scannerLine, 100, 100), { color: "white", certain: true });
  const conflicting = pixels(255, 255);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++)
    if (x < 5 || x >= 95) conflicting.set([0, 0, 0, 255], (y * 100 + x) * 4);
  assert.deepEqual(detectColor(conflicting, 100, 100), { color: "black", certain: false });
});
