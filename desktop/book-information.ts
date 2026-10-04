import type { BookInformation } from "../sdk/types.ts";
import { t } from "../sdk/i18n.ts";

export type InformationOptions = {
  rename: boolean;
  title: string;
  author: string;
  language: string;
  direction: "" | "rtl" | "ltr";
  cover: "" | "both" | "shelf";
  numbering: "preserve" | "sequence" | "none";
  start: number;
  digits: number;
  suffix: "第{number}卷" | "Vol. {number}" | "{number}";
};
export type InformationSource = {
  key: string;
  title: string;
  filename?: string;
  metadata?: BookInformation;
};
export type BookOverride = { included?: boolean; volume?: string; title?: string };
export type InformationRow = InformationSource & {
  included: boolean;
  volume: string;
  newTitle: string;
  customTitle?: string;
  patch: BookInformation;
  error: string;
};

export const initialInformation = (title = "", creation = false): InformationOptions => ({
  rename: creation,
  title,
  author: "",
  language: "",
  direction: creation ? "rtl" : "",
  cover: "",
  numbering: "preserve",
  start: 1,
  digits: 2,
  suffix: "第{number}卷",
});

export function volumeNumber(value: string): string {
  const name = value.normalize("NFKC").replace(/\.[a-zA-Z][a-zA-Z0-9]{0,15}$/, "");
  const match =
    /第\s*(\d{1,4})\s*[卷巻集册冊]/.exec(name) ||
    /(?:\bvol(?:ume)?\.?\s*|\bv\s*)(\d{1,4})(?!\d)/i.exec(name) ||
    /(?<!\d)(\d{1,4})\s*$/.exec(name);
  return match ? String(Number(match[1])) : "";
}

export function suggestedFolder(title: string): string {
  let name = title
    .trim()
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 120);
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `book-${name}`;
  if (/\.mteproj$/i.test(name)) name += "-project";
  return name.slice(0, 120).replace(/[. ]+$/g, "");
}

export function informationRows(
  sources: InformationSource[],
  options: InformationOptions,
  overrides: Record<string, BookOverride> = {},
): InformationRow[] {
  let position = 0;
  return sources.map((source) => {
    const override = overrides[source.key] || {};
    const included = override.included !== false;
    const sequence = options.start + position;
    if (included) position++;
    const volume =
      override.volume ??
      (options.numbering === "sequence"
        ? String(sequence)
        : volumeNumber(source.title) || volumeNumber(source.filename || ""));
    const patch: BookInformation = {};
    let error = "",
      newTitle = source.title;
    if (options.rename) {
      const title = options.title.trim();
      const validNumber = /^\d{1,4}$/.test(volume) && Number(volume) <= 9999;
      if (!title || title.length > 4096) error = t("Enter a book title");
      else if (override.title !== undefined && !override.title.trim())
        error = t("Enter a book title");
      else if (options.numbering !== "none" && override.title === undefined && !validNumber)
        error = t("Enter a volume number or a custom title");
      if (
        options.digits < 1 ||
        options.digits > 4 ||
        !Number.isInteger(options.digits) ||
        (options.numbering === "sequence" &&
          (!Number.isInteger(options.start) || options.start < 0 || options.start > 9999))
      )
        error = t("Use a starting volume from 0 to 9999 and 1 to 4 digits");
      const suffix =
        options.numbering === "none"
          ? ""
          : options.suffix.replace(
              "{number}",
              validNumber ? String(Number(volume)).padStart(options.digits, "0") : "?",
            );
      newTitle =
        override.title === undefined
          ? [title, suffix].filter(Boolean).join(" ")
          : override.title.trim();
      patch.title = newTitle;
    }
    if (options.author.trim()) patch.author = options.author.trim();
    if (options.language.trim()) patch.language = options.language.trim();
    if (options.direction) patch.direction = options.direction;
    if (options.cover) patch.cover_only = options.cover === "shelf";
    if (newTitle.length > 4096 || !newTitle.trim()) error = t("Enter a book title");
    if (options.author.length > 4096) error = t("Author cannot exceed 4096 characters");
    if (
      options.language.trim() &&
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(options.language.trim())
    )
      error = t("Enter a valid language code, such as en or zh-Hant");
    return { ...source, included, volume, newTitle, customTitle: override.title, patch, error };
  });
}
