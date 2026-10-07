import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { HostAPI, Plugin, PluginList, ProcessingSettings, RenderResolution } from "../sdk/types";
import { t, setLocale, type Locale } from "../sdk/i18n";
import { StorageSettings } from "./storage";
import { closeBookWindows } from "./tool-windows";

export function Preferences({
  host,
  plugins,
  bundled,
  busy,
  dpi,
  setDpi,
  locale,
  run,
  replaceAllowed,
  refreshPlugins,
  navigate,
  refreshPreviews,
  prepare,
}: {
  host: HostAPI;
  plugins: PluginList;
  bundled: Plugin[];
  busy: boolean;
  dpi: RenderResolution;
  setDpi: (value: RenderResolution) => void;
  locale: Locale;
  run: (action: () => Promise<unknown>, commit?: boolean) => Promise<void>;
  replaceAllowed: (title?: string) => Promise<boolean>;
  refreshPlugins: () => Promise<void>;
  navigate: (tab: string) => Promise<void>;
  refreshPreviews: () => void;
  prepare: () => Promise<void>;
}) {
  const importers = plugins.active.filter((plugin) => plugin.format?.direction === "import");
  const [processing, setProcessing] = useState<ProcessingSettings | null>(null);
  const [savingProcessing, setSavingProcessing] = useState(false);
  useEffect(() => {
    let active = true;
    host.rpc<ProcessingSettings>("processing.get").then(value => {if (active) setProcessing(value);}).catch(host.report);
    return () => {active = false;};
  }, [host]);
  const saveProcessing = async () => {
    if (!processing || savingProcessing) return;
    setSavingProcessing(true);
    try {
      setProcessing(await host.rpc<ProcessingSettings>("processing.configure", processing));
      host.notify(t("Processing preferences saved"));
    } catch (error) {host.report(error);}
    finally {setSavingProcessing(false);}
  };

  const useLanguage = (code: string) =>
    run(async () => {
      if (!locale.available.some((item) => item.code === code)) {
        const pack = bundled.find((item) => item.language?.locale === code);
        if (!pack) throw new Error(t("Interface language is not available"));
        if (!plugins.items.some((item) => item.id === pack.id))
          await host.rpc("plugins.install_bundled", { id: pack.id });
        await host.rpc("plugins.set_enabled", { id: pack.id, enabled: true });
        await refreshPlugins();
      }
      setLocale(await host.rpc<Locale>("app.locale", { code }));
      host.notify(t("Interface language changed"));
    });

  return (
    <section className="content settings">
      <div className="page-heading">
        <h1>{t("Preferences")}</h1>
      </div>
      <article className="settings-row">
        <div>
          <h2>{t("Background processing")}</h2>
          <p>{t("Prepare books when a project opens. Saved results are reused; pages requiring rendering wait for your confirmation.")}</p>
          <p>{t("Exports use the book version at the start of each export. Editing can continue while tasks run.")}</p>
        </div>
        <form onSubmit={event => {event.preventDefault(); void saveProcessing();}}>
          <fieldset disabled={!processing || savingProcessing} className="processing-settings">
            <label><input type="checkbox" checked={processing?.preparse ?? true}
              onChange={event => setProcessing(value => value && {...value, preparse: event.target.checked})}/>{t("Preparse project books")}</label>
            <label>{t("Parsing concurrency")}<input type="number" required min="1" max="8" step="1"
              value={processing?.parse_concurrency ?? 2}
              onChange={event => setProcessing(value => value && {...value, parse_concurrency: Number(event.target.value)})}/></label>
            <label><input type="checkbox" checked={processing?.parallel_export ?? true}
              onChange={event => setProcessing(value => value && {...value, parallel_export: event.target.checked})}/>{t("Export books concurrently")}</label>
            <label>{t("Export concurrency")}<input type="number" required min="1" max="8" step="1" disabled={!processing?.parallel_export}
              value={processing?.export_concurrency ?? 2}
              onChange={event => setProcessing(value => value && {...value, export_concurrency: Number(event.target.value)})}/></label>
            <button>{t("Save preferences")}</button>
          </fieldset>
        </form>
      </article>
      {importers.some((plugin) => plugin.format?.rendering) && (
        <article className="settings-row">
          <div>
            <h2>{t("Complex page rendering")}</h2>
            <p>
              {t(
                "Auto follows the main image’s resolution, up to 6000 pixels on the longest edge. Text and vector pages use 200 DPI within that limit. Rendering requires confirmation.",
              )}
            </p>
          </div>
          <label>
            {t("Resolution")}
            <select
              value={dpi}
              onChange={(e) => setDpi(e.target.value === "auto" ? "auto" : Number(e.target.value))}
            >
              <option value="auto">{t("Auto (recommended)")}</option>
              {[72, 150, 200, 300, 400, 600].map((value) => (
                <option key={value} value={value}>
                  {value} DPI
                </option>
              ))}
            </select>
          </label>
        </article>
      )}
      <article className="settings-row">
        <div>
          <h2>{t("Interface language")}</h2>
          <p>{t("Changes menus and buttons. Book language controls book metadata separately.")}</p>
          <button onClick={() => void navigate("plugins")}>{t("Manage language packs")}</button>
        </div>
        <label>
          {t("Interface language")}
          <select
            value={locale.code}
            disabled={busy}
            onChange={(e) => void useLanguage(e.target.value)}
          >
            {locale.available.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
            {bundled
              .filter(
                (item) =>
                  item.language &&
                  !locale.available.some((value) => value.code === item.language!.locale),
              )
              .map((item) => (
                <option key={item.id} value={item.language!.locale}>
                  {t(
                    plugins.items.some((value) => value.id === item.id)
                      ? "Enable and use {0}"
                      : "Install and use {0}",
                    item.language!.name,
                  )}
                </option>
              ))}
          </select>
        </label>
      </article>
      <StorageSettings
        host={host}
        busy={busy}
        prepare={prepare}
        refreshPreviews={refreshPreviews}
      />
      <article className="settings-row">
        <div>
          <h2>{t("Safe mode")}</h2>
          <p>{t("Skip all plugins on the next launch to troubleshoot plugin issues.")}</p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (await replaceAllowed(t("Restart in safe mode"))) {
                if (!(await closeBookWindows(true))) return;
                await host.rpc("app.safe_mode");
                await invoke("restart_app");
              }
            })
          }
        >
          {t("Restart in safe mode")}
        </button>
      </article>
    </section>
  );
}
