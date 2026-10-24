import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getThemePreference, initializeTheme, setThemePreference } from "../desktop/theme.ts";

test("appearance follows the system, persists overrides and synchronizes native windows and storage changes", () => {
  const saved = new Map<string, string>();
  const system = Object.assign(new EventTarget(), { matches: false });
  const native: (string | null)[] = [];
  const dataset: Record<string, string> = {};
  const globals = {
    isTauri: true,
    document: { documentElement: { dataset } },
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
    window: Object.assign(new EventTarget(), {
      matchMedia: () => system,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string, args: { value: string | null }) => {
          assert.equal(command, "plugin:window|set_theme");
          native.push(args.value);
        },
      },
    }),
  };
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const storage = (key: string | null) => globals.window.dispatchEvent(Object.assign(new Event("storage"), { key }));
  let stop = () => {};
  try {
    assert.equal(getThemePreference(), "system");
    saved.set("theme", "invalid");
    assert.equal(getThemePreference(), "system");
    stop = initializeTheme();
    assert.equal(dataset.theme, "light");
    assert.equal(native.at(-1), null);
    system.matches = true;
    system.dispatchEvent(new Event("change"));
    assert.equal(dataset.theme, "dark");

    setThemePreference("light");
    assert.equal(saved.get("theme"), "light");
    assert.equal(dataset.theme, "light");
    assert.equal(native.at(-1), "light");
    system.dispatchEvent(new Event("change"));
    assert.equal(dataset.theme, "light", "an explicit choice must override a dark system");
    saved.set("theme", "dark");
    const count = native.length;
    storage("export-settings");
    assert.equal(native.length, count, "unrelated preferences must not reset native appearance");
    storage("theme");
    assert.equal(dataset.theme, "dark");
    assert.equal(native.at(-1), "dark");

    stop();
    dataset.theme = "light";
    stop = initializeTheme();
    assert.equal(dataset.theme, "dark", "a new window must immediately restore the saved theme");
    saved.clear();
    system.matches = false;
    storage(null);
    assert.equal(dataset.theme, "light");
    assert.equal(native.at(-1), null);
    stop();
    system.matches = true;
    system.dispatchEvent(new Event("change"));
    storage("theme");
    assert.equal(dataset.theme, "light", "disposed windows must remove their listeners");
  } finally {
    stop();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("both palettes keep text, selection and feedback readable", () => {
  const css = readFileSync(new URL("../sdk/theme.css", import.meta.url), "utf8");
  const palettes = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]+)/g)].map(value => [value[1], value[2]])));
  assert.equal(palettes.length, 2);
  const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
  const pairs = [
    ["ink", "paper"], ["ink", "surface"], ["ink", "side"], ["ink", "hover"], ["ink", "stage"],
    ["ink", "placeholder"], ["muted", "paper"], ["muted", "surface"], ["muted", "side"],
    ["link", "surface"], ["link", "hover"], ["white", "selection"], ["white", "warning-action"],
    ["warning-ink", "warning-bg"], ["success-ink", "success-bg"], ["error-ink", "error-bg"],
  ];
  for (const [index, overrides] of palettes.entries()) {
    const palette: Record<string, string> = { ...palettes[0], ...overrides, white: "#ffffff" };
    for (const [foreground, background] of pairs) {
      const [a, b] = [luminance(palette[foreground]), luminance(palette[background])];
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= 4.5, `${index ? "Dark" : "Light"} ${foreground}/${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});
