import assert from "node:assert/strict";
import { test } from "node:test";
import type { Book, Page } from "../sdk/types.ts";
import {
  applyPreset,
  createPreset,
  insertBlankPage,
  navigatePage,
  pageSize,
  parseRange,
  restorePages,
  rotatePages,
  splitPages,
  spreadGroups,
  spreadPages,
} from "../plugins/editor/src/pages.ts";
import { moveBefore } from "../sdk/order.ts";
import { REVIEW_EXTENSION_ID, reviewData } from "../sdk/review.ts";
import { setSpreadMarks, spreadMarks, spreadRecommendations, toggleSpreadMark } from "../plugins/editor/src/spreads.ts";

function fixture(count = 4): Book {
  const pages: Page[] = Array.from({ length: count }, (_, index) => index + 1).map((n) => ({
    id: `page-${n}`,
    kind: "image",
    asset_id: `asset-${n}`,
    width: 1200,
    height: 1600,
    crop: [0, 0, 1, 1],
    source_page: n,
  }));
  return {
    schema: 1,
    id: "book",
    revision: 0,
    pages,
    assets: Object.fromEntries(
      pages.map((p) => [
        p.asset_id,
        { kind: "pdf", width: 1200, height: 1600, source_page: p.source_page, ext: "jpg" },
      ]),
    ),
    sources: { source: { path: "/test.pdf", page_count: count, sha256: "hash" } },
    extensions: {},
    metadata: {
      title: "書",
      author: "",
      language: "zh-Hant",
      direction: "rtl",
      cover_only: false,
      cover_id: pages[0].id,
    },
    dirty: true,
    can_undo: false,
    can_redo: false,
    project_path: null,
  };
}

test("the shared review contract reads legacy storage, removes stale marks and preserves other extension data", () => {
  const book = fixture();
  book.extensions["org.foluma.editor"] = { review: ["page-1", "page-1", "gone", {}, 1], extra: "keep" };
  assert.deepEqual(reviewData(book), { review: ["page-1"], extra: "keep" });
  book.pages = book.pages.slice(1);
  assert.deepEqual(reviewData(book).review, []);
  for (const value of [null, [], "invalid", { review: "invalid" }]) {
    book.extensions[REVIEW_EXTENSION_ID] = value;
    assert.deepEqual(reviewData(book).review, []);
  }
});

test("split, restore and leading preview gap preserve page identity", () => {
  const book = fixture(),
    ids = new Set(["page-1"]);
  const changes = splitPages(book, ids, 0.4);
  const split = {
    ...book,
    pages: changes.pages!,
    metadata: { ...book.metadata, ...changes.metadata },
  };
  assert.deepEqual(
    split.pages.slice(0, 2).map((p) => p.split?.side),
    ["right", "left"],
  );
  assert.deepEqual(split.pages[0].crop, [0.4, 0, 0.6, 1]);
  assert.deepEqual(restorePages(split, new Set([split.pages[1].id])).pages, book.pages);
  assert.deepEqual(
    spreadPages(book, "page-1", true).map((p) => p?.id || null),
    ["page-1", null],
  );
  assert.deepEqual(
    spreadPages(book, "page-2", true).map((p) => p?.id || null),
    ["page-3", "page-2"],
  );
  assert.deepEqual(
    book.pages.map((p) => p.id),
    ["page-1", "page-2", "page-3", "page-4"],
  );
});

test("leading preview gap changes pairing for both reading directions without editing the book", () => {
  const book = fixture(),
    before = structuredClone(book);
  const ids = (selected: string, gap: boolean) =>
    spreadPages(book, selected, gap).map((page) => page?.id || null);
  assert.deepEqual(ids("page-1", true), ["page-1", null]);
  assert.deepEqual(ids("page-2", true), ["page-3", "page-2"]);
  assert.deepEqual(ids("page-2", false), ["page-2", "page-1"]);
  assert.deepEqual(book, before);
  book.metadata.direction = "ltr";
  assert.deepEqual(ids("page-1", true), [null, "page-1"]);
  assert.deepEqual(ids("page-2", true), ["page-2", "page-3"]);
  assert.deepEqual(ids("page-2", false), ["page-1", "page-2"]);
  book.metadata.cover_only = true;
  assert.deepEqual(ids("page-1", true), ["page-1"]);
  assert.deepEqual(ids("page-2", true), [null, "page-2"]);
  assert.equal(book.pages.length, 4);
});

test("ranges and noncontiguous moves keep original order", () => {
  const pages = fixture().pages;
  assert.deepEqual(parseRange("1-2, 4", pages), ["page-1", "page-2", "page-4"]);
  assert.throws(() => parseRange("4-2", pages));
  assert.throws(() => parseRange("5", pages));
  assert.deepEqual(
    moveBefore(pages, new Set(["page-1", "page-3"]), null).map((p) => p.id),
    ["page-2", "page-4", "page-1", "page-3"],
  );
});

test("portable preset maps new source assets, embedded images and split restoration", () => {
  const book = fixture();
  book.assets.insert = { kind: "file", width: 60, height: 70, ext: "png", path: "/insert.png" };
  book.pages.splice(1, 0, {
    id: "insert",
    kind: "image",
    asset_id: "insert",
    width: 60,
    height: 70,
    crop: [0, 0, 1, 1],
  });
  const split = splitPages(book, new Set(["page-2"]));
  book.pages = split.pages!;
  const preset = createPreset(book);
  assert.deepEqual(preset.asset_ids, ["insert"]);
  const target = fixture();
  target.assets.newInsert = { ...book.assets.insert };
  target.assets.extra = { ...target.assets["asset-4"], source_page: 5 };
  target.pages.push({ ...target.pages[3], id: "page-5", asset_id: "extra", source_page: 5 });
  const applied = applyPreset(target, preset.payload, { insert: "newInsert" });
  assert.equal(applied.pages!.length, 7);
  assert.equal(applied.pages![1].asset_id, "newInsert");
  assert.equal(applied.pages!.at(-1)!.id, "page-5");
  const after = { ...target, pages: applied.pages! };
  assert.equal(restorePages(after, new Set([after.pages[2].id])).pages!.length, 6);
  delete target.assets["asset-3"];
  assert.throws(() => applyPreset(target, preset.payload, { insert: "newInsert" }));
});

test("moving selected pages handles both drop edges and no-op drops", () => {
  const pages = fixture().pages,
    selected = new Set(["page-2", "page-3"]);
  assert.deepEqual(
    moveBefore(pages, selected, "page-1").map((p) => p.id),
    ["page-2", "page-3", "page-1", "page-4"],
  );
  assert.deepEqual(
    moveBefore(pages, selected, null).map((p) => p.id),
    ["page-1", "page-4", "page-2", "page-3"],
  );
  assert.deepEqual(moveBefore(pages, selected, "page-2"), pages);
  assert.deepEqual(moveBefore(pages, selected, "page-4"), pages);
  assert.throws(() => moveBefore(pages, selected, "missing"));
});

test("spread navigation visits each visible pair once, including cover, gaps and inserted blanks", () => {
  for (const direction of ["rtl", "ltr"] as const)
    for (const cover_only of [false, true])
      for (const gap of [false, true]) {
        const book = fixture();
        book.metadata.direction = direction;
        book.metadata.cover_only = cover_only;
        book.pages = insertBlankPage(book, book.pages[2], true).pages!;
        const groups = spreadGroups(book, gap);
        assert.deepEqual(
          groups
            .flat()
            .filter(Boolean)
            .map((page) => page!.id)
            .sort(),
          book.pages.map((page) => page.id).sort(),
        );
        let current = book.pages[0],
          seen = new Set<string>();
        for (let i = 0; i < groups.length; i++) {
          const pair = spreadPages(book, current.id, gap)
            .filter(Boolean)
            .map((page) => page!.id)
            .sort()
            .join(",");
          assert.ok(!seen.has(pair), "same spread must not require a second forward action");
          seen.add(pair);
          const next = navigatePage(book, current.id, 1, true, gap);
          if (i === groups.length - 1) assert.equal(next, undefined);
          else {
            assert.ok(next);
            const previous = navigatePage(book, next.id, -1, true, gap)!;
            assert.deepEqual(
              spreadPages(book, previous.id, gap),
              spreadPages(book, current.id, gap),
            );
            current = next;
          }
        }
        assert.equal(navigatePage(book, book.pages[0].id, -1, true, gap), undefined);
      }
});

test("blank insertion preserves source identities and matches a cropped page's displayed dimensions", () => {
  const book = fixture(),
    original = structuredClone(book);
  const split = splitPages(book, new Set([book.pages[1].id]), 0.4);
  const cropped = { ...book, pages: split.pages! },
    page = cropped.pages[1];
  const before = insertBlankPage(cropped, page, true).pages!;
  assert.equal(before[1].kind, "blank");
  assert.equal(before[2].id, page.id);
  assert.equal(before[1].width, 720);
  assert.equal(before[1].height, 1600);
  const after = insertBlankPage(cropped, page, false).pages!;
  assert.equal(after[1].id, page.id);
  assert.equal(after[2].kind, "blank");
  assert.deepEqual(book, original);
});

test("manual spread marks preserve review data, validate selections and toggle by stable IDs", () => {
  const book = fixture();
  book.extensions[REVIEW_EXTENSION_ID] = { review: ["page-1"], extra: "keep" };
  const original = structuredClone(book);
  const changes = toggleSpreadMark(book, new Set(["page-3", "page-2"]));
  book.extensions[REVIEW_EXTENSION_ID] = changes.extension!.data;
  assert.deepEqual(spreadMarks(book), [["page-2", "page-3"]]);
  assert.deepEqual(reviewData(book).review, ["page-1"]);
  assert.equal(reviewData(book).extra, "keep");
  assert.deepEqual(book.pages, original.pages);
  assert.throws(() => toggleSpreadMark(book, new Set(["page-1", "page-2"])));
  assert.throws(() => toggleSpreadMark(book, new Set(["page-1", "page-4"])));
  assert.throws(() => toggleSpreadMark(book, new Set(["page-1", "missing"])));
  const removed = toggleSpreadMark(book, new Set(["page-3", "page-2"]));
  book.extensions[REVIEW_EXTENSION_ID] = removed.extension!.data;
  assert.deepEqual(spreadMarks(book), []);
  book.extensions[REVIEW_EXTENSION_ID] = { spreads: [["page-2", "page-3"], ["page-3", "page-2"], [], ["page-1", "page-1"], [1, 2]] };
  assert.deepEqual(spreadMarks(book), [["page-2", "page-3"]]);
});

test("quarter-turn rotations preserve source images, split in visual coordinates and travel with presets", () => {
  for (const direction of ["rtl", "ltr"] as const) {
    const original = fixture();
    original.metadata.direction = direction;
    let book = structuredClone(original);
    for (const angle of [90, 180, 270, 0] as const) {
      book = { ...book, pages: rotatePages(book, new Set(["page-2"])).pages! };
      assert.equal(book.pages[1].rotation || 0, angle);
      assert.deepEqual(pageSize(book.pages[1]), angle % 180 ? [1600, 1200] : [1200, 1600]);
      const blank = insertBlankPage(book, book.pages[1], true).pages![1];
      assert.deepEqual([blank.width, blank.height], pageSize(book.pages[1]));
      const split = { ...book, pages: splitPages(book, new Set(["page-2"]), 0.4).pages! };
      const halves = split.pages.filter((page) => page.split);
      const left = halves.find((page) => page.split!.side === "left")!;
      const right = halves.find((page) => page.split!.side === "right")!;
      const [width, height] = pageSize(book.pages[1]);
      assert.deepEqual(pageSize(left), [width * 0.4, height]);
      assert.deepEqual(pageSize(right), [width * 0.6, height]);
      assert.deepEqual(restorePages(split, new Set([left.id])).pages, book.pages);
      const preset = createPreset(split);
      const restored = { ...original, pages: applyPreset(original, preset.payload, {}).pages! };
      assert.equal(restored.pages[1].rotation || 0, angle);
      assert.equal(restorePages(restored, new Set([restored.pages[1].id])).pages![1].rotation || 0, angle);
    }
    assert.deepEqual(book.pages, original.pages, "four quarter turns restore the original page data");
    assert.deepEqual(book.assets, original.assets);
    const blankBook = { ...original, pages: insertBlankPage(original, original.pages[0], true).pages! };
    assert.equal(rotatePages(blankBook, new Set([blankBook.pages[0].id])).pages![0], blankBook.pages[0]);
  }
});

test("one blank can fix multiple marked spreads and every suggested boundary agrees with the actual preview", () => {
  const book = fixture(65);
  book.extensions[REVIEW_EXTENSION_ID] = setSpreadMarks(book, [["page-17", "page-18"], ["page-60", "page-61"]]).extension!.data;
  assert.equal(spreadRecommendations(book, true).suggestions.length, 2, "original page numbers alone do not determine parity");
  book.pages = insertBlankPage(book, book.pages[39], false).pages!;
  const original = structuredClone(book);
  const plan = spreadRecommendations(book, true);
  assert.deepEqual(plan.suggestions, [{ from: "page-1", to: "page-17" }]);
  assert.ok(plan.spreads.every((spread) => !spread.aligned && !spread.problem));
  for (let boundary = 0; boundary <= 16; boundary++) {
    const edited = { ...book, pages: insertBlankPage(book, book.pages[boundary], true).pages! };
    assert.equal(spreadRecommendations(edited, true).suggestions.length, 0);
    assert.ok(spreadRecommendations(edited, true).spreads.every((spread) => spread.aligned));
    for (const ids of spreadMarks(edited))
      assert.ok(spreadGroups(edited, true).some((group) => ids.every((id) => group.some((page) => page?.id === id))));
  }
  assert.deepEqual(book, original, "recommendations must not modify the document");
  for (const direction of ["rtl", "ltr"] as const)
    for (const cover_only of [false, true])
      for (const gap of [false, true]) {
        const target = fixture(8);
        target.metadata = { ...target.metadata, direction, cover_only };
        target.extensions[REVIEW_EXTENSION_ID] = setSpreadMarks(target, [["page-2", "page-3"], ["page-5", "page-6"]]).extension!.data;
        for (const location of ["from", "to"] as const) {
          const edited = structuredClone(target);
          for (const suggestion of spreadRecommendations(target, gap).suggestions)
            edited.pages = insertBlankPage(edited, edited.pages.find((page) => page.id === suggestion[location]), true).pages!;
          assert.ok(spreadRecommendations(edited, gap).spreads.every((spread) => spread.aligned));
          for (const ids of spreadMarks(edited))
            assert.ok(spreadGroups(edited, gap).some((group) => ids.every((id) => group.some((page) => page?.id === id))));
        }
      }
});

test("invalidated spread relationships stay removable and suppress unsafe recommendations", () => {
  const book = fixture();
  book.extensions[REVIEW_EXTENSION_ID] = setSpreadMarks(book, [["page-2", "page-3"]]).extension!.data;
  book.pages = insertBlankPage(book, book.pages[2], true).pages!;
  assert.ok(spreadRecommendations(book, true).spreads[0].problem);
  assert.deepEqual(spreadRecommendations(book, true).suggestions, []);
  book.pages = book.pages.filter((page) => page.id !== "page-2");
  assert.ok(spreadRecommendations(book, true).spreads[0].problem);
  book.extensions[REVIEW_EXTENSION_ID] = toggleSpreadMark(book, new Set(["page-2", "page-3"])).extension!.data;
  assert.deepEqual(spreadMarks(book), []);
  const cover = fixture();
  cover.metadata.cover_only = true;
  assert.throws(() => toggleSpreadMark(cover, new Set(["page-1", "page-2"])));
  cover.extensions[REVIEW_EXTENSION_ID] = setSpreadMarks(cover, [["page-1", "page-2"]]).extension!.data;
  assert.ok(spreadRecommendations(cover, true).spreads[0].problem);
  cover.metadata.cover_only = false;
  cover.extensions[REVIEW_EXTENSION_ID] = setSpreadMarks(cover, [["page-1", "page-2"], ["page-2", "page-3"]]).extension!.data;
  assert.ok(spreadRecommendations(cover, true).spreads.every((spread) => spread.problem));
  assert.deepEqual(spreadRecommendations(cover, true).suggestions, []);
});
