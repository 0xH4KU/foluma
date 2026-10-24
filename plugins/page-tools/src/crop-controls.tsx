import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../sdk/i18n.ts";
import { MAX_DESKEW, PAGE_TOOLS_ID, type CropMargins } from "../../../sdk/page-layout.ts";
import type { HostAPI } from "../../../sdk/types.ts";

export type CropEdit = { margins: CropMargins; angle: number };
export type CropState = CropEdit & {
  documentId: string; pageId: string | null; revision: number; title: string; disabled: boolean;
  canPrevious: boolean; canNext: boolean;
};

export function useCropChannel(host: HostAPI) {
  const owner = new URLSearchParams(window.location.search).get("parent") || host.getWindowId?.();
  const channel = useMemo(() => owner && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(`${PAGE_TOOLS_ID}.${owner}`) : null, [owner]);
  useEffect(() => () => {
    channel?.postMessage({ type: "unavailable" });
    channel?.close();
  }, [channel]);
  return channel;
}

export function CropControls({ title, margins, angle, disabled, canPrevious, canNext, change, navigate, close }: {
  title: string; margins: CropMargins; angle: number; disabled: boolean;
  canPrevious: boolean; canNext: boolean; navigate: (step: -1 | 1) => void;
  change: (margins: CropMargins, angle: number) => void; close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => { panel.current?.querySelector("input")?.focus(); }, []);
  useEffect(() => {
    const node = panel.current;
    const active = (node?.getRootNode() as Document | ShadowRoot)?.activeElement;
    if (disabled && (!active || active === document.body || active instanceof HTMLInputElement && node?.contains(active))) node?.focus();
    else if (!disabled && active === node) (field.current || node?.querySelector<HTMLInputElement>("input"))?.focus();
  }, [disabled]);
  const setValue = (side: number, value: number) => {
    if (disabled || !Number.isFinite(value)) return;
    if (side === 4) { change(margins, Math.round(Math.max(-MAX_DESKEW, Math.min(MAX_DESKEW, value)) * 10) / 10); return; }
    const next: CropMargins = [...margins];
    next[side] = Math.round(Math.max(0, Math.min(99 - margins[(side + 2) % 4], value)) * 10) / 10;
    change(next, angle);
  };
  return <div ref={panel} id="crop-controls" className="crop-controls" role="dialog" aria-modal="false" tabIndex={-1}
    aria-labelledby="crop-controls-title"
    onFocusCapture={event => { if (event.target instanceof HTMLInputElement) field.current = event.target; }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if ((event.key === "PageUp" || event.key === "PageDown") &&
          !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === "PageUp" ? canPrevious : canNext) navigate(event.key === "PageUp" ? -1 : 1);
      }
    }}>
    <header><strong id="crop-controls-title" aria-live="polite">{title}</strong>
      <button className="crop-close" aria-label={t("Close")} onClick={close}>×</button></header>
    <div className="crop-values">{([["Top", 1], ["Left", 0], ["Angle", 4], ["Right", 2], ["Bottom", 3]] as const).map(([label, side]) => {
      const value = side === 4 ? angle : margins[side], min = side === 4 ? -MAX_DESKEW : 0;
      const max = side === 4 ? MAX_DESKEW : 99 - margins[(side + 2) % 4], unit = side === 4 ? "°" : "%";
      return <div key={label} className={`crop-side crop-side-${side}`}><label className="crop-side-label" htmlFor={`crop-value-${side}`}>{t(label)}</label>
        <div className="crop-value"><input id={`crop-value-${side}`} type="number" disabled={disabled} min={min} max={max} step="0.1"
          value={value} aria-valuetext={`${value}${unit}`}
          onChange={event => setValue(side, event.target.valueAsNumber)} /><span className="crop-unit" aria-hidden="true">{unit}</span>
          <span className="crop-stepper">{[1, -1].map(delta => <button key={delta} tabIndex={-1}
            disabled={disabled || (delta > 0 ? value >= max : value <= min)}
            aria-label={side === 4 ? t(delta > 0 ? "Increase angle" : "Decrease angle") : t(delta > 0 ? "Increase {0} crop" : "Decrease {0} crop", t(label))}
            onClick={() => setValue(side, value + delta * 0.1)}>
            <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d={delta > 0 ? "M1 4 4 1 7 4" : "M1 1 4 4 7 1"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>)}</span>
        </div>
      </div>;
    })}</div>
    <nav className="crop-navigation" aria-label={t("Pages")}>
      <button type="button" disabled={!canPrevious} onClick={() => navigate(-1)}
        title={t("Previous page (Page Up)")} aria-keyshortcuts="PageUp">{t("Previous page")}</button>
      <button type="button" disabled={!canNext} onClick={() => navigate(1)}
        title={t("Next page (Page Down)")} aria-keyshortcuts="PageDown">{t("Next page")}</button>
    </nav>
  </div>;
}

export function CropTool({ host }: { host: HostAPI }) {
  const channel = useCropChannel(host);
  const [state, setState] = useState<CropState | null>(null);
  useEffect(() => {
    if (!channel) return;
    channel.onmessage = ({ data }) => {
      if (data?.type === "state") setState(data.state);
      if (data?.type === "unavailable") { setState(null); channel.postMessage({ type: "request" }); }
    };
    channel.postMessage({ type: "request" });
    return () => { channel.onmessage = null; };
  }, [channel]);
  return <div className="crop-tool">
    <CropControls title={state?.title || t("Crop…")} margins={state?.margins || [0, 0, 0, 0]} angle={state?.angle || 0}
      canPrevious={!!state?.canPrevious} canNext={!!state?.canNext} navigate={step => {
        if (!state) return;
        channel?.postMessage({ type: "navigate", documentId: state.documentId, pageId: state.pageId, revision: state.revision, step });
      }}
      disabled={!state || state.disabled} close={() => void host.closeWindow?.().catch(host.report)} change={(margins, angle) => {
        if (!state || state.disabled || !channel) return;
        setState({ ...state, margins, angle });
        channel.postMessage({ type: "change", documentId: state.documentId, pageId: state.pageId, revision: state.revision, margins, angle });
      }} />
    {!state && <p role="status">{t("Select a page in Crop and margins to edit it.")}</p>}
  </div>;
}
