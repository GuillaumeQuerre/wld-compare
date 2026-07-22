// compareEngine.jsx — Lot B1 : comparaison concurrentielle approfondie
// Partie 1 (données LLM, déjà en base) opérationnelle ; parties 2 (Screaming Frog)
// et 3 (Semrush) en squelette avec CTA d'import (remplies au Lot B2).
import React from "react";

// ── Définition des lignes du tableau ─────────────────────────────────────────
// group : "llm" | "sf" | "semrush"
// better: "high" (plus grand = mieux) | "low" (plus petit = mieux) | null (neutre)
// fmt   : formatage d'affichage
export const COMPARE_ROWS = [
  // Partie 1 — Résultats LLM (source : réponses des moteurs, déjà en base)
  { id: "mentions",   group: "llm", label: "Mentions classées",      better: "high", fmt: (v) => v == null ? "—" : String(v) },
  { id: "evocations", group: "llm", label: "Évocations",             better: "high", fmt: (v) => v == null ? "—" : String(v) },
  { id: "citations",  group: "llm", label: "Citations sources",      better: "high", fmt: (v) => v == null ? "—" : String(v) },
  { id: "avgPos",     group: "llm", label: "Position moyenne",       better: "low",  fmt: (v) => v == null ? "—" : `#${v}` },
  { id: "urlsCited",  group: "llm", label: "URLs citées (distinctes)", better: "high", fmt: (v) => v == null ? "—" : String(v) },
  { id: "bestUrlHits",group: "llm", label: "Citations de la meilleure URL", better: "high", fmt: (v) => v == null ? "—" : String(v) },
  // Partie 2 — Screaming Frog (Lot B2)
  { id: "sf_pages200",  group: "sf", label: "Pages 200",              better: "high", needs: "sf" },
  { id: "sf_images",    group: "sf", label: "Images",                better: "high", needs: "sf" },
  { id: "sf_h1multi",   group: "sf", label: "Pages à H1 multiples",  better: "low",  needs: "sf" },
  { id: "sf_titleLong", group: "sf", label: "Titles trop longs",     better: "low",  needs: "sf" },
  // Partie 3 — Semrush (Lot B2)
  { id: "sm_keywords",  group: "semrush", label: "Mots-clés organiques", better: "high", needs: "semrush" },
  { id: "sm_traffic",   group: "semrush", label: "Trafic organique",     better: "high", needs: "semrush" },
];

export const COMPARE_GROUPS = [
  { id: "llm",     label: "Résultats des moteurs IA", tool: null },
  { id: "sf",      label: "Analyse technique — Screaming Frog", tool: "Screaming Frog" },
  { id: "semrush", label: "Visibilité SEO — Semrush", tool: "Semrush" },
];

// ── Partie 1 : stats LLM par site (marque + concurrents) ─────────────────────
// Renvoie { columns:[{key,label,isBrand,color}], data:{ rowId: { colKey: value } } }
// brandStats : { mentions, evocations, citations, avgPos, urlsCited, bestUrlHits }
// compEntries : [{ key, label, color, isBrand, stats:{...} }]
export function buildLlmComparison(brandLabel, brandStats, compEntries, toolStatsByCol = {}) {
  const columns = [
    { key: "__brand__", label: brandLabel || "Votre marque", isBrand: true, color: "#1A3C2E" },
    ...compEntries.map(c => ({ key: c.key, label: c.label, isBrand: false, color: c.color || "#64748B" })),
  ];
  const statBy = { __brand__: brandStats || {} };
  compEntries.forEach(c => { statBy[c.key] = c.stats || {}; });
  const data = {};
  // Partie 1 — Résultats LLM (source : réponses des moteurs)
  COMPARE_ROWS.filter(r => r.group === "llm").forEach(r => {
    data[r.id] = {};
    columns.forEach(col => {
      const s = statBy[col.key] || {};
      data[r.id][col.key] = s[r.id] != null ? s[r.id] : null;
    });
  });
  // Parties 2 & 3 — Screaming Frog / Semrush (par colonne si fourni, sinon "—")
  // toolStatsByCol : { <colKey>: { sf_pages200, sf_images, …, sm_keywords, sm_traffic } }
  COMPARE_ROWS.filter(r => r.group === "sf" || r.group === "semrush").forEach(r => {
    data[r.id] = {};
    columns.forEach(col => {
      const ts = toolStatsByCol[col.key] || {};
      data[r.id][col.key] = ts[r.id] != null ? ts[r.id] : null;
    });
  });
  return { columns, data };
}

// ── Moteur de périmètre SF : filtre les lignes SF selon un périmètre ─────────
// perimeter : { paths:[prefixes], indexableOnly, status200Only, minWords, maxDepth }
// Chemins = OU logique de préfixes ; vide = tous. Les filtres nuls/false sont ignorés.
export function applySfPerimeter(rows, perimeter) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  if (!perimeter) return rows;
  const { paths, indexableOnly, status200Only, minWords, maxDepth } = perimeter;
  const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const F = (row, ...keys) => { const w = keys.map(norm); for (const k of Object.keys(row)) { if (w.includes(norm(k))) return row[k]; } return undefined; };
  const toInt = (v) => { const n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; };
  const pathList = (Array.isArray(paths) ? paths : []).map(p => (p || "").trim().toLowerCase()).filter(Boolean);
  const getPath = (url) => { try { return (new URL(url).pathname || "").toLowerCase(); } catch { const m = String(url || "").toLowerCase().replace(/^https?:\/\/[^/]+/, ""); return m || "/"; } };
  const hasMinWords = minWords != null && minWords !== "" && Number.isFinite(Number(minWords));
  const hasMaxDepth = maxDepth != null && maxDepth !== "" && Number.isFinite(Number(maxDepth));
  return rows.filter(row => {
    const url = F(row, "Adresse", "Address", "URL", "Page") || "";
    if (pathList.length) { const path = getPath(url); if (!pathList.some(p => path.startsWith(p))) return false; }
    if (status200Only) { const code = toInt(F(row, "Code HTTP", "Status Code")); if (code !== 200) return false; }
    if (indexableOnly) { const ix = norm(F(row, "Statut d'indexabilité", "Indexability", "Indexabilite")); if (!ix.includes("index") || ix.includes("non") || ix.includes("not")) return false; }
    if (hasMinWords) { const w = toInt(F(row, "Nombre de mots", "Word Count")); if (w == null || w < Number(minWords)) return false; }
    if (hasMaxDepth) { const d = toInt(F(row, "Profondeur de crawl", "Crawl Depth", "Crawl Profondeur")); if (d == null || d > Number(maxDepth)) return false; }
    return true;
  });
}

// Périmètre actif d'un site (depuis ses presets) → config ou null (aucun filtre).
export function getSitePerimeter(site) {
  if (!site || !Array.isArray(site.sf_presets) || !site.sf_activePreset) return null;
  return site.sf_presets.find(p => p.id === site.sf_activePreset) || null;
}

// ── Agrégats Screaming Frog pour la comparaison (à partir des lignes brutes) ──
// rows : sfData[site.id] (lignes CSV brutes de l'export « internal_all »).
// Renvoie { sf_pages200, sf_images, sf_h1multi, sf_titleLong } ou null si vide.
export function sfCompareStats(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const F = (row, ...keys) => {
    const wanted = keys.map(norm);
    for (const k of Object.keys(row)) { if (wanted.includes(norm(k))) return row[k]; }
    return undefined;
  };
  const toInt = (v) => { const n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; };
  let sf_pages200 = 0, sf_images = 0, sf_h1multi = 0, sf_titleLong = 0;
  rows.forEach(row => {
    const ct = String(F(row, "Type de contenu", "Content Type") || "").toLowerCase();
    const code = toInt(F(row, "Code HTTP", "Status Code", "statuscode"));
    const isImage = ct.includes("image");
    if (isImage) { sf_images++; return; }
    const isHtml = ct.includes("html") || ct === ""; // type inconnu → traité comme page
    if (!isHtml) return;
    if (code === 200) sf_pages200++;
    const h12 = String(F(row, "H1-2") || "").trim();
    if (h12) sf_h1multi++;
    const tl = toInt(F(row, "Longueur du Title 1", "Title 1 Length"));
    if (tl != null && tl > 60) sf_titleLong++;
  });
  return { sf_pages200, sf_images, sf_h1multi, sf_titleLong };
}

// ── Agrégats Semrush pour la comparaison (export « Organic Pages ») ──────────
// rows : smData[site.id] (lignes de l'export top pages Semrush).
// sm_keywords = somme des mots-clés par page ; sm_traffic = somme du trafic.
// Renvoie une métrique à null si sa colonne est absente (jamais un faux chiffre).
export function smCompareStats(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const F = (row, ...keys) => {
    const wanted = keys.map(norm);
    for (const k of Object.keys(row)) { if (wanted.includes(norm(k))) return row[k]; }
    return undefined;
  };
  const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; };
  let kw = 0, tr = 0, kwFound = false, trFound = false;
  rows.forEach(row => {
    const k = num(F(row, "Number of Keywords", "nombre de mots-cles", "keywords", "num keywords", "nb keywords"));
    const t = num(F(row, "Traffic", "trafic", "organic traffic"));
    if (k != null) { kw += k; kwFound = true; }
    if (t != null) { tr += t; trFound = true; }
  });
  return { sm_keywords: kwFound ? Math.round(kw) : null, sm_traffic: trFound ? Math.round(tr) : null };
}

// ── Semrush « Overview » : totaux autoritatifs du domaine ────────────────────
// Parse l'export overview-trend : une ligne par métrique, valeur dans « Summary ».
// Renvoie { organic_traffic, organic_keywords } (nombres) ou null.
export function parseSemrushOverview(text) {
  if (!text || typeof text !== "string") return null;
  const clean = text.replace(/^\uFEFF/, "");
  const parseLine = (line) => {
    const out = []; let val = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { val += '"'; i++; } else inQ = false; } else val += ch; }
      else { if (ch === '"') inQ = true; else if (ch === ",") { out.push(val); val = ""; } else val += ch; }
    }
    out.push(val); return out;
  };
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return null;
  const header = parseLine(lines[0]).map(h => h.toLowerCase().trim());
  const iMetric = header.indexOf("metric");
  const iSummary = header.indexOf("summary");
  if (iMetric === -1 || iSummary === -1) return null;
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; };
  let organic_traffic = null, organic_keywords = null;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const metric = (cols[iMetric] || "").toLowerCase().trim();
    const summary = num(cols[iSummary]);
    if (metric === "organic traffic") organic_traffic = summary;
    else if (metric === "organic keywords") organic_keywords = summary;
  }
  if (organic_traffic == null && organic_keywords == null) return null;
  return { organic_traffic, organic_keywords };
}

// Résout les stats Semrush du tableau (sm_keywords, sm_traffic) :
// priorité à l'Overview (totaux du domaine), repli sur la somme des top pages.
export function resolveSmStats(overview, pagesRows) {
  if (overview && (overview.organic_keywords != null || overview.organic_traffic != null)) {
    return { sm_keywords: overview.organic_keywords ?? null, sm_traffic: overview.organic_traffic ?? null };
  }
  return smCompareStats(pagesRows);
}

// ── Détermine la meilleure cellule d'une ligne (pour la bordure) ─────────────
export function bestColKey(rowDef, rowData) {
  if (!rowDef.better || !rowData) return null;
  let best = null, bestVal = null;
  Object.entries(rowData).forEach(([k, v]) => {
    const num = typeof v === "string" ? parseFloat(v) : v;
    if (num == null || !Number.isFinite(num)) return;
    if (bestVal == null || (rowDef.better === "high" ? num > bestVal : num < bestVal)) { bestVal = num; best = k; }
  });
  // Pas de "meilleure" si une seule valeur numérique
  const numericCount = Object.values(rowData).filter(v => Number.isFinite(typeof v === "string" ? parseFloat(v) : v)).length;
  return numericCount > 1 ? best : null;
}

// ── Composant tableau réutilisable (onglet Concurrents + audit) ──────────────
// mode "edit"  : checkbox d'inclusion par ligne + CTA d'import (onglet Concurrents)
// mode "audit" : lecture seule, ne montre que les lignes incluses
export function CompareTable({
  columns = [], data = {}, includedRows = null, onToggleRow = null,
  importStatus = {}, onImport = null, mode = "edit",
}) {
  if (!columns.length) return null;
  const isIncluded = (rowId) => includedRows == null || includedRows.includes(rowId);
  const rowsToShow = mode === "audit" ? COMPARE_ROWS.filter(r => isIncluded(r.id)) : COMPARE_ROWS;
  const C = { ink: "#1A3C2E", mid: "#64748B", line: "#1A3C2E14", head: "#1A3C2E", best: "#1A7A4A" };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
        <thead>
          <tr>
            {mode === "edit" && <th style={{ width: 28, borderBottom: `1px solid ${C.line}` }} />}
            <th style={{ textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.mid, fontWeight: 600, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>Critère</th>
            {columns.map(col => (
              <th key={col.key} style={{ textAlign: "center", padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: col.isBrand ? C.head : col.color, fontWeight: 700, fontSize: 12, minWidth: 96 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color, display: "inline-block" }} />
                  {col.label}{col.isBrand ? " ★" : ""}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_GROUPS.map(group => {
            const groupRows = rowsToShow.filter(r => r.group === group.id);
            if (!groupRows.length) return null;
            return (
              <React.Fragment key={group.id}>
                <tr>
                  <td colSpan={columns.length + (mode === "edit" ? 2 : 1)} style={{ padding: "12px 10px 5px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mid, background: "transparent" }}>
                    {group.label}
                  </td>
                </tr>
                {groupRows.map(rowDef => {
                  const rowData = data[rowDef.id] || {};
                  const best = bestColKey(rowDef, rowData);
                  const included = isIncluded(rowDef.id);
                  return (
                    <tr key={rowDef.id} style={{ opacity: mode === "edit" && !included ? 0.4 : 1 }}>
                      {mode === "edit" && (
                        <td style={{ textAlign: "center", borderBottom: `1px solid ${C.line}` }}>
                          <input type="checkbox" checked={included} onChange={() => onToggleRow && onToggleRow(rowDef.id)}
                            title={included ? "Incluse dans l'audit" : "Exclue de l'audit"}
                            style={{ cursor: "pointer", accentColor: "#1A3C2E" }} />
                        </td>
                      )}
                      <td style={{ padding: "7px 10px", borderBottom: `1px solid ${C.line}`, color: C.ink, fontWeight: 500 }}>{rowDef.label}</td>
                      {columns.map(col => {
                        const needsTool = rowDef.needs;
                        const hasImport = !needsTool || importStatus[col.key]?.[needsTool];
                        const v = rowData[col.key];
                        if (needsTool && !hasImport) {
                          // Cellule sans import → CTA (mode edit) ou tiret (audit, mode dégradé)
                          return (
                            <td key={col.key} style={{ textAlign: "center", padding: "6px 8px", borderBottom: `1px solid ${C.line}` }}>
                              {mode === "edit" && onImport ? (
                                <button onClick={() => onImport(col, needsTool)}
                                  style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, border: "1px dashed #1A4A7A55", background: "#1A4A7A08", color: "#1A4A7A", cursor: "pointer", whiteSpace: "nowrap" }}>
                                  ↑ Importer {needsTool === "sf" ? "SF" : "Semrush"}
                                </button>
                              ) : (
                                <span title="Import manquant pour ce site" style={{ color: "#CBD5E1", cursor: "help" }}>—</span>
                              )}
                            </td>
                          );
                        }
                        const isBest = best === col.key && v != null;
                        return (
                          <td key={col.key} style={{
                            textAlign: "center", padding: "6px 8px", borderBottom: `1px solid ${C.line}`,
                            color: col.isBrand ? C.head : C.ink,
                            fontWeight: isBest ? 700 : 500,
                            border: isBest ? `1.5px solid ${C.best}` : undefined,
                            borderRadius: isBest ? 6 : undefined,
                            background: isBest ? "#1A7A4A0A" : undefined,
                          }}>
                            {rowDef.fmt ? rowDef.fmt(v) : (v == null ? "—" : String(v))}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}