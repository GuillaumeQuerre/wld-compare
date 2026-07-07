// ════════════════════════════════════════════════════════════════════
// exportOptimisations.js  →  src/lib/exportOptimisations.js
// Exports "format clusters" inspirés d'un tableau de clustering de mots-clés.
// Deux jeux, pensés comme 2 onglets :
//   • "Optimisations mots clés" : par cluster (= catégorie), mots-clés + actions roadmap "Et maintenant".
//   • "Optimisations GEO"        : par page auditée (URL du site), mots-clés liés + actions GEO de l'audit.
// Colonnes inspirées de l'image :
//   Mot-clé / Élément | Mot clé principal (Primaire/Secondaire) | Intégré | Page | Volume | Difficulté | Score
// La difficulté et le score n'existent pas dans l'app → colonnes laissées vides (à compléter, comme un template).
// La colonne "Intégré" vaut FALSE : dans Google Sheets, Insertion ▸ Case à cocher la transforme en case décochée.
// ════════════════════════════════════════════════════════════════════

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  return "\uFEFF" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
}

// Téléchargement (autonome — n'a pas besoin des helpers de l'app).
export function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Nettoie le markdown des actions (**gras**, [texte](url)) pour un rendu CSV propre.
function stripMd(s) {
  return String(s || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\s+/g, " ")
    .trim();
}
const iceScore = (a) => (a?.impact || 0) + (a?.confidence || 0) + (a?.ease || 0);

const HEADER_LABELS = ["Mot clé principal", "Intégré", "Page", "Volume", "Difficulté", "Score"];
const clusterHeader = (name) => [name, ...HEADER_LABELS];
const SEP = ["", "", "", "", "", "", ""];

// ── Onglet 1 : Optimisations mots clés (par cluster = catégorie) ──────────
export function buildKeywordClustersCsv({ keywords = [], roadmap = [], categories = [] }) {
  const catNameById = {};
  categories.forEach(c => { if (c && c.id != null) catNameById[c.id] = c.name; });
  const kwCatIds = (k) => (k.tags && k.tags.length ? k.tags : (k.category_id ? [k.category_id] : []));

  // Index des actions roadmap par nom de catégorie (insensible à la casse).
  const roadByCat = {};
  roadmap.forEach(r => {
    const key = (r.category || "Autres").toLowerCase().trim();
    (roadByCat[key] = roadByCat[key] || []).push(r);
  });

  // Regroupe les mots-clés par cluster (1ère catégorie connue, sinon "Sans catégorie").
  const clusters = {};
  keywords.forEach(k => {
    const names = kwCatIds(k).map(id => catNameById[id]).filter(Boolean);
    const name = names[0] || "Sans catégorie";
    (clusters[name] = clusters[name] || []).push(k);
  });

  const rows = [];
  const usedRoadKeys = new Set();

  Object.keys(clusters).sort((a, b) => a.localeCompare(b, "fr")).forEach(name => {
    const kws = clusters[name].slice().sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0));
    const roadKey = name.toLowerCase().trim();
    const acts = roadByCat[roadKey] || [];
    if (acts.length) usedRoadKeys.add(roadKey);
    const clusterPage = (acts.find(a => a.target_url) || {}).target_url || "";

    rows.push(clusterHeader(name));
    kws.forEach((k, i) => rows.push([
      k.keyword, i === 0 ? "Primaire" : "Secondaire", "FALSE",
      clusterPage, k.search_volume ?? "", "", "",
    ]));
    if (acts.length) {
      rows.push(["Actions à faire", "", "", "", "", "", ""]);
      acts.forEach(a => rows.push([
        "• " + stripMd(a.action),
        a.target_url ? (a.page_exists ? "Optimiser" : "Créer") : "Action",
        "FALSE", a.target_url || "", "", "", iceScore(a) || "",
      ]));
    }
    rows.push(SEP);
  });

  // Actions roadmap dont la catégorie ne correspond à aucun cluster de mots-clés.
  const orphan = roadmap.filter(r => !usedRoadKeys.has((r.category || "Autres").toLowerCase().trim()));
  if (orphan.length) {
    rows.push(clusterHeader("Autres actions (sans mots-clés rattachés)"));
    orphan.forEach(a => rows.push([
      "• " + stripMd(a.action),
      a.target_url ? (a.page_exists ? "Optimiser" : "Créer") : "Action",
      "FALSE", a.target_url || "", "", "", iceScore(a) || "",
    ]));
    rows.push(SEP);
  }

  if (!rows.length) rows.push(["Aucun mot-clé ni action à exporter", "", "", "", "", "", ""]);
  return toCSV(rows);
}

// ── Onglet 2 : Optimisations GEO (par page auditée) ───────────────────────
export function buildGeoPagesCsv({ audit, keywords = [] }) {
  const kwById = {};
  keywords.forEach(k => { if (k && k.id != null) kwById[k.id] = k; });

  const rows = [];
  const norm = (u) => u.norm || u.url;
  const optimizeSet = new Set((audit.urlsToOptimize || []).map(norm));
  const reworkSet = new Set((audit.urlsToRework || []).map(norm));

  // URLs du site auditées (sinon repli sur toutes les URLs triées).
  const pages = (audit.brandOwnUrls && audit.brandOwnUrls.length)
    ? audit.brandOwnUrls
    : (audit.brandUrls || audit.sortedUrls || []);

  pages.forEach(u => {
    const url = u.url || u.norm;
    if (!url) return;
    const status = optimizeSet.has(norm(u)) ? "À optimiser"
      : reworkSet.has(norm(u)) ? "À retravailler"
      : "Référence / à maintenir";

    rows.push([url, "Statut : " + status, "Intégré", "Page", "Volume", "Difficulté", "Score"]);

    // Mots-clés liés à la page (résolus depuis les ids).
    const resolved = (u.linkedKeywords || [])
      .map(id => kwById[id])
      .filter(Boolean)
      .sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0));
    if (resolved.length) {
      resolved.forEach((k, i) => rows.push([
        k.keyword, i === 0 ? "Primaire" : "Secondaire", "FALSE",
        url, k.search_volume ?? "", "", "",
      ]));
    } else {
      rows.push(["(aucun mot-clé lié détecté)", "", "", url, "", "", ""]);
    }

    // Action GEO de la page.
    rows.push(["Actions à faire", "", "", "", "", "", ""]);
    if (status === "À optimiser") {
      rows.push(["• Optimiser la page pour être davantage citée par les LLMs : réponse directe dès l'intro, listes comparatives explicites, FAQ + JSON-LD.", "Optimiser", "FALSE", url, "", "", ""]);
    } else if (status === "À retravailler") {
      rows.push(["• Page citée mais pas en source : renforcer l'autorité (backlinks, IndexNow) et clarifier la structure (H2/H3, FAQ).", "Retravailler", "FALSE", url, "", "", ""]);
    } else {
      rows.push(["• Maintenir et enrichir ; utiliser comme hub de maillage interne vers les pages du même axe.", "Maintenir", "FALSE", url, "", "", ""]);
    }
    rows.push(SEP);
  });

  // Recommandations GEO globales (issues de l'audit).
  if (audit.leads && audit.leads.length) {
    rows.push(["Recommandations GEO globales", "Priorité", "Intégré", "", "", "", ""]);
    audit.leads.forEach(l => rows.push([
      "• " + stripMd(l.action), l.priority || "", "FALSE", "", "", "", "",
    ]));
    rows.push(SEP);
  }

  if (!rows.length) rows.push(["Aucune page auditée à exporter", "", "", "", "", "", ""]);
  return toCSV(rows);
}