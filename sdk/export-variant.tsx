import { useId } from "react";
import type { ExportVariant } from "./types";
import { t } from "./i18n";

export function ExportVariantSelect({ variants, value, onChange, disabled = false }: {
  variants?: ExportVariant[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const descriptionId = useId();
  const selected = variants?.find((variant) => variant.id === value) || variants?.[0];
  if (!selected) return null;
  return <>
    <label>
      {t("Export edition")}
      <select value={selected.id} onChange={(event) => onChange(event.target.value)}
        disabled={disabled} aria-describedby={descriptionId}>
        {variants!.map((variant) => <option key={variant.id} value={variant.id}>{t(variant.name)}</option>)}
      </select>
    </label>
    <small id={descriptionId}>{t(selected.description)}</small>
  </>;
}
