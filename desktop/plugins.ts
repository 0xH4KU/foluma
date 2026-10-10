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

export function availablePlugins(candidates: Plugin[], installed: Plugin[], ...existing: Plugin[][]): Plugin[] {
  const known = existing.flat();
  return candidates.filter(plugin => !installed.some(current => current.id === plugin.id) &&
    !known.some(current => current.id === plugin.id && !newerVersion(plugin.version, current.version)));
}

function newerVersion(candidate: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const next = candidate.split(".").map(BigInt), previous = current.split(".").map(BigInt);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

export function pluginUpdates(installed: Plugin[], ...sources: Plugin[][]): Plugin[] {
  const updates = new Map<string, Plugin>();
  for (const candidate of sources.flat()) {
    const current = installed.find(plugin => plugin.id === candidate.id);
    if (current && candidate.api_version === current.api_version &&
        newerVersion(candidate.version, (updates.get(candidate.id) || current).version)) {
      updates.set(candidate.id, candidate);
    }
  }
  return [...updates.values()];
}
