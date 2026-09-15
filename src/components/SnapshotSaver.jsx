import { useState } from "react";
import { C } from "../lib/constants";
import { sbSaveSnapshot } from "../lib/supabase";
import { extractSF, extractGSC, extractGA, extractBing, extractSemrush } from "../lib/parsers";

function detectDateFromFilename(filename) {
  if (!filename) return null;
  const m = filename.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function detectPeriodFromRows(rows) {
  if (!rows?.length) return { start: null, end: null };
  const dateKeys = ["date", "jour", "day", "semaine", "week", "mois", "month"];
  const dateKey = Object.keys(rows[0] || {}).find(k =>
    dateKeys.some(d => k.toLowerCase().includes(d))
  );
  if (!dateKey) return { start: null, end: null };
  const dates = rows.map(r => r[dateKey]).filter(Boolean).map(d => d.trim()).filter(d => /\d{4}/.test(d)).sort();
  if (!dates.length) return { start: null, end: null };
  return { start: dates[0], end: dates[dates.length - 1] };
}

const SOURCE_META = {
  sf:      { label: "Screaming Frog",         icon: "🕷️", color: "#7C3AED" },
  gsc:     { label: "Google Search Console",  icon: "🔍", color: "#2563EB" },
  ga:      { label: "Google Analytics 4",     icon: "📊", color: "#EA580C" },
  bing:    { label: "Bing AI",                icon: "🤖", color: "#0891B2" },
  semrush: { label: "Semrush",                icon: "📈", color: "#059669" },
  sm:      { label: "Semrush",                icon: "📈", color: "#059669" },
};

function buildMetrics(source, rows) {
  try {
    if (source === "sf")                return extractSF(rows);
    if (source === "gsc")               return extractGSC(rows);
    if (source === "ga")                return extractGA(rows);
    if (source === "bing")              return extractBing(rows);
    if (source === "semrush" || source === "sm") return extractSemrush(rows);
  } catch { return null; }
  return null;
}

// ── Modal wrapper ─────────────────────────────────────────────────

export function SnapshotModal({ source, rows, filename, projectId, siteId, onClose, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const detectedEnd    = detectDateFromFilename(filename) || today;
  const detectedPeriod = detectPeriodFromRows(rows);
  const isSF = source === "sf";

  const [dateEnd,   setDateEnd]   = useState(detectedEnd);
  const [dateStart, setDateStart] = useState(isSF ? "" : (detectedPeriod.start || ""));
  const [label,     setLabel]     = useState("");
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [error,     setError]     = useState(null);

  const src = SOURCE_META[source] || { label: source, icon: "📁", color: C.blue };
  const durationDays = dateStart && dateEnd
    ? Math.max(1, Math.round((new Date(dateEnd) - new Date(dateStart)) / 86400000) + 1)
    : 1;

  const save = async () => {
    if (!dateEnd) { setError("Date de fin requise"); return; }
    setSaving(true); setError(null);
    try {
      const metrics = buildMetrics(source, rows);
      if (!metrics) throw new Error("Impossible d'extraire les métriques");
      await sbSaveSnapshot({
        project_id:    projectId,
        site_id:       siteId,
        source,
        date_start:    isSF || !dateStart ? null : dateStart,
        date_end:      dateEnd,
        duration_days: isSF ? 1 : durationDays,
        label:         label || `${src.label} — ${dateEnd}`,
        metrics,
      });
      setSaved(true);
      onSaved?.();
      setTimeout(() => onClose(), 1200);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.white, borderRadius: 16, padding: "28px 32px", width: 480, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <span style={{ fontSize: 20 }}>{src.icon}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>Sauvegarder un snapshot</div>
            <div style={{ fontSize: 12, color: C.textLight }}>{src.label} · {rows?.length || 0} lignes</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 18, cursor: "pointer", color: C.textLight, padding: "0 4px", lineHeight: 1 }}>×</button>
        </div>

        {saved ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10, fontSize: 13, color: "#15803D", fontWeight: 600 }}>
            ✓ Snapshot enregistré
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Dates */}
              <div style={{ display: "flex", gap: 10 }}>
                {!isSF && (
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: C.textLight, display: "block", marginBottom: 4 }}>Début de période</label>
                    <input type="date" value={dateStart} onChange={e => setDateStart(e.target.value)}
                      style={{ width: "100%", padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text, background: C.white, boxSizing: "border-box" }} />
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: C.textLight, display: "block", marginBottom: 4 }}>
                    {isSF ? "Date du crawl" : "Fin de période"}
                  </label>
                  <input type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text, background: C.white, boxSizing: "border-box" }} />
                </div>
                {!isSF && durationDays > 1 && (
                  <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}>
                    <div style={{ padding: "7px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.textMid, whiteSpace: "nowrap" }}>{durationDays} j</div>
                  </div>
                )}
              </div>

              {/* Label */}
              <div>
                <label style={{ fontSize: 11, color: C.textLight, display: "block", marginBottom: 4 }}>Label (optionnel)</label>
                <input type="text" value={label} onChange={e => setLabel(e.target.value)}
                  placeholder={`${src.label} — ${dateEnd}`}
                  style={{ width: "100%", padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text, background: C.white, boxSizing: "border-box" }} />
              </div>
            </div>

            {error && <div style={{ marginTop: 10, fontSize: 12, color: "#DC2626" }}>⚠️ {error}</div>}

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
              <button onClick={onClose}
                style={{ padding: "8px 18px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.white, color: C.textMid, fontSize: 12, cursor: "pointer" }}>
                Annuler
              </button>
              <button onClick={save} disabled={saving || !dateEnd}
                style={{ padding: "8px 20px", border: "none", borderRadius: 8, background: saving ? C.bg : src.color, color: saving ? C.textLight : "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>
                {saving ? "Enregistrement…" : "📌 Sauvegarder"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
