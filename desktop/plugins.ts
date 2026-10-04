import type {Plugin} from "../sdk/types";

export const pluginCategories = [
  {id: "import", name: "Import plugins"},
  {id: "export", name: "Export plugins"},
  {id: "tools", name: "Editing and tools"},
  {id: "language", name: "Language packs"},
] as const;

export type PluginCategory = typeof pluginCategories[number]["id"];
export type PluginFilter = PluginCategory | "all";

export function pluginCategory(plugin: Plugin): PluginCategory {
  if (plugin.format?.direction === "import" || plugin.format?.direction === "export") return plugin.format.direction;
  return plugin.language ? "language" : "tools";
}

export function groupPlugins(plugins: Plugin[], filter: PluginFilter = "all", known: Plugin[] = plugins) {
  const categories = new Map(known.map(plugin => [plugin.id, pluginCategory(plugin)]));
  return pluginCategories.filter(category => filter === "all" || category.id === filter).map(category => ({
    ...category,
    items: plugins.filter(plugin => (categories.get(plugin.id) || pluginCategory(plugin)) === category.id)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  })).filter(group => group.items.length);
}

export function uniquePlugins(...sources: Plugin[][]): Plugin[] {
  return [...new Map(sources.flat().map(plugin => [plugin.id, plugin])).values()];
}

export function availablePlugins(candidates: Plugin[], ...existing: Plugin[][]): Plugin[] {
  const known = new Set(existing.flat().map(plugin => `${plugin.id}@${plugin.version}`));
  return candidates.filter(plugin => !known.has(`${plugin.id}@${plugin.version}`));
}
