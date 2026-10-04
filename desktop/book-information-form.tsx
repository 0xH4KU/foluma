import { t } from "../sdk/i18n";
import type { BookOverride, InformationOptions, InformationRow } from "./book-information";

export function InformationFields({
  options,
  change,
  creation = false,
}: {
  options: InformationOptions;
  change: (patch: Partial<InformationOptions>) => void;
  creation?: boolean;
}) {
  return (
    <div className="book-information-fields">
      {!creation && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={options.rename}
            onChange={(event) => change({ rename: event.target.checked })}
          />
          {t("Change book titles")}
        </label>
      )}
      <label>
        {t("Book title")}
        <input
          autoFocus
          required={options.rename}
          disabled={!options.rename}
          maxLength={4096}
          value={options.title}
          onChange={(event) => change({ title: event.target.value })}
        />
      </label>
      <label>
        {t("Author (optional)")}
        <input
          maxLength={4096}
          value={options.author}
          placeholder={t("Keep the original author when empty")}
          onChange={(event) => change({ author: event.target.value })}
        />
      </label>
      <div className="direction-choices" role="group" aria-label={t("Reading direction")}>
        {!creation && (
          <label className="direction-choice direction-keep">
            <input
              type="radio"
              name="information-direction"
              checked={!options.direction}
              onChange={() => change({ direction: "" })}
            />
            <span>{t("Keep each book's setting")}</span>
          </label>
        )}
        {(["rtl", "ltr"] as const).map((direction) => (
          <label className="direction-choice" key={direction}>
            <input
              type="radio"
              name="information-direction"
              checked={options.direction === direction}
              onChange={() => change({ direction })}
            />
            <strong>{t(direction === "rtl" ? "Right to left" : "Left to right")}</strong>
            <span className="direction-pages" aria-hidden="true">
              {direction === "rtl" ? (
                <>
                  <i>2</i>
                  <b>←</b>
                  <i>1</i>
                </>
              ) : (
                <>
                  <i>1</i>
                  <b>→</b>
                  <i>2</i>
                </>
              )}
            </span>
          </label>
        ))}
      </div>
      {!creation && (
        <div className="form-pair">
          <label>
            {t("Book language")}
            <input
              maxLength={64}
              value={options.language}
              placeholder={t("Keep each book's setting")}
              onChange={(event) => change({ language: event.target.value })}
            />
          </label>
          <label>
            {t("Cover placement")}
            <select
              value={options.cover}
              onChange={(event) =>
                change({ cover: event.target.value as InformationOptions["cover"] })
              }
            >
              <option value="">{t("Keep each book's setting")}</option>
              <option value="both">{t("Bookshelf and book body")}</option>
              <option value="shelf">{t("Bookshelf only")}</option>
            </select>
          </label>
        </div>
      )}
      {options.rename && (
        <fieldset className="volume-options" disabled={!options.rename}>
          <legend>{t("Volume numbering")}</legend>
          <label>
            {t("Numbering mode")}
            <select
              value={options.numbering}
              onChange={(event) =>
                change({ numbering: event.target.value as InformationOptions["numbering"] })
              }
            >
              <option value="preserve">{t("Keep existing volume numbers")}</option>
              <option value="sequence">{t("Number in preview order")}</option>
              <option value="none">{t("Do not add volume numbers")}</option>
            </select>
          </label>
          <div className="form-pair">
            <label>
              {t("Starting volume")}
              <input
                type="number"
                min={0}
                max={9999}
                disabled={options.numbering !== "sequence"}
                value={Number.isFinite(options.start) ? options.start : ""}
                onChange={(event) =>
                  change({ start: event.target.value === "" ? NaN : Number(event.target.value) })
                }
              />
            </label>
            <label>
              {t("Number of digits")}
              <select
                disabled={options.numbering === "none"}
                value={options.digits}
                onChange={(event) => change({ digits: Number(event.target.value) })}
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t("Volume title style")}
            <select
              disabled={options.numbering === "none"}
              value={options.suffix}
              onChange={(event) =>
                change({ suffix: event.target.value as InformationOptions["suffix"] })
              }
            >
              <option value="第{number}卷">第01卷</option>
              <option value="Vol. {number}">Vol. 01</option>
              <option value="{number}">01</option>
            </select>
          </label>
        </fieldset>
      )}
    </div>
  );
}

export function InformationPreview({
  rows,
  options,
  override,
  move,
}: {
  rows: InformationRow[];
  options: InformationOptions;
  override: (key: string, patch: BookOverride) => void;
  move?: (index: number, offset: number) => void;
}) {
  return (
    <div className="information-preview">
      <table>
        <thead>
          <tr>
            <th>{t("Include")}</th>
            <th>{t("Original title")}</th>
            <th>{t("Volume")}</th>
            <th>{t("New title")}</th>
            <th>{t("Author")}</th>
            {move && <th>{t("Order")}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key} className={row.included ? "" : "excluded-book"}>
              <td>
                <input
                  type="checkbox"
                  aria-label={t("Include {0}", row.title)}
                  checked={row.included}
                  onChange={(event) => override(row.key, { included: event.target.checked })}
                />
              </td>
              <td title={row.filename || row.title}>{row.title}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  aria-label={t("Volume number for {0}", row.title)}
                  value={row.volume}
                  disabled={!row.included || !options.rename || options.numbering === "none"}
                  onChange={(event) =>
                    override(row.key, { volume: event.target.value, title: undefined })
                  }
                />
              </td>
              <td>
                <input
                  aria-label={t("New title for {0}", row.title)}
                  maxLength={4096}
                  value={row.customTitle ?? row.newTitle}
                  disabled={!row.included || !options.rename}
                  aria-invalid={row.included && !!row.error}
                  onChange={(event) => override(row.key, { title: event.target.value })}
                />
                {row.error && row.included && (
                  <small className="series-error" role="alert">
                    {row.error}
                  </small>
                )}
                {row.customTitle !== undefined && (
                  <button
                    type="button"
                    disabled={!row.included}
                    onClick={() => override(row.key, { title: undefined, volume: undefined })}
                  >
                    {t("Use generated title")}
                  </button>
                )}
              </td>
              <td>{row.patch.author || row.metadata?.author || t("Keep original")}</td>
              {move && (
                <td>
                  <button
                    type="button"
                    aria-label={t("Move {0} up", row.title)}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t("Move {0} down", row.title)}
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p>{t("Choose books to preview their names")}</p>}
    </div>
  );
}
