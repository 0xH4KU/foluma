import { useEffect, useRef, useState } from "react";
import { t } from "../../../sdk/i18n.ts";
import { usePagePreview } from "../../../sdk/previews.ts";
import type { CropMargins } from "../../../sdk/page-layout.ts";
import type { Book, HostAPI, Page } from "../../../sdk/types.ts";

export function CropDialog({ book, page, host, initial, apply, close }: {
  book: Book; page: Page; host: HostAPI; initial: CropMargins;
  apply: (margins: CropMargins) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [margins, setMargins] = useState(initial);
  const { url, error } = usePagePreview(book, page, host, 1600);
  const drag = useRef<{ side: number; pointer: number } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const setSide = (side: number, value: number) => {
    if (!Number.isFinite(value)) return;
    setMargins(old => {
      const next: CropMargins = [...old];
      next[side] = Math.round(Math.max(0, Math.min(99 - old[(side + 2) % 4], value)) * 10) / 10;
      return next;
    });
  };
  const move = (event: React.PointerEvent) => {
    const bounds = frame.current?.getBoundingClientRect(), active = drag.current;
    if (!bounds || !active || active.pointer !== event.pointerId) return;
    const values = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height,
      (bounds.right - event.clientX) / bounds.width, (bounds.bottom - event.clientY) / bounds.height];
    setSide(active.side, values[active.side] * 100);
  };
  return <dialog ref={dialog} className="crop-dialog" aria-labelledby="crop-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><strong id="crop-title">{t("Crop page {0}", book.pages.indexOf(page) + 1)}</strong>
      <button onClick={close}>{t("Cancel")}</button></header>
    <p>{t("Drag the four edges or enter percentages. The original image is retained.")}</p>
    <div className="crop-stage">
      {url ? <div className="crop-image" ref={frame} onPointerMove={move}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <img src={url} alt={t("Page {0}", book.pages.indexOf(page) + 1)} draggable={false} />
        <div className="crop-box" style={{ left: `${margins[0]}%`, top: `${margins[1]}%`,
          right: `${margins[2]}%`, bottom: `${margins[3]}%` }}>
          {["Left", "Top", "Right", "Bottom"].map((label, side) => <span key={label} className={`crop-edge edge-${side}`}
            aria-hidden="true" onPointerDown={event => {
              event.preventDefault(); drag.current = { side, pointer: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
            }} />)}
        </div>
      </div> : <p role={error ? "alert" : "status"}>{error || t("Loading preview…")}</p>}
    </div>
    <div className="crop-values">{["Left", "Top", "Right", "Bottom"].map((label, side) =>
      <label key={label}>{t(label)} <input type="number" min="0" max={99 - margins[(side + 2) % 4]} step="0.1"
        value={margins[side]} onChange={event => setSide(side, event.target.valueAsNumber)} /> %</label>)}</div>
    <footer><button onClick={() => setMargins([0, 0, 0, 0])}>{t("Reset")}</button>
      <button className="primary" disabled={!url} onClick={() => apply(margins)}>{t("Preview crop")}</button></footer>
  </dialog>;
}
