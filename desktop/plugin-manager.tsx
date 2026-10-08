import React, { useEffect, useState } from "react";
import type { HostAPI, Plugin, PluginList } from "../sdk/types";
import { t } from "../sdk/i18n";
import {
  availablePlugins,
  groupPlugins,
  pluginCategories,
  pluginCategory,
  pluginUpdates,
  uniquePlugins,
  type PluginFilter,
} from "./plugins";

function PluginGroups({
  groups,
  showTitles,
  render,
}: {
  groups: ReturnType<typeof groupPlugins>;
  showTitles: boolean;
  render: (plugin: Plugin) => React.ReactNode;
}) {
  return (
    <>
      {groups.map((group) => (
        <section className="plugin-group" key={group.id} aria-label={t(group.name)}>
          {showTitles && (
            <div className="plugin-group-heading">
              <h3>{t(group.name)}</h3>
              <span>{group.items.length}</span>
            </div>
          )}
          {group.items.map(render)}
        </section>
      ))}
    </>
  );
}

export function PluginManager({
  host,
  plugins,
  bundled,
  busy,
  hidden,
  run,
  refreshPlugins,
  restart,
  checkUpdates,
  onUpdates,
}: {
  host: HostAPI;
  plugins: PluginList;
  bundled: Plugin[];
  busy: boolean;
  hidden: boolean;
  run: (action: () => Promise<unknown>, commit?: boolean) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  restart: () => Promise<void>;
  checkUpdates: boolean;
  onUpdates: (updates: Plugin[]) => void;
}) {
  const [pluginFilter, setPluginFilter] = useState<PluginFilter>("all");
  const [catalog, setCatalog] = useState<{
    plugins: (Plugin & { url: string; sha256: string })[];
    offline?: boolean;
    message?: string;
  } | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const knownPlugins = uniquePlugins(catalog?.plugins || [], bundled, plugins.items);
  const installedGroups = groupPlugins(plugins.items, pluginFilter);
  const includedGroups = groupPlugins(
    availablePlugins(bundled, plugins.items),
    pluginFilter,
    knownPlugins,
  );
  const catalogGroups = groupPlugins(
    availablePlugins(catalog?.plugins || [], plugins.items, bundled),
    pluginFilter,
    knownPlugins,
  );
  const installedCount = installedGroups.reduce((count, group) => count + group.items.length, 0);
  const loadCatalog = async () => {
    setLoadingCatalog(true);
    try {
      setCatalog(await host.rpc("plugins.catalog"));
    } catch (error) {
      setCatalog({
        plugins: [],
        offline: true,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingCatalog(false);
    }
  };
  useEffect(() => {
    if (checkUpdates) void loadCatalog();
  }, [checkUpdates, host]);
  useEffect(() => {
    if (checkUpdates) onUpdates(pluginUpdates(plugins.items, bundled, catalog?.plugins || []));
  }, [checkUpdates, plugins.items, bundled, catalog, onUpdates]);
  const installLocal = () =>
    run(async () => {
      const path = await host.pickFile({
        extensions: ["mte-plugin", "zip"],
        title: t("Install plugin"),
      });
      if (typeof path !== "string") return;
      const plugin = await host.rpc<Plugin>("plugins.inspect", { path });
      if (
        !plugin.language &&
        !(await host.confirm(
          t(
            "Install “{0}” {1}?\n\nPlugins can run local code and access your files. Only install plugins from sources you trust.",
            plugin.name,
            plugin.version,
          ),
          t("Install plugin"),
        ))
      )
        return;
      await host.rpc("plugins.install", { path });
      await refreshPlugins();
    });
  return (
    <section className="content" hidden={hidden}>
      <div className="page-heading">
        <h1>{t("Plugins")}</h1>
        <button disabled={busy} onClick={installLocal}>
          {t("Install local package…")}
        </button>
      </div>
      {plugins.restart_required && (
        <div className="restart-banner">
          <span>{t("Plugin changes take effect after restarting.")}</span>
          <button disabled={busy} onClick={restart}>
            {t("Restart")}
          </button>
        </div>
      )}
      {plugins.safe_mode && (
        <div className="notice">
          {t("Safe mode: plugins were not loaded for this session.")}
          <button onClick={restart}>{t("Restart normally")}</button>
        </div>
      )}
      <div className="plugin-filters" role="group" aria-label={t("Plugin categories")}>
        <button
          type="button"
          aria-pressed={pluginFilter === "all"}
          onClick={() => setPluginFilter("all")}
        >
          {t("All plugins")}
          <span>{knownPlugins.length}</span>
        </button>
        {pluginCategories.map((category) => (
          <button
            type="button"
            key={category.id}
            aria-pressed={pluginFilter === category.id}
            onClick={() => setPluginFilter(category.id)}
          >
            {t(category.name)}
            <span>
              {knownPlugins.filter((plugin) => pluginCategory(plugin) === category.id).length}
            </span>
          </button>
        ))}
      </div>
      <div className="section-title">
        <h2>{t("Installed")}</h2>
        <span>{t("Installed: {0}", installedCount)}</span>
      </div>
      <div className="plugin-table">
        <div className="plugin-table-head">
          <span>{t("Name")}</span>
          <span>{t("Version")}</span>
          <span>{t("Status")}</span>
          <span>{t("Actions")}</span>
        </div>
        {!installedGroups.length && (
          <div className="empty-row">
            {t(
              pluginFilter === "all"
                ? "No plugins installed"
                : "No installed plugins in this category",
            )}
          </div>
        )}
        <PluginGroups
          groups={installedGroups}
          showTitles={pluginFilter === "all"}
          render={(plugin) => (
            <div className="plugin-row" key={plugin.id}>
              <div>
                <strong>{t(plugin.name)}</strong>
                <p>{t(plugin.description || "")}</p>
              </div>
              <span className="version">{plugin.version}</span>
              <label className="switch-label">
                <input
                  type="checkbox"
                  aria-label={t("Enable plugin {0}", t(plugin.name))}
                  checked={plugin.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void run(async () => {
                      await host.rpc("plugins.set_enabled", {
                        id: plugin.id,
                        enabled: e.target.checked,
                      });
                      await refreshPlugins();
                    })
                  }
                />
                {plugin.pending
                  ? t("Restart needed")
                  : plugin.enabled
                    ? t("Enabled")
                    : t("Disabled")}
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      await host.confirm(
                        t("Remove “{0}”? Saved plugin data will be kept.", plugin.name),
                      )
                    ) {
                      await host.rpc("plugins.remove", { id: plugin.id });
                      await refreshPlugins();
                    }
                  })
                }
              >
                {t("Remove")}
              </button>
            </div>
          )}
        />
      </div>
      <div className="section-title">
        <h2>{t("Included packages")}</h2>
        <span>{t("Available offline")}</span>
      </div>
      {!includedGroups.length && (
        <div className="empty-row bordered">
          {t(
            bundled.some(
              (plugin) => pluginFilter === "all" || pluginCategory(plugin) === pluginFilter,
            )
              ? "All included plugins in this category are installed"
              : "No included plugins in this category",
          )}
        </div>
      )}
      <PluginGroups
        groups={includedGroups}
        showTitles={pluginFilter === "all"}
        render={(plugin) => (
          <div className="catalog-row" key={plugin.id}>
            <div>
              <strong>{t(plugin.name)}</strong>
              <p>{t(plugin.description || "")}</p>
            </div>
            <span>{plugin.version}</span>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await host.rpc("plugins.install_bundled", { id: plugin.id });
                  await refreshPlugins();
                })
              }
            >
              {t(
                plugins.items.some((installed) => installed.id === plugin.id)
                  ? "Update"
                  : "Install",
              )}
            </button>
          </div>
        )}
      />
      <div className="section-title">
        <h2>{t("Official catalog")}</h2>
        <button disabled={loadingCatalog} onClick={() => { host.notify(""); void loadCatalog(); }}>
          {t(loadingCatalog ? "Loading catalog…" : "Load catalog")}
        </button>
      </div>
      {loadingCatalog && (
        <p role="status">{t("Loading the official catalog. You can keep working on your book.")}</p>
      )}
      {!loadingCatalog && !catalog && (
        <div className="empty-row bordered">{t("Catalog not loaded")}</div>
      )}
      {!loadingCatalog && catalog?.offline && (
        <div className="catalog-offline">
          <p>
            {t(
              "The official catalog could not be loaded. Included and local packages are still available.",
            )}
          </p>
          {!!catalog.plugins.length && <p>{t("Showing the last downloaded catalog.")}</p>}
          <details>
            <summary>{t("Technical details")}</summary>
            <p>{catalog.message}</p>
          </details>
        </div>
      )}
      {!loadingCatalog && catalog && !catalog.offline && !catalog.plugins.length && (
        <div className="empty-row bordered">
          {t("No plugins are available for download. You can install a local package.")}
        </div>
      )}
      {!!catalog?.plugins.length && !catalogGroups.length && (
        <div className="empty-row bordered">
          {t("No additional downloads in this category. Check installed and included packages.")}
        </div>
      )}
      <PluginGroups
        groups={catalogGroups}
        showTitles={pluginFilter === "all"}
        render={(plugin) => (
          <div className="catalog-row" key={plugin.id}>
            <div>
              <strong>{t(plugin.name)}</strong>
              <p>{t(plugin.description || "")}</p>
            </div>
            <span>{plugin.version}</span>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await host.rpc("plugins.install_official", { id: plugin.id });
                  await refreshPlugins();
                })
              }
            >
              {t(
                plugins.items.some((installed) => installed.id === plugin.id)
                  ? "Update"
                  : "Install",
              )}
            </button>
          </div>
        )}
      />
      {!!plugins.errors.length && <div className="notice error">{plugins.errors.join("\n")}</div>}
    </section>
  );
}
