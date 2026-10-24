import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePreference = "system" | "light" | "dark";

export function getThemePreference(): ThemePreference {
  const value = localStorage.getItem("theme");
  return value === "light" || value === "dark" ? value : "system";
}

export function setThemePreference(value: ThemePreference) {
  localStorage.setItem("theme", value);
  window.dispatchEvent(new Event("foluma-theme"));
}

export function subscribeTheme(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === "theme" || event.key === null) listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener("foluma-theme", listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener("foluma-theme", listener);
  };
}

export function initializeTheme() {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const preference = getThemePreference();
    document.documentElement.dataset.theme = preference === "system" ? system.matches ? "dark" : "light" : preference;
    if (isTauri()) void getCurrentWindow().setTheme(preference === "system" ? null : preference).catch(console.error);
  };
  const stop = subscribeTheme(apply);
  system.addEventListener("change", apply);
  apply();
  return () => { stop(); system.removeEventListener("change", apply); };
}
