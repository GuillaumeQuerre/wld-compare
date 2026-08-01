// Helpers d'affichage PURS du calendrier de présence (sans JSX, testables via node).
// Importés par PresenceCalendar.jsx ET par presenceCalendar.test.mjs.

// Classifie une entrée calendrier en cellule : présence + type (m/e/c) + position.
export function classifyCalEntry(e) {
  const present = e.brand_present === true || e.brand_present === 1;
  const isMention   = e.brand_mention === 1 || e.brand_mention === true;
  const isEvocation = e.brand_evocation === 1 || e.brand_evocation === true;
  const isCitation  = e.brand_citation === 1 || e.brand_citation === true;
  let type = null, pos = null;
  if (isMention)        { type = "m"; pos = e.mention_position != null ? e.mention_position : null; }
  else if (isEvocation) { type = "e"; }
  else if (isCitation)  { type = "c"; }
  return { present, type, pos };
}

// Fusionne deux cellules du même jour : présent l'emporte, type le plus fort (m>e>c).
export function mergeCalCells(cur, cand) {
  if (cur === undefined) return cand;
  const rank = { m: 3, e: 2, c: 1, null: 0 };
  const merged = { present: cur.present || cand.present };
  if ((rank[cand.type] || 0) >= (rank[cur.type] || 0)) { merged.type = cand.type; merged.pos = cand.pos; }
  else { merged.type = cur.type; merged.pos = cur.pos; }
  return merged;
}

// Groupe des entrées par provider → date → cellule fusionnée.
export function groupCalByProvider(entries) {
  const byProvider = {};
  (entries || []).forEach(e => {
    const pid = e.provider_id;
    const key = String(e.test_date).slice(0, 10);
    if (!byProvider[pid]) byProvider[pid] = {};
    byProvider[pid][key] = mergeCalCells(byProvider[pid][key], classifyCalEntry(e));
  });
  return byProvider;
}

// Couleur du carré : gris (non testé), rouge (absent), vert (mention),
// orange (évocation), vert profond (citation).
export function cellColor(cell) {
  if (cell === undefined) return "#E5E7EB";
  if (!cell.present) return "#DC2626";
  if (cell.type === "m") return "#059669";
  if (cell.type === "e") return "#D97706";
  if (cell.type === "c") return "#1A3C2E";
  return "#059669";
}

// Glyphe : position si mention, sinon e / c, ✓ si présent non ventilé, "" sinon.
export function cellGlyph(cell) {
  if (!cell || !cell.present) return "";
  if (cell.type === "m") return cell.pos != null ? String(cell.pos) : "m";
  if (cell.type === "e") return "e";
  if (cell.type === "c") return "c";
  return "✓";
}

// Filtre par marque : ne garder que les entrées d'un site_id (null = tout).
export function filterCalBySite(entries, siteId) {
  return siteId ? (entries || []).filter(e => e.site_id === siteId) : (entries || []);
}

// Type de présence d'une marque (une valeur de brand_presences) :
// mention (classée) > évocation (citée sans rang) > citation (dans les sources) > null.
export function presenceType(pres) {
  if (!pres) return null;
  if (pres.mention_position != null) return "mention";
  if (pres.evocation_position != null) return "evocation";
  if (pres.in_sources) return "citation";
  return null;
}

// Construit une entrée calendrier à partir de la présence d'une marque.
// Utilisé pour l'optimiste (affichage immédiat) ET pour l'écriture au run,
// afin que les deux produisent exactement la même chose.
export function presenceToCalEntry(provider_id, site_id, pres, test_date) {
  const type = presenceType(pres);
  return {
    provider_id, site_id, test_date,
    brand_present: !!((pres && pres.mentioned) || type === "citation"),
    brand_mention:   type === "mention"   ? 1 : 0,
    brand_evocation: type === "evocation" ? 1 : 0,
    brand_citation:  type === "citation"  ? 1 : 0,
    mention_position: type === "mention" ? (pres && pres.mention_position != null ? pres.mention_position : null) : null,
  };
}

// Construit des entrées calendrier à partir des RÉSULTATS d'interrogation
// (geo_results), qui portent brand_presences par marque et persistent toujours.
export function resultsToCalEntries(results, getProviderId) {
  const out = [];
  (results || []).forEach(r => {
    const test_date = (r.created_at || "").slice(0, 10);
    if (!test_date) return;
    const provider_id = typeof getProviderId === "function" ? getProviderId(r.model) : (r.provider_id || r.model);
    const bp = r.brand_presences && typeof r.brand_presences === "object" ? r.brand_presences : null;
    if (bp && Object.keys(bp).length) {
      Object.entries(bp).forEach(([sid, pres]) => out.push(presenceToCalEntry(provider_id, sid, pres, test_date)));
    } else {
      // Pas de ventilation par marque : entrée « marque principale » (site_id null),
      // reconstruite depuis les champs de position du résultat.
      const pres = {
        mentioned: !!r.brand_mentioned,
        mention_position:   r.brand_mention_position   ?? null,
        evocation_position: r.brand_evocation_position ?? null,
        citation_position:  r.brand_citation_position  ?? null,
        in_sources: !!r.brand_in_sources,
      };
      out.push(presenceToCalEntry(provider_id, null, pres, test_date));
    }
  });
  return out;
}