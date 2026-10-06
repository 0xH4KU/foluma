import {useEffect, useMemo, useState} from "react";
import type {HostAPI} from "../sdk/types";
import {t} from "../sdk/i18n";
import {createActionRunner} from "../sdk/actions";

type Storage = {used: number; limit: number; freed: number};

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function StorageSettings({host, busy, prepare, refreshPreviews}: {
  host: HostAPI; busy: boolean; prepare: () => Promise<void>; refreshPreviews: () => void;
}) {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [choice, setChoice] = useState("5");
  const [custom, setCustom] = useState("5");
  const [working, setWorking] = useState(false);
  const execute = useMemo(() => createActionRunner(host, setWorking), [host]);
  useEffect(() => {
    let active = true;
    host.rpc<Storage>("storage.info").then(value => {
      if (!active) return;
      setStorage(value);
      const limit = value.limit / 1_000_000_000;
      setChoice([1, 5, 10].includes(limit) ? String(limit) : "custom");
      setCustom(String(limit));
    }).catch(host.report);
    return () => {active = false;};
  }, [host]);
  const update = async (method: "storage.clear" | "storage.configure", limit?: number) => {
    if (busy) return;
    await execute(async () => {
      await prepare();
      const value = await host.rpc<Storage>(method, limit === undefined ? {} : {limit: Math.round(limit * 1_000_000_000)});
      setStorage(value);
      if (method === "storage.clear") {
        refreshPreviews();
        host.notify(t("Cache cleared · {0} freed", formatBytes(value.freed)));
      } else host.notify(t("Cache limit saved"));
    });
  };
  return <article className="settings-row storage-settings"><div><h2>{t("Storage")}</h2>
    <p>{t("Preview cache only. PDFs, saved edits and imported images are kept.")}</p>
    <p>{t("Old previews are removed automatically. Recently used previews may temporarily exceed the limit.")}</p>
    {storage && <><p role="status">{t("Cache: {0} / limit: {1}", formatBytes(storage.used), formatBytes(storage.limit))}</p>
      <progress aria-label={t("Preview cache usage")} value={Math.min(storage.used, storage.limit)} max={storage.limit}/></>}
    <p>{t("The first preview after clearing may take longer. Active previews are kept until they finish.")}</p>
  </div><form onSubmit={event => {event.preventDefault(); void update("storage.configure", Number(choice === "custom" ? custom : choice));}}>
    <fieldset disabled={busy || working || !storage}>
      <label>{t("Cache capacity limit")}<select value={choice} onChange={event => setChoice(event.target.value)}>
        {[1, 5, 10].map(value => <option key={value} value={value}>{value} GB</option>)}<option value="custom">{t("Custom")}</option>
      </select></label>
      {choice === "custom" && <label>{t("Custom limit (GB)")}<input required type="number" min="1" max="1000" step="0.1" value={custom} onChange={event => setCustom(event.target.value)}/></label>}
      <button type="submit">{t("Save limit")}</button>
      <button type="button" onClick={() => void update("storage.clear")}>{t("Clear cache now")}</button>
    </fieldset>
  </form></article>;
}
