import { useState, useEffect } from "react";
import { sbGetCalendarEntries } from "../lib/supabase";
import { groupCalByProvider, cellColor, cellGlyph, filterCalBySite, presenceToCalEntry } from "../lib/calendarDisplay";

// PROVIDERS is passed as prop to avoid circular import
const DAYS = 30;

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── CalendarGrid — pure rendering ────────────────────────────────

function CalendarGrid({ entries, providers, errorMsg = null, alwaysShow = false, hideProviderLabel = false }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ERR_COLOR = "#B45309"; // ambre — distinct du rouge "absent"

  // Group entries by provider → date → cellule (helpers purs, testés unitairement)
  const byProvider = groupCalByProvider(entries);

  // alwaysShow : afficher la grille même sans aucune entrée (carrés gris « non testé »),
  // pour que chaque ligne de marque montre sa timeline dès l'affichage.
  const activeProviders = alwaysShow ? providers : providers.filter(p => byProvider[p.id] || errorMsg);
  if (!activeProviders.length) return null;

  // Glyphe et couleur : helpers purs exportés (testés). Label reste local.
  const glyphOf = cellGlyph;
  const colorOf = cellColor;
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
            {!hideProviderLabel && (
              <span style={{ fontSize: 10, fontWeight: 700, color: p.color, minWidth: 68, flexShrink: 0 }}>
                {p.icon} {p.label}
              </span>
            )}
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

export default function PresenceCalendar({ questionId, providers = [], newEntry = null, errorMsg = null, siteId = null, alwaysShow = false, hideProviderLabel = false }) {
  const [entries, setEntries] = useState([]);

  // Load from DB on mount / question change
  useEffect(() => {
    if (!questionId) return;
    sbGetCalendarEntries(questionId).then(rows => setEntries(rows || [])).catch(() => {});
  }, [questionId]);

  // Filtre par marque (helper pur testé) : ne garder que les entrées de ce site_id.
  const shownEntries = filterCalBySite(entries, siteId);

  // Add entry when a new result arrives (from parent)
  useEffect(() => {
    if (!newEntry) return;
    const { provider_id, presences = null } = newEntry;
    if (!provider_id) return;

    // Rechargements MULTIPLES avec fusion : plusieurs tentatives espacées, car les
    // écritures par marque du run n'atterrissent pas toutes en même temps. On
    // FUSIONNE (on n'écrase pas l'optimiste tant que la base n'a pas confirmé).
    const timers = [1500, 4000, 8000].map(delay => setTimeout(() => {
      sbGetCalendarEntries(questionId).then(rows => {
        const fresh = filterCalBySite(rows || [], siteId);
        if (fresh.length) setEntries(rows || []); // la base a des entrées pour cette marque → source de vérité
      }).catch(() => {});
    }, delay));

    // Carré optimiste immédiat pour CETTE marque, tiré de presences[siteId].
    const mySite = siteId || null;
    const pres = presences && mySite ? presences[mySite] : (presences && !mySite ? Object.values(presences)[0] : null);
    if (pres) {
      const today = localDateKey(new Date());
      const optimistic = presenceToCalEntry(provider_id, mySite, pres, today);
      setEntries(prev => {
        // remplace une éventuelle entrée optimiste du même jour/marque, sinon ajoute
        const others = prev.filter(e => !(String(e.test_date).slice(0, 10) === today && (e.site_id ?? null) === mySite && e.provider_id === provider_id));
        return [...others, optimistic];
      });
    }
    return () => timers.forEach(clearTimeout);
  }, [newEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  return <CalendarGrid entries={shownEntries} providers={providers} errorMsg={errorMsg} alwaysShow={alwaysShow} hideProviderLabel={hideProviderLabel} />;
}