import { useState, useCallback } from "react";
import { C, SF_DIM_TOOLTIPS } from "../lib/constants";

function useTooltip(enabled) {
  const [rect, setRect] = useState(null);
  const onEnter = useCallback((e) => { if (enabled) setRect(e.currentTarget.getBoundingClientRect()); }, [enabled]);
  const onLeave = useCallback(() => setRect(null), []);
  return { rect, onEnter, onLeave };
}

function tooltipStyle(rect, w, h, gap = 10) {
  if (!rect) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const above = rect.top - h - gap;
  const below = rect.bottom + gap;
  const top = above >= 0 ? above : (below + h <= vh ? below : Math.max(8, vh - h - 8));
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, vw - w - 8));
  return { position: "fixed", top, left, zIndex: 9999, pointerEvents: "none" };
}

// Shared dark tooltip shell
function DarkTooltip({ style, children }) {
  return (
    <div style={{ ...style, background: "#1E1E2E", color: "#fff", borderRadius: 10, padding: "13px 15px", fontSize: 12, boxShadow: "0 6px 20px rgba(0,0,0,0.3)", lineHeight: 1.7, wordWrap: "break-word", overflowWrap: "break-word", whiteSpace: "normal" }}>
      {children}
    </div>
  );
}

// ── SfDimCell ───────────────────────────────────────────────────
export function SfDimCell({ dim, rowBg, tooltipEnabled }) {
  const { rect, onEnter, onLeave } = useTooltip(tooltipEnabled);
  const tip = SF_DIM_TOOLTIPS[dim.key];
  const W = 280, H = 180;
  const ts = tooltipEnabled ? tooltipStyle(rect, W, H) : null;

  return (
    <td
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        padding: "10px 16px", fontSize: 12, color: C.textMid, fontWeight: 500,
        whiteSpace: "nowrap", background: rowBg,
        borderBottom: `1px solid ${C.borderLight}`, borderRight: `1px solid ${C.border}`,
        cursor: tooltipEnabled ? "help" : "default", position: "relative",
      }}
    >
      {dim.label}
      {ts && rect && (
        <DarkTooltip style={{ ...ts, width: W }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: "#E2E8F0" }}>{dim.label}</div>
          {tip && <div style={{ fontSize: 11, color: "#CBD5E1", marginBottom: 6 }}>{tip}</div>}
          <div style={{ fontSize: 11, color: "#CBD5E1" }}>
            Les pages avec <b style={{ color: "#E2E8F0" }}>{dim.label}</b>
            {dim.higher !== false
              ? <> <b style={{ color: "#86EFAC" }}>élevé</b> tendent à mieux performer.</>
              : <> <b style={{ color: "#FCA5A5" }}>bas</b> tendent à mieux performer.</>
            }
          </div>
          <div style={{ fontSize: 10, color: "#64748B", marginTop: 6 }}>Cliquer pour trier</div>
        </DarkTooltip>
      )}
    </td>
  );
}