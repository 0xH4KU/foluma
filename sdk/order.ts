import { t } from "./i18n.ts";

export function moveBefore<T extends { id: string }>(
  items: T[],
  ids: Set<string>,
  before: string | null,
): T[] {
  if (before && ids.has(before)) return items;
  const moving = items.filter((item) => ids.has(item.id));
  const rest = items.filter((item) => !ids.has(item.id));
  const index = before === null ? rest.length : rest.findIndex((item) => item.id === before);
  if (index < 0) throw new Error(t("The destination page no longer exists"));
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
}
