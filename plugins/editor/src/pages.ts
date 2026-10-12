import { t } from "../../../sdk/i18n.ts";
import type { Book, Changes, Metadata, Page } from "../../../sdk/types.ts";

export function parseRange(text: string, pages: Page[]): string[] {
  const chosen = new Set<number>();
  if (!text.trim()) throw new Error(t("Enter pages, for example 1-3, 5, 8-10"));
  for (const part of text.replaceAll("，", ",").split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error(t("Invalid page range: {0}", part));
    const first = Number(match[1]),
      last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > pages.length)
      throw new Error(t("Page range is out of bounds or reversed"));
    for (let i = first; i <= last; i++) chosen.add(i - 1);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => pages[i].id);
}

export function pageSize(page: Page): [number, number] {
  const width = page.width * (page.crop?.[2] || 1), height = page.height * (page.crop?.[3] || 1);
  return (page.rotation || 0) % 180 ? [height, width] : [width, height];
}

export function rotatePages(book: Book, ids: Set<string>): Changes {
  return { pages: book.pages.map((page) => {
    if (page.kind !== "image" || !ids.has(page.id)) return page;
    const rotated = { ...page }, angle = ((page.rotation || 0) + 90) % 360 as Page["rotation"];
    if (angle) rotated.rotation = angle;
    else delete rotated.rotation;
    return rotated;
  }) };
}

export function splitPages(book: Book, ids: Set<string>, ratio = 0.5): Changes {
  if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 0.95)
    throw new Error(t("Split position must be between 5% and 95%"));
  let cover = book.metadata.cover_id;
  const pages = book.pages.flatMap((page) => {
    if (!ids.has(page.id) || page.kind === "blank" || page.split) return [page];
    const [x, y, w, h] = page.crop!;
    let leftCrop: Page["crop"] = [x, y, w * ratio, h];
    let rightCrop: Page["crop"] = [x + w * ratio, y, w * (1 - ratio), h];
    if (page.rotation === 90) {
      leftCrop = [x, y + h * (1 - ratio), w, h * ratio];
      rightCrop = [x, y, w, h * (1 - ratio)];
    } else if (page.rotation === 180) {
      leftCrop = [x + w * (1 - ratio), y, w * ratio, h];
      rightCrop = [x, y, w * (1 - ratio), h];
    } else if (page.rotation === 270) {
      leftCrop = [x, y, w, h * ratio];
      rightCrop = [x, y + h * ratio, w, h * (1 - ratio)];
    }
    const group = crypto.randomUUID();
    const left: Page = {
      ...page,
      id: crypto.randomUUID(),
      crop: leftCrop,
      split: { group, original: page, side: "left" },
    };
    const right: Page = {
      ...page,
      id: crypto.randomUUID(),
      crop: rightCrop,
      split: { group, original: page, side: "right" },
    };
    const pair = book.metadata.direction === "rtl" ? [right, left] : [left, right];
    if (cover === page.id) cover = pair[0].id;
    return pair;
  });
  return { pages, metadata: { cover_id: cover } };
}

export function isPair(a: Page | undefined, b: Page | undefined): boolean {
  return !!(
    a?.split &&
    b?.split &&
    a.split.group === b.split.group &&
    a.split.side !== b.split.side &&
    a.asset_id === b.asset_id &&
    a.split.original.id === b.split.original.id
  );
}

export function restorePages(book: Book, ids: Set<string>): Changes {
  const pages: Page[] = [];
  let cover = book.metadata.cover_id;
  for (let i = 0; i < book.pages.length; i++) {
    const a = book.pages[i],
      b = book.pages[i + 1];
    if (isPair(a, b) && (ids.has(a.id) || ids.has(b.id))) {
      const original = structuredClone(a.split!.original);
      if (cover === a.id || cover === b.id) cover = original.id;
      pages.push(original);
      i++;
    } else pages.push(a);
  }
  return { pages, metadata: { cover_id: cover } };
}

export function readingPages(book: Book): Page[] {
  return book.pages.filter(
    (p) => !book.metadata.cover_only || p.id !== book.metadata.cover_id,
  );
}

export function spreadGroups(book: Book, gap: boolean): (Page | null)[][] {
  const reading = readingPages(book);
  const display: (Page | null)[] = gap && reading.length ? [null, ...reading] : reading;
  const groups: (Page | null)[][] = [];
  const cover = book.pages.find((p) => p.id === book.metadata.cover_id);
  if (book.metadata.cover_only && cover) groups.push([cover]);
  for (let i = 0; i < display.length; i += 2) {
    const pair = [display[i] || null, display[i + 1] || null];
    groups.push(book.metadata.direction === "rtl" ? pair.reverse() : pair);
  }
  return groups;
}

export function spreadPages(book: Book, selectedId: string | null, gap: boolean): (Page | null)[] {
  const groups = spreadGroups(book, gap);
  return groups.find((pair) => pair.some((page) => page?.id === selectedId)) || groups[0] || [];
}

export function navigatePage(
  book: Book,
  selectedId: string | null,
  step: number,
  spread: boolean,
  gap: boolean,
): Page | undefined {
  if (!spread) {
    const index = book.pages.findIndex((page) => page.id === selectedId);
    return book.pages[index + step];
  }
  const groups = spreadGroups(book, gap);
  const index = groups.findIndex((pair) => pair.some((page) => page?.id === selectedId));
  const pair = groups[index + step];
  return (
    (book.metadata.direction === "rtl" ? pair?.slice().reverse() : pair)?.find(
      (page) => page !== null,
    ) || undefined
  );
}

export function insertBlankPage(book: Book, page: Page | undefined, before: boolean): Changes {
  const pages = [...book.pages];
  const [width, height] = page ? pageSize(page) : [1200, 1600];
  const blank: Page = {
    id: crypto.randomUUID(),
    kind: "blank",
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
  const index = page ? book.pages.indexOf(page) : -1;
  pages.splice(index < 0 ? 0 : index + (before ? 0 : 1), 0, blank);
  return { pages };
}

type PresetPage =
  | { kind: "blank"; width: number; height: number }
  | {
      kind: "source" | "inserted";
      source_page?: number;
      asset_id?: string;
      crop: [number, number, number, number];
      rotation?: Page["rotation"];
      split?: {
        group: string;
        side: "left" | "right";
        original_crop: [number, number, number, number];
        original_rotation?: Page["rotation"];
      };
    };
export type Preset = {
  schema: 1;
  source_pages: number;
  pages: PresetPage[];
  cover_index: number;
  metadata: Pick<Metadata, "direction" | "cover_only">;
};

export function createPreset(book: Book): { payload: Preset; asset_ids: string[] } {
  const assets = new Set<string>();
  const pages = book.pages.map((page): PresetPage => {
    if (page.kind === "blank") return { kind: "blank", width: page.width, height: page.height };
    const sourcePage = book.assets[page.asset_id!].source_page;
    if (!sourcePage) assets.add(page.asset_id!);
    return {
      kind: sourcePage ? "source" : "inserted",
      source_page: sourcePage,
      asset_id: sourcePage ? undefined : page.asset_id,
      crop: page.crop!,
      rotation: page.rotation,
      split: page.split
        ? {
            group: page.split.group,
            side: page.split.side,
            original_crop: page.split.original.crop!,
            original_rotation: page.split.original.rotation,
          }
        : undefined,
    };
  });
  return {
    payload: {
      schema: 1,
      source_pages: Math.max(0, ...Object.values(book.sources).map((s) => s.page_count)),
      pages,
      cover_index: book.pages.findIndex((p) => p.id === book.metadata.cover_id),
      metadata: { direction: book.metadata.direction, cover_only: book.metadata.cover_only },
    },
    asset_ids: [...assets],
  };
}

export function applyPreset(book: Book, payload: Preset, remap: Record<string, string>): Changes {
  if (
    payload?.schema !== 1 ||
    !Array.isArray(payload.pages) ||
    !Number.isInteger(payload.source_pages) ||
    payload.source_pages < 0
  )
    throw new Error(t("Unsupported layout preset"));
  const originals = new Map(
    Object.entries(book.assets)
      .filter(([, a]) => a.source_page)
      .map(([id, a]) => [a.source_page!, id]),
  );
  const groups = new Map<string, { id: string; original: Page }>();
  const pages = payload.pages.map((item): Page => {
    const id = crypto.randomUUID();
    if (item.kind === "blank") return { id, kind: "blank", width: item.width, height: item.height };
    if (item.kind !== "source" && item.kind !== "inserted")
      throw new Error(t("Preset contains an unknown page type"));
    const assetId =
      item.kind === "source" ? originals.get(item.source_page!) : remap[item.asset_id!];
    if (!assetId || !book.assets[assetId])
      throw new Error(t("Missing preset asset or source page {0}", item.source_page || "?"));
    const asset = book.assets[assetId];
    const page: Page = {
      id,
      kind: "image",
      asset_id: assetId,
      crop: item.crop,
      ...(item.rotation ? { rotation: item.rotation } : {}),
      width: asset.width,
      height: asset.height,
      source_page: item.kind === "source" ? item.source_page : null,
    };
    if (item.split) {
      let group = groups.get(item.split.group);
      if (!group) {
        group = {
          id: crypto.randomUUID(),
          original: { ...page, id: crypto.randomUUID(), crop: item.split.original_crop, rotation: item.split.original_rotation || 0 },
        };
        groups.set(item.split.group, group);
      }
      page.split = { group: group.id, original: group.original, side: item.split.side };
    }
    return page;
  });
  // A preset describes its source range. Keep later target pages in their current order.
  pages.push(...book.pages.filter((p) => (p.source_page || 0) > payload.source_pages));
  return {
    pages,
    metadata: {
      direction: payload.metadata.direction,
      cover_only: payload.metadata.cover_only,
      cover_id: pages[payload.cover_index]?.id || null,
    },
  };
}
