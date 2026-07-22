// ─────────────────────────────────────────────────────────────────────────────
// ExportFanout.js
// Utilitaire d'export CSV des questions fan-out où la marque est citée.
//
// INTÉGRATION dans GeoTab.jsx :
//   1. Copiez la fonction exportFanoutCSV() et le composant <ExportFanoutBtn>
//      dans votre fichier GeoTab.jsx (en dehors des autres composants).
//   2. Dans QuestionsTab, ajoutez le bouton dans la toolbar des filtres,
//      à côté du bouton "▶ Lancer tout" :
//
//      <ExportFanoutBtn
//        questions={filtered}
//        results={results}        // state interne de QuestionsTab
//        brandName={brand_name}
//        brandAliases={brand_aliases}
//        projectName={site?.name || "export"}
//      />
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { C } from "../lib/constants";

// ── Helpers ───────────────────────────────────────────────────────

/** Échappe une valeur pour CSV (RFC 4180) */
function csvCell(val) {
  if (val === null || val === undefined) return "";
  const s = String(val).replace(/\r?\n/g, " ").replace(/"/g, '""');
  return /[,;"\n]/.test(s) ? `"${s}"` : s;
}

/** Convertit un tableau de lignes (tableaux de valeurs) en string CSV UTF-8 BOM */
function toCSV(rows) {
  return "\uFEFF" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
}

/** Déclenche le téléchargement d'un fichier texte */
function downloadText(content, filename, mime = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Formate une date ISO en "DD/MM/YYYY HH:mm" */
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Identifie le provider depuis le champ model stocké en base */
function getProviderId(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("openai") || m.includes("gpt"))                return "OpenAI";
  if (m.includes("gemini"))                                      return "Gemini";
  if (m.includes("perplexity") || m.includes("sonar"))          return "Perplexity";
  if (m.includes("claude"))                                      return "Claude";
  return model || "Inconnu";
}

// ── Fonction principale d'export ──────────────────────────────────

/**
 * Génère et télécharge un fichier CSV contenant :
 * - Toutes les lignes où brand_mentioned = true  (une ligne par résultat provider)
 * - Colonnes : Question · Mot-clé · Provider · Modèle · Position · En sources ·
 *              Concurrents · Réponse · Sources · Date · Tokens
 *
 * @param {object[]} questions   - tableau de questions (de QuestionsTab.filtered)
 * @param {object[]} results     - tous les geo_results du site
 * @param {string}   brandName   - nom de la marque
 * @param {string[]} brandAliases
 * @param {object[]} keywords    - liste des keywords (pour afficher le label)
 * @param {string}   projectName - utilisé dans le nom de fichier
 */
export function exportFanoutCSV({ questions, results, brandName, brandAliases = [], keywords = [], projectName = "export" }) {
  // Index results par question_id
  const byQ = {};
  results.forEach(r => {
    if (!byQ[r.question_id]) byQ[r.question_id] = [];
    byQ[r.question_id].push(r);
  });

  // Index keywords
  const kwMap = {};
  keywords.forEach(k => { kwMap[k.id] = k.keyword; });

  const allBrandTerms = [brandName, ...brandAliases].filter(Boolean).map(t => t.toLowerCase());

  const header = [
    "Question",
    "Mot-clé",
    "Provider",
    "Modèle",
    "Position marque",
    "Marque dans sources",
    "Concurrents cités",
    "Réponse",
    "Sources citées",
    "Date interrogation",
    "Tokens (in+out)",
  ];

  const rows = [header];

  questions.forEach(q => {
    const qResults = byQ[q.id] || [];
    // Ne garder que les résultats où brand_mentioned = true
    const branded = qResults.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1);

    branded.forEach(r => {
      const sources = (r.sources || []);
      const brandSources = sources.filter(u =>
        allBrandTerms.some(t => u.toLowerCase().includes(t))
      );
      const comps = (r.competitors_mentioned || [])
        .map(c => c.position ? `${c.name} (#${c.position})` : c.name)
        .join(", ");

      rows.push([
        q.question,
        kwMap[q.keyword_id] || "",
        getProviderId(r.model),
        r.model || "",
        r.brand_position ? `#${r.brand_position}` : "",
        brandSources.length > 0 ? brandSources.join(" | ") : "Non",
        comps || "—",
        (r.answer || ""),
        sources.join(" | "),
        fmtDate(r.created_at),
        String((r.input_tokens || 0) + (r.output_tokens || 0)),
      ]);
    });
  });

  if (rows.length === 1) {
    // Seule la ligne d'en-tête — aucune citation marque
    alert("Aucune question avec citation de la marque trouvée dans la sélection actuelle.");
    return 0;
  }

  const slug    = projectName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadText(toCSV(rows), `fanout_${slug}_marque_${dateStr}.csv`);
  return rows.length - 1; // nb de lignes exportées
}

// ── Bouton React prêt à l'emploi ──────────────────────────────────

/**
 * Bouton d'export à insérer dans la toolbar de QuestionsTab.
 *
 * Props :
 *   questions    {object[]}  questions filtrées affichées
 *   results      {object[]}  tous les résultats du site
 *   brandName    {string}
 *   brandAliases {string[]}
 *   keywords     {object[]}
 *   projectName  {string}
 */
export function ExportFanoutBtn({ questions, results, brandName, brandAliases = [], keywords = [], projectName = "export" }) {
  const [exporting, setExporting] = useState(false);
  const [lastCount, setLastCount] = useState(null);

  // Comptage "live" des lignes exportables (pour afficher dans le tooltip)
  const byQ = {};
  results.forEach(r => {
    if (!byQ[r.question_id]) byQ[r.question_id] = [];
    byQ[r.question_id].push(r);
  });
  const brandedCount = questions.reduce((acc, q) => {
    const qRes = byQ[q.id] || [];
    return acc + qRes.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
  }, 0);

  const handleExport = () => {
    setExporting(true);
    setTimeout(() => {
      const n = exportFanoutCSV({ questions, results, brandName, brandAliases, keywords, projectName });
      setLastCount(n);
      setExporting(false);
      // Réinitialise le badge après 4 s
      if (n > 0) setTimeout(() => setLastCount(null), 4000);
    }, 0);
  };

  const disabled = exporting || brandedCount === 0;

  return (
    <button
      onClick={handleExport}
      disabled={disabled}
      title={
        brandedCount === 0
          ? "Aucune citation de marque dans la sélection actuelle"
          : `Exporter ${brandedCount} résultat${brandedCount > 1 ? "s" : ""} avec citation de ${brandName || "la marque"} (CSV)`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px",
        border: `1.5px solid ${disabled ? C.border : "#059669"}`,
        borderRadius: 8,
        background: disabled ? C.bg : "#ECFDF5",
        color: disabled ? C.textLight : "#059669",
        fontSize: 12,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "all 0.15s",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {exporting ? (
        <>⏳ Export…</>
      ) : lastCount !== null ? (
        <>{lastCount} lignes exportées ✓</>
      ) : (
        <>
          <span style={{ fontSize: 14 }}>📥</span>
          Exporter citations marque
          {brandedCount > 0 && (
            <span style={{
              fontSize: 10,
              fontWeight: 800,
              background: "#059669",
              color: "#fff",
              borderRadius: 10,
              padding: "1px 6px",
              marginLeft: 2,
            }}>
              {brandedCount}
            </span>
          )}
        </>
      )}
    </button>
  );
}