import { useEffect, useRef, useState } from "react";
import type { BookInformation, SeriesItem } from "../sdk/types";
import { t } from "../sdk/i18n";
import { informationRows, initialInformation, type BookOverride } from "./book-information";
import { InformationFields, InformationPreview } from "./book-information-form";

export type InformationChange = {
  id: string;
  base_revision: number | null;
  metadata: BookInformation;
};

export function BookInformationDialog({
  name,
  items,
  visibleIds,
  selectedIds,
  apply,
  close,
}: {
  name: string;
  items: SeriesItem[];
  visibleIds: string[];
  selectedIds: string[];
  apply: (books: InformationChange[]) => Promise<void>;
  close: () => void;
}) {
  const [scope, setScope] = useState(selectedIds.length ? "selected" : "visible");
  const [options, setOptions] = useState(() => initialInformation(name));
  const [overrides, setOverrides] = useState<Record<string, BookOverride>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const scoped = items.filter(
    (item) =>
      scope === "all" || (scope === "selected" ? selectedIds : visibleIds).includes(item.id),
  );
  const rows = informationRows(
    scoped.map((item) => ({
      key: item.id,
      title: item.title,
      metadata: item.metadata,
      filename: item.path.split(/[\\/]/).pop(),
    })),
    options,
    overrides,
  );
  const changed = rows.filter((row) => row.included && Object.keys(row.patch).length);
  const submit = async () => {
    if (working || !changed.length || changed.some((row) => row.error)) return;
    setWorking(true);
    setError("");
    try {
      await apply(
        changed.map((row) => ({
          id: row.key,
          base_revision: items.find((item) => item.id === row.key)!.revision,
          metadata: row.patch,
        })),
      );
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="project-dialog book-information-dialog"
      aria-labelledby="information-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <h1 id="information-title">{t("Batch book information")}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={working}>
          <label>
            {t("Apply to")}
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="selected" disabled={!selectedIds.length}>
                {t("Selected books ({0})", selectedIds.length)}
              </option>
              <option value="visible">{t("Books in this view ({0})", visibleIds.length)}</option>
              <option value="all">{t("All project books ({0})", items.length)}</option>
            </select>
          </label>
          <div className="information-layout">
            <InformationFields
              options={options}
              change={(patch) => setOptions((old) => ({ ...old, ...patch }))}
            />
            <div>
              <p>{t("Review the changes. Uncheck books you want to keep unchanged.")}</p>
              <InformationPreview
                rows={rows}
                options={options}
                override={(key, patch) =>
                  setOverrides((old) => ({ ...old, [key]: { ...old[key], ...patch } }))
                }
              />
              <p>{t("{0} books will be updated", changed.length)}</p>
            </div>
          </div>
        </fieldset>
        {error && (
          <p className="series-error" role="alert">
            {error}
          </p>
        )}
        <div className="project-dialog-actions">
          <button type="button" disabled={working} onClick={close}>
            {t("Cancel")}
          </button>
          <button
            className="primary"
            disabled={working || !changed.length || changed.some((row) => !!row.error)}
          >
            {t(working ? "Saving book information…" : "Apply book information")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
