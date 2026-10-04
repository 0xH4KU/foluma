import assert from "node:assert/strict";
import { test } from "node:test";
import {
  informationRows,
  initialInformation,
  suggestedFolder,
  volumeNumber,
} from "../desktop/book-information.ts";

test("book information preserves volume gaps and original authors, and permits custom side-story titles", () => {
  const sources = ["作品 第01卷", "Vol.2", "漫畫１０", "外傳"].map((title, index) => ({
    key: String(index),
    title,
    metadata: { author: "Original author" },
  }));
  const options = { ...initialInformation("New series", true), direction: "ltr" as const };
  const rows = informationRows(sources, options, { "3": { title: "New series 外傳" } });
  assert.deepEqual(
    rows.map((row) => row.newTitle),
    ["New series 第01卷", "New series 第02卷", "New series 第10卷", "New series 外傳"],
  );
  assert.ok(
    rows.every((row) => !row.error && row.patch.direction === "ltr" && !("author" in row.patch)),
  );
  assert.equal(volumeNumber("Book Vol.01.pdf"), "1");
  assert.equal(volumeNumber("Vol.1"), "1");
  assert.equal(volumeNumber("Special"), "");
  assert.equal(volumeNumber("Book 10000.pdf"), "");
  assert.ok(informationRows(sources, options)[3].error);
});

test("sequential volume previews follow the chosen order and skip excluded books", () => {
  const sources = ["Ten", "Side story", "Two"].map((title) => ({ key: title, title }));
  const options = {
    ...initialInformation("Series", true),
    numbering: "sequence" as const,
    start: 7,
    digits: 3,
    suffix: "Vol. {number}" as const,
    author: "Writer",
  };
  const rows = informationRows(sources, options, { "Side story": { included: false } });
  assert.deepEqual(
    rows.filter((row) => row.included).map((row) => row.newTitle),
    ["Series Vol. 007", "Series Vol. 008"],
  );
  assert.ok(rows.every((row) => row.patch.author === "Writer"));
  const reordered = informationRows([sources[2], sources[0]], options);
  assert.deepEqual(
    reordered.map((row) => [row.key, row.newTitle]),
    [
      ["Two", "Series Vol. 007"],
      ["Ten", "Series Vol. 008"],
    ],
  );
  assert.ok(informationRows(sources, { ...options, start: 9999 })[2].error);
  assert.ok(informationRows(sources, options, { Ten: { title: "" } })[0].error);
});

test("author-only edits retain titles and reject invalid metadata before applying", () => {
  const source = [{ key: "book", title: "Keep title" }];
  const options = { ...initialInformation("Unused"), author: "New author" };
  assert.deepEqual(informationRows(source, options)[0].patch, { author: "New author" });
  assert.ok(informationRows(source, { ...options, language: "not a language" })[0].error);
  assert.equal(suggestedFolder("作品名: 特別篇 / 版"), "作品名_ 特別篇 _ 版");
  assert.equal(suggestedFolder("CON"), "book-CON");
});
