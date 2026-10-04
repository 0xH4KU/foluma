import { useEffect, useRef, useState } from "react";
import type { BookCandidate, HostAPI, ProjectCreation } from "../sdk/types";
import { t } from "../sdk/i18n";
import {
  informationRows,
  initialInformation,
  suggestedFolder,
  type BookOverride,
} from "./book-information";
import { InformationFields, InformationPreview } from "./book-information-form";

export function ProjectWizard({
  host,
  initialPaths = [],
  create,
  close,
}: {
  host: HostAPI;
  initialPaths?: string[];
  create: (settings: ProjectCreation) => Promise<void>;
  close: () => void;
}) {
  const [step, setStep] = useState(0);
  const [parent, setParent] = useState("");
  const [options, setOptions] = useState(() => initialInformation("", true));
  const [folder, setFolder] = useState("");
  const [books, setBooks] = useState<BookCandidate[]>([]);
  const [overrides, setOverrides] = useState<Record<string, BookOverride>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const rows = informationRows(
    books.map((book) => ({ ...book, key: book.path })),
    options,
    overrides,
  );
  const included = rows.filter((row) => row.included);
  const importers = (host.getFormats?.() || []).filter(
    (plugin) => plugin.format?.direction === "import",
  );
  const extensions = [...new Set(importers.flatMap((plugin) => plugin.format!.extensions))];
  const folderName = folder.trim() || suggestedFolder(options.title);

  const load = async (paths: string[]) => {
    const preview = await host.rpc<{ books: BookCandidate[]; folders_skipped: number }>(
      "series.preview",
      { paths },
    );
    setBooks(preview.books);
    if (preview.folders_skipped) host.notify(t("{0} subfolders skipped", preview.folders_skipped));
  };
  const run = async (action: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };
  const pick = (kind: "files" | "folder" | "book") =>
    run(async () => {
      const chosen = await host.pickFile(
        kind === "files"
          ? { extensions, multiple: true, title: t("Add books to project") }
          : {
              directory: true,
              title: t(
                kind === "book"
                  ? "Choose a .mteproj book folder"
                  : "Import supported books from this folder only",
              ),
            },
      );
      if (chosen)
        await load([
          ...books.map((book) => book.path),
          ...(Array.isArray(chosen) ? chosen : [chosen]),
        ]);
    });
  const next = () =>
    run(async () => {
      if (step === 0) {
        if (!parent) throw new Error(t("Choose a location…"));
        setStep(1);
        return;
      }
      if (!options.title.trim()) throw new Error(t("Enter a book title"));
      if (!folderName) throw new Error(t("Enter a project folder name"));
      if (step === 1) {
        setStep(2);
        if (!books.length && initialPaths.length) await load(initialPaths);
        return;
      }
      if (!included.length) throw new Error(t("Choose at least one book"));
      const invalid = included.find((row) => row.error);
      if (invalid) throw new Error(invalid.error);
      await create({
        parent,
        name: folderName,
        paths: included.map((row) => row.key),
        books: included.map((row) => ({ path: row.key, metadata: row.patch })),
      });
      close();
    });
  const move = (index: number, offset: number) =>
    setBooks((old) => {
      const next = [...old];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });

  return (
    <dialog
      ref={dialog}
      className={`project-dialog project-wizard ${step === 2 ? "with-preview" : ""}`}
      aria-labelledby="wizard-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <h1 id="wizard-title">{t("New project")}</h1>
      <ol className="wizard-steps" aria-label={t("Project creation steps")}>
        {[t("Location"), t("Book information"), t("Books and preview")].map((label, index) => (
          <li key={label} aria-current={step === index ? "step" : undefined}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void next();
        }}
      >
        <fieldset disabled={working}>
          {step === 0 && (
            <div className="wizard-location">
              <p>{t("Choose where to create the project folder")}</p>
              <label>
                {t("Location")}
                <input readOnly value={parent} placeholder={t("Choose a location…")} />
              </label>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const value = await host.pickFile({
                      directory: true,
                      title: t("Choose a location for the new project"),
                    });
                    if (typeof value === "string") setParent(value);
                  })
                }
              >
                {t("Choose location…")}
              </button>
            </div>
          )}
          {step === 1 && (
            <>
              <InformationFields
                options={options}
                creation
                change={(patch) => setOptions((old) => ({ ...old, ...patch }))}
              />
              <label>
                {t("Project folder name")}
                <input
                  maxLength={120}
                  value={folder}
                  placeholder={suggestedFolder(options.title)}
                  onChange={(event) => setFolder(event.target.value)}
                />
              </label>
              {folderName && (
                <p className="project-location">
                  {parent}/{folderName}
                </p>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <div className="information-summary">
                <strong>{options.title.trim()}</strong>
                <span>{options.author.trim() || t("Keep original author")}</span>
                <span>{t(options.direction === "rtl" ? "Right to left" : "Left to right")}</span>
              </div>
              <div className="wizard-import">
                <button
                  type="button"
                  disabled={!extensions.length}
                  onClick={() => void pick("files")}
                >
                  {t("Add books…")}
                </button>
                <button
                  type="button"
                  disabled={!extensions.length}
                  onClick={() => void pick("folder")}
                >
                  {t("Import folder · this level only…")}
                </button>
                <button type="button" onClick={() => void pick("book")}>
                  {t("Import book project…")}
                </button>
                <button
                  type="button"
                  disabled={!books.length}
                  onClick={() => {
                    setBooks([]);
                    setOverrides({});
                  }}
                >
                  {t("Clear book list")}
                </button>
              </div>
              <p>
                {t(
                  "Arrange the books, adjust volume numbers, and review each title before creating the project.",
                )}
              </p>
              <InformationPreview
                rows={rows}
                options={options}
                move={move}
                override={(key, patch) =>
                  setOverrides((old) => ({ ...old, [key]: { ...old[key], ...patch } }))
                }
              />
              <p>{t("{0} books will be added", included.length)}</p>
            </>
          )}
        </fieldset>
        {error && (
          <p className="series-error" role="alert">
            {error}
          </p>
        )}
        {working && <p role="status">{t(step === 2 ? "Creating project…" : "Reading files…")}</p>}
        <div className="project-dialog-actions">
          <button type="button" disabled={working} onClick={close}>
            {t("Cancel")}
          </button>
          {step > 0 && (
            <button
              type="button"
              disabled={working}
              onClick={() => {
                setStep((value) => value - 1);
                setError("");
              }}
            >
              {t("Back")}
            </button>
          )}
          <button
            className="primary"
            disabled={
              working ||
              (step === 0
                ? !parent
                : step === 1
                  ? !options.title.trim() || !folderName
                  : !included.length || included.some((row) => !!row.error))
            }
          >
            {t(step === 2 ? "Create project" : "Next")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
