import { useState, useEffect } from "react";
import { sbGetCalendarEntries, sbAddCalendarEntry } from "../lib/supabase";

// PROVIDERS is passed as prop to avoid circular import
const DAYS = 30;

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── CalendarGrid — pure rendering ────────────────────────────────

function CalendarGrid({ entries, providers, errorMsg = null }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ERR_COLOR = "#B45309"; // ambre — distinct du rouge "absent"

  // Group entries by provider → date → { présence + type M/É/C + position }
  // Type prioritaire : mention > évocation > citation. La présence reste binaire.
  const byProvider = {};
  entries.forEach(e => {
    const pid = e.provider_id;
    const key = String(e.test_date).slice(0, 10);
    if (!byProvider[pid]) byProvider[pid] = {};
    const present = e.brand_present === true || e.brand_present === 1;
    const isMention   = e.brand_mention === 1 || e.brand_mention === true;
    const isEvocation = e.brand_evocation === 1 || e.brand_evocation === true;
    const isCitation  = e.brand_citation === 1 || e.brand_citation === true;
    // type le plus fort de la journée
    let type = null, pos = null;
    if (isMention)        { type = "m"; pos = e.mention_position != null ? e.mention_position : null; }
    else if (isEvocation) { type = "e"; }
    else if (isCitation)  { type = "c"; }
    const cur = byProvider[pid][key];
    const cand = { present, type, pos };
    if (cur === undefined) {
      byProvider[pid][key] = cand;
    } else {
      // fusion : présent l'emporte ; type le plus fort l'emporte (m > e > c)
      const rank = { m: 3, e: 2, c: 1, null: 0 };
      const merged = { present: cur.present || present };
      if ((rank[cand.type] || 0) >= (rank[cur.type] || 0)) { merged.type = cand.type; merged.pos = cand.pos; }
      else { merged.type = cur.type; merged.pos = cur.pos; }
      byProvider[pid][key] = merged;
    }
  });

  const activeProviders = providers.filter(p => byProvider[p.id] || errorMsg);
  if (!activeProviders.length) return null;

  // Glyphe affiché dans le carré : position si mention, sinon e / c
  const glyphOf = (cell) => {
    if (!cell || !cell.present) return "";
    if (cell.type === "m") return cell.pos != null ? String(cell.pos) : "m";
    if (cell.type === "e") return "e";
    if (cell.type === "c") return "c";
    return "✓"; // présent mais type non ventilé (ancien enregistrement)
  };
  const colorOf = (cell) => {
    if (cell === undefined) return "#E5E7EB";       // non testé
    if (!cell.present) return "#DC2626";             // absent
    if (cell.type === "m") return "#059669";         // mention — vert
    if (cell.type === "e") return "#D97706";         // évocation — orange
    if (cell.type === "c") return "#1A3C2E";         // citation — vert profond
    return "#059669";
  };
  const labelOf = (cell) => {
    if (cell === undefined) return "non testé";
    if (!cell.present) return "✗ Absent";
    if (cell.type === "m") return `◎ Mention${cell.pos != null ? " #" + cell.pos : ""}`;
    if (cell.type === "e") return "⟶ Évocation";
    if (cell.type === "c") return "↗ Citation";
    return "✓ Présent";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
      {activeProviders.map(p => {
        const dayMap = byProvider[p.id] || {};
        const slots = [];
        for (let i = DAYS - 1; i >= 0; i--) {
          const d = new Date(today); d.setDate(d.getDate() - i);
          const key = localDateKey(d);
          const cell = dayMap[key];
          slots.push({ key, cell, color: colorOf(cell), glyph: glyphOf(cell), title: `${key} — ${labelOf(cell)}` });
        }
        // Erreur sur la dernière interrogation : le carré du jour devient une icône
        // d'erreur (ambre « ! »), PAS un carré rouge « absent ». Message au survol.
        if (errorMsg) {
          const last = slots[slots.length - 1];
          last.color = ERR_COLOR;
          last.glyph = "!";
          last.title = `⚠ Erreur d'interrogation : ${errorMsg}`;
        }
        const lastKey = Object.keys(dayMap).sort().pop();
        const lastCell = lastKey !== undefined ? dayMap[lastKey] : undefined;

        return (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: p.color, minWidth: 68, flexShrink: 0 }}>
              {p.icon} {p.label}
            </span>
            <div style={{ display: "flex", gap: 2, flex: 1, overflow: "hidden", flexWrap: "nowrap" }}>
              {slots.map(s => (
                <div key={s.key} title={s.title}
                  style={{
                    width: 14, height: 14, borderRadius: 3, background: s.color, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 8, fontWeight: 700, color: "#fff", lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                  }}>
                  {s.glyph}
                </div>
              ))}
            </div>
            {errorMsg ? (
              <span title={errorMsg} style={{ fontSize: 10, fontWeight: 700, color: ERR_COLOR, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, cursor: "help" }}>
                ⚠ Erreur
              </span>
            ) : (lastCell !== undefined && (
              <span style={{ fontSize: 9, fontWeight: 700, color: colorOf(lastCell), flexShrink: 0 }}>
                {lastCell.present ? (lastCell.type === "m" && lastCell.pos != null ? "#" + lastCell.pos : (lastCell.type || "✓").toUpperCase()) : "✗"}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── PresenceCalendar — data + rendering ──────────────────────────

export default function PresenceCalendar({ questionId, providers = [], newEntry = null, errorMsg = null, siteId = null }) {
  const [entries, setEntries] = useState([]);

  // Load from DB on mount / question change
  useEffect(() => {
    if (!questionId) return;
    sbGetCalendarEntries(questionId).then(rows => setEntries(rows || [])).catch(() => {});
  }, [questionId]);

  // Filtre par marque : ne garder que les entrées de ce site_id. Les entrées
  // héritées (site_id null) ne s'affichent qu'en l'absence de siteId (rétrocompat).
  const shownEntries = siteId ? entries.filter(e => e.site_id === siteId) : entries;

  // Add entry when a new result arrives (from parent)
  useEffect(() => {
    if (!newEntry) return;
    const { provider_id, brand_present, presType = null, mentionPos = null, site_id = null } = newEntry;
    if (!provider_id) return;

    // Rechargement depuis la base après un court délai : les entrées écrites PAR
    // MARQUE au run (site_id) apparaissent alors pour CHAQUE ligne de marque, pas
    // seulement la principale. S'exécute pour toutes les marques (avant le filtre).
    const reloadT = setTimeout(() => {
      sbGetCalendarEntries(questionId).then(rows => setEntries(rows || [])).catch(() => {});
    }, 2500);

    // Carré optimiste immédiat : uniquement pour la marque de cette entrée.
    if (siteId && site_id && site_id !== siteId) return () => clearTimeout(reloadT);

    const today = localDateKey(new Date());
    const flags = {
      brand_mention:   presType === "mention"   ? 1 : 0,
      brand_evocation: presType === "evocation" ? 1 : 0,
      brand_citation:  presType === "citation"  ? 1 : 0,
      mention_position: presType === "mention" ? mentionPos : null,
    };
    const optimistic = { provider_id, test_date: today, brand_present: !!brand_present, site_id, ...flags };

    // Optimistic — add immediately
    setEntries(prev => [...prev, optimistic]);

    // Persist (avec type + position)
    sbAddCalendarEntry(questionId, provider_id, brand_present, presType, mentionPos, site_id)
      .then(saved => {
        if (saved?.id) {
          setEntries(prev => prev.map(e =>
            e === optimistic
              ? { provider_id: saved.provider_id, test_date: String(saved.test_date).slice(0, 10), brand_present: saved.brand_present,
                  brand_mention: saved.brand_mention, brand_evocation: saved.brand_evocation, brand_citation: saved.brand_citation, mention_position: saved.mention_position, site_id: saved.site_id }
              : e
          ));
        }
      })
      .catch(() => {});
    return () => clearTimeout(reloadT);
  }, [newEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  return <CalendarGrid entries={shownEntries} providers={providers} errorMsg={errorMsg} />;
}