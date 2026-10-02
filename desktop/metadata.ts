import type {HostAPI, Metadata} from "../sdk/types.ts";
import {t} from "../sdk/i18n.ts";

export type MetadataDraft = {bookId: string | null; values: Partial<Metadata>; pending: Promise<void> | null};

export async function flushMetadata(host: Pick<HostAPI,"getDocument"|"apply">, draft: MetadataDraft,
  changed: (values: Partial<Metadata>) => void): Promise<void> {
  if (draft.pending) await draft.pending;
  const values = {...draft.values};
  if (!Object.keys(values).length) return;
  const book = host.getDocument();
  if (!book || book.id !== draft.bookId) throw new Error(t("Book information belongs to another book. Your input was kept."));
  const request = host.apply(book,{metadata: values}).then(() => {
    draft.values = Object.fromEntries(Object.entries(draft.values).filter(([key,value]) => value !== values[key as keyof Metadata]));
    changed(draft.values);
  });
  draft.pending = request;
  try {await request;} finally {if (draft.pending === request) draft.pending = null;}
}
