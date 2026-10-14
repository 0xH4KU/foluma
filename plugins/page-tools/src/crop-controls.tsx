import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../sdk/i18n.ts";
import { PAGE_TOOLS_ID, type CropMargins } from "../../../sdk/page-layout.ts";
import type { Book, HostAPI } from "../../../sdk/types.ts";

export type CropState = { pageId: string | null; revision: number; title: string; margins: CropMargins; disabled: boolean };

export function useCropChannel(book: Book, host: HostAPI) {
  const owner = new URLSearchParams(window.location.search).get("parent") || host.getWindowId?.();
  const channel = useMemo(() => owner && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(`${PAGE_TOOLS_ID}.${owner}.${book.id}`) : null, [owner, book.id]);
  useEffect(() => () => {
    channel?.postMessage({ type: "unavailable" });
    channel?.close();
  }, [channel]);
  return channel;
}

export function CropControls({ title, margins, disabled, change, close }: {
  title: string; margins: CropMargins; disabled: boolean;
  change: (margins: CropMargins) => void; close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector("input")?.focus(); }, []);
  const setSide = (side: number, value: number) => {
    if (disabled || !Number.isFinite(value)) return;
    const next: CropMargins = [...margins];
    next[side] = Math.round(Math.max(0, Math.min(99 - margins[(side + 2) % 4], value)) * 10) / 10;
    change(next);
  };
  return <div ref={panel} id="crop-controls" className="crop-controls" role="dialog" aria-modal="false"
    aria-labelledby="crop-controls-title"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
    <header><strong id="crop-controls-title" aria-live="polite">{title}</strong>
      <button className="crop-close" aria-label={t("Close")} onClick={close}>×</button></header>
    <div className="crop-values">{([["Top", 1], ["Left", 0], ["Right", 2], ["Bottom", 3]] as const).map(([label, side]) =>
      <div key={label} className={`crop-side crop-side-${side}`}><label className="crop-side-label" htmlFor={`crop-value-${side}`}>{t(label)}</label>
        <div className="crop-value"><input id={`crop-value-${side}`} type="number" disabled={disabled} min="0" max={99 - margins[(side + 2) % 4]} step="0.1"
          value={margins[side]} aria-valuetext={`${margins[side]}%`}
          onChange={event => setSide(side, event.target.valueAsNumber)} /><span className="crop-unit" aria-hidden="true">%</span>
          <span className="crop-stepper">{[1, -1].map(delta => <button key={delta} tabIndex={-1}
            disabled={disabled || (delta > 0 ? margins[side] >= 99 - margins[(side + 2) % 4] : margins[side] <= 0)}
            aria-label={t(delta > 0 ? "Increase {0} crop" : "Decrease {0} crop", t(label))}
            onClick={() => setSide(side, margins[side] + delta * 0.1)}>
            <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d={delta > 0 ? "M1 4 4 1 7 4" : "M1 1 4 4 7 1"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>)}</span>
        </div>
      </div>)}</div>
  </div>;
}

export function CropTool({ book, host }: { book: Book; host: HostAPI }) {
  const channel = useCropChannel(book, host);
  const [state, setState] = useState<CropState | null>(null);
  useEffect(() => {
    if (!channel) return;
    channel.onmessage = ({ data }) => {
      if (data?.type === "state") setState(data.state);
      if (data?.type === "unavailable") setState(null);
    };
    channel.postMessage({ type: "request" });
    return () => { channel.onmessage = null; };
  }, [channel]);
  return <div className="crop-tool">
    <CropControls title={state?.title || t("Crop…")} margins={state?.margins || [0, 0, 0, 0]}
      disabled={!state || state.disabled} close={() => void host.closeWindow?.().catch(host.report)} change={margins => {
        if (!state || state.disabled || !channel) return;
        setState({ ...state, margins });
        channel.postMessage({ type: "change", pageId: state.pageId, revision: state.revision, margins });
      }} />
    {!state && <p role="status">{t("Select a page in Crop and margins to edit it.")}</p>}
  </div>;
}
