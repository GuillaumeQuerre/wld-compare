// src/lib/audit-tools.js
// ════════════════════════════════════════════════════════════════
// Modules d'analyse croisant les imports d'outils (Screaming Frog,
// GSC, GA, Bing) avec les données de présence GEO (Fan-outs).
// Chaque module est indépendant et activable via un switch dans l'UI.
// Tier 1 (#4, #1, #7) · Tier 2 (#2, #10, #9) · Tier 3 (#8, #5, #3, #6)
// ════════════════════════════════════════════════════════════════

// ── Helpers de normalisation d'URL / nombres ─────────────────────
function tNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[%\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// Chemin normalisé d'une URL (sans protocole, www, query, slash final) — pour le matching
export function urlPath(raw) {
  if (!raw) return "";
  let u = String(raw).trim().toLowerCase();
  u = u.replace(/[?#].*$/, "").replace(/\/+$/, "");
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const slash = u.indexOf("/");
  return slash >= 0 ? u.slice(slash) : "/"; // garde le chemin uniquement
}

// Lecture tolérante d'un champ (gère variantes FR/EN)
function field(row, ...keys) {
  for (const k of keys) {
    const v = row[k] ?? row[k?.toLowerCase?.()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// ── Indexer les lignes outil par chemin d'URL ────────────────────
function indexByPath(rows, ...urlKeys) {
  const map = {};
  (rows || []).forEach(r => {
    const raw = field(r, ...urlKeys);
    if (!raw) return;
    const p = urlPath(raw);
    if (p) map[p] = r;
  });
  return map;
}

// ════════════════════════════════════════════════════════════════
// EXTRACTEURS par ligne (renvoient des objets normalisés par URL)
// ════════════════════════════════════════════════════════════════

// Screaming Frog — une ligne par URL crawlée
export function sfRowMetrics(r) {
  const indexRaw = String(field(r, "indexability", "indexabilité", "indexable") || "").toLowerCase();
  return {
    url:        field(r, "address", "adresse", "url", "page") || "",
    crawlDepth: tNum(field(r, "crawl depth", "crawl profondeur")),
    inlinks:    tNum(field(r, "inlinks", "liens entrants", "liens entrants uniques")),
    wordCount:  tNum(field(r, "word count", "nombre de mots")),
    h1:         field(r, "h1-1", "h1", "title 1") || "",
    titleLen:   tNum(field(r, "title 1 length", "longueur du title 1", "longueur de la title 1")),
    metaLen:    tNum(field(r, "meta description 1 length", "longueur de la meta description 1")),
    flesch:     tNum(field(r, "flesch reading ease", "score de lisibilité de flesch")),
    statusCode: tNum(field(r, "status code", "code http", "statuscode") || 200),
    indexable:  indexRaw.includes("index") && !indexRaw.includes("non") && !indexRaw.includes("not"),
    indexRaw,
  };
}

// GSC — clics / impressions / ctr / position par URL
export function gscRowMetrics(r) {
  return {
    url:         field(r, "pages les plus populaires", "page", "url", "adresse", "address", "landing page") || "",
    clicks:      tNum(field(r, "clics", "clicks")),
    impressions: tNum(field(r, "impressions")),
    ctr:         tNum(field(r, "ctr", "taux de clics")),
    position:    tNum(field(r, "position", "position moyenne")),
  };
}

// Recherche d'une colonne insensible à la casse/aux accents/espaces
function fieldCI(row, ...keys) {
  const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const map = {};
  Object.keys(row || {}).forEach(k => { map[norm(k)] = row[k]; });
  for (const k of keys) {
    const v = map[norm(k)];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// GSC complet — query + page + position (gère dimension Requêtes seule OU Pages+Requêtes)
function gscRowFull(r) {
  return {
    query:       (fieldCI(r, "requêtes les plus fréquentes", "requête", "requete", "query", "queries", "mot-clé", "mot clé", "keyword", "search query") || "").toString().trim(),
    url:         fieldCI(r, "pages les plus populaires", "page", "url", "adresse", "address", "landing page") || "",
    clicks:      tNum(fieldCI(r, "clics", "clicks")),
    impressions: tNum(fieldCI(r, "impressions")),
    ctr:         tNum(fieldCI(r, "ctr", "taux de clics")),
    position:    tNum(fieldCI(r, "position", "position moyenne")),
  };
}

// Normalise un texte pour le matching (minuscules, sans accents, sans ponctuation)
function normText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Mots significatifs (retire les stopwords FR/EN courts et fréquents)
const GSC_STOP = new Set("le la les un une des de du au aux et ou a en dans pour par sur avec sans quel quelle quels quelles qui que quoi est sont meilleur meilleurs meilleure meilleures comment the of to and in for on with what which who is are best how".split(" "));
function sigWords(s) {
  return normText(s).split(" ").filter(w => w.length >= 3 && !GSC_STOP.has(w));
}

// Pour une question, trouve la meilleure page du site dans les données GSC importées.
// Stratégie : matching mots-clés question ↔ requête GSC (recouvrement), pondéré par
// la position (meilleure = plus bas). Gère les deux dimensions d'export GSC :
//  - si la ligne a une query → on matche sur la query ;
//  - sinon (dimension Pages seule) → on matche sur l'URL/le chemin.
// Retourne { url, position, query, score } ou null si rien d'exploitable.
export function matchGscForQuestion(question, gscRows, siteDomain = "") {
  if (!Array.isArray(gscRows) || !gscRows.length) return null;
  const qWords = sigWords(question);
  if (!qWords.length) return null;
  const qSet = new Set(qWords);
  let best = null;

  gscRows.forEach(raw => {
    const g = gscRowFull(raw);
    const hayText = g.query || g.url || "";
    if (!hayText) return;
    const hWords = sigWords(g.query ? g.query : urlPath(g.url).replace(/[-_/]/g, " "));
    if (!hWords.length) return;
    // recouvrement de mots
    let overlap = 0;
    hWords.forEach(w => { if (qSet.has(w)) overlap++; });
    if (overlap === 0) return;
    // score : recouvrement normalisé + bonus position (meilleure position = bonus)
    const coverage = overlap / Math.max(qWords.length, 1);
    const posBonus = g.position > 0 ? Math.max(0, (30 - Math.min(g.position, 30)) / 30) : 0;
    const score = coverage * 0.7 + posBonus * 0.3;
    if (!best || score > best.score || (score === best.score && (g.position || 99) < (best.position || 99))) {
      best = { url: g.url || "", position: g.position || null, query: g.query || "", score, coverage, overlap };
    }
  });

  // Seuil minimal de pertinence : au moins 1 mot significatif commun et couverture ≥ 25%
  if (best && best.coverage >= 0.25) return best;
  return best && best.overlap >= 2 ? best : null;
}

// GA — sessions / vues par URL
export function gaRowMetrics(r) {
  return {
    url:      field(r, "page path", "chemin de page", "page", "url", "adresse") || "",
    sessions: tNum(field(r, "ga4 sessions", "sessions", "séances")),
    views:    tNum(field(r, "ga4 views", "views", "pages vues")),
    conversions: tNum(field(r, "conversions", "key events", "événements clés", "transactions")),
    revenue:  tNum(field(r, "revenue", "revenus", "total revenue", "chiffre d'affaires")),
  };
}

// ════════════════════════════════════════════════════════════════
// MODULE #1 (Tier 1) — Pages à débloquer (SF × URLs citées GEO)
// URLs de la marque citées par les LLM mais avec un frein technique SF.
// ════════════════════════════════════════════════════════════════
export function computePagesToUnblock(audit, sfRows) {
  const sfIdx = indexByPath((sfRows || []).map(sfRowMetrics), "url");
  const cited = audit.brandOwnUrls || audit.brandUrls || [];
  const out = [];
  cited.forEach(u => {
    const raw = typeof u === "string" ? u : (u.url || u.address || "");
    const citations = typeof u === "object" ? (u.count || u.citations || 0) : 0;
    const p = urlPath(raw);
    const sf = sfIdx[p];
    if (!sf) return; // pas de données SF pour cette URL
    const issues = [];
    if (!sf.indexable)               issues.push("Non indexable");
    if (sf.statusCode >= 400)        issues.push(`Statut ${sf.statusCode}`);
    if (sf.crawlDepth > 4)           issues.push(`Profondeur ${sf.crawlDepth}`);
    if (sf.wordCount > 0 && sf.wordCount < 300) issues.push(`${sf.wordCount} mots`);
    if (sf.inlinks <= 1)             issues.push("Quasi orpheline");
    if (issues.length) out.push({ url: raw, citations, crawlDepth: sf.crawlDepth, inlinks: sf.inlinks, wordCount: sf.wordCount, indexable: sf.indexable, issues: issues.join(" · ") });
  });
  return out.sort((a, b) => b.citations - a.citations);
}

// ════════════════════════════════════════════════════════════════
// MODULE #2 (Tier 2) — Score de citabilité par page (SF)
// Structure extractible par les LLM : Hn, longueur, lisibilité, statut.
// ════════════════════════════════════════════════════════════════
export function computeCitabilityScores(sfRows, citedSet) {
  return (sfRows || []).map(sfRowMetrics).filter(s => s.url).map(s => {
    let score = 0;
    if (s.indexable) score += 25;
    if (s.statusCode < 400) score += 10;
    if (s.wordCount >= 600) score += 20; else if (s.wordCount >= 300) score += 10;
    if (s.h1) score += 10;
    if (s.titleLen >= 30 && s.titleLen <= 65) score += 10;
    if (s.metaLen >= 70 && s.metaLen <= 160) score += 10;
    if (s.flesch >= 50) score += 10;
    if (s.crawlDepth <= 3) score += 5;
    const isCited = citedSet ? citedSet.has(urlPath(s.url)) : false;
    return { url: s.url, score: Math.min(score, 100), wordCount: s.wordCount, crawlDepth: s.crawlDepth, flesch: s.flesch, cited: isCited };
  }).sort((a, b) => a.score - b.score); // pires en premier (quick wins)
}

// ════════════════════════════════════════════════════════════════
// MODULE #3 (Tier 3) — Contenus orphelins citables (SF inlinks faibles + cités)
// ════════════════════════════════════════════════════════════════
export function computeOrphanCited(audit, sfRows) {
  const sfIdx = indexByPath((sfRows || []).map(sfRowMetrics), "url");
  const cited = audit.brandOwnUrls || audit.brandUrls || [];
  const out = [];
  cited.forEach(u => {
    const raw = typeof u === "string" ? u : (u.url || u.address || "");
    const sf = sfIdx[urlPath(raw)];
    if (sf && sf.inlinks <= 2) out.push({ url: raw, inlinks: sf.inlinks, crawlDepth: sf.crawlDepth });
  });
  return out.sort((a, b) => a.inlinks - b.inlinks);
}

// ════════════════════════════════════════════════════════════════
// MODULE #4 (Tier 1) — Écart SEO ↔ GEO (GSC)
// Requêtes/pages fortes en SEO (clics, position) mais absentes du GEO.
// On rapproche par URL : pages GSC performantes non citées par l'IA.
// ════════════════════════════════════════════════════════════════
export function computeSeoGeoGap(audit, gscRows) {
  const citedPaths = new Set((audit.brandOwnUrls || audit.brandUrls || []).map(u => urlPath(typeof u === "string" ? u : (u.url || u.address || ""))));
  const rows = (gscRows || []).map(gscRowMetrics).filter(g => g.url && (g.clicks > 0 || g.impressions > 0));
  const out = rows.map(g => {
    const cited = citedPaths.has(urlPath(g.url));
    return { ...g, cited };
  }).filter(g => !g.cited && (g.clicks >= 1 || g.impressions >= 50)); // performe en SEO, absent en GEO
  // Trier par opportunité : clics puis impressions
  return out.sort((a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions)).slice(0, 100);
}

// ════════════════════════════════════════════════════════════════
// MODULE #5 (Tier 3) — Cannibalisation inverse (GSC)
// Forte impression + faible CTR = l'IA capte le clic. GEO défensif.
// ════════════════════════════════════════════════════════════════
export function computeReverseCannibalization(gscRows) {
  const rows = (gscRows || []).map(gscRowMetrics).filter(g => g.url && g.impressions >= 100);
  return rows.filter(g => g.ctr > 0 && g.ctr < 2 && g.position <= 10) // bien positionné mais peu cliqué
    .sort((a, b) => b.impressions - a.impressions).slice(0, 50);
}

// ════════════════════════════════════════════════════════════════
// MODULE #6 (Tier 3) — Comparatif Bing vs présence GEO
// ════════════════════════════════════════════════════════════════
export function computeBingGap(audit, bingData) {
  const entries = Object.entries(bingData || {});
  if (!entries.length) return [];
  // bingData = { topic/url : valeur }. On compare présence Bing vs présence GEO globale.
  return entries.map(([key, val]) => ({ topic: key, bingValue: typeof val === "number" ? val : tNum(val) }))
    .sort((a, b) => b.bingValue - a.bingValue).slice(0, 50);
}

// ════════════════════════════════════════════════════════════════
// MODULE #7 (Tier 1) — Pondération ICE par valeur business (GA)
// Enrichit chaque catégorie/question avec sessions/vues/conversions GA.
// ════════════════════════════════════════════════════════════════
export function computeBusinessValue(audit, gaRows) {
  const rows = (gaRows || []).map(gaRowMetrics).filter(g => g.url);
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
  const totalRevenue  = rows.reduce((s, r) => s + r.revenue, 0);
  // Top pages par valeur, avec statut de citation GEO
  const citedPaths = new Set((audit.brandOwnUrls || audit.brandUrls || []).map(u => urlPath(typeof u === "string" ? u : (u.url || u.address || ""))));
  const ranked = rows.map(g => ({ ...g, cited: citedPaths.has(urlPath(g.url)) }))
    .sort((a, b) => (b.revenue - a.revenue) || (b.sessions - a.sessions));
  // Pages à forte valeur business MAIS non citées en GEO = priorité absolue
  const highValueNotCited = ranked.filter(g => !g.cited && (g.revenue > 0 || g.sessions > 0)).slice(0, 50);
  return { totalSessions, totalRevenue, ranked: ranked.slice(0, 50), highValueNotCited, hasRevenue: totalRevenue > 0 };
}

// ════════════════════════════════════════════════════════════════
// MODULE #8 (Tier 3) — Trafic IA entrant (GA4 referrers)
// Sessions référées par les domaines IA (chatgpt, perplexity, gemini…).
// ════════════════════════════════════════════════════════════════
const AI_REFERRERS = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai", "bing.com/chat"];
export function computeAITraffic(gaRows) {
  const out = [];
  (gaRows || []).forEach(r => {
    const src = String(r["source"] || r["session source"] || r["source / support"] || r["source/medium"] || "").toLowerCase();
    const matched = AI_REFERRERS.find(ai => src.includes(ai.split("/")[0].split(".")[0]) && (src.includes(ai) || src.includes(ai.split(".")[0])));
    if (matched) out.push({ source: src, sessions: tNum(r["ga4 sessions"] || r["sessions"] || r["séances"]), engine: matched });
  });
  const byEngine = {};
  out.forEach(o => { byEngine[o.engine] = (byEngine[o.engine] || 0) + o.sessions; });
  return { rows: out, byEngine, total: out.reduce((s, o) => s + o.sessions, 0), detected: out.length > 0 };
}

// ════════════════════════════════════════════════════════════════
// EXPORT CSV CONTEXTUEL — pour un lot d'URLs ou de mots-clés
// columns = [{ key, label }], rows = objets
// ════════════════════════════════════════════════════════════════
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[;,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function buildCSV(columns, rows) {
  const header = columns.map(c => csvCell(c.label)).join(";");
  const body = (rows || []).map(r => columns.map(c => csvCell(r[c.key])).join(";")).join("\r\n");
  return "\uFEFF" + header + "\r\n" + body; // BOM pour Excel FR
}
export function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Définitions de colonnes contextuelles par type de ressource
export const CSV_COLUMNS = {
  unblock:      [{ key: "url", label: "URL" }, { key: "citations", label: "Citations IA" }, { key: "crawlDepth", label: "Profondeur crawl" }, { key: "inlinks", label: "Liens entrants" }, { key: "wordCount", label: "Nb mots" }, { key: "indexable", label: "Indexable" }, { key: "issues", label: "Freins détectés" }],
  citability:   [{ key: "url", label: "URL" }, { key: "score", label: "Score citabilité /100" }, { key: "wordCount", label: "Nb mots" }, { key: "crawlDepth", label: "Profondeur" }, { key: "flesch", label: "Lisibilité Flesch" }, { key: "cited", label: "Déjà citée" }],
  orphan:       [{ key: "url", label: "URL" }, { key: "inlinks", label: "Liens entrants" }, { key: "crawlDepth", label: "Profondeur" }],
  seoGap:       [{ key: "url", label: "URL" }, { key: "clicks", label: "Clics GSC" }, { key: "impressions", label: "Impressions GSC" }, { key: "ctr", label: "CTR %" }, { key: "position", label: "Position moy." }],
  cannibal:     [{ key: "url", label: "URL" }, { key: "impressions", label: "Impressions" }, { key: "ctr", label: "CTR %" }, { key: "position", label: "Position" }],
  bing:         [{ key: "topic", label: "Sujet / URL" }, { key: "bingValue", label: "Présence Bing" }],
  business:     [{ key: "url", label: "URL" }, { key: "sessions", label: "Sessions GA" }, { key: "views", label: "Vues" }, { key: "conversions", label: "Conversions" }, { key: "revenue", label: "Revenus" }, { key: "cited", label: "Citée IA" }],
  aiTraffic:    [{ key: "engine", label: "Moteur IA" }, { key: "source", label: "Source" }, { key: "sessions", label: "Sessions" }],
};