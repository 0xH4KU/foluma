import assert from "node:assert/strict";
import { test } from "node:test";
import { exportSelection } from "../sdk/export-settings.ts";
import type { Plugin } from "../sdk/types.ts";

test("export preferences restore each format's edition and fall back when providers or editions disappear", () => {
  const formats = [
    { id: "import", format: { direction: "import", extensions: ["pdf"] } },
    { id: "epub", format: { direction: "export", variants: [
      { id: "general", options: {} }, { id: "spread", options: { spread: true } },
    ] } },
    { id: "pdf", format: { direction: "export" } },
  ] as Plugin[];
  const saved = JSON.stringify({ format: "epub", variants: { epub: "spread" } });
  assert.equal(exportSelection(formats, saved).outputFormat?.id, "epub");
  assert.deepEqual(exportSelection(formats, saved).variant?.options, { spread: true });
  assert.equal(exportSelection(formats, JSON.stringify({ format: "pdf", variants: { epub: "spread" } })).variant, undefined);
  assert.equal(exportSelection(formats.slice(2), saved).outputFormat?.id, "pdf");
  assert.equal(exportSelection(formats, JSON.stringify({ format: "epub", variants: { epub: "removed" } })).variant?.id, "general");
  for (const invalid of [null, "{", "null", "42", '{"format":false,"variants":{"epub":false}}']) {
    assert.equal(exportSelection(formats, invalid).variant?.id, "general");
  }
  assert.deepEqual(exportSelection([], saved), { exporters: [], outputFormat: undefined, variant: undefined });
});
