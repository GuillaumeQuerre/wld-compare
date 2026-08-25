import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./geo-tab.css";
import "./geo-responsive.css";
import TourGuide from "./TourGuide";
import PresenceCalendar from "../components/PresenceCalendar";
import { callProvider, detectBrand, extractDomain, getProviderId, buildPrompt, webSearchEnabled } from "../lib/geoEngine";
import { buildKeywordClustersCsv } from "../lib/exportOptimisations";
import { generateRoadmap, RoadmapView } from "../lib/roadmapShared";
import {
  sbGetBrand,
  sbSaveKeywords, sbGetKeywords, sbUpdateKeywordStatus, sbDeleteKeyword, sbUpdateKeywordVolume,
  sbSaveQuestions, sbGetQuestions, sbUpdateQuestion, sbDeleteQuestion,
  sbSaveGeoResult, sbGetGeoResults, sbSaveHint, sbGetHints, sbSetKeywordTags,
  sbUpsertPresenceDaily, sbGetPresenceDaily, sbEnqueueAioScrape, sbGetAioQueue, sbCancelAioScrape,
  sbGetSchedule, sbSaveSchedule, sbUpdateSchedule, sbTriggerScheduler,
  sbSaveProjectSettings,
  sbGetCategories, sbSaveCategory, sbDeleteCategory,
  sbSetQuestionCategory,
  sbSetQuestionIntent,
  sbSetQuestionSites,
  sbGetAllQuestions,
  sbReorderQuestions,
  sbBulkSetKeywordCategory, sbBulkSetQuestionCategory,
  sbGetUrlIndex, sbUpdateUrlMeta, sbIncrementUrlCounts,
  sbAddCalendarEntry, sbUpsertCalendarEntry, sbGetCalendarEntriesBatch,
  sbDownload, sbSaveProject, sbDeleteProject,
  sbGetCompetitors,
  sbGetAliases,
  sbSaveAlias,
  sbDeleteAlias, sbSaveCompetitor, sbUpdateCompetitor, sbDeleteCompetitor,
  sbGetCompareSettings, sbSetCompareRows,
  sbSaveGeoAnalysis, sbGetGeoAnalyses,
} from "../lib/supabase";
import { ProviderConfigPanel, BrandConfigPanel } from "../components/GeoConfig";
import { CompareTable, buildLlmComparison, COMPARE_ROWS, sfCompareStats, resolveSmStats, parseSemrushOverview, applySfPerimeter, getSitePerimeter, computeToolImport, entityToolStats, entityUrlStats, citedUrlSet } from "../lib/compareEngine";
import UploadCard from "../components/UploadCard";
import { newProject, parseCSV, parseSemrushCSV } from "../lib/helpers";
import { parseSemrush } from "../lib/parsers";
import { C, SITE_PALETTE } from "../lib/constants";
import { PresenceTrendChart, earliestSelectableDate, computeMecDaily, BRAND_PALETTE } from "../lib/presenceTrend";
import { presenceType, resultsToCalEntries } from "../lib/calendarDisplay";
import { matchGscForQuestion } from "../lib/auditTools";
// Note: sbSaveGeoAxes is called via onSaveAxes prop from App.jsx

// ── Throttle par provider (prévention des 429 RPM, surtout Gemini) ──────────
// Intervalle minimum entre deux appels d'un MÊME provider. Les autres providers
// ne sont pas ralentis (files indépendantes). Ajustable : passer un provider à 0
// = pas de throttle (utile en tier payant à quota élevé).
const PROVIDER_MIN_GAP_MS = { gemini: 3000, perplexity: 1500, openai: 0, claude: 0 };
const _providerGate = {}; // { providerId: Promise } — sérialise les appels d'un même provider
function throttleProvider(providerId) {
  const gap = PROVIDER_MIN_GAP_MS[providerId] || 0;
  if (!gap) return Promise.resolve();
  const chain = _providerGate[providerId] || Promise.resolve();
  _providerGate[providerId] = chain.then(() => new Promise(res => setTimeout(res, gap)));
  return chain; // on attend la fin du délai de l'appel précédent avant de lancer celui-ci
}

// ── Intention manuelle de la question (tag contrôlé à 3 valeurs) ──────────────
const QUESTION_INTENTS = [
  { id: "transactional",  label: "Transactionnelle",     short: "Transac.", color: "#1A4A7A", bg: "#1A4A7A14" },
  { id: "informational",  label: "Informationnelle",     short: "Info.",    color: "#1A7A4A", bg: "#1A7A4A14" },
  { id: "brand",          label: "Notoriété de la marque", short: "Notoriété", color: "#C97820", bg: "#C9782014" },
];
const INTENT_BY_ID = Object.fromEntries(QUESTION_INTENTS.map(i => [i.id, i]));

// Multi-sélecteur de marques (sites du projet) associées à une question.
// value = liste d'IDs de sites ; sites = tous les sites du projet.
function SiteBrandSelect({ value = [], sites = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const sel = Array.isArray(value) ? value : [];
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  if (!sites || sites.length < 2) return null; // pertinent seulement en multi-sites
  const toggle = (id) => onChange(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const selectedSites = sites.filter(s => sel.includes(s.id));
  const label = selectedSites.length === 0 ? "Marques…"
    : selectedSites.length === 1 ? selectedSites[0].label
    : `${selectedSites.length} marques`;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="Marques associées à cette question"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
          border: `0.5px solid ${sel.length ? "#2563EB44" : "#1A3C2E18"}`, background: sel.length ? "#2563EB10" : "transparent", color: sel.length ? "#2563EB" : "#94A3B8" }}>
        {selectedSites.length > 0 && <span style={{ display: "inline-flex", gap: 2 }}>{selectedSites.slice(0, 3).map(s => <span key={s.id} style={{ width: 7, height: 7, borderRadius: "50%", background: s.color || "#2563EB" }} />)}</span>}
        {label}
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, minWidth: 180, maxHeight: 260, overflowY: "auto", background: "#fff", border: "0.5px solid #1A3C2E22", borderRadius: 8, boxShadow: "0 4px 16px rgba(26,60,46,0.12)", padding: 4 }}>
          {sites.map(s => {
            const on = sel.includes(s.id);
            return (
              <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", fontSize: 11, color: "#1A3C2E", cursor: "pointer", borderRadius: 4 }}>
                <input type="checkbox" checked={on} onChange={() => toggle(s.id)} style={{ cursor: "pointer", accentColor: s.color || "#2563EB" }} />
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color || "#2563EB", flexShrink: 0 }} />
                <span>{s.label}</span>
              </label>
            );
          })}
          {sel.length > 0 && (
            <div onClick={() => onChange([])} style={{ marginTop: 4, padding: "5px 9px", fontSize: 10, color: "#94A3B8", cursor: "pointer", borderTop: "0.5px solid #1A3C2E11" }}>✕ Tout retirer</div>
          )}
        </div>
      )}
    </div>
  );
}

// Petit sélecteur d'intention pour une ligne de question
function IntentSelect({ value, onChange }) {
  const cur = value ? INTENT_BY_ID[value] : null;
  return (
    <select
      value={value || ""}
      onChange={e => onChange(e.target.value || null)}
      title="Intention de la question"
      style={{
        padding: "3px 8px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
        border: `0.5px solid ${cur ? cur.color + "44" : "#1A3C2E18"}`,
        background: cur ? cur.bg : "transparent",
        color: cur ? cur.color : "#94A3B8", appearance: "none", maxWidth: 130,
      }}>
      <option value="">Intention…</option>
      {QUESTION_INTENTS.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
    </select>
  );
}



// ── Recommandations : modèles + recherche web (temps réel + vérif d'existence) ──
const RECO_MODEL_DEEP = "claude-sonnet-4-6";          // analyses globales (qualité)
const RECO_MODEL_LIGHT = "claude-haiku-4-5-20251001"; // reco par question (coût)
const webSearchTool = (maxUses = 5) => ({ type: "web_search_20250305", name: "web_search", max_uses: maxUses });

// Extrait le texte FINAL d'une réponse Claude. Avec l'outil web_search, le modèle
// intercale des blocs (server_tool_use / web_search_tool_result) et du texte de
// raisonnement : on ne garde que le texte qui suit le dernier résultat d'outil.
function claudeFinalText(content) {
  const blocks = Array.isArray(content) ? content : [];
  let lastTool = -1;
  blocks.forEach((b, i) => {
    if (b.type === "web_search_tool_result" || b.type === "server_tool_use" || b.type === "tool_result" || b.type === "tool_use") lastTool = i;
  });
  let textBlocks = blocks.filter((b, i) => b.type === "text" && i > lastTool);
  if (!textBlocks.length) textBlocks = blocks.filter(b => b.type === "text");
  return textBlocks.map(b => b.text).join("\n").trim();
}

const DEFAULT_AXES = [
  "Meilleur / top / recommandé",
  "Pistes et approches pour utiliser / bénéficier du mot-clé",
  "Avis / fiable / fiabilité",
  "Pour atteindre un objectif lié au mot-clé",
  "Pour résoudre une problématique liée au mot-clé",
];

// ── API Key helpers — base64 obfuscation (Supabase already protected by auth) ──
// Fallback: if stored value looks like an AES blob (not a valid sk- key after decode),
// the user must re-enter the key once to migrate to the new format.
function decodeKey(enc) {
  if (!enc) return "";
  try {
    const k = decodeURIComponent(escape(atob(enc)));
    return k; // may or may not start with sk- — UI will validate
  } catch {
    return ""; // AES blob or corrupted — user must re-enter
  }
}


// Retire les query strings et fragments des URLs pour l'affichage
function stripQuery(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

// Convertit le markdown basique (gras, italique, listes) en éléments React
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split("\n");
  return lines.map((line, li) => {
    // Transformer **bold** et *italic* dans chaque ligne
    const parts = [];
    let remaining = line;
    let key = 0;
    while (remaining.length > 0) {
      const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/s);
      const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/s);
      // Choisir le match le plus proche
      const useBold = boldMatch && (!italicMatch || boldMatch[1].length <= italicMatch[1].length);
      if (useBold) {
        if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
        parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
        remaining = remaining.slice(boldMatch[0].length);
      } else if (italicMatch) {
        if (italicMatch[1]) parts.push(<span key={key++}>{italicMatch[1]}</span>);
        parts.push(<em key={key++}>{italicMatch[2]}</em>);
        remaining = remaining.slice(italicMatch[0].length);
      } else {
        parts.push(<span key={key++}>{remaining}</span>);
        remaining = "";
      }
    }
    const trimmed = line.trimStart();
    // ── Titres Markdown : # (titre) · ## / ### (sous-titre). On masque les dièses. ──
    const h1 = trimmed.match(/^#\s+(.*)$/);          // un seul dièse → titre principal
    const h2 = trimmed.match(/^#{2,3}\s+(.*)$/);      // deux/trois dièses → sous-titre
    // Item numéroté de top (ex. "1. PERGAM") → à hiérarchiser fortement
    const numItem = trimmed.match(/^(\d+)\.\s+(.*)$/);
    // Puce simple (-, *, •) → on retire le marqueur (évite le doublon "• -")
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);

    if (h2) {
      // Sous-titre : souligné
      return <div key={li} style={{ fontWeight: 600, fontSize: 13, marginTop: 10, marginBottom: 3, textDecoration: "underline", textUnderlineOffset: 3, color: "#1A1A1A" }}>{renderInline(h2[1])}</div>;
    }
    if (h1) {
      // Titre principal : plus gros, mis en valeur
      return <div key={li} style={{ fontWeight: 700, fontSize: 15, marginTop: 14, marginBottom: 5, letterSpacing: "-0.01em", color: "#1A1A1A" }}>{renderInline(h1[1])}</div>;
    }
    if (numItem) {
      // Élément de top : numéro en pastille + titre en gras, bien détaché de ses détails
      return (
        <div key={li} style={{ display: "flex", gap: 8, alignItems: "baseline", marginTop: 12, marginBottom: 2 }}>
          <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: "#1A3C2E", fontVariantNumeric: "tabular-nums", minWidth: 18 }}>{numItem[1]}.</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{renderInline(numItem[2])}</span>
        </div>
      );
    }
    if (bullet) {
      // Détail (Site web / Description…) : indenté sous l'item, une seule puce
      return <div key={li} style={{ paddingLeft: 26, marginBottom: 2, display: "flex", gap: 6 }}><span style={{ flexShrink: 0, color: "#1A3C2E" }}>·</span><span>{renderInline(bullet[1])}</span></div>;
    }
    if (!line.trim()) return <div key={li} style={{ height: 6 }} />;
    return <div key={li} style={{ marginBottom: 2 }}>{parts}</div>;
  });
}

// Rendu inline (gras/italique) d'un fragment de texte déjà débarrassé de son marqueur
function renderInline(text) {
  const parts = [];
  let remaining = text, key = 0;
  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/s);
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/s);
    const useBold = boldMatch && (!italicMatch || boldMatch[1].length <= italicMatch[1].length);
    if (useBold) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
    } else if (italicMatch) {
      if (italicMatch[1]) parts.push(<span key={key++}>{italicMatch[1]}</span>);
      parts.push(<em key={key++}>{italicMatch[2]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
    } else {
      parts.push(<span key={key++}>{remaining}</span>);
      remaining = "";
    }
  }
  return parts;
}

// ── renderMarkdownHighlighted — surligne marque (vert) et concurrents ──
// eslint-disable-next-line no-unused-vars
function renderMarkdownHighlighted(text, brandTerms = [], competitorMap = {}) {
  if (!text) return null;
  const hasHighlights = brandTerms.length > 0 || Object.keys(competitorMap).length > 0;
  if (!hasHighlights) return renderMarkdown(text);
  function highlightLine(line) {
    if (!line) return [line];
    const allTerms = [
      ...brandTerms.map(t => ({ term: t, type: "brand" })),
      ...Object.keys(competitorMap).map(t => ({ term: t, type: "competitor" })),
    ].filter(t => t.term).sort((a, b) => b.term.length - a.term.length);
    if (!allTerms.length) return [line];
    const pattern = allTerms.map(t => t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(${pattern})`, "gi");
    const parts = line.split(re);
    return parts.map((part, i) => {
      const lower = part.toLowerCase();
      if (brandTerms.some(t => t.toLowerCase() === lower))
        return <mark key={i} style={{ background: "#DCFCE7", color: "#166534", borderRadius: 3, padding: "0 2px", fontWeight: 600 }}>{part}</mark>;
      if (competitorMap[lower]) {
        const cat = competitorMap[lower];
        const bg = cat.category === "direct" ? "#FEE2E2" : cat.category === "geo" ? "#FEF3C7" : "#F3F4F6";
        const color = cat.category === "direct" ? "#991B1B" : cat.category === "geo" ? "#92400E" : "#374151";
        return <mark key={i} style={{ background: bg, color, borderRadius: 3, padding: "0 2px", fontWeight: 500 }}>{part}</mark>;
      }
      return part;
    });
  }
  const lines = text.split("\n");
  return lines.map((line, li) => {
    const highlighted = highlightLine(line);
    const trimmed = line.trimStart();
    const isHeading = trimmed.startsWith("## ") || trimmed.startsWith("### ");
    const isList = /^[-*•]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);
    if (isHeading) return <div key={li} style={{ fontWeight: 700, fontSize: 13, marginTop: 8, marginBottom: 2 }}>{highlighted}</div>;
    if (isList) return <div key={li} style={{ paddingLeft: 12, marginBottom: 2, display: "flex", gap: 6 }}><span style={{ flexShrink: 0 }}>•</span><span>{highlighted}</span></div>;
    if (!line.trim()) return <div key={li} style={{ height: 6 }} />;
    return <div key={li} style={{ marginBottom: 2 }}>{highlighted}</div>;
  });
}

// ── Export CSV helpers ────────────────────────────────────────────

function csvCell(val) {
  if (val === null || val === undefined) return "";
  const s = String(val).replace(/\r?\n/g, " ").replace(/"/g, '""');
  return /[,;"\n]/.test(s) ? `"${s}"` : s;
}

function toCSV(rows) {
  return "\uFEFF" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
}

function downloadText(content, filename, mime = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDateExport(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function getProviderLabel(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("openai") || m.includes("gpt"))       return "OpenAI";
  if (m.includes("gemini"))                             return "Gemini";
  if (m.includes("perplexity") || m.includes("sonar")) return "Perplexity";
  if (m.includes("claude"))                             return "Claude";
  return model || "Inconnu";
}

// questionScope : "brand" (marque présente) | "favorites" (favoris) | "all" (toutes)
function exportFanoutCSV({ questions, results, brandName, brandAliases = [], keywords = [], projectName = "export", selectedProviders = [], questionScope = "brand", hintsMap = {} }) {
  const byQ = {};
  results.forEach(r => {
    if (!byQ[r.question_id]) byQ[r.question_id] = [];
    byQ[r.question_id].push(r);
  });
  const kwMap = {};
  keywords.forEach(k => { kwMap[k.id] = k.keyword; });
  const allBrandTerms = [brandName, ...brandAliases].filter(Boolean).map(t => t.toLowerCase());

  const header = [
    "Question",
    "Favori",
    "Mot-clé",
    "Provider",
    "Modèle",
    "Marque présente",
    "Position marque",
    "Marque dans sources",
    "Concurrents cités",
    "Réponse",
    "Sources citées",
    "Date interrogation",
    "Tokens (in+out)",
    "Indice généré",
  ];

  const rows = [header];

  // Filtrer les questions selon le scope
  const scopedQuestions = questions.filter(q => {
    if (questionScope === "favorites") return !!q.is_favorite;
    if (questionScope === "brand") {
      const qRes = byQ[q.id] || [];
      return qRes.some(r => r.brand_mentioned === true || r.brand_mentioned === 1);
    }
    return true; // "all"
  });

  scopedQuestions.forEach(q => {
    const qResults = (byQ[q.id] || []).filter(r =>
      selectedProviders.length === 0 || selectedProviders.includes(getProviderId(r.model))
    );

    if (qResults.length === 0) {
      // Question sans résultat — ligne vide pour tracer la question
      rows.push([q.question, q.is_favorite ? "⭐" : "", kwMap[q.keyword_id] || "", "", "", "Non", "", "", "", "", "", "", "", (hintsMap[q.id]?.text || "")]);
      return;
    }

    qResults.forEach(r => {
      const sources = r.sources || [];
      const brandSources = sources.filter(u => allBrandTerms.some(t => u.toLowerCase().includes(t)));
      const isBrand = r.brand_mentioned === true || r.brand_mentioned === 1;
      const comps = (r.competitors_mentioned || [])
        .map(c => c.position ? `${c.name} (#${c.position})` : c.name)
        .join(", ");
      rows.push([
        q.question,
        q.is_favorite ? "⭐" : "",
        kwMap[q.keyword_id] || "",
        getProviderLabel(r.model),
        r.model || "",
        isBrand ? "✓ Oui" : "Non",
        r.brand_position ? `#${r.brand_position}` : "",
        brandSources.length > 0 ? brandSources.join(" | ") : "Non",
        comps || "—",
        (r.answer || ""),
        sources.join(" | "),
        fmtDateExport(r.created_at),
        String((r.input_tokens || 0) + (r.output_tokens || 0)),
        (hintsMap[q.id]?.text || ""),
      ]);
    });
  });

  if (rows.length === 1) {
    alert("Aucun résultat à exporter pour la sélection actuelle.");
    return 0;
  }

  const scopeLabel = questionScope === "brand" ? "marque" : questionScope === "favorites" ? "favoris" : "toutes";
  const slug    = projectName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadText(toCSV(rows), `fanout_${slug}_${scopeLabel}_${dateStr}.csv`);
  return rows.length - 1;
}

// ── PDF export helpers ────────────────────────────────────────────

// questionScope : "brand" | "favorites" | "all"
function buildFanoutPDF({ questions, results, hintsMap = {}, brandName, brandAliases = [], keywords = [], projectName = "export", latestResultByQ = {}, lostByQ = {}, selectedProviders = [], questionScope = "brand" }) {
  const byQ = {};
  results.forEach(r => {
    if (!byQ[r.question_id]) byQ[r.question_id] = [];
    byQ[r.question_id].push(r);
  });
  const kwMap = {};
  keywords.forEach(k => { kwMap[k.id] = k.keyword; });

  // Filtrer par providers si sélection
  const filterByProvider = (rs) => {
    if (selectedProviders.length === 0) return rs;
    return rs.filter(r => selectedProviders.includes(getProviderId(r.model)));
  };

  // Catégoriser chaque question
  const presentQs  = []; // marque présente dans le dernier résultat
  const lostQs     = []; // marque déjà présente mais absente maintenant
  const absentQs   = []; // marque jamais présente

  // Filtrer les questions selon le scope
  const scopedQuestions = questions.filter(q => {
    if (questionScope === "favorites") return !!q.is_favorite;
    if (questionScope === "brand") {
      const qRes = byQ[q.id] || [];
      return qRes.some(r => r.brand_mentioned === true || r.brand_mentioned === 1);
    }
    return true; // "all"
  });

  scopedQuestions.forEach(q => {
    const allRes = filterByProvider(byQ[q.id] || []);
    const latest = latestResultByQ[q.id];
    const latestFiltered = latest && (selectedProviders.length === 0 || selectedProviders.includes(getProviderId(latest.model))) ? latest : [...allRes].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0))[0];
    const isPresent = latestFiltered && (latestFiltered.brand_mentioned === true || latestFiltered.brand_mentioned === 1);
    const isLost = lostByQ[q.id] && !isPresent;

    if (isPresent) presentQs.push({ q, latest: latestFiltered, allRes });
    else if (isLost) lostQs.push({ q, latest: latestFiltered, allRes });
    else absentQs.push({ q, latest: latestFiltered, allRes });
  });

  // Métriques
  const totalRes    = filterByProvider(results).length;
  const withBrand   = filterByProvider(results).filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
  const withSources = filterByProvider(results).filter(r => r.brand_in_sources).length;
  const positions   = filterByProvider(results).filter(r => r.brand_position).map(r => r.brand_position);
  const avgPos      = positions.length ? (positions.reduce((a,b)=>a+b,0)/positions.length).toFixed(1) : null;
  const presence    = totalRes ? Math.round(withBrand/totalRes*100) : 0;
  const dateStr     = new Date().toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" });

  // Top concurrents
  const compCount = {};
  filterByProvider(results).forEach(r => {
    const seen = new Set();
    (r.competitors_mentioned||[]).forEach(c => { if(c.name && !seen.has(c.name)) { seen.add(c.name); compCount[c.name]=(compCount[c.name]||0)+1; } });
  });
  const topComps = Object.entries(compCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // ── HTML du PDF ──────────────────────────────────────────────────
  const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const badge = (color, bg, text) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${bg};color:${color};border:1px solid ${color}44">${esc(text)}</span>`;

  const sectionTitle = (emoji, text, color = "#1E293B") =>
    `<div style="margin:28px 0 14px;padding:10px 16px;background:${color}08;border-left:4px solid ${color};border-radius:0 8px 8px 0;">
      <span style="font-size:16px;font-weight:800;color:${color}">${emoji} ${esc(text)}</span>
    </div>`;

  const questionBlock = ({ q, latest, allRes }, showHint = true, showDate = false) => {
    const kw = kwMap[q.keyword_id] || "";
    const hint = hintsMap[q.id]?.text || "";
    const hintDate = hintsMap[q.id]?.date || "";
    const comps = (latest?.competitors_mentioned || []).map(c => c.name).join(", ");
    const sources = (latest?.sources || []).slice(0, 3);
    const dateLabel = latest?.created_at ? new Date(latest.created_at).toLocaleDateString("fr-FR", {day:"2-digit",month:"short",year:"numeric"}) : "";

    return `<div style="margin-bottom:14px;padding:14px 18px;border:1px solid #E2E8F0;border-radius:10px;break-inside:avoid;page-break-inside:avoid;">
      <div style="font-size:13px;font-weight:700;color:#0F172A;margin-bottom:8px;line-height:1.4">${esc(q.question)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:${(comps||sources.length||hint) ? "10px":"0"}">
        ${kw ? badge("#6366F1","#EEF2FF",`🔑 ${kw}`) : ""}
        ${latest?.brand_position ? badge("#059669","#ECFDF5",`Position #${latest.brand_position}`) : ""}
        ${latest?.brand_in_sources ? badge("#2563EB","#EFF6FF","🔗 Dans les sources") : ""}
        ${showDate && dateLabel ? badge("#64748B","#F8FAFC",`Dernière parution : ${dateLabel}`) : ""}
      </div>
      ${comps ? `<div style="font-size:11px;color:#64748B;margin-bottom:6px">Concurrents cités : <strong>${esc(comps)}</strong></div>` : ""}
      ${sources.length ? `<div style="font-size:10px;color:#94A3B8">${sources.map(u=>{ const clean=stripQuery(u); return `<a href="${esc(u)}" style="color:#6366F1">${esc(clean.length>60?clean.slice(0,60)+"…":clean)}</a>`; }).join("  ·  ")}</div>` : ""}
      ${showHint && hint ? `<div style="margin-top:10px;padding:10px 12px;background:#FFFBEB;border:1px solid #FCD34D;border-radius:7px;">
        <div style="font-size:10px;font-weight:700;color:#B45309;margin-bottom:4px">💡 HINT GEO${hintDate ? " · "+new Date(hintDate).toLocaleDateString("fr-FR",{day:"2-digit",month:"short"}) : ""}</div>
        <div style="font-size:11px;color:#92400E;line-height:1.6;white-space:pre-wrap">${esc(hint)}</div>
      </div>` : ""}
    </div>`;
  };

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Fan-outs GEO — ${esc(projectName)} — ${dateStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0F172A; background: #fff; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
    }
  </style>
</head>
<body style="padding:32px 40px;max-width:900px;margin:0 auto">

  <!-- Bouton imprimer -->
  <div class="no-print" style="text-align:right;margin-bottom:16px">
    <button onclick="window.print()" style="padding:8px 18px;background:#6366F1;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
      🖨️ Imprimer / Enregistrer en PDF
    </button>
  </div>

  <!-- ── En-tête ── -->
  <div style="border-bottom:3px solid #6366F1;padding-bottom:20px;margin-bottom:28px">
    <div style="font-size:11px;font-weight:700;color:#6366F1;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">Rapport GEO — Fan-outs</div>
    <div style="font-size:26px;font-weight:800;color:#0F172A;margin-bottom:4px">${esc(projectName)}</div>
    <div style="font-size:13px;color:#64748B">Généré le ${dateStr}${selectedProviders.length > 0 ? " · Providers : "+selectedProviders.join(", ") : " · Tous les providers"}</div>
  </div>

  <!-- ── Chiffres clés ── -->
  ${sectionTitle("📊","Chiffres clés","#6366F1")}
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
    ${[
      { label:"Présence marque", value: presence+"%", sub:`${withBrand}/${totalRes} réponses`, color: presence>=50?"#059669":presence>0?"#D97706":"#DC2626" },
      { label:"Position moyenne", value: avgPos ? "#"+avgPos : "—", sub:"dans les fan-outs", color:"#6366F1" },
      { label:"Dans les sources", value: withSources, sub:"questions citées", color:"#2563EB" },
      { label:"Questions analysées", value: questions.length, sub:`${presentQs.length} positionnées`, color:"#0F172A" },
    ].map(k=>`<div style="padding:16px;border:1px solid #E2E8F0;border-radius:12px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px">${esc(k.label)}</div>
      <div style="font-size:28px;font-weight:800;color:${k.color};margin-bottom:3px">${esc(String(k.value))}</div>
      <div style="font-size:10px;color:#94A3B8">${esc(k.sub)}</div>
    </div>`).join("")}
  </div>

  ${topComps.length > 0 ? `<div style="padding:12px 16px;border:1px solid #E2E8F0;border-radius:10px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;color:#64748B;margin-bottom:8px;text-transform:uppercase;letter-spacing:.7px">Top concurrents cités</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${topComps.map(([name,cnt])=>`<span style="padding:4px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:20px;font-size:12px;font-weight:600;color:#DC2626">${esc(name)} <span style="opacity:.7">${cnt}×</span></span>`).join("")}
    </div>
  </div>` : ""}

  <!-- ── Questions positionnées ── -->
  ${presentQs.length > 0 ? `
  ${sectionTitle("✅",`Questions positionnées (${presentQs.length})`, "#059669")}
  ${presentQs.map(item => questionBlock(item, true, false)).join("")}
  ` : `<div style="padding:16px;background:#F8FAFC;border-radius:8px;color:#94A3B8;font-size:13px;margin-bottom:20px">Aucune question positionnée pour l'instant.</div>`}

  <!-- ── Questions déjà positionnées (perdues) ── -->
  ${lostQs.length > 0 ? `
  <div class="page-break"></div>
  ${sectionTitle("📈",`Positionnées précédemment — position perdue (${lostQs.length})`, "#D97706")}
  ${lostQs.map(item => questionBlock(item, true, true)).join("")}
  ` : ""}

  <!-- ── Questions sans présence ── -->
  ${absentQs.length > 0 ? `
  <div class="page-break"></div>
  ${sectionTitle("❌",`Marque absente (${absentQs.length})`, "#DC2626")}
  ${absentQs.map(item => questionBlock(item, true, false)).join("")}
  ` : ""}

  <!-- Pied de page -->
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #E2E8F0;font-size:10px;color:#94A3B8;text-align:center">
    Rapport Echo GEO · ${esc(projectName)} · ${dateStr}
  </div>

</body>
</html>`;

  // Ouvrir dans un nouvel onglet pour impression
  const win = window.open("", "_blank");
  if (!win) { alert("Autorisez les pop-ups pour générer le PDF"); return; }
  win.document.write(html);
  win.document.close();
  // Déclencher l'impression après chargement
  win.onload = () => { setTimeout(() => win.print(), 300); };
  return true;
}

// ── ExportFanoutBtn (avec sélection provider + CSV + PDF) ─────────

function ExportFanoutBtn({ questions, results, brandName, brandAliases = [], keywords = [], projectName = "export", hintsMap = {}, latestResultByQ = {}, lostByQ = {} }) {
  const [open, setOpen]             = useState(false);
  const [selectedProviders, setSel] = useState([]);        // [] = tous
  const [questionScope, setScope]   = useState("brand");   // "brand" | "favorites" | "all"
  const [exportStatus, setStatus]   = useState("idle");
  const [lastCount, setLastCount]   = useState(null);
  const popRef                      = useRef();

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (!popRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const byQ = {};
  results.forEach(r => {
    if (!byQ[r.question_id]) byQ[r.question_id] = [];
    byQ[r.question_id].push(r);
  });

  const presentProviders = [...new Set(results.map(r => getProviderId(r.model)).filter(Boolean))];

  // Compter les questions selon le scope courant
  const scopedCount = questions.filter(q => {
    if (questionScope === "favorites") return !!q.is_favorite;
    if (questionScope === "brand") {
      const qRes = byQ[q.id] || [];
      return qRes.some(r =>
        (r.brand_mentioned === true || r.brand_mentioned === 1) &&
        (selectedProviders.length === 0 || selectedProviders.includes(getProviderId(r.model)))
      );
    }
    return true;
  }).length;

  const toggleProvider = (pid) => {
    setSel(prev => prev.includes(pid) ? prev.filter(p => p !== pid) : [...prev, pid]);
  };

  const doCSV = () => {
    setStatus("exporting");
    setTimeout(() => {
      const n = exportFanoutCSV({ questions, results, brandName, brandAliases, keywords, projectName, selectedProviders, questionScope, hintsMap });
      setLastCount(n);
      setStatus(n > 0 ? "done" : "idle");
      if (n > 0) setTimeout(() => { setStatus("idle"); setLastCount(null); }, 4000);
      setOpen(false);
    }, 0);
  };

  const doPDF = () => {
    setStatus("exporting");
    setTimeout(() => {
      buildFanoutPDF({ questions, results, hintsMap, brandName, brandAliases, keywords, projectName, latestResultByQ, lostByQ, selectedProviders, questionScope });
      setStatus("idle");
      setOpen(false);
    }, 0);
  };

  const providerColors = { openai:"#059669", gemini:"#2563EB", perplexity:"#7C3AED", claude:"#D97706", other:"#64748B" };
  const providerIcons  = { openai:"🟢", gemini:"🔵", perplexity:"🟣", claude:"🟠", other:"⚪" };
  const providerLabels = { openai:"OpenAI", gemini:"Gemini", perplexity:"Perplexity", claude:"Claude", other:"Autre" };

  const SCOPES = [
    { key: "brand",     label: "✓ Marque présente",  desc: "Questions où la marque est citée",   color: "#059669", bg: "#ECFDF5" },
    { key: "favorites", label: "⭐ Favoris",           desc: "Questions marquées comme favoris",   color: "#F59E0B", bg: "#FFFBEB" },
    { key: "all",       label: "◉ Toutes",            desc: "Toutes les questions et réponses",   color: "#6366F1", bg: "#EEF2FF" },
  ];
  const currentScope = SCOPES.find(s => s.key === questionScope);

  return (
    <div ref={popRef} style={{ position: "relative", display: "inline-block" }}>
      {/* Bouton principal */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Exporter les fan-outs (CSV ou PDF)"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 14px",
          border: `1.5px solid ${open ? "#6366F1" : "#059669"}`,
          borderRadius: 8,
          background: open ? "#EEF2FF" : "#ECFDF5",
          color: open ? "#6366F1" : "#059669",
          fontSize: 12, fontWeight: 700,
          cursor: "pointer",
          transition: "all 0.15s",
          whiteSpace: "nowrap", flexShrink: 0,
        }}
      >
        {exportStatus === "exporting" ? <>⏳ Export…</> :
         exportStatus === "done" && lastCount !== null ? <>{lastCount} lignes ✓</> : (
          <>
            <span style={{ fontSize: 14 }}>📤</span>
            Exporter
            {scopedCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 800, background: currentScope?.color || "#059669", color: "#fff", borderRadius: 10, padding: "1px 6px", marginLeft: 2 }}>
                {scopedCount}
              </span>
            )}
            <span style={{ fontSize: 10, opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
          </>
        )}
      </button>

      {/* ── Popover ── */}
      {open && (
        <div className="geo-export-popup" style={{
          zIndex: 300, background: "#fff", border: "1px solid #E2E8F0",
          borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.14)", padding: 16, minWidth: 290,
        }}>

          {/* ── Périmètre des questions ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".7px", marginBottom: 8 }}>
              Questions à exporter
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {SCOPES.map(s => (
                <button key={s.key} onClick={() => setScope(s.key)}
                  style={{
                    padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                    border: `2px solid ${questionScope === s.key ? s.color : "#E2E8F0"}`,
                    background: questionScope === s.key ? s.bg : "transparent",
                    color: questionScope === s.key ? s.color : "#64748B",
                    cursor: "pointer", textAlign: "left",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                  }}
                >
                  <span>{s.label}</span>
                  <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>{s.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Providers ── */}
          {presentProviders.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".7px", marginBottom: 8 }}>
                Providers à inclure
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {presentProviders.map(pid => {
                  const active = selectedProviders.includes(pid);
                  const col = providerColors[pid] || providerColors.other;
                  return (
                    <button key={pid} onClick={() => toggleProvider(pid)}
                      style={{
                        padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                        border: `2px solid ${active ? col : "#E2E8F0"}`,
                        background: active ? col+"18" : "transparent",
                        color: active ? col : "#64748B", cursor: "pointer",
                      }}
                    >
                      {providerIcons[pid]||"⚪"} {providerLabels[pid]||pid}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 5 }}>
                {selectedProviders.length === 0 ? "Tous les providers inclus" : `${selectedProviders.length} provider${selectedProviders.length>1?"s":""} sélectionné${selectedProviders.length>1?"s":""}`}
              </div>
            </div>
          )}

          {/* ── Résumé ── */}
          <div style={{ fontSize: 11, color: "#64748B", marginBottom: 14, padding: "8px 10px", background: "#F8FAFC", borderRadius: 7 }}>
            <strong style={{ color: currentScope?.color }}>{scopedCount}</strong> question{scopedCount>1?"s":""} · {currentScope?.desc?.toLowerCase()}
            <br/><span style={{ color: "#94A3B8" }}>{questions.length} questions au total · {results.length} réponses</span>
          </div>

          {/* ── Boutons d'export ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={doCSV} disabled={scopedCount === 0}
              style={{
                padding: "9px 14px", borderRadius: 8, border: "none",
                background: scopedCount === 0 ? "#F1F5F9" : "#059669",
                color: scopedCount === 0 ? "#94A3B8" : "#fff",
                fontSize: 12, fontWeight: 700, cursor: scopedCount === 0 ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 16 }}>📥</span>
              <div style={{ textAlign: "left" }}>
                <div>Exporter CSV</div>
                <div style={{ fontSize: 10, opacity: .8 }}>Questions + réponses + hints en tableau</div>
              </div>
            </button>

            <button onClick={doPDF}
              style={{
                padding: "9px 14px", borderRadius: 8, border: "none",
                background: "#6366F1", color: "#fff",
                fontSize: 12, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ fontSize: 16 }}>📄</span>
              <div style={{ textAlign: "left" }}>
                <div>Exporter PDF</div>
                <div style={{ fontSize: 10, opacity: .8 }}>Rapport mise en page · chiffres clés · hints</div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── OpenAI call helpers ───────────────────────────────────────────


export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    icon: "🟢",
    model: "gpt-4o-mini",
    keyField: "openai_key_enc",
    keyPrefix: "sk-",
    keyPlaceholder: "sk-…",
    proxyPath: "/api/openai",
    color: "#059669",
  },
  {
    id: "gemini",
    label: "Gemini",
    icon: "🔵",
    model: "gemini-3.5-flash",   // supports Google Search grounding (real-time web)
    keyField: "gemini_key_enc",
    keyPrefix: "AIza",
    keyPlaceholder: "AIzaSy…",
    proxyPath: "/api/gemini",
    color: "#2563EB",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    icon: "🟣",
    model: "sonar",              // real-time web search + citations
    keyField: "perplexity_key_enc",
    keyPrefix: "pplx-",
    keyPlaceholder: "pplx-…",
    proxyPath: "/api/perplexity",
    color: "#7C3AED",
  },
  {
    id: "claude",
    label: "Claude",
    icon: "🟠",
    model: "claude-haiku-4-5-20251001", // knowledge-based (no web access)
    keyField: "claude_geo_key_enc",
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-…",
    proxyPath: "/api/claude-geo",
    color: "#D97706",
  },
  {
    id: "aio",
    label: "AI Overview",
    icon: "🔶",
    model: "AI Overview (google)",
    external: true,          // alimenté par le scraper local, pas d'API/clé, pas interrogeable depuis l'app
    color: "#4285F4",
  },
];



// ── Habillage visuel évocateur par provider (sans logos officiels) ──
// Couleur d'accent + pictogramme générique + style de bulle, pour rappeler
// l'univers de chaque LLM sans reproduire son interface propriétaire.
const PROVIDER_THEME = {
  openai: {
    name: "ChatGPT",
    accent: "#10A37F", bubbleBg: "#F7F7F8", botBg: "#FFFFFF",
    glyph: "✦", avatarBg: "#10A37F", avatarFg: "#FFFFFF",
    font: '"Söhne", -apple-system, "Segoe UI", Helvetica, sans-serif',
  },
  gemini: {
    name: "Gemini",
    accent: "#4285F4", bubbleBg: "#F0F4F9", botBg: "#FFFFFF",
    glyph: "✧", avatarGradient: "linear-gradient(135deg, #4285F4, #9B72CB, #D96570)", avatarFg: "#FFFFFF",
    font: '"Google Sans", "Product Sans", -apple-system, sans-serif',
  },
  perplexity: {
    name: "Perplexity",
    accent: "#20808D", bubbleBg: "#FBFAF4", botBg: "#FFFFFF",
    glyph: "≈", avatarBg: "#20808D", avatarFg: "#FFFFFF",
    font: '"FK Grotesk", -apple-system, "Segoe UI", sans-serif',
  },
  claude: {
    name: "Claude",
    accent: "#D97757", bubbleBg: "#F5F4EE", botBg: "#FFFFFF",
    glyph: "✺", avatarBg: "#D97757", avatarFg: "#FFFFFF",
    font: '"Styrene", "Tiempos", -apple-system, "Segoe UI", serif',
  },
  other: {
    name: "Assistant",
    accent: "#64748B", bubbleBg: "#F8FAFC", botBg: "#FFFFFF",
    glyph: "○", avatarBg: "#64748B", avatarFg: "#FFFFFF",
    font: '-apple-system, "Segoe UI", sans-serif',
  },
};

// Rendu d'une réponse façon interface de chat (évocateur, neutre juridiquement)
function ChatAnswer({ providerId, modelLabel, answerNode }) {
  const t = PROVIDER_THEME[providerId] || PROVIDER_THEME.other;
  const avatarStyle = t.avatarGradient
    ? { background: t.avatarGradient }
    : { background: t.avatarBg };
  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: `0.5px solid ${t.accent}22`, background: t.botBg, fontFamily: t.font }}>
      {/* Barre d'en-tête provider */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `0.5px solid ${t.accent}18`, background: `${t.accent}0A` }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: t.avatarFg, ...avatarStyle }}>{t.glyph}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.accent }}>{t.name}</span>
        {modelLabel && <span style={{ fontSize: 10, color: "#1A3C2E", marginLeft: "auto", fontFamily: "monospace" }}>{modelLabel}</span>}
      </div>

      <div style={{ padding: "14px 14px 16px" }}>
        {/* Réponse de l'assistant (la question n'est pas réécrite) */}
        <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: t.avatarFg, ...avatarStyle }}>{t.glyph}</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.7, color: "#1A1A1A", wordBreak: "break-word" }}>
            {answerNode}
          </div>
        </div>
      </div>
    </div>
  );
}

// Une fois la Responses API (web_search) constatée indisponible pour ce compte,
// on évite de la rappeler à chaque interrogation (sinon 500 répétée et inutile).


// Parse free-text response (Gemini, Perplexity, Claude) into the standard shape



// ── Brand detection — 3 types de présence ───────────────────────
//
// MENTION  = marque dans un item numéroté du Top (ligne "N. Marque")
//            position = numéro du rang dans le classement
//
// EVOCATION = marque dans le corps narratif (hors items de top, hors sources)
//             position = ordre d'apparition dans le texte narratif
//
// CITATION  = domaine de la marque dans les sources/URLs citées
//             position = rang dans la liste de sources

function Btn({ children, onClick, disabled, color, variant = "solid", small, title, style: extraStyle }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: small ? "4px 14px" : "7px 20px",
    fontSize: small ? 11 : 12, fontWeight: 500,
    letterSpacing: "0.02em",
    borderRadius: 20, cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.35 : 1,
    transition: "opacity 0.2s, background 0.2s",
    border: "1px solid transparent",
    userSelect: "none", whiteSpace: "nowrap",
    ...(variant === "solid"
      ? { background: "#1A3C2E", color: "#F0EBE0", borderColor: "#1A3C2E" }
      : variant === "outline" || variant === "ghost"
      ? { background: "transparent", color: "#1A3C2E", borderColor: "#1A3C2E33" }
      : { background: "#F0EBE0", color: "#1A3C2E", borderColor: "#1A3C2E11" }),
    ...extraStyle,
  };
  return <button onClick={disabled ? undefined : onClick} disabled={disabled} title={title} style={base}>{children}</button>;
}

function StatusBadge({ status }) {
  const map = {
    pending:       { label: "Prêt",       color: "#1A3C2E" },
    generating_q:  { label: "Génération…", color: "#E8541A" },
    done_q:        { label: "Généré",      color: "#1A7A4A" },
    generating_r:  { label: "LLM…",       color: "#E8541A" },
    done:          { label: "Terminé",     color: "#1A3C2E" },
    error:         { label: "Erreur",      color: "#C0352A" },
  };
  const s = map[status] || map.pending;
  return (
    <span style={{
      fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase",
      color: s.color, padding: "0 0", background: "none", border: "none",
    }}>
      {s.label}
    </span>
  );
}

// ── Stats header ──────────────────────────────────────────────────

// ── Code couleur partagé pour les 3 tops (marque + catégories concurrents) ──
const TOP_COLORS = {
  brand:   { color: "#1A7A4A", label: "Votre marque" },   // vert Sonate
  direct:  { color: "#C0352A", label: "Concurrent direct" },
  geo:     { color: "#C97820", label: "Concurrent GEO" },
  partner: { color: "#1A3C2E", label: "Partenaire" },
  other:   { color: "#9AAEA4", label: "Autre" },
};

// Graphe en barres verticales, trié décroissant, tooltip au survol.
// data: [{ name, count, kind }] · kind ∈ brand|direct|geo|partner|other
function TopBarChart({ title, glyph, data, accent = "#1A3C2E", onBarClick = null }) {
  const [hover, setHover] = useState(null);
  const rows = (data || []).slice(0, 20); // jusqu'à 20 entrées (colonnes fines)
  const max = rows.length ? Math.max(...rows.map(d => d.count)) : 0;
  const total = (data || []).reduce((s, d) => s + d.count, 0);
  const gap = rows.length > 12 ? 2 : rows.length > 8 ? 3 : 5;

  return (
    <div className="gt-kpi-card" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* En-tête */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: `${accent}14`, color: accent, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{glyph}</span>
        <span className="gt-kpi-label" style={{ marginBottom: 0 }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{total}</span>
      </div>

      {rows.length === 0 ? (
        <div className="gt-caption" style={{ fontStyle: "italic", padding: "24px 0", textAlign: "center" }}>Aucune donnée</div>
      ) : (
        <>
          {/* Zone graphe — abscisse = rang (1 à gauche, ordre croissant) */}
          <div style={{ position: "relative", height: 150, display: "flex", alignItems: "flex-end", gap, padding: "18px 0 0", marginTop: 6 }}>
            {rows.map((d, i) => {
              const h = max ? Math.max((d.count / max) * 100, 4) : 4;
              const c = (TOP_COLORS[d.kind] || TOP_COLORS.other).color;
              const isHover = hover === i;
              const clickable = !!onBarClick;
              return (
                <div key={d.name + i}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={clickable ? () => onBarClick(d) : undefined}
                  title={clickable ? `Filtrer sur « ${d.name} »` : undefined}
                  style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", cursor: clickable ? "pointer" : "default", position: "relative" }}>
                  {/* Tooltip : nom + rang + occurrences (le nom n'apparaît QU'au survol) */}
                  {isHover && (
                    <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: "50%", transform: "translateX(-50%)", background: "#1A3C2E", color: "#F0EBE0", borderRadius: 6, padding: "5px 9px", fontSize: 11, whiteSpace: "nowrap", zIndex: 5, boxShadow: "0 2px 8px #1A3C2E33", pointerEvents: "none" }}>
                      <div style={{ fontWeight: 600 }}>#{i + 1} · {d.name}</div>
                      <div style={{ opacity: 0.8, fontVariantNumeric: "tabular-nums" }}>{d.count} occurrence{d.count > 1 ? "s" : ""}{clickable ? " · cliquer pour filtrer" : ""}</div>
                    </div>
                  )}
                  <div style={{
                    width: "100%", height: `${h}%`, background: c,
                    borderRadius: "2px 2px 0 0", transition: "opacity 0.12s, transform 0.12s",
                    opacity: isHover ? 1 : 0.85, transform: isHover ? "scaleY(1.02)" : "none", transformOrigin: "bottom",
                    minHeight: 3,
                  }} />
                </div>
              );
            })}
          </div>
          {/* Axe des rangs : "1" à gauche, ordre croissant (pas de noms de sites) */}
          <div style={{ display: "flex", gap, marginTop: 5, paddingTop: 5, borderTop: "0.5px solid #1A3C2E0C" }}>
            {rows.map((d, i) => (
              <div key={d.name + i} style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
                <span style={{ fontSize: 8, color: hover === i ? accent : "#1A3C2E", fontVariantNumeric: "tabular-nums", fontWeight: hover === i ? 700 : 500 }}>{i + 1}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
// Panneau « Autres marques à identifier » — rendu dans l'onglet Concurrents.
function UnknownBrandsPanel({ list = [] }) {
  if (!list.length) return null;
  return (
    <div className="gt-kpi-card" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: "#C978201A", color: "#C97820", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>?</span>
        <span className="gt-kpi-label" style={{ marginBottom: 0 }}>Autres marques à identifier</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#1A3C2E" }}>{list.length}</span>
      </div>
      <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 10 }}>
        Entités présentes dans les tops LLM qui ne sont ni votre marque ni un concurrent renseigné. Ajoutez-les comme concurrents pour les suivre.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {list.slice(0, 30).map((e, i) => (
          <span key={i} title={`${e.count} apparition${e.count > 1 ? "s" : ""}${e.bestPos ? ` · meilleure position #${e.bestPos}` : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 14, border: "0.5px solid #1A3C2E18", background: "#fff", fontSize: 11, color: "#1A3C2E" }}>
            {e.bestPos && <span style={{ fontSize: 9, fontWeight: 700, color: "#C97820", fontVariantNumeric: "tabular-nums" }}>#{e.bestPos}</span>}
            {e.name}
            <span style={{ fontSize: 9, color: "#1A3C2E" }}>×{e.count}</span>
          </span>
        ))}
        {list.length > 30 && <span style={{ fontSize: 10, color: "#1A3C2E", alignSelf: "center" }}>+ {list.length - 30} autres</span>}
      </div>
    </div>
  );
}

// Calcule la liste des « autres marques à identifier » (entités présentes dans les
// tops LLM qui ne sont ni la marque ni un concurrent renseigné). Extrait pour être
// réutilisable dans l'onglet Concurrents. Termes génériques exclus.
function computeUnknownEntities({ results = [], brandName = "", qualifiedCompetitors = [], aliasMap = {} }) {
  const brandKey = (brandName || "").toLowerCase().replace(/\s+/g, "");
  const compCatByName = {};
  (qualifiedCompetitors || []).forEach(c => { if (c.name) compCatByName[c.name.toLowerCase()] = c.category || "other"; });
  const kindOf = (rawName) => {
    const n = (rawName || "").toLowerCase();
    const compact = n.replace(/\s+/g, "").replace(/^www\./, "");
    const wb = (hay, needle) => {
      if (!needle) return false;
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
    };
    if (brandKey && (wb(n, brandKey) || compact === brandKey || compact.includes(brandKey))) return "brand";
    for (const [cname, cat] of Object.entries(compCatByName)) {
      const cc = cname.replace(/\s+/g, "");
      if (cc && (wb(n, cname) || compact === cc || compact.includes(cc))) return cat;
    }
    return "other";
  };
  const GENERIC_ENTITIES = new Set(["site web", "site internet", "site", "description", "votre marque", "la marque", "marque", "n/a", "na", "aucun", "aucune", "non", "autre", "autres", "etc"]);
  const aliasLut = {};
  Object.entries(aliasMap || {}).forEach(([a, b]) => { aliasLut[(a || "").toLowerCase().trim()] = b; });
  const canon = (name) => { if (!name) return name; return aliasLut[name.toLowerCase().trim()] || name; };
  const agg = {};
  const ensure = (rawName) => {
    if (!rawName) return null;
    const name = canon(rawName);
    const key = name.toLowerCase();
    if (GENERIC_ENTITIES.has(key.trim())) return null;
    if (!agg[key]) agg[key] = { name, kind: kindOf(name), ment: { count: 0, bestPos: null }, evoc: { count: 0 }, cit: { count: 0 }, isAlias: false };
    return agg[key];
  };
  const addMent = (name, pos) => { const e = ensure(name); if (!e) return; e.ment.count++; if (pos != null && pos > 0) e.ment.bestPos = e.ment.bestPos == null ? pos : Math.min(e.ment.bestPos, pos); };
  const addEvoc = (name) => { const e = ensure(name); if (e) e.evoc.count++; };
  const addCit  = (name) => { const e = ensure(name); if (e) e.cit.count++; };
  (results || []).forEach(r => {
    (r.competitors_mentioned || []).forEach(c => {
      if (!c.name) return;
      const mPos = c.mention_position != null ? c.mention_position : (c.position != null && c.position > 0 ? c.position : null);
      if (mPos != null && mPos > 0) addMent(c.name, mPos);
      if (c.evocation_position != null) addEvoc(c.name);
      if (c.in_sources || c.citation_position != null) addCit(c.name);
    });
    (r.unknown_entities || []).forEach(e => {
      if (!e?.name) return;
      const mPos = e.mention_position != null ? e.mention_position : (e.position != null && e.position > 0 ? e.position : null);
      if (mPos != null && mPos > 0) addMent(e.name, mPos);
      if (e.evocation_position != null) addEvoc(e.name);
      if (e.in_sources || e.citation_position != null) addCit(e.name);
    });
  });
  return Object.values(agg)
    .filter(e => e.kind === "other" && !e.isAlias && (e.ment.count + e.evoc.count + e.cit.count) > 0)
    .map(e => ({ name: e.name, count: e.ment.count + e.evoc.count + e.cit.count, bestPos: e.ment.bestPos }))
    .sort((a, b) => { const pa = a.bestPos ?? 9999, pb = b.bestPos ?? 9999; return pa !== pb ? pa - pb : b.count - a.count; });
}

function StatsHeader({ questions, results: allResults, brandName, qualifiedCompetitors = [], aliasMap = {}, onTopClick = null, mode = "response", siteIds = null, view = "cumule", statBrands = [] }) {
  // A.2 — les chiffres portent sur la DERNIÈRE DATE D'INTERROGATION.
  const lastDate = (allResults || []).reduce((mx, r) => {
    const d = (r.created_at || "").slice(0, 10);
    return d && d > mx ? d : mx;
  }, "");
  const results = lastDate ? (allResults || []).filter(r => (r.created_at || "").slice(0, 10) === lastDate) : (allResults || []);

  // Chiffres PAR MARQUE cumulé (somme des marques sélectionnées), via la même
  // agrégation que les courbes → chiffres et courbes cohérents.
  const _brands = Array.isArray(siteIds) && siteIds.length ? siteIds : null;
  const _agg = computeMecDaily(results, _brands)[0] || {
    responses_count: 0, questions_count: 0,
    mentions_resp: 0, evocations_resp: 0, citations_resp: 0, mentions_q: 0, evocations_q: 0, citations_q: 0,
  };
  const _suf = mode === "question" ? "_q" : "_resp";
  const total = mode === "question" ? _agg.questions_count : _agg.responses_count;

  // Positions de mention PAR MARQUE (depuis brand_presences), pour la moyenne.
  const _posBrands = _brands || [null];
  const mentionPositions = [];
  results.forEach(r => _posBrands.forEach(sid => {
    if (sid == null) { if (r.brand_mention_position != null) mentionPositions.push(r.brand_mention_position); }
    else { const p = r.brand_presences && r.brand_presences[sid]; if (p && p.mention_position != null) mentionPositions.push(p.mention_position); }
  }));

  const mentionCount   = _agg["mentions" + _suf];
  const evocationCount = _agg["evocations" + _suf];
  const citationCount  = _agg["citations" + _suf];
  const mentionAvgPos  = mentionPositions.length
    ? (mentionPositions.reduce((a, b) => a + b, 0) / mentionPositions.length).toFixed(1)
    : null;

  // ÉVOCATION = dans le corps narratif hors top
  // Rétrocompat : brand_mentioned=true SANS position dans un top = évocation
  const evocationResults   = results.filter(r => {
    if (r.brand_evocation_position != null) return true;
    // Ancien résultat : mentionné mais pas dans un top → évocation
    const isMentioned = r.brand_mentioned === true || r.brand_mentioned === 1;
    const hasTopPos   = (r.brand_mention_position != null) || (r.brand_position != null && r.brand_position > 0);
    return isMentioned && !hasTopPos;
  });
  const evocationPositions = evocationResults
    .map(r => r.brand_evocation_position)
    .filter(Boolean);
  const evocationAvgPos  = evocationPositions.length
    ? (evocationPositions.reduce((a, b) => a + b, 0) / evocationPositions.length).toFixed(1)
    : null;

  // CITATION = domaine dans les sources
  const citationResults   = results.filter(r =>
    r.brand_citation_position != null || r.brand_in_sources
  );
  const citationPositions = citationResults
    .map(r => r.brand_citation_position)
    .filter(Boolean);
  const citationAvgPos  = citationPositions.length
    ? (citationPositions.reduce((a, b) => a + b, 0) / citationPositions.length).toFixed(1)
    : null;


  // Top competitors
  const compCount = {};
  results.forEach(r => {
    const seen = new Set();
    (r.competitors_mentioned || []).forEach(c => {
      if (c.name && !seen.has(c.name)) {
        seen.add(c.name);
        compCount[c.name] = (compCount[c.name] || 0) + 1;
      }
    });
  });
  // (topComps retiré — remplacé par les 3 TopBarChart)


  // ── Helper : couleur selon le taux (nb / total) ───────────────
  function rateColor(count) {
    if (!total) return "";
    const pct = count / total * 100;
    return pct >= 50 ? "gt-success" : pct > 0 ? "gt-warn" : "gt-danger";
  }

  // ── 3 TOPS par site : mentions / évocations / sources ─────────
  // Code couleur : marque · concurrent direct · concurrent GEO · partenaire · autre
  const brandKey = (brandName || "").toLowerCase().replace(/\s+/g, "");
  const compCatByName = {};
  (qualifiedCompetitors || []).forEach(c => {
    if (c.name) compCatByName[c.name.toLowerCase()] = c.category || "other";
  });
  // Détermine le "kind" (couleur) d'un nom de site/entité
  const kindOf = (rawName) => {
    const n = (rawName || "").toLowerCase();
    const compact = n.replace(/\s+/g, "").replace(/^www\./, "");
    // Frontière de mot (insensible casse) pour éviter les faux positifs de classification
    const wb = (hay, needle) => {
      if (!needle) return false;
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
    };
    if (brandKey && (wb(n, brandKey) || compact === brandKey || compact.includes(brandKey))) return "brand";
    for (const [cname, cat] of Object.entries(compCatByName)) {
      const cc = cname.replace(/\s+/g, "");
      // match par mot dans le nom OU domaine compact identique
      if (cc && (wb(n, cname) || compact === cc || compact.includes(cc))) return cat;
    }
    return "other";
  };

  // Top mentions & évocations : par CONCURRENT/MARQUE détecté dans les réponses.
  // mention = présent dans une liste classée (position) · évocation = cité sans position.
  // On agrège { count, bestPos } pour pouvoir trier par MEILLEURE position.
  // ── Agrégation des 3 tops par MARQUE (projet + concurrents + autres marques) ──
  // Chaque entité accumule : mentions (count + meilleure position), évocations (count),
  // citations (count). Une même marque peut apparaître dans les 3 tops.
  const agg = {}; // name → { name, kind, ment:{count,bestPos}, evoc:{count}, cit:{count,bestPos} }
  // Canonicalisation par alias : A est compté comme B. Insensible casse/espaces.
  const aliasLut = {};
  Object.entries(aliasMap || {}).forEach(([a, b]) => { aliasLut[(a || "").toLowerCase().trim()] = b; });
  const canon = (name) => {
    if (!name) return name;
    const c = aliasLut[name.toLowerCase().trim()];
    return c || name;
  };
  // Termes génériques que les LLM listent parfois comme des « entités » mais qui
  // ne sont PAS des marques → jamais comptés (mentions, évocations, citations, tops).
  const GENERIC_ENTITIES = new Set([
    "site web", "site internet", "site", "description", "votre marque", "la marque",
    "marque", "n/a", "na", "aucun", "aucune", "non", "autre", "autres", "etc",
  ]);
  const ensure = (rawName) => {
    if (!rawName) return null;
    const name = canon(rawName);               // somme l'alias sur le canonique
    const key = name.toLowerCase();
    if (GENERIC_ENTITIES.has(key.trim())) return null; // terme générique → ignoré
    if (!agg[key]) agg[key] = { name, kind: kindOf(name), ment: { count: 0, bestPos: null }, evoc: { count: 0 }, cit: { count: 0, bestPos: null } };
    return agg[key];
  };
  const addMent = (name, pos) => { const e = ensure(name); if (!e) return; e.ment.count++; if (pos != null && pos > 0) e.ment.bestPos = e.ment.bestPos == null ? pos : Math.min(e.ment.bestPos, pos); };
  const addEvoc = (name) => { const e = ensure(name); if (e) e.evoc.count++; };
  const addCit  = (name, pos) => { const e = ensure(name); if (!e) return; e.cit.count++; if (pos != null && pos > 0) e.cit.bestPos = e.cit.bestPos == null ? pos : Math.min(e.cit.bestPos, pos); };

  results.forEach(r => {
    // ── MARQUE(S) du projet ──
    // Cumulé : une entrée « Votre marque » (champs du résultat).
    // Comparaison : une entrée PAR MARQUE sélectionnée (depuis brand_presences).
    const _compareTops = view === "compare" && Array.isArray(statBrands) && statBrands.length > 1;
    const brandEntries = _compareTops
      ? statBrands.map(b => ({ label: b.label, pres: (r.brand_presences && r.brand_presences[b.id]) || null }))
      : [{ label: brandName, pres: null }];
    brandEntries.forEach(({ label, pres }) => {
      if (!label) return;
      let mPos, isEvoc, isCit, citPos;
      if (pres) {
        mPos = pres.mention_position ?? null;
        isEvoc = pres.evocation_position != null;
        isCit = !!pres.in_sources;
        citPos = pres.citation_position ?? null;
      } else {
        mPos = r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null);
        isEvoc = r.brand_evocation_position != null;
        isCit = (r.brand_in_sources === true || r.brand_in_sources === 1);
        citPos = r.brand_citation_position ?? null;
      }
      const e = ensure(label); if (e) e.kind = "brand"; // couleur « votre marque » forcée
      if (mPos != null && mPos > 0) addMent(label, mPos);
      if (isEvoc) addEvoc(label);
      if (isCit) addCit(label, citPos);
    });

    // ── CONCURRENTS flaggués (positions fiables M/É/C) ──
    (r.competitors_mentioned || []).forEach(c => {
      if (!c.name) return;
      const mPos = c.mention_position != null ? c.mention_position : (c.position != null && c.position > 0 ? c.position : null);
      if (mPos != null && mPos > 0) addMent(c.name, mPos);
      if (c.evocation_position != null) addEvoc(c.name);
      if (c.in_sources || c.citation_position != null) addCit(c.name, c.citation_position ?? null);
    });

    // ── AUTRES MARQUES détectées (à identifier) ──
    (r.unknown_entities || []).forEach(e => {
      if (!e?.name) return;
      const mPos = e.mention_position != null ? e.mention_position : (e.position != null && e.position > 0 ? e.position : null);
      if (mPos != null && mPos > 0) addMent(e.name, mPos);
      if (e.evocation_position != null) addEvoc(e.name);
      if (e.in_sources || e.citation_position != null) addCit(e.name, e.citation_position ?? null);
    });
  });

  // Afficher les alias à 0 (leur compte a été sommé sur le canonique).
  Object.keys(aliasLut).forEach(aliasLower => {
    if (!agg[aliasLower]) {
      // nom d'affichage : retrouver une casse réelle vue dans les données si possible
      agg[aliasLower] = { name: aliasLower, kind: "other", ment: { count: 0, bestPos: null }, evoc: { count: 0 }, cit: { count: 0, bestPos: null }, isAlias: true };
    }
  });
  const aggList = Object.values(agg);
  // Top mentions : tri par meilleure position puis count
  const topMentions = aggList.filter(e => e.ment.count > 0)
    .map(e => ({ name: e.name, count: e.ment.count, bestPos: e.ment.bestPos, kind: e.kind }))
    .sort((a, b) => { if (b.count !== a.count) return b.count - a.count; return (a.bestPos ?? 9999) - (b.bestPos ?? 9999); });
  // Top évocations : tri par count
  const topEvocations = aggList.filter(e => e.evoc.count > 0)
    .map(e => ({ name: e.name, count: e.evoc.count, kind: e.kind }))
    .sort((a, b) => b.count - a.count);
  // Top citations : marques citées en source, tri par count puis meilleure position
  const topCitations = aggList.filter(e => e.cit.count > 0)
    .map(e => ({ name: e.name, count: e.cit.count, bestPos: e.cit.bestPos, kind: e.kind }))
    .sort((a, b) => { if (b.count !== a.count) return b.count - a.count; const pa = a.bestPos ?? 9999, pb = b.bestPos ?? 9999; return pa - pb; });
  // (Top sources par domaine retiré de l'affichage — remplacé par Top citations par marque)

  // Liste des autres marques à identifier (celles NI marque NI concurrent connu)
  const unknownEntitiesList = aggList
    .filter(e => e.kind === "other" && !e.isAlias && (e.ment.count + e.evoc.count + e.cit.count) > 0)
    .map(e => ({ name: e.name, count: e.ment.count + e.evoc.count + e.cit.count, bestPos: e.ment.bestPos }))
    .sort((a, b) => { const pa = a.bestPos ?? 9999, pb = b.bestPos ?? 9999; return pa !== pb ? pa - pb : b.count - a.count; });
  void unknownEntitiesList; // conservé pour d'éventuels usages ; affichage déplacé dans Concurrents

  return (
    <div style={{ marginBottom: 24 }}>

      {/* ── 3 couples Présence + Position ── */}
      {/* Mode COMPARAISON : un jeu de 3 chiffres PAR MARQUE (mention/évocation/citation). */}
      {view === "compare" && statBrands.length > 1 && (
        <div style={{ marginBottom: 12, border: "0.5px solid #1A3C2E14", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", fontSize: 10, fontWeight: 700, color: "#94A3B8", padding: "6px 12px", background: "#1A3C2E08", textTransform: "uppercase", letterSpacing: 0.3 }}>
            <span>Marque</span><span style={{ textAlign: "center" }}>Mention</span><span style={{ textAlign: "center" }}>Évocation</span><span style={{ textAlign: "center" }}>Citation</span>
          </div>
          {statBrands.map((b, i) => {
            const a = computeMecDaily(results, [b.id])[0] || { responses_count: 0, questions_count: 0, mentions_resp: 0, evocations_resp: 0, citations_resp: 0, mentions_q: 0, evocations_q: 0, citations_q: 0 };
            const tot = mode === "question" ? a.questions_count : a.responses_count;
            const pct = (v) => tot ? Math.round(v / tot * 100) : 0;
            const col = b.color || BRAND_PALETTE[i % BRAND_PALETTE.length];
            return (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid #1A3C2E10" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#1A3C2E" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: col, flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.label}</span>
                </span>
                <span style={{ textAlign: "center", fontWeight: 700, color: "#1A7A4A" }}>{pct(a["mentions" + _suf])}%<span style={{ fontSize: 9, color: "#94A3B8", fontWeight: 400 }}> · {a["mentions" + _suf]}</span></span>
                <span style={{ textAlign: "center", fontWeight: 700, color: "#C97820" }}>{pct(a["evocations" + _suf])}%<span style={{ fontSize: 9, color: "#94A3B8", fontWeight: 400 }}> · {a["evocations" + _suf]}</span></span>
                <span style={{ textAlign: "center", fontWeight: 700, color: "#2563EB" }}>{pct(a["citations" + _suf])}%<span style={{ fontSize: 9, color: "#94A3B8", fontWeight: 400 }}> · {a["citations" + _suf]}</span></span>
              </div>
            );
          })}
        </div>
      )}

      <div className="gt-kpi-grid geo-stats-kpi-grid" style={{ marginBottom: 12, display: view === "compare" && statBrands.length > 1 ? "none" : undefined }}>

        {/* Mention */}
        <div className="gt-kpi-card">
          <div className="gt-kpi-label" style={{ marginBottom: 6 }}>
            Mention
            <span className="gt-caption" style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0 }}>
              dans le top
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className={`gt-kpi-val ${rateColor(mentionCount)}`}>
              {total ? Math.round(mentionCount / total * 100) : 0}%
            </div>
            {mentionAvgPos && (
              <div className="gt-caption" style={{ fontVariantNumeric: "tabular-nums" }}>
                pos. moy. #{mentionAvgPos}
              </div>
            )}
          </div>
          <div className="gt-kpi-sub">{mentionCount} / {total} réponses</div>
        </div>

        {/* Évocation */}
        <div className="gt-kpi-card">
          <div className="gt-kpi-label" style={{ marginBottom: 6 }}>
            Évocation
            <span className="gt-caption" style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0 }}>
              dans le texte
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className={`gt-kpi-val ${rateColor(evocationCount)}`}>
              {total ? Math.round(evocationCount / total * 100) : 0}%
            </div>
            {evocationAvgPos && (
              <div className="gt-caption" style={{ fontVariantNumeric: "tabular-nums" }}>
                pos. moy. #{evocationAvgPos}
              </div>
            )}
          </div>
          <div className="gt-kpi-sub">{evocationCount} / {total} réponses</div>
        </div>

        {/* Citation */}
        <div className="gt-kpi-card">
          <div className="gt-kpi-label" style={{ marginBottom: 6 }}>
            Citation
            <span className="gt-caption" style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0 }}>
              dans les sources
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className={`gt-kpi-val ${rateColor(citationCount)}`}>
              {total ? Math.round(citationCount / total * 100) : 0}%
            </div>
            {citationAvgPos && (
              <div className="gt-caption" style={{ fontVariantNumeric: "tabular-nums" }}>
                pos. moy. #{citationAvgPos}
              </div>
            )}
          </div>
          <div className="gt-kpi-sub">{citationCount} / {total} réponses</div>
        </div>
      </div>

      {/* ── 3 TOPS : Mentions · Évocations · Sources (barres verticales) ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        <TopBarChart title="Top mentions" glyph="◎" accent="#1A7A4A" data={topMentions} onBarClick={onTopClick ? (d) => onTopClick("mention", d.name) : null} />
        <TopBarChart title="Top évocations" glyph="⟶" accent="#C97820" data={topEvocations} onBarClick={onTopClick ? (d) => onTopClick("evocation", d.name) : null} />
        <TopBarChart title="Top citations" glyph="↗" accent="#1A3C2E" data={topCitations} onBarClick={onTopClick ? (d) => onTopClick("citation", d.name) : null} />
      </div>

      {/* Légende code couleur */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12, paddingTop: 10, borderTop: "0.5px solid #1A3C2E0C" }}>
        {Object.entries(TOP_COLORS).map(([k, v]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "#1A3C2E" }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: v.color, flexShrink: 0 }} />
            {v.label}
          </span>
        ))}
      </div>

      {/* Autres marques présentes dans les tops — à identifier */}
      {/* « Autres marques à identifier » déplacé dans l'onglet Concurrents. */}
    </div>
  );
}

// ── Competitor categories ─────────────────────────────────────────
const COMP_CATEGORIES = [
  { key: "direct",      label: "Concurrent direct",  color: "#DC2626", bg: "#FEF2F2" },
  { key: "geo",         label: "Concurrent GEO",      color: "#D97706", bg: "#FFFBEB" },
  { key: "partner",     label: "Partenaire",           color: "#059669", bg: "#ECFDF5" },
  { key: "second_site", label: "2nd site suivi",       color: "#2563EB", bg: "#EFF6FF" },
  { key: "other",       label: "Autre",                color: "#64748B", bg: "#F1F5F9" },
];

// ── Overlay d'import SF / Semrush pour un concurrent (comparaison approfondie) ──
function ToolImportOverlay({ target, tool, citedUrls = null, onClose, onSubmit }) {
  // tool : "sf" | "semrush". Pour semrush, choix Overview / Top pages.
  const [smKind, setSmKind] = useState("sm_overview");
  const [file, setFile] = useState(null);
  const [crawlDate, setCrawlDate] = useState("");
  const [analysisDate, setAnalysisDate] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!target) return null;
  const kind = tool === "sf" ? "sf" : smKind;

  const submit = async () => {
    if (!file) { setErr("Sélectionnez un fichier CSV."); return; }
    setBusy(true); setErr("");
    try {
      const text = await file.text();
      const meta = { filename: file.name };
      if (kind === "sf") meta.crawl_date = crawlDate || null;
      else if (kind === "sm_overview") meta.analysis_date = analysisDate || null;
      else if (kind === "sm_pages") { meta.period_start = periodStart || null; meta.period_end = periodEnd || null; }
      const rec = computeToolImport(kind, text, meta, citedUrls);
      if (!rec) { setErr("Fichier non reconnu pour ce type d'import."); setBusy(false); return; }
      await onSubmit(kind, rec);
      setBusy(false); onClose();
    } catch (e) { setErr("Erreur de lecture du fichier."); setBusy(false); }
  };

  const L = { fontSize: 11, color: "#64748B", marginBottom: 3, display: "block" };
  const I = { width: "100%", padding: "7px 9px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12, boxSizing: "border-box" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(26,60,46,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 380, maxWidth: "100%", background: "#fff", borderRadius: 14, boxShadow: "0 12px 48px rgba(26,60,46,0.25)", padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A3C2E", marginBottom: 2 }}>
          Importer {tool === "sf" ? "Screaming Frog" : "Semrush"}
        </div>
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 16 }}>pour <b style={{ color: target.color }}>{target.label}</b></div>

        {tool === "semrush" && (
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {[{ id: "sm_overview", label: "Overview" }, { id: "sm_pages", label: "Top pages" }].map(k => (
              <button key={k.id} onClick={() => setSmKind(k.id)}
                style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${smKind === k.id ? "#1A4A7A" : "#E2E8F0"}`, background: smKind === k.id ? "#1A4A7A" : "transparent", color: smKind === k.id ? "#fff" : "#64748B" }}>
                {k.label}
              </button>
            ))}
          </div>
        )}

        <label style={L}>Fichier CSV export{kind === "sf" ? " (internal_all)" : kind === "sm_overview" ? " (Domain Overview)" : " (Organic Pages)"}</label>
        <input type="file" accept=".csv" onChange={e => { setFile(e.target.files?.[0] || null); setErr(""); }} style={{ ...I, marginBottom: 14, padding: "6px" }} />

        {kind === "sf" && (
          <div style={{ marginBottom: 14 }}>
            <label style={L}>Date du crawl</label>
            <input type="date" value={crawlDate} onChange={e => setCrawlDate(e.target.value)} style={I} />
          </div>
        )}
        {kind === "sm_overview" && (
          <div style={{ marginBottom: 14 }}>
            <label style={L}>Date d'analyse</label>
            <input type="date" value={analysisDate} onChange={e => setAnalysisDate(e.target.value)} style={I} />
          </div>
        )}
        {kind === "sm_pages" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <div style={{ flex: 1 }}><label style={L}>Début période</label><input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} style={I} /></div>
            <div style={{ flex: 1 }}><label style={L}>Fin période</label><input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} style={I} /></div>
          </div>
        )}

        {err && <div style={{ fontSize: 11, color: "#E8541A", marginBottom: 10 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={submit} disabled={busy} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: busy ? "#94A3B8" : "#1A7A4A", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: busy ? "default" : "pointer" }}>{busy ? "Import…" : "Importer"}</button>
          <button onClick={onClose} style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #E2E8F0", background: "transparent", color: "#64748B", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

function CompetitorManager({ projectId, siteId, allResults, competitors, setCompetitors, brandLabel = "Votre marque", aliasMap = {}, sfData = {}, smData = {}, smOverview = {}, sfPerimeter = null }) {
  // « Autres marques à identifier » (déplacé depuis le Suivi) — entités des tops
  // LLM ni marque ni concurrent renseigné.
  const unknownEntitiesList = useMemo(
    () => computeUnknownEntities({ results: allResults, brandName: brandLabel, qualifiedCompetitors: (competitors || []).filter(c => c.enabled !== false), aliasMap }),
    [allResults, brandLabel, competitors, aliasMap]
  );
  const [newName, setNewName] = useState("");
  const [newCat,  setNewCat]  = useState("direct");
  const [saving,  setSaving]  = useState(false);
  const [sortBy,  setSortBy]  = useState("mentions");
  const [catMenuFor, setCatMenuFor] = useState(null); // marque dont le menu de catégorie est ouvert
  // Alias : alias A → canonique B (sommés partout dans le projet)
  const [aliases, setAliases] = useState([]);
  const [aliasA, setAliasA] = useState("");   // le nom variante
  const [aliasB, setAliasB] = useState("");   // la forme canonique
  const [aliasSaving, setAliasSaving] = useState(false);
  useEffect(() => {
    if (!projectId || !siteId) { setAliases([]); return; }
    let cancelled = false;
    sbGetAliases(projectId, siteId).then(rows => { if (!cancelled) setAliases(rows || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]);
  const saveAlias = async () => {
    if (!aliasA.trim() || !aliasB.trim() || !projectId || !siteId) return;
    if (aliasA.trim().toLowerCase() === aliasB.trim().toLowerCase()) return; // pas d'auto-alias
    setAliasSaving(true);
    try {
      const saved = await sbSaveAlias({ project_id: projectId, site_id: siteId, alias: aliasA, canonical: aliasB });
      setAliases(prev => {
        const idx = prev.findIndex(a => a.alias.toLowerCase() === aliasA.trim().toLowerCase());
        if (idx >= 0) { const n = [...prev]; n[idx] = saved; return n; }
        return [...prev, saved];
      });
      setAliasA(""); setAliasB("");
    } catch(e) { console.error(e); }
    setAliasSaving(false);
  };
  const removeAlias = async (id) => {
    try { await sbDeleteAlias(id); setAliases(prev => prev.filter(a => a.id !== id)); }
    catch(e) { console.error(e); }
  };

  const detectedNames = useMemo(() => {
    const mentions = {}; const display = {};
    allResults.forEach(r => {
      (r.competitors_mentioned || []).forEach(c => {
        if (!c.name) return;
        const lower = c.name.toLowerCase();
        mentions[lower] = (mentions[lower] || 0) + 1;
        if (!display[lower]) display[lower] = c.name;
      });
      // Marques détectées dans les tops mais non flaggées (à identifier)
      (r.unknown_entities || []).forEach(e => {
        if (!e?.name) return;
        const lower = e.name.toLowerCase();
        mentions[lower] = (mentions[lower] || 0) + 1;
        if (!display[lower]) display[lower] = e.name;
      });
    });
    // Recherche rétroactive
    competitors.forEach(comp => {
      const lower = comp.name.toLowerCase();
      const re = new RegExp(comp.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      allResults.forEach(r => {
        const already = (r.competitors_mentioned || []).some(c => c.name?.toLowerCase() === lower);
        if (!already && re.test(r.answer || "")) {
          mentions[lower] = (mentions[lower] || 0) + 1;
          if (!display[lower]) display[lower] = comp.name;
        }
      });
    });
    return Object.keys(mentions).map(lower => ({
      name: display[lower] || lower, lower,
      mentions: mentions[lower] || 0,
    })).sort((a, b) => b.mentions - a.mentions);
  }, [allResults, competitors]); // eslint-disable-line react-hooks/exhaustive-deps

  const getCatDef = (cat) => COMP_CATEGORIES.find(c => c.key === cat) || COMP_CATEGORIES[3];

  const save = async () => {
    if (!newName.trim() || !projectId || !siteId) return;
    setSaving(true);
    try {
      const catDef = getCatDef(newCat);
      const saved = await sbSaveCompetitor({ project_id: projectId, site_id: siteId, name: newName.trim(), category: newCat, color: catDef.color, enabled: true });
      setCompetitors(prev => {
        const idx = prev.findIndex(c => c.name.toLowerCase() === newName.trim().toLowerCase());
        if (idx >= 0) { const n = [...prev]; n[idx] = saved; return n; }
        return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
      setNewName("");
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  // Catégoriser directement une marque détectée → la déplacer dans Concurrents
  const categorizeDetected = async (name, category) => {
    if (!name || !projectId || !siteId) return;
    const catDef = getCatDef(category);
    try {
      const saved = await sbSaveCompetitor({ project_id: projectId, site_id: siteId, name: name.trim(), category, color: catDef.color, enabled: true });
      setCompetitors(prev => {
        const idx = prev.findIndex(c => c.name.toLowerCase() === name.trim().toLowerCase());
        if (idx >= 0) { const n = [...prev]; n[idx] = saved; return n; }
        return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch(e) { console.error(e); }
  };

  const updateCat = async (comp, category) => {
    const catDef = getCatDef(category);
    try {
      await sbUpdateCompetitor(comp.id, { category, color: catDef.color });
      setCompetitors(prev => prev.map(c => c.id === comp.id ? { ...c, category, color: catDef.color } : c));
    } catch(e) { console.error(e); }
  };

  const updateEnabled = async (comp, enabled) => {
    try {
      await sbUpdateCompetitor(comp.id, { enabled });
      setCompetitors(prev => prev.map(c => c.id === comp.id ? { ...c, enabled } : c));
    } catch(e) { console.error(e); }
  };

  const remove = async (id) => {
    try { await sbDeleteCompetitor(id); setCompetitors(prev => prev.filter(c => c.id !== id)); }
    catch(e) { console.error(e); }
  };

  const displayed = useMemo(() => {
    return [...competitors].sort((a, b) => {
      if (sortBy === "alpha") return a.name.localeCompare(b.name);
      if (sortBy === "cat") return (a.category||"").localeCompare(b.category||"");
      const ma = detectedNames.find(d => d.lower === a.name.toLowerCase())?.mentions || 0;
      const mb = detectedNames.find(d => d.lower === b.name.toLowerCase())?.mentions || 0;
      return mb - ma;
    });
  }, [competitors, sortBy, detectedNames]);

  // ── Lot B1 : comparaison approfondie ───────────────────────────────────────
  const [includedRows, setIncludedRows] = useState(null); // null = toutes incluses
  useEffect(() => {
    if (!projectId) return;
    sbGetCompareSettings(projectId).then(cfg => {
      if (cfg && Array.isArray(cfg.compare_rows) && cfg.compare_rows.length) setIncludedRows(cfg.compare_rows);
      else setIncludedRows(COMPARE_ROWS.map(r => r.id)); // défaut : tout coché
    });
  }, [projectId]);

  const deepSelected = competitors.filter(c => c.deep_compare === true);
  const MAX_DEEP = 5;

  const toggleDeep = async (comp) => {
    const next = !(comp.deep_compare === true);
    if (next && deepSelected.length >= MAX_DEEP) return; // plafond
    setCompetitors(prev => prev.map(c => c.id === comp.id ? { ...c, deep_compare: next } : c));
    try { await sbUpdateCompetitor(comp.id, { deep_compare: next }); } catch { /* colonne non migrée → état local conservé */ }
  };

  const toggleRow = async (rowId) => {
    const base = includedRows || COMPARE_ROWS.map(r => r.id);
    const next = base.includes(rowId) ? base.filter(r => r !== rowId) : [...base, rowId];
    setIncludedRows(next);
    if (projectId) sbSetCompareRows(projectId, next).catch(() => {});
  };

  // Agrégats Screaming Frog + Semrush de la marque (site courant) pour les lignes sf_*/sm_*
  const [importTarget, setImportTarget] = useState(null); // colonne (concurrent) en cours d'import
  const [importTool, setImportTool] = useState("sf");     // "sf" | "semrush"
  const openImport = (col, needsTool) => {
    if (col.isBrand) { window.alert("Pour votre marque, importez les données dans l'onglet Configuration (import par site)."); return; }
    setImportTarget(col); setImportTool(needsTool);
  };
  const submitImport = async (kind, rec) => {
    const compId = importTarget?.key;
    if (!compId) return;
    const comp = competitors.find(c => c.id === compId);
    const nextImports = { ...(comp?.tool_imports || {}), [kind]: rec };
    setCompetitors(prev => (Array.isArray(prev) ? prev : []).map(c => c.id === compId ? { ...c, tool_imports: nextImports } : c));
    try { await sbUpdateCompetitor(compId, { tool_imports: nextImports }); } catch { /* colonne non migrée → l'état local reste */ }
  };
  const citedSet = useMemo(() => citedUrlSet(allResults), [allResults]);
  const sfStats = useMemo(() => sfCompareStats(applySfPerimeter((sfData || {})[siteId] || [], sfPerimeter), citedSet), [sfData, siteId, sfPerimeter, citedSet]);
  const smStats = useMemo(() => resolveSmStats(((smOverview || {})[siteId] || [])[0], (smData || {})[siteId]), [smOverview, smData, siteId]);

  // Stats LLM par site, calculées localement depuis allResults (autonome vs audit)
  const compareView = useMemo(() => {
    const deep = competitors.filter(c => c.deep_compare === true).slice(0, MAX_DEEP);
    // Marque
    const brandStats = { mentions: 0, evocations: 0, citations: 0, positions: [], urls: {} };
    allResults.forEach(r => {
      const mPos = r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null);
      if (mPos != null && mPos > 0) { brandStats.mentions++; brandStats.positions.push(mPos); }
      else if (r.brand_mentioned === true || r.brand_mentioned === 1) brandStats.evocations++;
      if (r.brand_in_sources === true || r.brand_in_sources === 1) {
        brandStats.citations++;
        (r.sources || []).forEach(u => { const k = String(u || "").trim(); if (k) brandStats.urls[k] = (brandStats.urls[k] || 0) + 1; });
      }
    });
    const bAvg = brandStats.positions.length ? Math.round((brandStats.positions.reduce((a, b) => a + b, 0) / brandStats.positions.length) * 10) / 10 : null;
    const bBest = Object.values(brandStats.urls).sort((a, b) => b - a)[0] || 0;
    const brandFinal = {
      mentions: brandStats.mentions, evocations: brandStats.evocations, citations: brandStats.citations,
      avgPos: bAvg, urlsCited: Object.keys(brandStats.urls).length, bestUrlHits: bBest,
    };
    // Concurrents : re-détection sur le TEXTE des réponses stockées (pas le figé
    // competitors_mentioned, qui ne contient que les concurrents connus à l'interrogation).
    // → un concurrent ajouté après coup est correctement compté.
    const compEntries = deep.map(comp => {
      const st = { mentions: 0, evocations: 0, citations: 0, positions: [] };
      allResults.forEach(r => {
        const d = detectBrand(r.answer || "", r.sources || [], comp.name, comp.aliases || [], []);
        const mPos = d.mention?.position ?? null;
        if (mPos != null && mPos > 0) { st.mentions++; st.positions.push(mPos); }
        else if (d.brandMentioned || d.evocation?.position != null) st.evocations++;
        if (d.brandInSources || d.citation?.position != null) st.citations++;
      });
      const avg = st.positions.length ? Math.round((st.positions.reduce((a, b) => a + b, 0) / st.positions.length) * 10) / 10 : null;
      const u = entityUrlStats(allResults, comp.name, comp.domain);
      return { key: comp.id, label: comp.name, color: comp.color || "#64748B",
        stats: { mentions: st.mentions, evocations: st.evocations, citations: st.citations, avgPos: avg, urlsCited: u.urlsCited || null, bestUrlHits: u.bestUrlHits || null } };
    });
    const brandTool = { ...(sfStats || {}), ...(smStats || {}) };
    const toolStatsByCol = {};
    if (Object.keys(brandTool).length) toolStatsByCol.__brand__ = brandTool;
    const importStatus = { __brand__: { sf: !!sfStats, semrush: !!smStats } };
    deep.forEach(comp => {
      const ts = entityToolStats(comp.tool_imports);
      if (ts) toolStatsByCol[comp.id] = ts;
      const ti = comp.tool_imports || {};
      importStatus[comp.id] = { sf: !!ti.sf, semrush: !!(ti.sm_overview || ti.sm_pages) };
    });
    const view = buildLlmComparison(brandLabel, brandFinal, compEntries, toolStatsByCol);
    return { ...view, importStatus };
  }, [allResults, competitors, brandLabel, sfStats, smStats]);


  return (
    <div>
      {/* Autres marques à identifier (déplacé depuis le Suivi) */}
      <UnknownBrandsPanel list={unknownEntitiesList} />
      {/* Formulaire ajout */}
      <div style={{ background: "transparent", border: "none", borderBottom: "0.5px solid #1A3C2E0D", padding: "0 0 16px 0", marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Ajouter un concurrent</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nom du concurrent…"
            onKeyDown={e => e.key === "Enter" && save()}
            style={{ flex: "1 1 180px", padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12 }} />
          <select value={newCat} onChange={e => setNewCat(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12 }}>
            {COMP_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button onClick={save} disabled={saving || !newName.trim()}
            style={{ padding: "6px 14px", background: newName.trim() ? "#1A3C2E" : "#F1F5F9", color: newName.trim() ? "#F0EBE0" : "#94A3B8", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: newName.trim() ? "pointer" : "default" }}>
            {saving ? "…" : "Ajouter"}
          </button>
        </div>
      </div>
      {/* Marques détectées non qualifiées — cliquer pour catégoriser → Concurrents */}
      {detectedNames.filter(d => !competitors.some(c => c.name.toLowerCase() === d.lower)).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>Marques détectées — à catégoriser</div>
          <div style={{ fontSize: 10, color: "#94A3B8", marginBottom: 8 }}>Cliquez une marque puis choisissez sa catégorie : elle rejoint vos concurrents.</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {detectedNames.filter(d => !competitors.some(c => c.name.toLowerCase() === d.lower)).slice(0, 20).map(d => (
              <div key={d.lower} style={{ position: "relative", display: "inline-block" }}>
                <button onClick={() => setCatMenuFor(catMenuFor === d.lower ? null : d.lower)}
                  style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, border: catMenuFor === d.lower ? "1px solid #1A3C2E" : "1px solid #E2E8F0", background: catMenuFor === d.lower ? "#1A3C2E0A" : "#F8FAFC", color: "#64748B", cursor: "pointer" }}>
                  {d.name} <span style={{ color: "#94A3B8" }}>{d.mentions}×</span>
                </button>
                {catMenuFor === d.lower && (
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "0.5px solid #1A3C2E22", borderRadius: 8, boxShadow: "0 4px 14px #1A3C2E22", padding: 4, minWidth: 160 }}>
                    {COMP_CATEGORIES.map(c => (
                      <button key={c.key}
                        onClick={() => { categorizeDetected(d.name, c.key); setCatMenuFor(null); }}
                        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", padding: "6px 9px", border: "none", background: "transparent", borderRadius: 6, fontSize: 12, color: "#1A3C2E", cursor: "pointer" }}
                        onMouseEnter={e => e.currentTarget.style.background = "#F8FAFC"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: c.color, flexShrink: 0 }} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* ── Panneau Alias : A compté comme B partout dans le projet ── */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "0.5px solid #1A3C2E0D" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>Alias de marques</div>
        <div style={{ fontSize: 10, color: "#94A3B8", marginBottom: 8 }}>
          Déclarez qu'un nom (A) doit être compté comme un autre (B). Ex. « 2io » → « Deux.io ». Les mentions / évocations / citations de A sont sommées sur B ; A apparaît ensuite à 0.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: aliases.length ? 10 : 0 }}>
          <input value={aliasA} onChange={e => setAliasA(e.target.value)} placeholder="Alias (A)…"
            onKeyDown={e => e.key === "Enter" && saveAlias()}
            style={{ flex: "1 1 130px", padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12 }} />
          <span style={{ fontSize: 13, color: "#94A3B8" }}>→</span>
          <input value={aliasB} onChange={e => setAliasB(e.target.value)} placeholder="Compté comme (B)…"
            onKeyDown={e => e.key === "Enter" && saveAlias()}
            style={{ flex: "1 1 130px", padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12 }} />
          <button onClick={saveAlias} disabled={aliasSaving || !aliasA.trim() || !aliasB.trim()}
            style={{ padding: "6px 14px", background: (aliasA.trim() && aliasB.trim()) ? "#1A3C2E" : "#F1F5F9", color: (aliasA.trim() && aliasB.trim()) ? "#F0EBE0" : "#94A3B8", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: (aliasA.trim() && aliasB.trim()) ? "pointer" : "default" }}>
            {aliasSaving ? "…" : "Ajouter"}
          </button>
        </div>
        {aliases.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {aliases.map(a => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#1A3C2E", padding: "4px 0" }}>
                <span style={{ fontWeight: 600 }}>{a.alias}</span>
                <span style={{ color: "#94A3B8" }}>→</span>
                <span style={{ fontWeight: 600, color: "#1A7A4A" }}>{a.canonical}</span>
                <button onClick={() => removeAlias(a.id)}
                  style={{ marginLeft: "auto", fontSize: 11, color: "#C0352A", background: "transparent", border: "none", cursor: "pointer" }}>Supprimer</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Liste qualifiés */}
      {competitors.length > 0 && (
        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: "#94A3B8" }}>{competitors.length} concurrent{competitors.length > 1 ? "s" : ""} qualifié{competitors.length > 1 ? "s" : ""}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {[{ key: "mentions", label: "Mentions" }, { key: "alpha", label: "A→Z" }, { key: "cat", label: "Catégorie" }].map(s => (
                <button key={s.key} onClick={() => setSortBy(s.key)}
                  style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, border: `1px solid ${sortBy === s.key ? "#1A3C2E" : "#E2E8F0"}`, background: sortBy === s.key ? "#1A3C2E" : "transparent", color: sortBy === s.key ? "#F0EBE0" : "#64748B", cursor: "pointer" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {displayed.map(comp => {
              const catDef = getCatDef(comp.category);
              const mentions = detectedNames.find(d => d.lower === comp.name.toLowerCase())?.mentions || 0;
              const enabled = comp.enabled !== false;
              return (
                <div key={comp.id} style={{ border: "none", borderBottom: "0.5px solid #1A3C2E08", borderRadius: 0, background: "transparent", padding: "9px 0", display: "flex", alignItems: "center", gap: 8, opacity: enabled ? 1 : 0.4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: catDef.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#1A3C2E", flex: 1 }}>{comp.name}</span>
                  {mentions > 0 && <span style={{ fontSize: 10, color: catDef.color, background: "#fff", border: `1px solid ${catDef.color}33`, borderRadius: 5, padding: "1px 6px", fontWeight: 600 }}>{mentions}×</span>}
                  {comp._virtual ? (
                    <span style={{ fontSize: 10, color: catDef.color, background: catDef.bg, border: `1px solid ${catDef.color}33`, borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>
                      {catDef.label}
                    </span>
                  ) : (
                  <>
                  <label title={comp.deep_compare ? "Retirer de la comparaison approfondie" : (deepSelected.length >= MAX_DEEP ? `Maximum ${MAX_DEEP} concurrents comparés` : "Comparer en profondeur")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: comp.deep_compare ? "#1A4A7A" : "#94A3B8", cursor: (comp.deep_compare || deepSelected.length < MAX_DEEP) ? "pointer" : "not-allowed", flexShrink: 0, userSelect: "none" }}>
                    <input type="checkbox" checked={comp.deep_compare === true}
                      disabled={!comp.deep_compare && deepSelected.length >= MAX_DEEP}
                      onChange={() => toggleDeep(comp)}
                      style={{ cursor: "inherit", accentColor: "#1A4A7A" }} />
                    comparer
                  </label>
                  <button onClick={() => updateEnabled(comp, !enabled)}
                    style={{ width: 32, height: 18, borderRadius: 9, border: "none", cursor: "pointer", background: enabled ? "#1A3C2E" : "#CBD5E1", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                    <span style={{ position: "absolute", top: 1, left: enabled ? 15 : 1, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </button>
                  <select value={comp.category} onChange={e => updateCat(comp, e.target.value)}
                    style={{ fontSize: 10, padding: "2px 5px", border: `1px solid ${catDef.color}44`, borderRadius: 5, background: "#fff", color: catDef.color, fontWeight: 700, cursor: "pointer" }}>
                    {COMP_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  <button onClick={() => remove(comp.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#94A3B8", fontSize: 11 }}>✕</button>
                  </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {competitors.length === 0 && detectedNames.length === 0 && (
        <div style={{ fontSize: 12, color: "#94A3B8", fontStyle: "italic" }}>Interrogez des questions pour détecter les concurrents cités.</div>
      )}

      {/* ── Lot B1 : Comparaison approfondie ── */}
      {deepSelected.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "0.5px solid #1A3C2E14" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1A3C2E", marginBottom: 3, display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 15 }}>⚖️</span>Comparaison approfondie
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, marginBottom: 14, maxWidth: 680 }}>
            Comparaison de votre marque avec {deepSelected.length} concurrent{deepSelected.length > 1 ? "s" : ""} sélectionné{deepSelected.length > 1 ? "s" : ""}. Cochez à gauche de chaque ligne pour l'inclure dans l'audit (navigateur + exports). La cellule encadrée en vert est la meilleure valeur de la ligne. Utilisez « Importer » sous une colonne concurrent pour ajouter son crawl Screaming Frog ou ses exports Semrush.
          </div>
          <CompareTable
            columns={compareView.columns}
            data={compareView.data}
            includedRows={includedRows}
            onToggleRow={toggleRow}
            importStatus={compareView.importStatus}
            onImport={openImport}
            mode="edit"
          />
          {importTarget && (
            <ToolImportOverlay target={importTarget} tool={importTool} citedUrls={citedSet} onClose={() => setImportTarget(null)} onSubmit={submitImport} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Category Manager ─────────────────────────────────────────────

const CAT_COLORS = ["#2563EB","#059669","#7C3AED","#D97706","#DC2626","#0891B2","#EA580C","#64748B"];

function CategoryManager({ projectId, categories, setCategories, compact }) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(CAT_COLORS[0]);
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (!newName.trim()) return;
    try {
      const cat = await sbSaveCategory({ project_id: projectId, name: newName.trim(), color: newColor });
      setCategories(prev => [...prev, cat]);
      setNewName(""); setAdding(false);
    } catch(e) { console.error(e); }
  };

  const del = async (id) => {
    await sbDeleteCategory(id);
    setCategories(prev => prev.filter(c => c.id !== id));
  };

  if (compact) return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {categories.map(c => (
        <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: c.color + "18", color: c.color, border: `1px solid ${c.color}44` }}>
          {c.name}
          <button onClick={() => del(c.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: c.color, padding: 0, lineHeight: 1 }}>×</button>
        </span>
      ))}
      {adding ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {CAT_COLORS.map(col => (
            <button key={col} onClick={() => setNewColor(col)} style={{ width: 14, height: 14, borderRadius: "50%", background: col, border: `2px solid ${newColor === col ? "#000" : "transparent"}`, cursor: "pointer" }} />
          ))}
          <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} placeholder="Nom…" style={{ padding: "2px 6px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 11, width: 100 }} />
          <button onClick={add} style={{ padding: "2px 7px", borderRadius: 6, background: newColor, color: "#fff", border: "none", fontSize: 11, cursor: "pointer" }}>OK</button>
          <button onClick={() => setAdding(false)} style={{ padding: "2px 6px", borderRadius: 6, background: "#FAFAF8", border: "0.5px solid #1A3C2E0D", fontSize: 11, cursor: "pointer" }}>✕</button>
        </span>
      ) : (
        <button onClick={() => setAdding(true)} style={{ padding: "2px 8px", borderRadius: 12, fontSize: 11, background: "#FAFAF8", border: `1px dashed ${C.border}`, color: C.textLight, cursor: "pointer" }}>+ Catégorie</button>
      )}
    </div>
  );

  return null;
}

// ── Category selector dropdown ────────────────────────────────────

// ── Multi-tag selector ───────────────────────────────────────────
function TagSelect({ values = [], categories, onChange, placeholder = "Tags…" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const toggle = (id) => {
    const next = values.includes(id) ? values.filter(v => v !== id) : [...values, id];
    onChange(next);
  };
  const selected = categories.filter(c => values.includes(c.id));
  // Pilule harmonisee avec SiteMultiSelect (Marques) et IntentSelect (Intention) :
  // meme rayon, meme bordure, fond transparent a vide puis teinte a la selection.
  const label = selected.length === 0 ? placeholder
    : selected.length === 1 ? selected[0].name
    : `${selected.length} catégories`;
  const accent = selected[0]?.color || "#2563EB";
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen(o => !o)} title={placeholder.replace("…", "")}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
          border: `0.5px solid ${selected.length ? accent + "44" : "#1A3C2E18"}`, background: selected.length ? accent + "10" : "transparent", color: selected.length ? accent : "#94A3B8" }}>
        {selected.length > 0 && <span style={{ display: "inline-flex", gap: 2 }}>{selected.slice(0, 3).map(c => <span key={c.id} style={{ width: 7, height: 7, borderRadius: "50%", background: c.color || accent }} />)}</span>}
        {label}
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#fff", border: "0.5px solid #1A3C2E22", borderRadius: 8, boxShadow: "0 4px 16px rgba(26,60,46,0.12)", padding: 4, minWidth: 160 }}>
          {categories.length === 0
            ? <div style={{ fontSize: 11, color: C.textLight, padding: "4px 8px" }}>Aucune catégorie</div>
            : categories.map(c => (
              <div key={c.id} onClick={() => toggle(c.id)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer", background: values.includes(c.id) ? c.color + "18" : "transparent" }}>
                <div style={{ width: 14, height: 14, borderRadius: 4, border: `2px solid ${values.includes(c.id) ? c.color : C.border}`, background: values.includes(c.id) ? c.color : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {values.includes(c.id) && <span style={{ color: "#fff", fontSize: 9, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{ fontSize: 11, color: c.color, fontWeight: 600 }}>{c.name}</span>
              </div>
            ))
          }
          {selected.length > 0 && (
            <div onClick={() => onChange([])}
              style={{ marginTop: 4, padding: "4px 8px", fontSize: 10, color: C.textLight, cursor: "pointer", borderTop: `1px solid ${C.border}` }}>
              ✕ Tout retirer
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CatSelect({ value, categories, onChange, placeholder = "Catégorie…" }) {
  return (
    <select value={value || ""} onChange={e => onChange(e.target.value || null)}
      style={{ padding: "4px 8px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 11, color: C.text, background: "#fff", cursor: "pointer" }}>
      <option value="">{placeholder}</option>
      {(Array.isArray(categories) ? categories : []).filter(c => c.id && c.name).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

// Multi-select catégories (checkboxes + tout sélectionner/désélectionner), stylé comme .gt-select
function CatMultiSelect({ value = [], categories, onChange, placeholder = "Catégorie" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const cats = (Array.isArray(categories) ? categories : []).filter(c => c.id && c.name);
  const sel = Array.isArray(value) ? value : [];
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const allSelected = cats.length > 0 && sel.length === cats.length;
  const toggle = (id) => onChange(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const toggleAll = () => onChange(allSelected ? [] : cats.map(c => c.id));
  const label = sel.length === 0 ? placeholder
    : allSelected ? "Toutes catégories"
    : sel.length === 1 ? (cats.find(c => c.id === sel[0])?.name || "1 catégorie")
    : `${sel.length} catégories`;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="gt-select" onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, color: sel.length ? "#1A3C2E" : undefined }}>
        <span>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50, minWidth: 200, maxHeight: 280, overflowY: "auto", background: "#fff", border: "0.5px solid #1A3C2E22", borderRadius: 8, boxShadow: "0 4px 16px rgba(26,60,46,0.12)", padding: 4 }}>
          {cats.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "#1A3C2E77" }}>Aucune catégorie</div>
          ) : (
            <>
              <button type="button" onClick={toggleAll}
                style={{ width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 600, color: "#1A3C2E", background: "transparent", border: "none", borderBottom: "0.5px solid #1A3C2E11", cursor: "pointer", borderRadius: 4 }}>
                {allSelected ? "Tout désélectionner" : "Tout sélectionner"}
              </button>
              {cats.map(c => {
                const on = sel.includes(c.id);
                return (
                  <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontSize: 11, color: "#1A3C2E", cursor: "pointer", borderRadius: 4 }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.id)} style={{ cursor: "pointer", accentColor: "#1A3C2E" }} />
                    <span>{c.name}</span>
                  </label>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Keywords sub-tab (v2) ─────────────────────────────────────────

function KeywordsTab({ site, projectId, apiKey, model, axes, context, categories, setCategories, onAxesChange, onQuestionsGenerated, semrushKey = "", providerKeys = {} }) {
  const [keywords, setKeywords] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [busy, setBusy]         = useState({});
  const [runningAll, setRunningAll] = useState(false);
  const [selected, setSelected]   = useState(new Set());
  const [bulkCat, setBulkCat]     = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [filterSearch, setFilterSearch] = useState(""); // regex/text filter on keyword
  const stopRef = useRef(false);
  const [enriching, setEnriching] = useState(false);
  const [showAddKw, setShowAddKw]   = useState(false); // section « Ajouter » repliée si ≥1 mot-clé
  const [showVolModal, setShowVolModal] = useState(false); // modal d'enrichissement Semrush
  const [copiedKw, setCopiedKw]     = useState(false);
  const fileVolRef = useRef(null);

  useEffect(() => {
    if (!projectId || !site?.id) return;
    // Load keywords + count questions per keyword
    Promise.all([
      sbGetKeywords(projectId, site.id),
      sbGetQuestions(projectId, site.id),
    ]).then(([kws, qs]) => {
      const countByKw = {};
      qs.forEach(q => { if (q.keyword_id) countByKw[q.keyword_id] = (countByKw[q.keyword_id] || 0) + 1; });
      setKeywords(kws.map(k => ({ ...k, question_count: countByKw[k.id] || 0 })));
    });
  }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const addKeywords = async () => {
    const lines = input.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setLoading(true);
    try {
      const rows = lines.map(keyword => ({ project_id: projectId, site_id: site.id, keyword, status: "pending" }));
      const saved = await sbSaveKeywords(rows);
      setKeywords(prev => [...saved, ...prev]);
      setInput("");
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  // Import CSV: col1=keyword, col2=category name
  const importCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const rows = parseCSV(ev.target.result).filter(r => r[0]);
      const toAdd = [];
      for (const [keyword, catName] of rows) {
        const cat = catName ? categories.find(c => c.name.toLowerCase() === catName.toLowerCase()) : null;
        toAdd.push({ project_id: projectId, site_id: site.id, keyword, status: "pending", ...(cat ? { category_id: cat.id } : {}) });
      }
      if (!toAdd.length) return;
      const saved = await sbSaveKeywords(toAdd);
      setKeywords(prev => [...saved, ...prev]);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Volume enrichment from Semrush API ──────────────────────
  const enrichFromApi = async () => {
    if (!semrushKey || !keywords.length) return;
    setEnriching(true);
    const batch = keywords.slice(0, 100);
    try {
      const res = await fetch("/api/semrush-volume", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Semrush-Key": semrushKey },
        body: JSON.stringify({ keywords: batch.map(k => k.keyword), database: "fr" }),
      });
      const data = await res.json();
      if (data.error) { alert("Erreur Semrush : " + data.error); return; }
      const vols = data.volumes || {};
      for (const kw of batch) {
        const vol = vols[kw.keyword.toLowerCase()];
        if (vol !== undefined) {
          await sbUpdateKeywordVolume(kw.id, vol, "semrush_api");
          setKeywords(prev => prev.map(k => k.id === kw.id ? { ...k, search_volume: vol, volume_source: "semrush_api" } : k));
        }
      }
    } catch(e) { alert("Erreur : " + e.message); }
    setEnriching(false);
  };

  // ── Volume enrichment from Semrush CSV ───────────────────────
  const enrichFromCsv = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target.result;
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) return;
      const header = lines[0].split(";").map(h => h.toLowerCase().replace(/"/g, "").trim());
      const kwIdx  = header.findIndex(h => h === "keyword" || h === "mot-clé" || h.startsWith("keyword"));
      const volIdx = header.findIndex(h => h === "volume" || h.includes("volume"));
      if (kwIdx === -1 || volIdx === -1) {
        alert("Colonnes non trouvées. Le CSV doit avoir des colonnes 'Keyword' et 'Volume'.");
        return;
      }
      const volMap = {};
      for (const line of lines.slice(1)) {
        const cols = line.split(";").map(c => c.replace(/"/g, "").trim());
        const kw  = cols[kwIdx]?.toLowerCase();
        const vol = parseInt(cols[volIdx], 10);
        if (kw && !isNaN(vol)) volMap[kw] = vol;
      }
      let updated = 0;
      for (const kw of keywords) {
        const vol = volMap[kw.keyword.toLowerCase()];
        if (vol !== undefined) {
          await sbUpdateKeywordVolume(kw.id, vol, "semrush_csv");
          setKeywords(prev => prev.map(k => k.id === kw.id ? { ...k, search_volume: vol, volume_source: "semrush_csv" } : k));
          updated++;
        }
      }
      alert(`${updated} mot${updated > 1 ? "s-clés" : "-clé"} enrichi${updated > 1 ? "s" : ""} depuis le CSV.`);
      if (fileVolRef.current) fileVolRef.current.value = "";
    };
    reader.readAsText(file, "UTF-8");
  };

  const generateQuestions = async (kw, axes) => {
    // Use providerKeys.openai first (set via UI), fallback to legacy apiKey prop
    const resolvedKey = providerKeys?.openai?.dec || apiKey;
    if (!resolvedKey) return;
    setBusy(b => ({ ...b, [kw.id]: "q" }));
    await sbUpdateKeywordStatus(kw.id, "generating_q");
    setKeywords(prev => prev.map(k => k.id === kw.id ? { ...k, status: "generating_q" } : k));
    try {
      const activeAxes = (axes && axes.length ? axes : DEFAULT_AXES);
      const numQ = activeAxes.length;
      const axesWithInstructions = activeAxes.map((axe, i) => `${i+1}. [${axe}]`).join("\n");
      const prompt = `Tu es un expert GEO. Pour le mot-clé "${kw.keyword}", génère exactement ${numQ} questions de recherche — une par axe ci-dessous.

OBJECTIF : chaque question doit naturellement amener un moteur IA (ChatGPT, Gemini, Perplexity) à citer des noms de marques, d'enseignes, de sites ou d'entreprises concrètes — jamais une réponse générique ou des conseils.

TERMINOLOGIE : adapte au contexte du mot-clé :
- Commerce / retail → privilégie "magasins", "enseignes", "boutiques"
- Services / B2B → privilégie "entreprises", "prestataires", "agences"
- E-commerce / web → privilégie "sites", "plateformes", "marques"
- Mixte → utilise le terme le plus naturel pour ce secteur

RÈGLE sur les axes :
- Chaque axe définit l'angle de la question, pas son sujet
- La réponse attendue doit toujours être une liste de noms (marques, sites, entreprises)
- "Alternative / pistes" = qui propose ce produit/service — PAS quoi remplace ce produit

AXES À TRAITER :
${axesWithInstructions}

CONTRAINTES :
- Une question par axe, dans l'ordre
- Maximum 12 mots par question
- Commence par "Quelles", "Quel", "Qui", "Lesquels" de préférence
- Ton naturel, comme une vraie requête de recherche

Réponds UNIQUEMENT avec les ${numQ} questions séparées par des points-virgules (;), sans numérotation, sans texte avant ou après.`;

      // Direct fetch — plain text, no json_object format
      const res = await fetch("/api/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Openai-Key": resolvedKey, "X-Openai-Endpoint": "completions" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 400 }),
      });
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error("Proxy /api/openai introuvable — copiez openai-proxy.js dans netlify/edge-functions/");
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Réponse non-JSON (${res.status}): ${text.slice(0,100)}`); }
      if (!res.ok) {
        const msg = data?.error?.message || data?.error || text.slice(0, 200);
        throw new Error(`OpenAI ${res.status}: ${msg}`);
      }

      const raw = (data?.choices?.[0]?.message?.content || "").trim();
      if (!raw) throw new Error(`Réponse vide. Data reçue: ${JSON.stringify(data).slice(0, 200)}`);

      const questions = raw
        .split(/[;\n]/)
        .map(s => s.replace(/^\s*\d+[.)\s]+/, "").trim())
        .filter(s => s.length > 5 && s.length < 250);

      if (!questions.length) throw new Error(`Parsing échoué. Reçu: "${raw.slice(0, 100)}"`);

      // Save — strip category_id if column not migrated yet
      const baseRow = (q) => ({ project_id: projectId, site_id: site.id, keyword_id: kw.id, question: q, is_manual: false });
      let saved;
      try {
        const qRows = questions.map(q => kw.category_id ? { ...baseRow(q), category_id: kw.category_id } : baseRow(q));
        saved = await sbSaveQuestions(qRows);
      } catch(saveErr) {
        console.warn("Retry without category_id:", saveErr.message);
        saved = await sbSaveQuestions(questions.map(baseRow));
      }
      const savedCount = Array.isArray(saved) ? saved.length : questions.length;
      console.log(`✓ ${savedCount} questions saved for "${kw.keyword}"`);

      await sbUpdateKeywordStatus(kw.id, "done_q");
      setKeywords(prev => prev.map(k => k.id === kw.id
        ? { ...k, status: "done_q", question_count: (k.question_count || 0) + savedCount }
        : k
      ));
      onQuestionsGenerated?.(false);
    } catch(e) {
      console.error("generateQuestions error:", e);
      await sbUpdateKeywordStatus(kw.id, "error");
      setKeywords(prev => prev.map(k => k.id === kw.id ? { ...k, status: "error", error_msg: e.message } : k));
    }
    setBusy(b => ({ ...b, [kw.id]: false }));
  };

  const deleteKw = async (id) => {
    await sbDeleteKeyword(id);
    setKeywords(prev => prev.filter(k => k.id !== id));
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
  };

  const generateAll = async () => {
    if (!apiKey) { setKeywords(prev => prev); return; } // apiKey missing shown in UI
    const toProcess = keywords.filter(kw => kw.status === "pending" || kw.status === "error");
    if (!toProcess.length) return;
    setRunningAll(true);
    stopRef.current = false;
    for (const kw of toProcess) {
      if (stopRef.current) break;
      await generateQuestions(kw, null);
    }
    setRunningAll(false);
    onQuestionsGenerated?.(true);
  };

  const toggleSelect = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());

  const applyBulkCat = async () => {
    if (!bulkCat || !selected.size) return;
    const ids = [...selected];
    await sbBulkSetKeywordCategory(ids, bulkCat || null);
    setKeywords(prev => prev.map(k => selected.has(k.id) ? { ...k, category_id: bulkCat || null } : k));
    clearSel(); setBulkCat("");
  };

  const bulkGenerate = async () => {
    const resolvedKey = providerKeys?.openai?.dec || apiKey;
    if (!selected.size || !resolvedKey) return;
    const toProcess = keywords.filter(k => selected.has(k.id));
    setRunningAll(true);
    stopRef.current = false;
    for (const kw of toProcess) {
      if (stopRef.current) break;
      await generateQuestions(kw, null);
    }
    setRunningAll(false);
    onQuestionsGenerated?.(true);
  };

  const bulkDelete = async () => {
    if (!selected.size) return;
    const ids = [...selected];
    await Promise.all(ids.map(id => sbDeleteKeyword(id)));
    setKeywords(prev => prev.filter(k => !selected.has(k.id)));
    clearSel();
  };

  const setTagsSingle = async (kwId, tags) => {
    await sbSetKeywordTags(kwId, tags);
    setKeywords(prev => prev.map(k => k.id === kwId ? { ...k, tags: tags || [] } : k));
  };

  const filtered = useMemo(() => {
    let kws = keywords;
    if (filterCat) kws = kws.filter(k => (k.tags || (k.category_id ? [k.category_id] : [])).includes(filterCat));
    if (filterSearch.trim()) {
      try {
        const rx = new RegExp(filterSearch.trim(), "i");
        kws = kws.filter(k => rx.test(k.keyword));
      } catch {
        kws = kws.filter(k => k.keyword.toLowerCase().includes(filterSearch.trim().toLowerCase()));
      }
    }
    return kws;
  }, [keywords, filterCat, filterSearch]);


  return (
    <div>
      {/* ── Volume enrichment toolbar ── */}
      {keywords.length > 0 && (
        <div className="geo-volume-toolbar" style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#1D4ED8" }}>🔍 Volumes de recherche</span>
          <span style={{ fontSize: 11, color: "#3B82F6" }}>
            {keywords.filter(k => k.search_volume != null).length}/{keywords.length} enrichis
          </span>
          <div className="geo-volume-toolbar-actions" style={{ gap: 6 }}>
            <input ref={fileVolRef} type="file" accept=".csv" style={{ display: "none" }} onChange={enrichFromCsv} />
            <button onClick={() => setShowVolModal(true)}
              style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", border: "1px solid #BFDBFE", borderRadius: 7, background: "#fff", color: "#2563EB", cursor: "pointer" }}>
              🔍 Enrichir avec des volumes de recherche
            </button>
            <button onClick={enrichFromApi} disabled={enriching || !semrushKey}
              title={!semrushKey ? "Clé API Semrush non configurée — ajoutez-la dans ⚙️ Gestion des Providers" : "Récupérer les volumes depuis l'API Semrush (1 crédit/mot-clé)"}
              style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", border: "1px solid #BFDBFE", borderRadius: 7, background: semrushKey ? "#2563EB" : C.bg, color: semrushKey ? "#fff" : C.textLight, cursor: semrushKey ? "pointer" : "not-allowed", opacity: semrushKey ? 1 : 0.6 }}>
              {enriching ? "⏳ Enrichissement…" : "⚡ API Semrush"}
            </button>
          </div>
        </div>
      )}

      {/* Input + CSV import — masqué si des mots-clés existent déjà (toggle « Ajouter des mots-clés ») */}
      {(keywords.length === 0 || showAddKw) && (
      <div style={{ background: "#fff", border: "0.5px solid #1A3C2E0D", borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>Ajouter des mots-clés (un par ligne)</div>
            <textarea value={input} onChange={e => setInput(e.target.value)}
              placeholder={"Mot clé 1\nMot clé 2\nMot clé 3"}
              style={{ width: "100%", minHeight: 90, padding: "8px 12px", border: "0.5px solid #1A3C2E0D", borderRadius: 8, fontSize: 12, color: C.text, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <Btn onClick={addKeywords} disabled={loading || !input.trim()}>{loading ? "Ajout…" : "➕ Ajouter"}</Btn>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 22 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "0.5px solid #1A3C2E0D", borderRadius: 8, fontSize: 12, fontWeight: 600, color: C.textMid, cursor: "pointer", background: C.white }}>
              📥 Importer CSV
              <input type="file" accept=".csv,.txt" onChange={importCSV} style={{ display: "none" }} />
            </label>
            <div style={{ fontSize: 10, color: C.textLight }}>Col. 1 = mot-clé<br />Col. 2 = catégorie (optionnel)</div>
          </div>
        </div>
      </div>
      )}

      {/* Categories */}
      <div style={{ background: "#fff", border: "0.5px solid #1A3C2E0D", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.textMid, marginBottom: 8 }}>Catégories du projet</div>
        <CategoryManager projectId={projectId} categories={categories} setCategories={setCategories} compact />
      </div>

      {/* Bulk bar + filters */}
      {keywords.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {/* Row 1: stats + search/regex + category filter */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.textLight, flexShrink: 0 }}>
              {filtered.length} mot{filtered.length > 1 ? "s-clés" : "-clé"}
              {" · "}<span style={{ color: "#059669", fontWeight: 600 }}>{filtered.filter(k => k.status === "done_q" || k.status === "done").length} générés</span>
              {" · "}{filtered.reduce((s, k) => s + (k.question_count || 0), 0)} question{filtered.reduce((s, k) => s + (k.question_count || 0), 0) > 1 ? "s" : ""}
              {selected.size > 0 && <strong style={{ color: C.text }}> · {selected.size} sélectionné{selected.size > 1 ? "s" : ""}</strong>}
            </span>

            {/* Regex search */}
            <input
              value={filterSearch}
              onChange={e => { setFilterSearch(e.target.value); setSelected(new Set()); }}
              placeholder="Filtrer par regex ou texte…"
              style={{ flex: 1, minWidth: 160, padding: "4px 10px", border: `1px solid ${filterSearch ? "#7C3AED" : C.border}`, borderRadius: 7, fontSize: 11, color: C.text }}
            />
            {filterSearch && (
              <button onClick={() => setFilterSearch("")} style={{ fontSize: 11, padding: "3px 8px", border: "0.5px solid #1A3C2E0D", borderRadius: 5, background: "#fff", cursor: "pointer", color: C.textMid }}>✕</button>
            )}

            {/* Filter by category */}
            <CatSelect value={filterCat} categories={categories} onChange={v => { setFilterCat(v || ""); setSelected(new Set()); }} placeholder="Toutes catégories" />
          </div>

          {/* Row 2: select all + bulk actions */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {/* Select all filtered */}
            <input
              type="checkbox"
              checked={filtered.length > 0 && filtered.every(k => selected.has(k.id))}
              onChange={e => e.target.checked ? setSelected(new Set(filtered.map(k => k.id))) : clearSel()}
              title="Tout sélectionner / désélectionner"
              style={{ cursor: "pointer", width: 14, height: 14 }}
            />
            <span style={{ fontSize: 11, color: C.textLight }}>
              {selected.size > 0 ? `${selected.size} sélectionné${selected.size > 1 ? "s" : ""}` : "Tout sélectionner"}
            </span>

            {selected.size > 0 && (
              <>
                <div style={{ width: 1, height: 14, background: C.border, margin: "0 2px" }} />
                {/* Bulk categorize */}
                <CatSelect value={bulkCat} categories={categories} onChange={setBulkCat} placeholder="Catégorie…" />
                {bulkCat && <Btn onClick={applyBulkCat} disabled={!bulkCat} small color="#7C3AED">Appliquer</Btn>}
                {/* Bulk generate */}
                <Btn onClick={bulkGenerate} disabled={runningAll || !apiKey} small color={site.color}
                  title={!apiKey ? "Clé OpenAI manquante — ajoutez-la dans ⚙️ Gestion des Providers" : `Générer les questions pour ${selected.size} mot${selected.size > 1 ? "s-clés" : "-clé"}`}>
                  💬 Générer ({selected.size})
                </Btn>
                {/* Bulk delete */}
                <Btn onClick={bulkDelete} small color="#DC2626" variant="outline"
                  title={`Supprimer ${selected.size} mot${selected.size > 1 ? "s-clés" : "-clé"}`}>
                  🗑 Supprimer ({selected.size})
                </Btn>
              </>
            )}

            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Btn onClick={() => setShowAddKw(v => !v)} variant="outline" small color={site.color}>
                {showAddKw ? "✕ Fermer l'ajout" : "➕ Ajouter des mots-clés"}
              </Btn>
              {runningAll && <Btn onClick={() => { stopRef.current = true; setRunningAll(false); }} color="#DC2626" variant="outline" small>⏹ Arrêter</Btn>}
            <Btn onClick={generateAll} disabled={runningAll || (!apiKey && !providerKeys?.openai?.dec)} color={site.color} small
              title={(!apiKey && !providerKeys?.openai?.dec) ? "Clé OpenAI manquante — ajoutez-la dans ⚙️ Gestion des Providers (en haut de page)" : undefined}>
              {runningAll ? "⏳ Génération en cours…" : "💬 Générer toutes les questions"}
            </Btn>
          </div>
          </div>
        </div>
      )}

      {/* Keywords list */}
      {filtered.length === 0 ? (
        keywords.length === 0 ? (
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "20px 24px", marginTop: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#92400E", marginBottom: 10 }}>⚠️ Aucun mot-clé ajouté</div>
            <div style={{ fontSize: 12, color: "#78350F", lineHeight: 1.6, marginBottom: 14 }}>Ajoutez vos mots-clés ci-dessus, puis configurez :</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ background: "#fff", border: "2px solid #F59E0B", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>⚙️</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>Gestion des Providers</div>
                  <div style={{ fontSize: 11, color: "#B45309" }}>Ajoutez vos clés API dans <strong>⚙️ Gestion des Providers</strong> en haut de l'onglet</div>
                </div>
              </div>
              <div style={{ background: "#fff", border: "2px solid #F59E0B", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>🏷️</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>Setup de la marque</div>
                  <div style={{ fontSize: 11, color: "#B45309" }}>Renseignez votre marque et vos concurrents dans la <strong>carte du site</strong> ci-dessus</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: 40, color: C.textLight, fontSize: 12 }}>
            Aucun mot-clé dans cette catégorie
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {filtered.map(kw => {
            const isSel = selected.has(kw.id);
            return (
              <div key={kw.id} className={`gt-item${isSel ? " gt-item--selected" : ""}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" checked={isSel} onChange={() => toggleSelect(kw.id)} style={{ cursor: "pointer", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{kw.keyword}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 3, alignItems: "center", flexWrap: "wrap" }}>
                    <StatusBadge status={kw.status} />
                    {kw.search_volume > 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#2563EB", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "1px 8px" }}
                        title={`Volume de recherche mensuel${kw.volume_source ? " (" + kw.volume_source + ")" : ""}`}>
                        🔍 {kw.search_volume >= 1000 ? (kw.search_volume / 1000).toFixed(1) + "k" : kw.search_volume}
                      </span>
                    )}
                    {kw.error_msg && (
                      <span style={{ fontSize: 10, color: "#DC2626", fontStyle: "italic", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={kw.error_msg}>
                        {kw.error_msg}
                      </span>
                    )}
                    {kw.question_count > 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#059669", background: "#ECFDF5", border: "1px solid #059669", borderRadius: 10, padding: "1px 8px" }}>
                        {kw.question_count} question{kw.question_count > 1 ? "s" : ""}
                      </span>
                    )}
                    {(kw.tags || (kw.category_id ? [kw.category_id] : [])).map(tagId => {
                      const tagCat = categories.find(c => c.id === tagId);
                      return tagCat ? (
                        <span key={tagId} style={{ fontSize: 10, fontWeight: 700, color: tagCat.color, background: tagCat.color + "18", border: `1px solid ${tagCat.color}44`, borderRadius: 10, padding: "1px 7px" }}>{tagCat.name}</span>
                      ) : null;
                    })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                  <TagSelect values={kw.tags || (kw.category_id ? [kw.category_id] : [])} categories={categories} onChange={tags => setTagsSingle(kw.id, tags)} />
                  <button onClick={() => generateQuestions(kw, null)} disabled={!!busy[kw.id] || (!apiKey && !providerKeys?.openai?.dec)}
                    style={{ padding: "4px 12px", border: "0.5px solid #1A3C2E22", borderRadius: 20, background: "transparent", color: "#1A3C2E", fontSize: 11, fontWeight: 500, cursor: (!!busy[kw.id] || (!apiKey && !providerKeys?.openai?.dec)) ? "not-allowed" : "pointer", opacity: (!!busy[kw.id] || (!apiKey && !providerKeys?.openai?.dec)) ? 0.35 : 1, letterSpacing: "0.01em", transition: "opacity 0.2s" }}
                    title={(!apiKey && !providerKeys?.openai?.dec) ? "Clé OpenAI manquante" : undefined}>
                    {busy[kw.id] === "q" ? "…" : kw.status === "done_q" ? "↺" : "▶"}
                  </button>
                  <button onClick={() => deleteKw(kw.id)} style={{ padding: "3px 8px", border: "none", background: "transparent", color: "#1A3C2E", fontSize: 12, cursor: "pointer", transition: "color 0.15s" }}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Modal : enrichissement volumes de recherche (CSV Semrush) ── */}
      {showVolModal && (
        <div onClick={() => setShowVolModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(26,60,46,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 14, padding: "24px 26px", maxWidth: 520, width: "100%", boxShadow: "0 12px 40px rgba(0,0,0,0.2)", maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#1A3C2E" }}>🔍 Enrichir avec des volumes de recherche</div>
              <button onClick={() => setShowVolModal(false)} style={{ background: "none", border: "none", fontSize: 18, color: "#1A3C2E", cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: "#1A3C2E", lineHeight: 1.55, marginBottom: 16 }}>
              Importez un fichier de suivi de mots-clés Semrush au format <strong>.csv</strong> pour ajouter les volumes de recherche à vos mots-clés.
            </div>

            <div style={{ background: "#F8F7F4", border: "0.5px solid #1A3C2E14", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1A3C2E", marginBottom: 8 }}>1. Copiez votre liste de mots-clés</div>
              <button onClick={() => { navigator.clipboard?.writeText(keywords.map(k => k.keyword).join("\n")); setCopiedKw(true); setTimeout(() => setCopiedKw(false), 2000); }}
                style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", border: "1px solid #1A3C2E", borderRadius: 8, background: copiedKw ? "#1A3C2E" : "#fff", color: copiedKw ? "#F0EBE0" : "#1A3C2E", cursor: "pointer" }}>
                {copiedKw ? "✓ Copié" : `📋 Copier les ${keywords.length} mots-clés`}
              </button>
            </div>

            <div style={{ fontSize: 12.5, color: "#1A3C2E", lineHeight: 1.6, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>2. Récupérez le CSV depuis Semrush</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                <li>Dans Semrush, ouvrez <strong>Keyword Overview</strong> (Vue d'ensemble des mots-clés) en mode analyse groupée.</li>
                <li>Collez la liste, choisissez le pays / la langue, puis lancez l'analyse.</li>
                <li>Cliquez sur <strong>Export</strong> et choisissez le format <strong>CSV</strong>.</li>
              </ol>
              <div style={{ fontSize: 11, color: "#8A8A82", marginTop: 6 }}>Le fichier doit contenir une colonne « Keyword » et une colonne « Volume ».</div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", borderTop: "0.5px solid #1A3C2E11", paddingTop: 14 }}>
              <button onClick={() => setShowVolModal(false)} style={{ fontSize: 12, padding: "8px 14px", border: "0.5px solid #1A3C2E22", borderRadius: 8, background: "transparent", color: "#1A3C2E", cursor: "pointer" }}>Annuler</button>
              <button onClick={() => { fileVolRef.current?.click(); setShowVolModal(false); }}
                style={{ fontSize: 12, fontWeight: 600, padding: "8px 16px", border: "none", borderRadius: 8, background: "#2563EB", color: "#fff", cursor: "pointer" }}>
                📄 Importer le fichier .csv
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 30-day presence calendar ─────────────────────────────────────


function isBrandPresent(r) {
  return !!r && (r.brand_mentioned === true || r.brand_mentioned === 1);
}




// history: [{ test_date: "YYYY-MM-DD", brand_mentioned: bool }]
// results: current geo_results for this provider (for today's optimistic update)

// ── HintPanelQuestion — one hint per question ────────────────────
function HintPanelQuestion({ questionId, question, sources, brandName, brandAliases, brandDomain, claudeKey, hasBrand, projectId, siteId, savedHint, savedHintDate = null, onHintSaved, initialOpen = false }) {
  const [open, setOpen]     = useState(false); // always start closed
  const [status, setStatus] = useState(savedHint ? "done" : "idle");
  const [hint, setHint]     = useState(savedHint || "");
  const hasHint = !!hint;

  const run = async () => {
    if (!claudeKey) return;
    setStatus("loading");
    const bDomain = brandDomain || brandName;
    const sourcesText = (Array.isArray(sources) ? sources : []).length > 0
      ? "Pages dans la réponse :\n" + sources.slice(0, 6).map((u, i) => `[${i+1}] ${u}`).join("\n")
      : "Aucune source listée.";
    const brandContext = hasBrand
      ? `La marque est DÉJÀ présente. Objectif : RENFORCER cette présence sur ${bDomain}.`
      : `La marque est ABSENTE. Objectif : la faire apparaître.`;
    const prompt = [
      `Tu es un expert GEO (Generative Engine Optimization). Un moteur d'IA a répondu à cette question sans mettre en avant "${brandName}" :`,
      `"${question}"`,
      "",
      sourcesText,
      "",
      "UTILISE LA RECHERCHE WEB pour :",
      `1. Vérifier si une page pertinente existe DÉJÀ sur le site via une recherche "site:${bDomain} <sujet de la question>". Conclus clairement : page existante (donne l'URL exacte) ou aucune page.`,
      "2. Regarder ce que contiennent les pages réellement citées par l'IA sur cette requête (format, angle), pour t'en inspirer.",
      "",
      brandContext,
      "",
      "REGLES STRICTES :",
      "- Ne décris PAS ta recherche, ne mets pas d'introduction. Donne directement le résultat.",
      "- Réponds en 3 lignes EXACTEMENT, préfixées ainsi :",
      "  • Diagnostic : pourquoi la marque n'est pas (assez) citée ici (1 phrase).",
      `  • Page : soit "Optimiser <URL existante vérifiée>", soit "Créer /<slug-suggéré> (H1 : <titre>)" si aucune page ne couvre le sujet.`,
      "  • Contenu : le format à adopter (liste, comparatif, tableau, FAQ…) + 2 éléments concrets à inclure (entités, chiffres, sections).",
    ].join("\n");

    try {
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({
          model: RECO_MODEL_LIGHT,
          max_tokens: 900,
          tools: [webSearchTool(3)],
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const raw = await res.text();
      const data = JSON.parse(raw);
      if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
      const text = claudeFinalText(data.content);
      const cleaned = text
        .replace(/^(Je vais|En effectuant|Je recherche|Voici|Permettez)[^\n]*/gim, "")
        .replace(/^\s*\n/gm, "")
        .trim();
      const finalHint = cleaned || "Aucune recommandation générée.";
      setHint(finalHint);
      setStatus("done");
      setOpen(true);
      onHintSaved?.(finalHint);
      if (questionId && projectId && siteId) {
        sbSaveHint(questionId, siteId, projectId, finalHint).catch(e =>
          console.warn("[Hint] save failed:", e.message)
        );
      }
    } catch(e) {
      setHint(`Erreur : ${e.message}`);
      setStatus("error");
      setOpen(true);
    }
  };

  return (
    <div style={{ borderRadius: 0, overflow: "hidden", border: "none", borderTop: "0.5px solid #1A3C2E08" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", background: "transparent", cursor: "pointer" }}
        onClick={() => hasHint ? setOpen(o => !o) : (!status.includes("loading") && run())}>
        <span style={{ fontSize: 14 }}>💡</span>
        {status === "loading" ? (
          <span style={{ fontSize: 11, color: "#D97706" }}>⏳ Génération de la recommandation…</span>
        ) : hasHint ? (
          <>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#D97706", flex: 1 }}>
              {open ? "▲ Masquer la recommandation" : "▼ Voir la recommandation"}
            </span>
            {savedHintDate && (
              <span style={{ fontSize: 10, color: "#B45309" }}>
                {new Date(savedHintDate).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setStatus("idle"); setHint(""); setOpen(false); setTimeout(run, 0); }}
              style={{ fontSize: 10, color: C.textLight, background: "none", border: "none", cursor: "pointer" }}>
              ↺
            </button>
          </>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 700, color: "#D97706" }}>✨ Générer une recommandation</span>
        )}
      </div>
      {open && hint && (
        <div style={{ padding: "10px 0 4px 0", background: "transparent" }}>
          {(savedHintDate || status === "done") && (
            <div style={{ fontSize: 10, color: "#B45309", marginBottom: 6 }}>
              🕐 {savedHintDate ? new Date(savedHintDate).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : new Date().toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          <div style={{ fontSize: 11, lineHeight: 1.7, color: status === "error" ? "#DC2626" : "#92400E" }}>
            {status === "error" ? hint : renderMarkdown(hint)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ProviderRow — calendar + info + accordion + run button ────────

function ProviderRow({ provider, results, brandName, brandAliases, brandDomain = "", hasKey, isRunning, onRun, questionId, newCalEntry = null, question = "", claudeKey = "", projectId = null, siteId = null, savedHint = "", brandTerms = [], competitorMap = {}, lastCalDate = null, isReadOnly = false, errorMsg = null, external = false, onEnqueue = null, queued = false, onCancelQueue = null, brandSites = [], singleSiteProject = false, calResults = null }) {
  // Carrés reconstruits depuis les résultats (persistants) → survivent au rechargement.
  const calSeed = resultsToCalEntries(calResults || results, getProviderId);
  const [open, setOpen] = useState(false);
  const p = provider;

  // Réponse affichée : résultats du provider ; repli sur calResults (tous sites)
  // pour que la réponse et la recommandation restent visibles même si la marque
  // sous laquelle la question a été lancée n'est pas dans la sélection courante.
  const _answerSrc = (results && results.length) ? results : (calResults || []);
  const result = [...(_answerSrc || [])].sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0))[0] || null;
  const sources = result?.sources || [];
  const comps   = result?.competitors_mentioned || [];

  const displayDate = result?.created_at || lastCalDate || null;

  return (
    <div>
      {/* ── Ligne provider ── */}
      <div className="gt-provider-row">

        {/* Nom */}
        <span className="gt-provider-name">{p.label}</span>

        {/* Calendrier inline : projet mono-site (legacy, sans filtre) OU une seule
            marque sélectionnée (filtrée). Multi-marques → rendu SOUS la ligne. */}
        {(singleSiteProject || brandSites.length <= 1) && (
          <PresenceCalendar questionId={questionId} providers={[provider]} newEntry={newCalEntry} errorMsg={errorMsg}
            siteId={singleSiteProject ? null : (brandSites[0]?.id || null)} seedEntries={calSeed} hideProviderLabel />
        )}

        {/* Présence — 3 types calculés depuis les champs DB ─────── */}
        {(() => {
          if (!result) return null;
          // Champs nouveaux (post-migration)
          const mentionPos   = result.brand_mention_position;
          const evocPos      = result.brand_evocation_position;
          const citationPos  = result.brand_citation_position;
          // Rétrocompat champs anciens
          const hasMention   = mentionPos != null || (result.brand_position != null && result.brand_position > 0);
          const hasEvocation = evocPos != null || (
            (result.brand_mentioned === true || result.brand_mentioned === 1) && !hasMention
          );
          const hasCitation  = citationPos != null || result.brand_in_sources;
          const topPos       = mentionPos || result.brand_position;
          return (<>
            {hasMention && (
              <span className="gt-provider-status gt-success" title={`Mention dans le Top${topPos ? ` — position #${topPos}` : ""}`}>
                {topPos ? `Top #${topPos}` : "Top"}
              </span>
            )}
            {!hasMention && hasEvocation && (
              <span className="gt-provider-status gt-warn" title="Évocation dans le texte">
                évoc.
              </span>
            )}
            {hasCitation && (
              <span className="gt-provider-status gt-dimmed" title={`Cité en source${citationPos ? ` — position #${citationPos}` : ""}`}>
                {citationPos ? `src #${citationPos}` : "src"}
              </span>
            )}
          </>);
        })()}

        {/* Bouton voir réponse */}
        {result && (
          <button className="gt-provider-toggle" onClick={() => setOpen(o => !o)}>
            {open ? "▲" : "Réponse ▾"}
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* Pastille bleue discrète — recherche web effectuée */}
        {result && (result.web_searches > 0) && (
          <span title="Réponse générée avec recherche web"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 600, color: "#1A4A7A", background: "#1A4A7A12", border: "0.5px solid #1A4A7A30", borderRadius: 999, padding: "1px 7px", letterSpacing: 0.2, whiteSpace: "nowrap" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#1A4A7A", flexShrink: 0 }} />web
          </span>
        )}

        {/* Date et tokens — méta discrète */}
        {displayDate && (
          <span className="gt-mono">
            {new Date(displayDate).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}
          </span>
        )}
        {result && (
          <span className="gt-mono">{(result.input_tokens||0)+(result.output_tokens||0)} tok</span>
        )}

        {/* Message d'erreur provider */}
        {errorMsg && (
          <span style={{ fontSize: 10, color: "#C0352A", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={errorMsg}>
            ⚠ {errorMsg.slice(0, 60)}{errorMsg.length > 60 ? "…" : ""}
          </span>
        )}
        {/* Provider externe (AI Overview) : ▶ met la question en file pour le scraper local */}
        {external ? (
          isReadOnly ? null : queued ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#C97820", fontStyle: "italic" }} title="En attente du scraper local (lancez-le en mode veille). Retour auto à ▶ après 1 min.">en attente…</span>
              <button onClick={onCancelQueue} title="Annuler la demande"
                style={{ border: "none", background: "transparent", color: "#C9782099", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
            </span>
          ) : (
            <button className="gt-provider-run" onClick={onEnqueue} title={`Lancer ${p.label} (via le scraper local)`}>▶</button>
          )
        ) : hasKey && !isReadOnly && (
          <button
            className="gt-provider-run"
            onClick={onRun}
            disabled={isRunning || !hasKey}
            title={`Interroger ${p.label}`}
          >
            {isRunning ? "·" : "▶"}
          </button>
        )}
      </div>

      {/* Marques concernées (multi) : une ligne de suivi par marque SÉLECTIONNÉE,
          SOUS le provider. Jamais pour un projet mono-site (#4). */}
      {!singleSiteProject && brandSites.length > 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 12, marginTop: 1, marginBottom: 4 }}>
          {brandSites.map(bs => (
            <div key={bs.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 74, flexShrink: 0, fontSize: 9.5, fontWeight: 600, color: bs.color || "#94A3B8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={bs.label}>{bs.label}</span>
              <PresenceCalendar questionId={questionId} providers={[provider]} newEntry={newCalEntry} errorMsg={errorMsg} siteId={bs.id} alwaysShow hideProviderLabel seedEntries={calSeed} />
            </div>
          ))}
        </div>
      )}

      {/* ── Accordéon réponse ── */}
      {open && result && (
        <div className="gt-provider-answer">
          <ChatAnswer
            providerId={getProviderId(result.model || p.label)}
            modelLabel={result.model || p.label}
            answerNode={renderMarkdown(result.answer || "")}
          />
          {sources.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="gt-label" style={{ marginBottom: 6 }}>Sources</div>
              {sources.map((url, i) => {
                const ib = [brandName, ...(brandAliases||[])].some(t => url.toLowerCase().includes((t||"").toLowerCase()));
                return (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 5, marginBottom: 4, minWidth: 0 }}>
                    <span className="gt-caption" style={{ minWidth: 18, flexShrink: 0, paddingTop: 1 }}>[{i+1}]</span>
                    <a href={url} target="_blank" rel="noreferrer"
                      style={{ fontSize: 11, color: ib ? "#1A7A4A" : "#1A3C2E", wordBreak: "break-all", flex: 1, minWidth: 0 }}>
                      {stripQuery(url)}
                    </a>
                    </div>
                );
              })}
            </div>
          )}
          {comps.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="gt-label" style={{ marginBottom: 6 }}>Concurrents</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {comps.map(c => (
                  <span key={c.name} className="gt-badge gt-badge--warn">
                    {c.name}{c.position ? ` #${c.position}` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}




// ── NextStepsAnalysis — "Et maintenant ?" ────────────────────────
// Analyse multi-niveaux produisant des recommandations actionnables :
//  1. Analyse des requêtes marque (ton + synthèse + recos)
//  2. Synthèse par catégorie de questions
//  3a. Tableau roadmap ICE (Impact/Confidence/Ease) — export CSV
//  3b. Tableau favoris catégorisés (défendre/surveiller/conquête/conquérir) — export CSV
//  4. Rappel "générer un hint" par question
//  5. Comparaison avec la version précédente (si existante)
// Persistée en BDD (kind="roadmap"), datée.
function NextStepsAnalysis({ questions, results, brand, categories = [], gscRows = [], claudeKey, projectId = null, siteId = null }) {
  const [status, setStatus]   = useState("idle");
  const [data, setData]       = useState(null);   // { brandAnalysis, categoryAnalysis, roadmap[], comparison }
  const [open, setOpen]       = useState(false);
  const [savedDate, setSavedDate] = useState(null);
  // prevData : l'analyse précédente est lue depuis data avant reset (pas de state séparé)

  // ── Mode d'affichage : "url" (roadmap ICE existante) ou "action" (par type d'action) ──
  const [mode, setMode]                 = useState("url");
  const [actionData, setActionData]     = useState(null); // { generated_at, presence, actionGroups[] }
  const [actionStatus, setActionStatus] = useState("idle"); // idle | loading | done | error
  const [actionSavedDate, setActionSavedDate] = useState(null);
  const [openActionTypes, setOpenActionTypes] = useState({}); // accordéons par type d'action

  const brandName    = brand?.brand_name || "";
  const brandDomain  = brand?.brand_domain || "";

  // ── Charger la dernière analyse roadmap persistée ──
  useEffect(() => {
    if (!projectId || !siteId) return;
    let cancelled = false;
    sbGetGeoAnalyses(projectId, siteId, "roadmap").then(rows => {
      if (cancelled || !rows?.length) return;
      const latest = rows[0];
      if (latest.content) {
        setData(latest.content);
        setStatus("done");
        setSavedDate(latest.created_at);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Charger la dernière analyse "par action" persistée ──
  useEffect(() => {
    if (!projectId || !siteId) return;
    let cancelled = false;
    sbGetGeoAnalyses(projectId, siteId, "roadmap-actions").then(rows => {
      if (cancelled || !rows?.length) return;
      const latest = rows[0];
      if (latest.content) {
        setActionData(latest.content);
        setActionStatus("done");
        setActionSavedDate(latest.created_at);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const resultsByQ = useMemo(() => {
    const m = {};
    results.forEach(r => { if (!m[r.question_id]) m[r.question_id] = []; m[r.question_id].push(r); });
    return m;
  }, [results]);

  // Position de la marque sur une question (meilleur résultat)
  const brandPosOf = (qId) => {
    const rs = resultsByQ[qId] || [];
    const positions = rs.map(r => r.brand_mention_position || r.brand_position).filter(p => p != null && p > 0);
    return positions.length ? Math.min(...positions) : null;
  };
  const isMentioned = (qId) => (resultsByQ[qId] || []).some(r => r.brand_mentioned === true || r.brand_mentioned === 1);

  // ── Catalogue des types d'action (regroupement des recos) ──
  const ACTION_TYPES = {
    optimize:   { label: "Optimiser une page existante", color: "#1A7A4A", icon: "✎" },
    create:     { label: "Créer une nouvelle page",       color: "#E8541A", icon: "＋" },
    enrich:     { label: "Enrichir / restructurer le contenu", color: "#C97820", icon: "≣" },
    netlink:    { label: "Netlinking / autorité",          color: "#7C3AED", icon: "⚓" },
    schema:     { label: "Données structurées (Schema)",   color: "#0EA5E9", icon: "{}" },
    media:      { label: "Médias (images, vidéo, formats)", color: "#DB2777", icon: "▦" },
    other:      { label: "Autres actions",                 color: "#64748B", icon: "•" },
  };

  // ── Mode "Par action" : présence par favori → page GSC → type d'action → récap ICE ──
  const runActionMode = async () => {
    if (!claudeKey) { setActionStatus("error"); setActionData({ error: "Clé Claude manquante (⚙️ Gestion des Providers)." }); return; }
    const favs = questions.filter(q => q.is_favorite);
    if (!favs.length) { setActionStatus("error"); setActionData({ error: "Aucune question favorite. Marquez des questions en favori (★) pour cibler le périmètre stratégique." }); return; }
    setActionStatus("loading"); setOpen(true);

    const siteDomain = (brandDomain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

    // 1+2a. Pour chaque favori : présence marque + meilleure page GSC du site
    const perQuestion = favs.map(q => {
      const pos = brandPosOf(q.id);
      const ment = isMentioned(q.id);
      const gsc = matchGscForQuestion(q.question, gscRows, siteDomain);
      return {
        question: q.question,
        present: ment,
        brandPos: pos,
        gscUrl: gsc?.url || null,
        gscPos: gsc?.position || null,
        gscQuery: gsc?.query || null,
        hasPage: !!(gsc && gsc.url),
      };
    });

    const hasGsc = Array.isArray(gscRows) && gscRows.length > 0;

    // 2b. Demander à Claude de classer l'action à mener pour chaque question
    const typeKeys = Object.keys(ACTION_TYPES);
    const prompt = `Tu es un expert GEO/SEO senior. Pour "${brandName}" (${siteDomain || "site"}), tu dois définir, pour chaque question favorite, LE type d'action prioritaire à mener pour améliorer la présence de la marque dans les réponses des moteurs IA.

CONTEXTE par question :
- "present" : la marque est-elle déjà mentionnée dans les réponses IA ?
- "brandPos" : meilleure position de la marque dans un top IA (null si absente)
- "gscUrl" : page du site la mieux positionnée sur cette requête d'après Google Search Console (null si aucune page ne ranke)
- "gscPos" : position Google de cette page (null si inconnue)
${hasGsc ? "" : "\nNOTE : aucune donnée Google Search Console importée — base-toi sur present/brandPos et juge s'il faut probablement créer ou optimiser une page.\n"}
RÈGLE de décision (à adapter finement) :
- Si une page du site ranke déjà (gscUrl présent) → privilégier "optimize" ou "enrich".
- Si aucune page ne ranke (gscUrl null) → VÉRIFIE via la recherche web "site:${siteDomain || "le-site"} <sujet>" si une page existe quand même (GSC ne voit que les pages qui rankent) : si oui → "optimize" avec son URL ; sinon → "create".
- "schema", "media", "netlink" si pertinent en complément.

TYPES D'ACTION AUTORISÉS (clé exacte) : ${typeKeys.join(", ")}

QUESTIONS :
${JSON.stringify(perQuestion.map((p, i) => ({ i, question: p.question, present: p.present, brandPos: p.brandPos, gscUrl: p.gscUrl, gscPos: p.gscPos })), null, 0)}

Réponds UNIQUEMENT en JSON valide, sans texte autour :
{
  "items": [
    { "i": 0, "actionType": "optimize", "reason": "justification courte (1 phrase)", "targetUrl": "url existante à optimiser ou null si création" }
  ],
  "groups": [
    { "actionType": "optimize", "impact": 8, "confidence": 7, "ease": 6, "summary": "ce que regroupe ce type d'action et pourquoi (1-2 phrases)" }
  ]
}
- "items" : une entrée par question (même ordre d'index "i").
- "groups" : une entrée par type d'action RÉELLEMENT utilisé, avec une matrice ICE (entiers 1-10) et un résumé.`;

    try {
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({ model: RECO_MODEL_DEEP, max_tokens: 2500, tools: [webSearchTool(6)], messages: [{ role: "user", content: prompt }] }),
      });
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error("Proxy /api/claude-geo introuvable");
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Réponse non-JSON (${res.status})`); }
      const raw = claudeFinalText(data?.content) || data?.completion || data?.choices?.[0]?.message?.content || "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Aucun JSON dans la réponse");
      const parsed = JSON.parse(jsonMatch[0]);

      // 2c + 3. Regrouper les recos par type d'action
      const itemsByType = {};
      (parsed.items || []).forEach(it => {
        const t = ACTION_TYPES[it.actionType] ? it.actionType : "other";
        const pq = perQuestion[it.i] || {};
        if (!itemsByType[t]) itemsByType[t] = [];
        itemsByType[t].push({
          question: pq.question,
          present: pq.present,
          brandPos: pq.brandPos,
          url: it.targetUrl || pq.gscUrl || null,
          gscPos: pq.gscPos,
          reason: it.reason || "",
        });
      });
      const groupMeta = {};
      (parsed.groups || []).forEach(g => { groupMeta[g.actionType] = g; });

      const actionGroups = Object.entries(itemsByType).map(([type, items]) => {
        const g = groupMeta[type] || {};
        const impact = Number(g.impact) || 5, confidence = Number(g.confidence) || 5, ease = Number(g.ease) || 5;
        const ice = +(impact * confidence * ease / 100).toFixed(1); // score ICE normalisé 0-10
        const urls = [...new Set(items.map(it => it.url).filter(Boolean))];
        return {
          type,
          label: ACTION_TYPES[type].label,
          summary: g.summary || "",
          impact, confidence, ease, ice,
          count: items.length,
          urlCount: urls.length,
          urls,
          items,
        };
      }).sort((a, b) => b.ice - a.ice);

      const presence = {
        total: favs.length,
        present: perQuestion.filter(p => p.present).length,
        absent: perQuestion.filter(p => !p.present).length,
        withPage: perQuestion.filter(p => p.hasPage).length,
      };

      const payload = { generated_at: new Date().toISOString(), hasGsc, presence, actionGroups, perQuestion };
      setActionData(payload);
      setActionStatus("done");
      setActionSavedDate(payload.generated_at);
      if (projectId && siteId) sbSaveGeoAnalysis({ project_id: projectId, site_id: siteId, kind: "roadmap-actions", content: payload }).catch(() => {});
    } catch (e) {
      console.error("runActionMode:", e);
      setActionStatus("error");
      setActionData({ error: e.message || "Échec de l'analyse par action" });
    }
  };

  const run = async () => {
    if (!claudeKey || !results.length) return;
    setStatus("loading"); setOpen(true);

    const previousForComparison = data;
    try {
      const parsed = await generateRoadmap({ questions, results, brand, categories, claudeKey, previousForComparison });
      setData(parsed);
      setStatus("done");
      setSavedDate(parsed.generated_at);
      if (projectId && siteId) {
        sbSaveGeoAnalysis({ project_id: projectId, site_id: siteId, kind: "roadmap", content: parsed }).catch(() => {});
      }
    } catch(e) {
      setData({ error: e.message });
      setStatus("error");
    }
  };

  // ── Export CSV roadmap ──
  const exportRoadmapCSV = () => {
    if (!data?.roadmap?.length) return;
    const header = ["Action", "Catégorie", "Page", "URL cible", "Favori", "Impact", "Confidence", "Ease", "Score ICE"];
    const rows = [header, ...data.roadmap.map(r => {
      const ice = ((r.impact || 0) + (r.confidence || 0) + (r.ease || 0));
      return [r.action, r.category || "", r.target_url ? (r.page_exists ? "Optimiser" : "Créer") : "", r.target_url || "", r.favorite ? "Oui" : "", r.impact, r.confidence, r.ease, ice];
    })];
    downloadText(toCSV(rows), `roadmap_geo_${new Date().toISOString().slice(0,10)}.csv`);
  };

  // ── Export "Optimisations mots clés" (format clusters, inspiré du template Sheets) ──
  const exportClustersCSV = async () => {
    if (!data?.roadmap?.length) return;
    let kws = [];
    try { kws = (projectId && siteId) ? (await sbGetKeywords(projectId, siteId)) || [] : []; } catch { kws = []; }
    const csv = buildKeywordClustersCsv({ keywords: kws, roadmap: data.roadmap, categories });
    downloadText(csv, `optimisations_mots_cles_${new Date().toISOString().slice(0,10)}.csv`);
  };

  // ── Export CSV favoris ──
  const BUCKET_LABELS = {
    defend:             "À défendre",
    watch:              "À surveiller",
    conquest_priority:  "Conquête prioritaire",
    conquer:            "À conquérir",
  };
  const exportFavoritesCSV = () => {
    if (!data?.favorites?.length) return;
    const header = ["Question", "Catégorie", "Position marque", "Mentionnée"];
    const order = ["defend", "watch", "conquest_priority", "conquer"];
    const sorted = [...data.favorites].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
    const rows = [header, ...sorted.map(f => [
      f.question, BUCKET_LABELS[f.bucket] || f.bucket, f.pos != null ? `#${f.pos}` : "—", f.mentioned ? "Oui" : "Non",
    ])];
    downloadText(toCSV(rows), `favoris_geo_${new Date().toISOString().slice(0,10)}.csv`);
  };

  if (!results.length) return null;

  const BUCKET_META = {
    defend:            { label: "À défendre",          color: "#1A7A4A", desc: "La marque lead (#1-3)" },
    watch:             { label: "À surveiller",         color: "#C97820", desc: "Top 4-10" },
    conquest_priority: { label: "Conquête prioritaire", color: "#E8541A", desc: "Non positionnée, fort potentiel" },
    conquer:           { label: "À conquérir",          color: "#1A3C2E", desc: "Non positionnée" },
  };

  return (
    <div style={{ marginBottom: 24 }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: open ? 16 : 0, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="gt-label" style={{ marginBottom: 3 }}>Et maintenant ?</div>
          <div style={{ fontSize: 13, fontWeight: 400, color: "#1A3C2E", letterSpacing: "-0.005em" }}>
            {mode === "url" ? "Plan d'action priorisé — roadmap ICE & favoris catégorisés" : "Actions à mener par type — ICE & pages concernées (favoris)"}
          </div>
          {mode === "url" && savedDate && (
            <div style={{ fontSize: 10, color: "#1A3C2E", marginTop: 2 }}>
              Dernière génération : {new Date(savedDate).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          {mode === "action" && actionSavedDate && (
            <div style={{ fontSize: 10, color: "#1A3C2E", marginTop: 2 }}>
              Dernière génération : {new Date(actionSavedDate).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Switch de mode */}
          <div style={{ display: "inline-flex", background: "#1A3C2E0A", borderRadius: 8, padding: 2 }}>
            {[["url", "Par URL"], ["action", "Par action"]].map(([m, lbl]) => (
              <button key={m} onClick={() => { setMode(m); setOpen(true); }}
                style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 6, cursor: "pointer",
                  background: mode === m ? "#fff" : "transparent", color: mode === m ? "#1A3C2E" : "#1A3C2E",
                  boxShadow: mode === m ? "0 1px 3px #1A3C2E1A" : "none" }}>
                {lbl}
              </button>
            ))}
          </div>

          {mode === "url" && (
            <>
              {status === "done" && (
                <button onClick={() => setOpen(o => !o)} className="gt-btn gt-btn--ghost" style={{ fontSize: 11 }}>
                  {open ? "Masquer" : "Voir le plan"}
                </button>
              )}
              <button
                onClick={run}
                disabled={status === "loading" || !claudeKey}
                className={`gt-btn ${status === "idle" ? "gt-btn--solid" : "gt-btn--ghost"}`}
                title={!claudeKey ? "Clé Claude manquante" : undefined}
                style={{ opacity: (!claudeKey || status === "loading") ? 0.4 : 1 }}>
                {status === "loading" ? "Génération…" : status === "done" ? "↺ Régénérer" : "Et maintenant ?"}
              </button>
            </>
          )}

          {mode === "action" && (
            <>
              {actionStatus === "done" && (
                <button onClick={() => setOpen(o => !o)} className="gt-btn gt-btn--ghost" style={{ fontSize: 11 }}>
                  {open ? "Masquer" : "Voir les actions"}
                </button>
              )}
              <button
                onClick={runActionMode}
                disabled={actionStatus === "loading" || !claudeKey}
                className={`gt-btn ${actionStatus === "idle" ? "gt-btn--solid" : "gt-btn--ghost"}`}
                title={!claudeKey ? "Clé Claude manquante" : undefined}
                style={{ opacity: (!claudeKey || actionStatus === "loading") ? 0.4 : 1 }}>
                {actionStatus === "loading" ? "Analyse…" : actionStatus === "done" ? "↺ Régénérer" : "Analyser les actions"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Mode PAR ACTION : rendu ── */}
      {mode === "action" && open && (
        <div style={{ borderTop: "0.5px solid #1A3C2E0D", paddingTop: 16 }}>
          {actionStatus === "loading" && (
            <div style={{ fontSize: 12, color: "#1A3C2E", padding: "12px 0" }}>Analyse des actions en cours… (présence, pages GSC, classification)</div>
          )}
          {actionStatus === "error" && actionData?.error && (
            <div style={{ fontSize: 12, color: "#C0352A", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "10px 12px" }}>{actionData.error}</div>
          )}
          {actionStatus === "done" && actionData && !actionData.error && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {/* Constat de présence */}
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", padding: "12px 16px", background: "#1A3C2E08", borderRadius: 10 }}>
                <div><div style={{ fontSize: 10, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5 }}>Favoris analysés</div><div style={{ fontSize: 20, fontWeight: 800, color: "#1A3C2E" }}>{actionData.presence.total}</div></div>
                <div><div style={{ fontSize: 10, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5 }}>Marque présente</div><div style={{ fontSize: 20, fontWeight: 800, color: "#1A7A4A" }}>{actionData.presence.present}</div></div>
                <div><div style={{ fontSize: 10, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5 }}>Marque absente</div><div style={{ fontSize: 20, fontWeight: 800, color: "#C0352A" }}>{actionData.presence.absent}</div></div>
                <div><div style={{ fontSize: 10, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5 }}>Page GSC trouvée</div><div style={{ fontSize: 20, fontWeight: 800, color: "#1A3C2E" }}>{actionData.presence.withPage}</div></div>
              </div>

              {!actionData.hasGsc && (
                <div style={{ fontSize: 11, color: "#C97820", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px" }}>
                  ⚠ Aucune donnée Google Search Console importée (onglet Audit → Imports). Les pages cibles n'ont pas pu être identifiées via GSC ; l'analyse repose sur la présence IA seule. Importez un export GSC pour des recommandations « optimiser vs créer » plus précises.
                </div>
              )}

              {/* Récap par type d'action */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {actionData.actionGroups.map(g => {
                  const meta = ACTION_TYPES[g.type] || ACTION_TYPES.other;
                  const isOpen = !!openActionTypes[g.type];
                  return (
                    <div key={g.type} style={{ border: "0.5px solid #1A3C2E18", borderRadius: 12, overflow: "hidden" }}>
                      {/* Bandeau type */}
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: meta.color + "0D" }}>
                        <span style={{ width: 26, height: 26, borderRadius: 7, background: meta.color, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{meta.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E" }}>{g.label}</div>
                          {g.summary && <div style={{ fontSize: 11, color: "#1A3C2E", marginTop: 1 }}>{g.summary}</div>}
                        </div>
                        {/* Matrice ICE */}
                        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                          {[["Impact", g.impact], ["Confiance", g.confidence], ["Facilité", g.ease]].map(([lbl, v]) => (
                            <div key={lbl} style={{ textAlign: "center" }}>
                              <div style={{ fontSize: 9, color: "#1A3C2E", textTransform: "uppercase" }}>{lbl}</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{v}</div>
                            </div>
                          ))}
                          <div style={{ textAlign: "center", paddingLeft: 8, borderLeft: "0.5px solid #1A3C2E18" }}>
                            <div style={{ fontSize: 9, color: meta.color, textTransform: "uppercase", fontWeight: 700 }}>ICE</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: meta.color, fontVariantNumeric: "tabular-nums" }}>{g.ice}</div>
                          </div>
                        </div>
                      </div>
                      {/* Accordéon URLs / questions */}
                      <button onClick={() => setOpenActionTypes(p => ({ ...p, [g.type]: !p[g.type] }))}
                        style={{ width: "100%", textAlign: "left", padding: "8px 14px", border: "none", borderTop: "0.5px solid #1A3C2E0D", background: "#fff", cursor: "pointer", fontSize: 11, color: "#1A3C2E", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
                        {g.count} question{g.count > 1 ? "s" : ""} concernée{g.count > 1 ? "s" : ""}{g.urlCount > 0 ? ` · ${g.urlCount} URL${g.urlCount > 1 ? "s" : ""}` : ""}
                      </button>
                      {isOpen && (
                        <div style={{ padding: "4px 14px 12px", background: "#fff", display: "flex", flexDirection: "column", gap: 8 }}>
                          {g.items.map((it, i) => (
                            <div key={i} style={{ paddingTop: 8, borderTop: i ? "0.5px solid #1A3C2E08" : "none" }}>
                              <div style={{ fontSize: 12, color: "#1A3C2E", fontWeight: 500 }}>{it.question}</div>
                              <div style={{ fontSize: 11, color: "#1A3C2E", marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <span style={{ color: it.present ? "#1A7A4A" : "#C0352A" }}>{it.present ? `Présente${it.brandPos ? ` #${it.brandPos}` : ""}` : "Absente"}</span>
                                {it.url && <span>↳ <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: meta.color, textDecoration: "none" }}>{it.url.replace(/^https?:\/\//, "").slice(0, 60)}</a>{it.gscPos ? ` (GSC #${Math.round(it.gscPos)})` : ""}</span>}
                                {!it.url && <span style={{ fontStyle: "italic" }}>aucune page existante</span>}
                              </div>
                              {it.reason && <div style={{ fontSize: 11, color: "#1A3C2E", marginTop: 2 }}>{it.reason}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {actionStatus === "idle" && (
            <div style={{ fontSize: 12, color: "#1A3C2E", padding: "12px 0" }}>
              Lancez l'analyse pour identifier, par question favorite, l'action prioritaire (optimiser, créer, enrichir…) et le récapitulatif par type d'action avec matrice ICE.
            </div>
          )}
        </div>
      )}

      {/* ── Contenu ── */}
      {mode === "url" && open && status === "done" && data && !data.error && (
        <div style={{ borderTop: "0.5px solid #1A3C2E0D", paddingTop: 16, display: "flex", flexDirection: "column", gap: 24 }}>

          {/* ── Plan d'action partagé (identique à l'audit) ── */}
          <RoadmapView data={data} exportSlot={
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={exportClustersCSV} className="gt-btn gt-btn--ghost" style={{ fontSize: 10, padding: "3px 10px" }} title="Mots-clés par cluster + actions, format inspiré du template Sheets">↓ Optimisations mots clés</button>
              <button onClick={exportRoadmapCSV} className="gt-btn gt-btn--ghost" style={{ fontSize: 10, padding: "3px 10px" }}>↓ Export CSV</button>
            </div>
          } />

          {/* 3b. Tableau favoris catégorisés */}
          {Array.isArray(data.favorites) && data.favorites.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E" }}>
                  ★ Favoris catégorisés
                </div>
                <button onClick={exportFavoritesCSV} className="gt-btn gt-btn--ghost" style={{ fontSize: 10, padding: "3px 10px" }}>
                  ↓ Export CSV
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {["defend", "watch", "conquest_priority", "conquer"].map(bucket => {
                  const items = data.favorites.filter(f => f.bucket === bucket);
                  if (!items.length) return null;
                  const meta = BUCKET_META[bucket];
                  return (
                    <div key={bucket}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: meta.color }}>{meta.label}</span>
                        <span style={{ fontSize: 10, color: "#1A3C2E" }}>{meta.desc} · {items.length}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 16 }}>
                        {items.map((f, i) => (
                          <div key={i} style={{ fontSize: 11, color: "#1A3C2E", display: "flex", gap: 8, alignItems: "baseline" }}>
                            <span style={{ flex: 1, lineHeight: 1.5 }}>{f.question}</span>
                            {f.pos != null && <span style={{ fontSize: 10, color: meta.color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>#{f.pos}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 5. Comparaison avec version précédente */}
          {data.comparison && (
            <div style={{ borderLeft: "2px solid #1A3C2E18", paddingLeft: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>
                ↔ Comparaison avec la version précédente
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { k: "better",    label: "Ce qui a mieux fonctionné",  color: "#1A7A4A" },
                  { k: "worse",     label: "Ce qui a moins bien fonctionné", color: "#C0352A" },
                  { k: "done",      label: "Ce qui semble avoir été fait", color: "#1A3C2E" },
                  { k: "missing",   label: "Ce qui semble avoir manqué",  color: "#C97820" },
                  { k: "reinforce", label: "Ce qui est à renforcer",      color: "#E8541A" },
                ].filter(row => data.comparison[row.k]).map(row => (
                  <div key={row.k}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: row.color, marginBottom: 2 }}>{row.label}</div>
                    <div style={{ fontSize: 11, color: "#1A3C2E", lineHeight: 1.6 }}>{data.comparison[row.k]}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4. Rappel hint */}
          <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic", background: "#FFFBEB", border: "0.5px solid #C9782022", borderRadius: 6, padding: "10px 12px" }}>
            💡 Pour des recommandations plus précises sur une question donnée, cliquez sur « Générer une recommandation » sous chaque question.
          </div>
        </div>
      )}

      {mode === "url" && open && status === "error" && data?.error && (
        <div style={{ fontSize: 12, color: "#C0352A", padding: "10px 0", borderTop: "0.5px solid #1A3C2E0D", marginTop: 8 }}>
          Erreur : {data.error}
        </div>
      )}
    </div>
  );
}


// ── Questions sub-tab (v2) ────────────────────────────────────────

// Multi-sélecteur de sites pour le périmètre du Suivi GEO.
// Tous cochés par défaut = vue globale. Toujours au moins un site coché.
function SiteMultiSelect({ sites = [], value = [], onChange }) {
  const list = Array.isArray(sites) ? sites : [];
  if (list.length < 2) return null;
  const sel = Array.isArray(value) && value.length ? value : list.map(s => s.id);
  const allOn = sel.length === list.length;
  const toggle = (id) => {
    // Point 2 : depuis « Tous » (toutes sélectionnées), un clic ISOLE la marque
    // (sélectionne celle-ci et désélectionne les autres). Sinon, comportement
    // habituel : ajout/retrait multi-sélection.
    if (allOn) { onChange([id]); return; }
    const next = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id];
    if (next.length === 0) return; // au moins un site
    onChange(next);
  };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button onClick={() => onChange(list.map(s => s.id))}
        title="Vue globale : tous les sites du projet"
        style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer",
          border: `1px solid ${allOn ? "#1A3C2E" : "#1A3C2E33"}`, background: allOn ? "#1A3C2E" : "transparent", color: allOn ? "#fff" : "#1A3C2E" }}>
        ◎ Tous
      </button>
      {list.map(s => {
        const on = sel.includes(s.id);
        const only = on && sel.length === 1;
        return (
          <button key={s.id} onClick={() => toggle(s.id)}
            title={only ? "Site actif — cochez-en d'autres pour agréger" : (on ? "Cliquer pour retirer" : "Cliquer pour ajouter")}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: "pointer",
              border: `1px solid ${s.color}${on ? "" : "33"}`, background: on ? s.color : "transparent", color: on ? "#fff" : s.color, opacity: allOn ? 0.85 : 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: on ? "#fff" : s.color }} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function QuestionsTab({ site, projectId, project = null, apiKey, model, brand, categories, setCategories, allResults, allSites = [], readSiteIds = null, siteBrandsMap = {}, gscRows = [], aliasMap = {}, onResultSaved, activeProviders = ["openai"], providerKeys = {}, runMode = "parallel", keywordsOrder = [], refreshTrigger = 0, competitors = [], setCompetitors = null, onSaveKey = null, isReadOnly = false, webSearchSettings = {} }) {
  const [questions, setQuestions]   = useState([]);
  const [results, setResults]       = useState(allResults || []);
  // Résultats de TOUS les sites du projet, réservés au CALENDRIER. Un résultat
  // porte brand_presences de toutes les marques mais n'est stocké que sous UN
  // site : le calendrier doit donc voir tous les sites, quelle que soit la
  // sélection (sinon désélectionner un site fait disparaître ses carrés colorés).
  const [calResults, setCalResults] = useState([]);
  const _allSiteIdsKey = (allSites || []).map(s => s.id).join(",");
  useEffect(() => {
    if (!projectId) return;
    const ids = (allSites || []).map(s => s.id).filter(Boolean);
    if (!ids.length) return;
    Promise.all(ids.map(sid => sbGetGeoResults(projectId, sid).catch(() => [])))
      .then(a => setCalResults(a.flat())).catch(() => {});
  }, [projectId, _allSiteIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const calResultsByQ = useMemo(() => {
    const m = {};
    calResults.forEach(r => { if (!m[r.question_id]) m[r.question_id] = []; m[r.question_id].push(r); });
    return m;
  }, [calResults]);
  // ── Agrégats quotidiens M/É/C (geo_presence_daily) : source des courbes ──
  const [dailyRows, setDailyRows] = useState([]);
  // File d'attente AI Overview (question_ids en attente/en cours pour ce site)
  const [mecMode, setMecMode] = useState("question"); // switch réponse/question, partagé courbe+chiffres
  const [mecView, setMecView] = useState("cumule");    // Cumulé (somme sélection) / Comparaison (par marque)
  const [compareMetric, setCompareMetric] = useState("mentions"); // métrique tracée en Comparaison
  // File AI Overview : Map question_id → requested_at (ISO). « en attente » n'est
  // affiché que si la demande date de MOINS de 60 s ; au-delà → retour auto à
  // « lancement » (le scraper peut encore la traiter). Croix = annulation manuelle.
  const AIO_TIMEOUT_MS = 60000;
  const [aioQueue, setAioQueue] = useState(new Map());
  const [aioNow, setAioNow] = useState(Date.now());
  const refreshAioQueue = useCallback(() => {
    if (!projectId || !site?.id) return;
    sbGetAioQueue(projectId, site.id)
      .then(rows => setAioQueue(new Map((rows || []).map(r => [r.question_id, r.requested_at || new Date().toISOString()]))))
      .catch(() => {});
  }, [projectId, site?.id]);
  useEffect(() => { refreshAioQueue(); }, [refreshAioQueue]);
  const aioPending = (questionId) => {
    const ts = aioQueue.get(questionId);
    if (!ts) return false;
    return (aioNow - new Date(ts).getTime()) < AIO_TIMEOUT_MS;
  };
  useEffect(() => {
    if (aioQueue.size === 0) return;
    const iv = setInterval(() => {
      setAioNow(Date.now());   // fait avancer l'horloge → déclenche l'auto-retour à 60 s
      refreshAioQueue();       // lève « en attente » dès que le scraper a traité la demande
      onResultSaved?.();       // recharge les résultats (affiche l'AI Overview arrivé)
    }, 8000);
    return () => clearInterval(iv);
  }, [aioQueue.size, refreshAioQueue, onResultSaved]);
  const enqueueAio = (questionId) => {
    if (isReadOnly) return; // lecture seule : aucun appel LLM / scrape
    if (!projectId || !site?.id || !questionId) return;
    setAioQueue(prev => new Map(prev).set(questionId, new Date().toISOString())); // feedback immédiat
    setAioNow(Date.now());
    sbEnqueueAioScrape(projectId, site.id, [questionId]).catch(() => {}).finally(refreshAioQueue);
  };
  const cancelAio = (questionId) => {
    if (!projectId || !site?.id || !questionId) return;
    setAioQueue(prev => { const m = new Map(prev); m.delete(questionId); return m; });
    sbCancelAioScrape(projectId, site.id, questionId).catch(() => {});
  };
  // Lecture de l'historique complet de la marque (au-delà des résultats récents).
  useEffect(() => {
    if (!projectId || !site?.id) return;
    const ids = (Array.isArray(readSiteIds) && readSiteIds.length ? readSiteIds : [site.id]).filter(Boolean);
    sbGetPresenceDaily(projectId, ids).then(rows => setDailyRows(rows || [])).catch(() => {});
  }, [projectId, site?.id, (Array.isArray(readSiteIds) ? readSiteIds.join(",") : "")]); // eslint-disable-line react-hooks/exhaustive-deps
  // Matérialisation : recalcule les jours présents dans les résultats et upsert,
  // puis fusionne dans l'état (les jours recalculés priment sur l'historique).
  // GARDE-FOU : on n'upsert PAS un jour dont le recalcul compte MOINS de réponses
  // que la ligne déjà stockée — sinon la fenêtre des 2000 résultats récents
  // écraserait un vieux jour complet par un sous-comptage.
  useEffect(() => {
    if (!projectId || !site?.id || !results.length) return;
    const fresh = computeMecDaily(results);
    if (!fresh.length) return;
    const storedByDate = {};
    (dailyRows || []).forEach(r => { storedByDate[r.date] = r; });
    const toUpsert = fresh.filter(r => {
      const prev = storedByDate[r.date];
      return !prev || (r.responses_count || 0) >= (prev.responses_count || 0);
    });
    // Matérialisation quotidienne PAR MARQUE sélectionnée (chaque site stocke sa
    // propre présence, cohérent avec le calcul par marque des courbes).
    (Array.isArray(readSiteIds) && readSiteIds.length ? readSiteIds : [site.id]).forEach(sid => {
      const freshSid = computeMecDaily(results, [sid]);
      const toUp = freshSid.filter(r => { const prev = storedByDate[r.date]; return !prev || (r.responses_count || 0) >= (prev.responses_count || 0); });
      if (toUp.length) sbUpsertPresenceDaily(projectId, sid, toUp).catch(() => {});
    });
    setDailyRows(prev => {
      const byDate = {};
      (prev || []).forEach(r => { byDate[r.date] = r; });
      toUpsert.forEach(r => { byDate[r.date] = { ...byDate[r.date], ...r }; });
      return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    });
  }, [projectId, site?.id, results]); // eslint-disable-line react-hooks/exhaustive-deps
  const [recomputing, setRecomputing]   = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState("");
  // Sort: favorites first, then by keyword order, then by creation date
  const sortedQuestions = useMemo(() => {
    const kwIndexMap = {};
    keywordsOrder.forEach((id, i) => { kwIndexMap[id] = i; });
    return [...questions].sort((a, b) => {
      // 1. Favoris d'abord (priorité absolue)
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      // 2. Ordre MANUEL (glisser-déposer) — stable, non modifié par l'interrogation.
      //    Les questions sans ordre manuel passent après celles qui en ont un.
      const soa = Number.isFinite(a.sort_order) ? a.sort_order : null;
      const sob = Number.isFinite(b.sort_order) ? b.sort_order : null;
      if (soa != null || sob != null) {
        if (soa == null) return 1;
        if (sob == null) return -1;
        if (soa !== sob) return soa - sob;
      }
      // 3. Keyword order (undefined → end)
      const ia = kwIndexMap[a.keyword_id] ?? 9999;
      const ib = kwIndexMap[b.keyword_id] ?? 9999;
      if (ia !== ib) return ia - ib;
      // 4. Creation date within same keyword
      return new Date(a.created_at) - new Date(b.created_at);
    });
  }, [questions, keywordsOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const [manualQ, setManualQ]       = useState("");
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvOverlay, setCsvOverlay] = useState(false);
  const csvInputRef = useRef(null);
  // Génération de questions depuis une URL (crawl léger + IA)
  const [urlGenOpen, setUrlGenOpen]   = useState(false);
  const [urlGenUrl, setUrlGenUrl]     = useState("");
  const [urlGenCount, setUrlGenCount] = useState(15);  // 10–25
  const [urlGenStatus, setUrlGenStatus] = useState(""); // "", "crawl", "gen", "error:…", "done:N"
  const [editingQ, setEditingQ]     = useState(null); // { id, text } — question being edited
  const [dragId, setDragId]         = useState(null); // glisser-déposer : question en cours de déplacement
  // Auto-scroll pendant le glisser-déposer : la page défile quand le curseur
  // approche du haut/bas de la fenêtre (le drag HTML5 ne le fait pas seul).
  const dragYRef = useRef(0);
  const scrollTimerRef = useRef(null);
  const startAutoScroll = () => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setInterval(() => {
      const y = dragYRef.current;
      const edge = 90, speed = 16;
      if (y > 0 && y < edge) window.scrollBy(0, -speed);
      else if (y > 0 && y > window.innerHeight - edge) window.scrollBy(0, speed);
    }, 16);
  };
  const stopAutoScroll = () => { if (scrollTimerRef.current) { clearInterval(scrollTimerRef.current); scrollTimerRef.current = null; } dragYRef.current = 0; };
  useEffect(() => () => stopAutoScroll(), []); // nettoyage au démontage
  // Réordonne les questions (glisser-déposer) et ENREGISTRE l'ordre (sort_order),
  // pour qu'il reste consistant après interrogation et rechargement.
  const moveQuestion = (fromId, toId) => {
    if (!fromId || fromId === toId) return;
    const ids = sortedQuestions.map(q => q.id);
    const fromIdx = ids.indexOf(fromId), toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    const pos = {}; ids.forEach((id, i) => { pos[id] = i; });
    setQuestions(prev => prev.map(q => (pos[q.id] != null ? { ...q, sort_order: pos[q.id] } : q)));
    sbReorderQuestions(projectId, ids).catch(() => {});
  };
  const [editingKw, setEditingKw]       = useState(null);
  const [kwInput, setKwInput]           = useState("");
  const [hintsMap, setHintsMap]     = useState({}); // { questionId: hint_text }
  // Filters — persisted per project+site in localStorage
  const filtersKey = `geo_filters_${projectId}`; // préférences de filtres au niveau PROJET (indépendant du site)
  const loadFilters = () => {
    try { return JSON.parse(localStorage.getItem(filtersKey) || "{}"); } catch { return {}; }
  };
  const savedF = loadFilters();
  const [filterFav,        setFilterFavRaw]        = useState(savedF.filterFav        || false);
  const favDefaultAppliedRef = useRef(false); // pour n'appliquer le défaut Favoris qu'une fois
  const [filterPositioned, setFilterPositionedRaw] = useState(savedF.filterPositioned || false);
  const [filterLost,       setFilterLostRaw]       = useState(savedF.filterLost       || false);
  const [sortByResult,     setSortByResult]        = useState(savedF.sortByResult     || false); // tri par résultat (mention/évoc/citation)
  const [filterCat,        setFilterCatRaw]        = useState(Array.isArray(savedF.filterCat) ? savedF.filterCat : (savedF.filterCat ? [savedF.filterCat] : []));
  const [filterKeyword,    setFilterKeywordRaw]    = useState(savedF.filterKeyword    || "");
  const [filterSearch,     setFilterSearchRaw]     = useState(savedF.filterSearch     || "");
  const [searchField,      setSearchField]         = useState(savedF.searchField      || "question"); // question|answer|mention|evocation|citation
  // ── Providers : 3 états par provider — "used" (interrogé + visible),
  //    "unused" (non interrogé, résultats passés toujours visibles),
  //    "hidden" (non interrogé + lignes masquées). Persisté en localStorage.
  const [providerModes, setProviderModesRaw] = useState(() => {
    const m = savedF.providerModes && typeof savedF.providerModes === "object" ? { ...savedF.providerModes } : {};
    // Rétrocompat : une ancienne sélection focus => ces providers "used", les autres "unused".
    if (!savedF.providerModes && Array.isArray(savedF.filterProviders) && savedF.filterProviders.length) {
      PROVIDERS.forEach(p => { m[p.id] = savedF.filterProviders.includes(p.id) ? "used" : "unused"; });
    }
    return m;
  });

  // Wrap setters to also persist to localStorage
  const persistFilters = (patch) => {
    try {
      const current = loadFilters();
      localStorage.setItem(filtersKey, JSON.stringify({ ...current, ...patch }));
    } catch {}
  };
  const setFilterFav        = (v) => { setFilterFavRaw(v);        persistFilters({ filterFav: v }); };
  const setFilterPositioned = (v) => { setFilterPositionedRaw(v); persistFilters({ filterPositioned: v }); };
  const setFilterLost       = (v) => { setFilterLostRaw(v);       persistFilters({ filterLost: v }); };
  const setFilterCat        = (v) => { setFilterCatRaw(v);        persistFilters({ filterCat: v }); };
  const setFilterKeyword    = (v) => { setFilterKeywordRaw(v);    persistFilters({ filterKeyword: v }); };
  const setFilterSearch     = (v) => { setFilterSearchRaw(v);     persistFilters({ filterSearch: v }); };
  const setProviderModes = (v) => { setProviderModesRaw(v); persistFilters({ providerModes: v }); };
  const providerMode = (id) => providerModes[id] || "used";
  const cycleProviderMode = (id) => {
    const next = providerMode(id) === "used" ? "unused" : providerMode(id) === "unused" ? "hidden" : "used";
    setProviderModes({ ...providerModes, [id]: next });
  };
  const [running, setRunning]       = useState({});
  const [providerErrors, setProviderErrors] = useState({}); // { "qId-pid": errorMsg }
  const [runAll, setRunAll]         = useState(false);
  const stopAllRef = useRef(false);
  // Refs so callbacks always read current values without stale closure issues
  const activeProvidersRef = useRef(activeProviders);
  const providerKeysRef    = useRef(providerKeys);
  // Keep refs in sync with props on every render (not just via useEffect)
  activeProvidersRef.current = activeProviders;
  providerKeysRef.current    = providerKeys;
  const [selected, setSelected]     = useState(new Set());
  const [bulkCat, setBulkCat]       = useState("");
  const [keywords, setKeywords]     = useState([]);
  const [newCalEntries, setNewCalEntries] = useState({}); // { `${q.id}|${p.id}` → last newEntry for PresenceCalendar }
  const [calendarEntries, setCalendarEntries] = useState([]); // entrées de la table geo_presence_calendar

  // Load all data on mount and when project/site/refreshTrigger changes
  const _readIds = (Array.isArray(readSiteIds) && readSiteIds.length ? readSiteIds : [site?.id]).filter(Boolean);
  const _readKey = _readIds.join(",");
  // Marques d'une question à AFFICHER : ses marques (associated_sites, ou toutes
  // si vide) INTERSECTÉES avec la sélection du haut de page (_readIds). #3
  const brandSitesFor = (q) => {
    const assoc = Array.isArray(q.associated_sites) && q.associated_sites.length
      ? q.associated_sites : (allSites || []).map(s => s.id);
    return (allSites || [])
      .filter(s => assoc.includes(s.id) && _readIds.includes(s.id))
      .map(s => ({ id: s.id, label: s.label, color: s.color }));
  };
  // Projet mono-site : on garde l'usage historique (pas de label marque, juste les carrés). #4
  const singleSiteProject = (allSites || []).length <= 1;
  useEffect(() => {
    if (!projectId || !site?.id) return;
    const ids = (Array.isArray(readSiteIds) && readSiteIds.length ? readSiteIds : [site.id]).filter(Boolean);
    // Résultats + questions : agrégés sur tous les sites du périmètre.
    // Hints / keywords / calendrier : gardés sur le site primaire (config/aux).
    Promise.all([
      Promise.all(ids.map(sid => sbGetGeoResults(projectId, sid).catch(() => []))).then(a => a.flat()),
      sbGetAllQuestions(projectId).catch(() => []),
      // Groupe D : hints / keywords / calendrier suivent la SÉLECTION (union des sites).
      Promise.all(ids.map(sid => sbGetHints(projectId, sid).catch(() => []))).then(a => a.flat()),
      Promise.all(ids.map(sid => sbGetKeywords(projectId, sid).catch(() => []))).then(a => a.flat()),
      Promise.all(ids.map(sid => sbGetCalendarEntriesBatch(projectId, sid).catch(() => []))).then(a => a.flat()),
    ]).then(([results, questions, hints, keywords, calEntries]) => {
      setResults(results.length ? results : (allResults || []));
      setQuestions(questions);
      // Tri/filtre Favoris ON par défaut au 1er chargement s'il existe des favoris
      // (sauf si l'utilisateur a déjà une préférence enregistrée).
      if (!favDefaultAppliedRef.current) {
        favDefaultAppliedRef.current = true;
        const hasFavs = questions.some(q => q.is_favorite);
        if (hasFavs && savedF.filterFav === undefined) setFilterFav(true);
      }
      const map = {};
      hints.forEach(r => { map[r.question_id] = { text: r.hint_text, date: r.updated_at }; });
      setHintsMap(map);
      // Dédup keywords par id (une même marque peut réapparaître entre sites).
      const kwSeen = new Set();
      setKeywords((keywords || []).filter(k => (k && k.id != null && !kwSeen.has(k.id)) ? (kwSeen.add(k.id), true) : false));
      setCalendarEntries(calEntries || []);
    }).catch(e => console.warn("[QuestionsTab] load error:", e));
  }, [projectId, site?.id, refreshTrigger, _readKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-tag "Marque" : questions contenant le nom de marque ──────
  // Crée la catégorie "Marque" si absente puis tague les questions dont
  // le texte contient le nom de marque ou un alias.
  useEffect(() => {
    if (isReadOnly) return; // pas d'écriture en vue agrégée / lecture seule
    if (!projectId || !site?.id) return;
    if (!questions.length) return;
    const brandName = (brand?.brand_name || "").trim();
    const aliases   = Array.isArray(brand?.brand_aliases) ? brand.brand_aliases : [];
    const terms = [brandName, ...aliases].filter(Boolean).map(t => t.toLowerCase().trim()).filter(t => t.length >= 2);
    if (!terms.length) return;

    let cancelled = false;
    (async () => {
      // 1. Trouver ou créer la catégorie "Marque"
      let marqueCat = categories.find(c => (c.name || "").toLowerCase() === "marque");
      if (!marqueCat) {
        try {
          marqueCat = await sbSaveCategory({ project_id: projectId, name: "Marque", color: "#1A3C2E" });
          if (cancelled || !marqueCat?.id) return;
          setCategories(prev => prev.some(c => c.id === marqueCat.id) ? prev : [...prev, marqueCat]);
        } catch { return; }
      }
      const marqueCatId = marqueCat.id;

      // 2. Détecter les questions à taguer (texte contient un terme marque)
      const toTag = questions.filter(q => {
        const txt = (q.question || "").toLowerCase();
        const hasBrandInText = terms.some(t => txt.includes(t));
        if (!hasBrandInText) return false;
        const existingTags = Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : []);
        return !existingTags.includes(marqueCatId); // pas déjà tagué
      });
      if (!toTag.length || cancelled) return;

      // 3. Appliquer le tag (ajout à la liste existante, sans écraser)
      for (const q of toTag) {
        const existingTags = Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : []);
        const newTags = [...new Set([...existingTags, marqueCatId])];
        sbSetKeywordTags(q.id, newTags).catch(() => {});
        if (!q.category_id) sbSetQuestionCategory(q.id, marqueCatId).catch(() => {});
      }
      if (cancelled) return;
      const tagIds = new Set(toTag.map(q => q.id));
      setQuestions(prev => prev.map(q => {
        if (!tagIds.has(q.id)) return q;
        const existingTags = Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : []);
        const newTags = [...new Set([...existingTags, marqueCatId])];
        return { ...q, tags: newTags, category_id: q.category_id || marqueCatId };
      }));
    })();

    return () => { cancelled = true; };
  }, [questions, categories, brand, projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const resultsByQ = useMemo(() => {
    const m = {};
    results.forEach(r => { if (!m[r.question_id]) m[r.question_id] = []; m[r.question_id].push(r); });
    return m;
  }, [results]);

  const saveEdit = async () => {
    if (!editingQ?.text?.trim()) return;
    const newText = editingQ.text.trim();
    const qId = editingQ.id;
    // Optimistic update immediately
    setQuestions(prev => prev.map(q => q.id === qId ? { ...q, question: newText } : q));
    setEditingQ(null);
    // Persist to Supabase
    const ok = await sbUpdateQuestion(qId, { question: newText });
    if (!ok) {
      // Revert on failure
      console.error("saveEdit failed — reverting");
      setQuestions(prev => prev.map(q => q.id === qId ? { ...q, question: editingQ.text } : q));
    }
  };

  const addManual = async () => {
    const q = manualQ.trim();
    if (!q) return;
    const saved = await sbSaveQuestions([{ project_id: projectId, site_id: site.id, question: q, is_manual: true }]);
    setQuestions(prev => [...saved, ...prev]);
    setManualQ("");
  };

  // Génère des questions GEO à partir du contenu d'une URL (crawl léger → IA)
  const generateFromUrl = async () => {
    const resolvedKey = providerKeys?.openai?.dec || apiKey;
    const brandName = (brand?.brand_name || "").trim();
    let url = (urlGenUrl || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (!resolvedKey) { setUrlGenStatus("error:Clé OpenAI manquante (⚙️ Gestion des Providers)"); return; }
    const n = Math.max(10, Math.min(25, parseInt(urlGenCount, 10) || 15));
    try {
      // 1) Crawl léger de la page
      setUrlGenStatus("crawl");
      const cres = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const ctext = await cres.text();
      if (ctext.trimStart().startsWith("<")) throw new Error("Proxy /api/crawl introuvable");
      let cdata;
      try { cdata = JSON.parse(ctext); } catch { throw new Error(`Crawl non-JSON (${cres.status})`); }
      if (!cres.ok || cdata.error) throw new Error(cdata.error || `Crawl ${cres.status}`);
      const sections = Array.isArray(cdata.sections) ? cdata.sections : [];
      // Construire un extrait compact du contenu (titres + texte), borné pour le prompt
      const content = sections
        .map(s => [s.title, s.text || s.content || ""].filter(Boolean).join(" : "))
        .join("\n")
        .slice(0, 6000);
      if (!content.trim()) throw new Error("Aucun contenu exploitable sur cette page");

      // 2) Génération des questions via OpenAI
      setUrlGenStatus("gen");
      const aliasList = Array.isArray(brand?.brand_aliases) ? brand.brand_aliases : [];
      const forbiddenNames = [brandName, ...aliasList].map(s => (s || "").trim()).filter(Boolean);
      const forbiddenLine = forbiddenNames.length
        ? `\n- INTERDICTION ABSOLUE : ne mentionne JAMAIS « ${forbiddenNames.join(" », « ")} » (ni aucune variante orthographique) dans les questions. Les questions restent neutres, sans citer la marque du site analysé.`
        : "";
      const prompt = `Tu es un expert GEO (Generative Engine Optimization). À partir du CONTENU ci-dessous (extrait d'une page web), génère exactement ${n} questions de recherche que des utilisateurs poseraient à un moteur IA (ChatGPT, Gemini, Perplexity).

OBJECTIF : chaque question est de TYPE COMPARATIF / CLASSEMENT — sa réponse attendue est un TOP, un palmarès ou une liste de marques, enseignes, sites ou prestataires concrets du secteur. La marque du site analysé ne doit PAS apparaître dans la question : le but est de voir si elle (ou ses concurrents) ressort spontanément dans la réponse de l'IA.

EXEMPLES de bonnes questions (cas d'un site de pergolas) :
- « Quel est le meilleur site pour acheter une pergola ? »
- « Quel prestataire choisir pour installer une pergola ? »
- « Où acheter une pergola bioclimatique de qualité ? »

CONTRAINTES :
- Questions neutres et génériques sur le secteur / les produits / services du contenu${forbiddenLine}
- Formule des questions qui appellent une réponse en LISTE d'acteurs (meilleur, top, quel prestataire, où acheter, quelle enseigne, comparatif…)
- Couvre les différents thèmes/produits/services présents dans le contenu
- Maximum 14 mots par question
- Ton naturel, comme une vraie requête de recherche
- Pas de doublons

CONTENU DE LA PAGE :
"""
${content}
"""

Réponds UNIQUEMENT avec les ${n} questions séparées par des points-virgules (;), sans numérotation, sans texte avant ou après.`;

      const res = await fetch("/api/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Openai-Key": resolvedKey, "X-Openai-Endpoint": "completions" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 700 }),
      });
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error("Proxy /api/openai introuvable");
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Réponse non-JSON (${res.status})`); }
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || data?.error || text.slice(0,120)}`);
      const raw = (data?.choices?.[0]?.message?.content || "").trim();
      if (!raw) throw new Error("Réponse vide");

      const qs = raw
        .split(/[;\n]/)
        .map(s => s.replace(/^\s*\d+[.)\s]+/, "").trim())
        .filter(s => s.length > 5 && s.length < 250);
      // Filet de sécurité : retirer toute question contenant encore la marque ou un alias
      const normQ = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const bannedRe = [brandName, ...(Array.isArray(brand?.brand_aliases) ? brand.brand_aliases : [])]
        .map(normQ).filter(b => b && b.length >= 2)
        .map(b => new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u"));
      const qsClean = qs.filter(q => { const nq = normQ(q); return !bannedRe.some(re => re.test(nq)); });
      // Dédoublonnage vs questions existantes
      const existing = new Set(questions.map(q => (q.question || "").toLowerCase().trim()));
      const fresh = qsClean.filter(q => !existing.has(q.toLowerCase().trim()));
      if (!fresh.length) throw new Error("Aucune nouvelle question générée");

      // 3) Sauvegarde — questions libres rattachées au site (sans mot-clé)
      const saved = await sbSaveQuestions(fresh.map(q => ({
        project_id: projectId, site_id: site.id, question: q, is_manual: false,
      })));
      const savedCount = Array.isArray(saved) ? saved.length : fresh.length;
      setQuestions(prev => [...(Array.isArray(saved) ? saved : []), ...prev]);
      setUrlGenStatus(`done:${savedCount}`);
      setUrlGenUrl("");
    } catch (e) {
      console.error("generateFromUrl:", e);
      setUrlGenStatus("error:" + (e.message || "échec"));
    }
  };

  const importCsvQuestions = async (file) => {
    if (!file) return;
    setCsvImporting(true);
    try {
      const text = await file.text();

      // Parseur robuste : détecte le séparateur (, ; ou tabulation) sur la 1re
      // ligne, hors guillemets, et respecte les champs entre guillemets.
      const parseDelimited = (raw) => {
        const firstLine = (raw.split(/\r?\n/).find(l => l.trim()) || "");
        const counts = { ",": 0, ";": 0, "\t": 0 }; let inQ0 = false;
        for (const ch of firstLine) { if (ch === '"') inQ0 = !inQ0; else if (!inQ0 && counts[ch] !== undefined) counts[ch]++; }
        const sep = (counts[";"] >= counts[","] && counts[";"] >= counts["\t"]) ? ";" : (counts["\t"] > counts[","] ? "\t" : ",");
        const out = []; let row = [], field = "", inQ = false;
        const endField = () => { row.push(field); field = ""; };
        const endRow = () => { endField(); if (row.some(c => c.trim() !== "")) out.push(row); row = []; };
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (inQ) {
            if (c === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
          } else if (c === '"') inQ = true;
          else if (c === sep) endField();
          else if (c === "\n") endRow();
          else if (c === "\r") { /* ignore */ }
          else field += c;
        }
        if (field.length || row.length) endRow();
        return out;
      };

      let rows = parseDelimited(text).filter(r => Array.isArray(r) && (r[0] || "").trim());

      // Sauter une éventuelle ligne d'en-tête (1re cellule = mot d'en-tête connu).
      const h0 = (rows[0]?.[0] || "").trim().toLowerCase();
      if (["question", "questions", "query", "requête", "keyword", "mot-clé"].includes(h0)) rows = rows.slice(1);

      // Mapping favori (col 2) et intention (col 4)
      const TRUTHY = new Set(["true", "1", "oui", "yes", "vrai", "x", "⭐", "favori", "favorite", "y"]);
      const intentLookup = {};
      QUESTION_INTENTS.forEach(i => { intentLookup[i.id] = i.id; intentLookup[i.label.toLowerCase()] = i.id; intentLookup[i.short.toLowerCase()] = i.id; });

      // Résolution des catégories (col 3) : réutilise l'existant, crée le manquant.
      const catByName = {};
      (categories || []).forEach(c => { catByName[(c.name || "").trim().toLowerCase()] = c.id; });
      const ensureCategory = async (name) => {
        const key = name.trim().toLowerCase();
        if (!key) return null;
        if (catByName[key]) return catByName[key];
        try {
          const cat = await sbSaveCategory({ project_id: projectId, name: name.trim(), color: "#1A3C2E" });
          catByName[key] = cat.id;
          setCategories(prev => prev.some(c => c.id === cat.id) ? prev : [...prev, cat]);
          return cat.id;
        } catch { return null; }
      };

      const existingInBase = new Set(questions.map(q => (q.question || "").trim().toLowerCase()));

      // Mapping nom de marque / libellé de site → id de site (col 5).
      const brandToSite = {};
      (allSites || []).forEach(s => { if (s.label) brandToSite[s.label.trim().toLowerCase()] = s.id; });
      Object.entries(siteBrandsMap || {}).forEach(([sid, b]) => { if (b && b.brand_name) brandToSite[b.brand_name.trim().toLowerCase()] = sid; });

      const seen = new Set();
      const toAdd = [];
      for (const cols of rows) {
        const question = (cols[0] || "").replace(/^["']|["']$/g, "").trim();
        if (!question || question.length <= 5) continue;
        const key = question.toLowerCase();
        if (existingInBase.has(key) || seen.has(key)) continue;
        seen.add(key);

        const favRaw = (cols[1] || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
        const is_favorite = TRUTHY.has(favRaw);

        const row = { project_id: projectId, site_id: site.id, question, is_manual: true, is_favorite };

        const catName = (cols[2] || "").replace(/^["']|["']$/g, "").trim(); // col 3 : catégorie (vide → ignorer)
        if (catName) { const cid = await ensureCategory(catName); if (cid) row.category_id = cid; }

        const intentRaw = (cols[3] || "").replace(/^["']|["']$/g, "").trim().toLowerCase(); // col 4 : intention (vide → ignorer)
        if (intentRaw && intentLookup[intentRaw]) row.intent = intentLookup[intentRaw];

        // col 5 : marques concernées, séparées par des virgules.
        // Vide → TOUTES les marques du projet (associated_sites = tous les sites),
        // pour que « toutes concernées » soit explicite et lu de façon cohérente
        // partout. Marques non reconnues → ignorées.
        const brandsRaw = (cols[4] || "").replace(/^["']|["']$/g, "").trim();
        if (brandsRaw) {
          const ids = brandsRaw.split(",").map(x => brandToSite[x.trim().toLowerCase()]).filter(Boolean);
          if (ids.length) row.associated_sites = [...new Set(ids)];
        } else {
          row.associated_sites = (allSites || []).map(s => s.id);
        }

        toAdd.push(row);
      }

      if (toAdd.length === 0) {
        alert("Aucune nouvelle question à importer (doublons ou fichier vide).");
        return;
      }

      const batchSize = 50;
      const allSaved = [];
      for (let i = 0; i < toAdd.length; i += batchSize) {
        const saved = await sbSaveQuestions(toAdd.slice(i, i + batchSize));
        allSaved.push(...(saved || []));
      }

      // Persiste les marques via le MÊME chemin que l'éditeur manuel (PATCH fiable),
      // car associated_sites n'est pas repris de façon fiable par l'insert initial.
      const assocByQuestion = {};
      toAdd.forEach(r => { if (Array.isArray(r.associated_sites)) assocByQuestion[r.question.trim().toLowerCase()] = r.associated_sites; });
      for (const sv of allSaved) {
        const assoc = assocByQuestion[(sv.question || "").trim().toLowerCase()];
        if (assoc) { try { await sbSetQuestionSites(sv.id, assoc); sv.associated_sites = assoc; } catch { /* colonne non migrée : ignoré */ } }
      }

      setQuestions(prev => [...allSaved, ...prev]);
      alert(`✓ ${allSaved.length} question${allSaved.length > 1 ? "s" : ""} importée${allSaved.length > 1 ? "s" : ""} sur ${toAdd.length} détectée${toAdd.length > 1 ? "s" : ""}.`);
    } catch(e) {
      console.error("CSV import error:", e);
      alert("Erreur lors de l'import : " + e.message);
    } finally {
      setCsvImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  const MAX_FAVORITES = 50;
  const toggleFav = async (qId, cur) => {
    // Blocage : pas plus de 50 favoris (limite d'interrogation automatique)
    if (!cur) {
      const favCount = questions.filter(q => q.is_favorite).length;
      if (favCount >= MAX_FAVORITES) {
        alert(`Maximum ${MAX_FAVORITES} questions favorites. Retirez-en une avant d'en ajouter une nouvelle.`);
        return;
      }
    }
    await sbUpdateQuestion(qId, { is_favorite: !cur });
    const sy = window.scrollY;
    setQuestions(prev => prev.map(q => q.id === qId ? { ...q, is_favorite: !cur } : q));
    // Empêche tout retour en haut de page suite au re-render de la liste
    requestAnimationFrame(() => { if (Math.abs(window.scrollY - sy) > 4) window.scrollTo(0, sy); });
  };

  const deleteQ = async (qId) => {
    await sbDeleteQuestion(qId);
    setQuestions(prev => prev.filter(q => q.id !== qId));
    setSelected(prev => { const n = new Set(prev); n.delete(qId); return n; });
  };

  // ── Assigner ou créer un mot-clé pour une question ─────────────
  const assignKeyword = async (q, kwName) => {
    const trimmed = kwName.trim();
    if (!trimmed) {
      await sbUpdateQuestion(q.id, { keyword_id: null }).catch(() => {});
      setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, keyword_id: null } : qq));
      setEditingKw(null); setKwInput("");
      return;
    }
    const existing = keywords.find(k => k.keyword.toLowerCase() === trimmed.toLowerCase());
    let kwId;
    if (existing) {
      kwId = existing.id;
    } else {
      const saved = await sbSaveKeywords([{
        project_id: projectId, site_id: site.id,
        keyword: trimmed, status: "done_q",
      }]).catch(() => []);
      if (!saved?.length) return;
      kwId = saved[0].id;
      setKeywords(prev => [{ ...saved[0], question_count: 1 }, ...prev]);
    }
    await sbUpdateQuestion(q.id, { keyword_id: kwId }).catch(() => {});
    setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, keyword_id: kwId } : qq));
    if (existing) {
      setKeywords(prev => prev.map(k => k.id === kwId ? { ...k, question_count: (k.question_count || 0) + 1 } : k));
    }
    setEditingKw(null); setKwInput("");
  };

  const removeCatFromQuestion = async (qId, catId) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== qId) return q;
      const newTags = (Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : [])).filter(t => t !== catId);
      const newPrimary = newTags[0] || null;
      sbSetQuestionCategory(qId, newPrimary).catch(() => {});
      sbSetKeywordTags(qId, newTags).catch(() => {});
      return { ...q, category_id: newPrimary, tags: newTags };
    }));
  };

  const applyBulkCat = async () => {
    if (!selected.size || !bulkCat) return; // Ne rien faire si pas de catégorie sélectionnée
    const ids = [...selected];
    await sbBulkSetQuestionCategory(ids, bulkCat);
    setQuestions(prev => prev.map(q => {
      if (!selected.has(q.id)) return q;
      // Multi-cat : ajouter la catégorie aux tags existants sans dupliquer
      const existingTags = Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : []);
      const newTags = existingTags.includes(bulkCat) ? existingTags : [...existingTags, bulkCat];
      return { ...q, category_id: bulkCat, tags: newTags };
    }));
    setSelected(new Set()); setBulkCat("");
  };



  // Run a single provider on a single question
  const runProvider = useCallback(async (q, provider) => {
    if (isReadOnly) return; // lecture seule : aucun appel LLM
    const pk = providerKeysRef.current[provider.id];
    if (!pk?.dec) { console.warn("No key for provider", provider.id); return; }
    setRunning(r => ({ ...r, [`${q.id}-${provider.id}`]: true }));
    const { brand_name = "", brand_aliases = [], context = "" } = brand || {}; // competitors vient du PROP (liste chargée), pas de brand

    // ── Modèle + mode choisis pour ce provider (config localStorage) ──
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(`geoProviderCfg_${projectId}`) || "{}")[provider.id] || {}; } catch { cfg = {}; }
    const chosenModel = cfg.model || provider.model;
    const modeId = cfg.mode || "standard";
    const modeMaxTokens = modeId === "discussion" ? 3072 : modeId === "fidelity" ? 2048 : 1024;
    const useWebSearch = webSearchEnabled(provider.id, webSearchSettings); // réglage BDD (projet)
    const prompt = buildPrompt(provider.id, q.question, context, modeId);
    const effectiveProvider = { ...provider, model: chosenModel };
    try {
      await throttleProvider(provider.id); // respecte l'intervalle mini du provider (anti-429 RPM)
      const parsed = await callProvider(effectiveProvider, pk.dec, prompt, modeMaxTokens, "", useWebSearch);
      const detectedBrand = detectBrand(parsed.answer, parsed.sources, brand_name, brand_aliases, competitors);
      const { brandMentioned, brandPosition, brandInSources, competitorsMentioned, unknownEntities } = detectedBrand;

      // ── Temps 2 : présence par marque associée (détectée dans la MÊME réponse) ──
      // Aucun appel LLM supplémentaire : on ré-applique detectBrand localement pour
      // chaque marque concernée. associated_sites vide = TOUTES les marques du projet.
      const _assocRaw = Array.isArray(q.associated_sites) ? q.associated_sites : [];
      const _assoc = _assocRaw.length ? _assocRaw : (allSites || []).map(s => s.id);
      const brand_presences = {};
      if (_assoc.length) {
        const _toPres = (d) => ({
          mentioned: !!d.brandMentioned,
          mention_position:   d.mention?.position   ?? null,
          evocation_position: d.evocation?.position ?? null,
          citation_position:  d.citation?.position  ?? null,
          in_sources: !!d.brandInSources,
        });
        brand_presences[site.id] = _toPres(detectedBrand); // marque du site courant (déjà détectée)
        _assoc.forEach(sid => {
          if (sid === site.id) return;
          const sb = siteBrandsMap[sid];
          if (!sb || !sb.brand_name) return;
          const d = detectBrand(parsed.answer, parsed.sources, sb.brand_name, sb.brand_aliases || [], []);
          brand_presences[sid] = _toPres(d);
        });
      }

      const domain_counts = {};
      (parsed.sources || []).forEach(url => {
        if (!domain_counts[url]) domain_counts[url] = { as_source: 0, in_answer: 0, domain: extractDomain(url) };
        domain_counts[url].as_source++;
      });
      await Promise.all(Object.entries(domain_counts).map(([url, counts]) => sbIncrementUrlCounts(projectId, url, counts)));
      const now = new Date().toISOString();
      const record = {
        question_id: q.id, project_id: projectId, site_id: site.id,
        model: `${provider.label} (${chosenModel})`,
        answer: parsed.answer, answer_type: parsed.answer_type, intent_type: parsed.intent_type,
        sources: parsed.sources, source_types: parsed.source_types,
        brand_mentioned: brandMentioned, brand_position: brandPosition,
        brand_in_sources: brandInSources, competitors_mentioned: competitorsMentioned, unknown_entities: unknownEntities || [],
        // Nouveaux champs de présence détaillés
        brand_mention_position:   detectedBrand.mention?.position   || null,
        brand_evocation_position: detectedBrand.evocation?.position || null,
        brand_citation_position:  detectedBrand.citation?.position  || null,
        ...(Object.keys(brand_presences).length ? { brand_presences } : {}),
        input_tokens: parsed._input_tokens, output_tokens: parsed._output_tokens,
        web_searches: parsed._web_searches ?? null,
        created_at: now,
      };
      // Optimistic local update — immediately update the card
      const pid = getProviderId(record.model);
      const optimisticResult = { ...record, id: `tmp-${pid}-${q.id}`, provider_id: pid };
      setResults(prev => {
        const existing = prev.findIndex(r => r.question_id === q.id && getProviderId(r.model) === pid);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { ...updated[existing], ...optimisticResult };
          return updated;
        }
        return [optimisticResult, ...prev];
      });

      // Persist to Supabase in background — update with real id when done
      sbSaveGeoResult(record).then(saved => {
        const real = Array.isArray(saved) ? saved[0] : saved;
        if (real?.id) {
          setResults(prev => prev.map(r =>
            r.id === optimisticResult.id ? { ...r, ...real } : r
          ));
        }
      }).catch(e => console.error("sbSaveGeoResult error:", e));

      // Optimiste : porte TOUTES les marques détectées, pas seulement la principale,
      // pour que chaque ligne de marque affiche son carré immédiatement.
      const _calPres = Object.keys(brand_presences).length ? brand_presences : { [site.id]: {
        mentioned: brandMentioned,
        mention_position: detectedBrand.mention?.position ?? null,
        evocation_position: detectedBrand.evocation?.position ?? null,
        citation_position: detectedBrand.citation?.position ?? null,
        in_sources: brandInSources,
      } };
      setNewCalEntries(prev => ({ ...prev, [`${q.id}|${provider.id}`]: { provider_id: provider.id, presences: _calPres, at: Date.now() } }));
      // Persiste UNE entrée calendrier PAR MARQUE (site_id). Même dérivation que
      // l'affichage optimiste (presenceType) → run et affichage sont garantis identiques.
      Object.entries(_calPres).forEach(([sid, pres]) => {
        const pType = presenceType(pres);
        sbAddCalendarEntry(q.id, provider.id, (pres.mentioned || pType === "citation"), pType, pres.mention_position ?? null, sid).catch(() => {});
      });

      // Update cached answers on question
      const cachePatch = { has_result: true, last_answer: parsed.answer, last_model: record.model, last_date: now };
      if (brandMentioned) Object.assign(cachePatch, { best_answer: parsed.answer, best_model: record.model, best_date: now });
      sbUpdateQuestion(q.id, cachePatch).catch(() => {});
      setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, ...cachePatch } : qq));
      // Notify parent for global stats (non-blocking)
      onResultSaved?.();
    } catch(e) {
      console.error(`runProvider ${provider.id} error:`, e);
      // Afficher l'erreur dans l'UI (badge rouge sur la ligne provider)
      setProviderErrors(prev => ({ ...prev, [`${q.id}-${provider.id}`]: e.message }));
      // Auto-clear après 30s
      setTimeout(() => setProviderErrors(prev => { const n = {...prev}; delete n[`${q.id}-${provider.id}`]; return n; }), 30000);
    }
    setRunning(r => ({ ...r, [`${q.id}-${provider.id}`]: false }));
  }, [brand, projectId, site?.id, providerKeys, onResultSaved, isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per question: latest result (most recent by created_at)
  const latestResultByQ = useMemo(() => {
    const out = {};
    Object.entries(resultsByQ).forEach(([qId, results]) => {
      if (!results.length) return;
      const sorted = [...results].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      out[qId] = sorted[0];
    });
    return out;
  }, [resultsByQ]);

  // ── Rang de tri "par résultat" (pour le bouton trier) ───────────────
  // Ordre voulu : 1) mentions par position croissante (Top1, Top2…)
  //               2) évocations sans mention
  //               3) citations sans mention ni évocation
  //               4) le reste (aucune présence / sans résultat)
  // On agrège TOUS les résultats d'une question et on garde sa meilleure présence.
  const resultRankByQ = useMemo(() => {
    const out = {};
    const allQIds = new Set([...Object.keys(resultsByQ), ...questions.map(q => q.id)]);
    allQIds.forEach(qId => {
      const rs = resultsByQ[qId] || [];
      let bestMentionPos = null, hasEvocation = false, hasCitation = false;
      rs.forEach(r => {
        const mPos = r.brand_mention_position ?? (r.brand_position != null && r.brand_position > 0 ? r.brand_position : null);
        if (mPos != null && mPos > 0) {
          if (bestMentionPos == null || mPos < bestMentionPos) bestMentionPos = mPos;
        }
        const evPos = r.brand_evocation_position;
        if (evPos != null || (r.brand_mentioned === true || r.brand_mentioned === 1)) hasEvocation = true;
        if (r.brand_citation_position != null || r.brand_in_sources) hasCitation = true;
      });
      // tier : 0 = mention, 1 = évocation, 2 = citation, 3 = reste
      let tier, pos;
      if (bestMentionPos != null) { tier = 0; pos = bestMentionPos; }
      else if (hasEvocation)      { tier = 1; pos = 0; }
      else if (hasCitation)       { tier = 2; pos = 0; }
      else                        { tier = 3; pos = 0; }
      out[qId] = { tier, pos };
    });
    return out;
  }, [resultsByQ, questions]);

  // Per question: était positionnée dans les 30 derniers jours (carré vert calendrier)
  // mais absente du dernier résultat → "Positionnée précédemment"
  const lostByQ = useMemo(() => {
    const out = {};

    // Cutoff en string YYYY-MM-DD pour comparer directement avec test_date (évite les bugs timezone)
    const cutoffStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Grouper les entrées calendar par question_id
    const calByQ = {};
    calendarEntries.forEach(e => {
      if (!e.question_id) return;
      if (!calByQ[e.question_id]) calByQ[e.question_id] = [];
      calByQ[e.question_id].push(e);
    });

    // Parcourir toutes les questions qui ont des entrées calendar OU des résultats
    const allQIds = new Set([...Object.keys(resultsByQ), ...Object.keys(calByQ)]);

    allQIds.forEach(qId => {
      // Condition 1 : marque absente du dernier résultat connu
      const latest = latestResultByQ[qId];
      const latestAbsent = !latest || !(latest.brand_mentioned === true || latest.brand_mentioned === 1);
      if (!latestAbsent) return; // encore positionnée → pas "perdue"

      // Condition 2 : au moins un carré vert dans les 30 derniers jours
      // test_date est une string "YYYY-MM-DD" — comparaison string directe, pas de Date()
      const entries = calByQ[qId] || [];
      const hadGreenIn30d = entries.some(e => {
        const dateStr = e.test_date || (e.created_at || "").slice(0, 10);
        return dateStr >= cutoffStr && (e.brand_present === true || e.brand_present === 1);
      });

      if (hadGreenIn30d) out[qId] = true;
    });

    return out;
  }, [calendarEntries, resultsByQ, latestResultByQ]);

  const filtered = useMemo(() => { const bn = brand?.brand_name || ""; const base = sortedQuestions.filter(q => {
    // Filtres cumulatifs (ET)
    // Marque : une question est visible si elle ne cible AUCUNE marque
    // (associated_sites vide = toutes) OU si ses marques intersectent la sélection.
    const assoc = Array.isArray(q.associated_sites) ? q.associated_sites : [];
    if (assoc.length && !assoc.some(sid => _readIds.includes(sid))) return false;
    if (filterFav && !q.is_favorite) return false;
    if (filterCat.length && !filterCat.includes(q.category_id)) return false;
    if (filterKeyword && q.keyword_id !== filterKeyword) return false;
    if (filterSearch) {
      // Construire le texte cible selon le champ choisi (question/réponse/mention/évocation/citation)
      const qRes = resultsByQ[q.id] || [];
      let haystack = "";
      if (searchField === "question") {
        haystack = q.question || "";
      } else if (searchField === "answer") {
        haystack = qRes.map(r => r.answer || "").join("\n");
      } else if (searchField === "mention") {
        // éléments classés (mention) : nom de la marque/concurrents positionnés
        haystack = qRes.flatMap(r => [
          ...((r.brand_mention_position != null) ? [bn] : []),
          ...(r.competitors_mentioned || []).filter(c => c.position != null && c.position > 0).map(c => c.name),
        ]).join(" ");
      } else if (searchField === "evocation") {
        haystack = qRes.flatMap(r => [
          ...((r.brand_mentioned && r.brand_mention_position == null) ? [bn] : []),
          ...(r.competitors_mentioned || []).filter(c => c.mentioned && !(c.position != null && c.position > 0)).map(c => c.name),
        ]).join(" ");
      } else if (searchField === "citation") {
        haystack = qRes.flatMap(r => (r.sources || [])).join(" ");
      }
      let ok = false;
      try { ok = new RegExp(filterSearch, 'i').test(haystack); } catch { ok = false; }
      if (!ok) {
        // Repli robuste aux accents : dé-échappe le terme et compare en normalisant (NFD)
        const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const literal = filterSearch.replace(/\\(.)/g, "$1");
        ok = norm(haystack).includes(norm(literal));
      }
      if (!ok) return false;
    }
    // Positionné ET/OU Positionné précédemment — condition OU non-exclusif si les deux sont actifs
    if (filterPositioned || filterLost) {
      const latest = latestResultByQ[q.id];
      const isPositioned = !!(latest && (latest.brand_mentioned === true || latest.brand_mentioned === 1));
      const isLost = !!lostByQ[q.id];
      // OU non-exclusif : la question doit matcher au moins un des filtres actifs
      const matchPositioned = filterPositioned && isPositioned;
      const matchLost = filterLost && isLost;
      if (!matchPositioned && !matchLost) return false;
    }
    return true;
  });
    // Tri optionnel "par résultat" : mentions (pos croissante) → évocations → citations → reste.
    // À égalité de tier/pos, on conserve l'ordre de base (favoris-first puis mot-clé).
    if (!sortByResult) return base;
    return base
      .map((q, i) => ({ q, i, rank: resultRankByQ[q.id] || { tier: 3, pos: 0 } }))
      .sort((a, b) => {
        // Favoris toujours en tête, même en tri par résultat (stabilité de position)
        if (!!a.q.is_favorite !== !!b.q.is_favorite) return a.q.is_favorite ? -1 : 1;
        if (a.rank.tier !== b.rank.tier) return a.rank.tier - b.rank.tier;
        if (a.rank.pos !== b.rank.pos)   return a.rank.pos - b.rank.pos; // position croissante (Top1 avant Top2)
        return a.i - b.i; // stabilité : ordre de base
      })
      .map(x => x.q);
  }, [questions, _readKey, filterFav, filterCat, filterKeyword, filterSearch, searchField, providerModes, filterPositioned, filterLost, resultsByQ, latestResultByQ, lostByQ, sortByResult, resultRankByQ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Returns providers that still need to be called for a question today
  const getProvidersToRun = (q, force = false) => {
    const currentKeys = providerKeysRef.current;
    const currentActive = activeProvidersRef.current;
    let configuredProviders = PROVIDERS.filter(p => currentActive.includes(p.id) && (p.external || currentKeys[p.id]?.dec));
    // Seuls les providers en état "used" (pills au-dessus des questions) sont interrogés.
    configuredProviders = configuredProviders.filter(p => providerMode(p.id) === "used");
    if (force) return configuredProviders; // always run all when forced (individual ▶ button)
    const today = new Date().toISOString().slice(0, 10);
    const qResults = resultsByQ[q.id] || [];
    return configuredProviders.filter(p => {
      // Skip if already generated today for this provider
      const alreadyToday = qResults.some(r =>
        getProviderId(r.model) === p.id &&
        r.created_at && r.created_at.slice(0, 10) === today
      );
      return !alreadyToday;
    });
  };

  const runAllQuestions = async () => {
    if (isReadOnly) return; // lecture seule : aucun lancement
    const toRun = filtered
      .map(q => ({ q, providers: getProvidersToRun(q, false) }))
      .filter(({ providers }) => providers.length > 0);
    if (!toRun.length) return;
    stopAllRef.current = false;
    setRunAll(true);
    for (const { q, providers } of toRun) {
      if (stopAllRef.current) break;
      setRunning(r => ({ ...r, [q.id]: true }));
      // Providers externes (AI Overview) : on enfile une demande pour le scraper
      // local, comme un provider à part entière. Les autres : appel API direct.
      await Promise.all(providers.map(p => p.external ? Promise.resolve(enqueueAio(q.id)) : runProvider(q, p)));
      setRunning(r => ({ ...r, [q.id]: false }));
    }
    setRunAll(false);
  };

  const { brand_name = "", brand_aliases = [] } = brand || {};

  // Results for filtered questions, filtered by provider selection
  // Count questions to generate for "Lancer tout" indicator
  const toRunCount = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const configuredProviders = PROVIDERS.filter(p =>
      activeProviders.includes(p.id) && (p.external || providerKeys[p.id]?.dec)
    );
    if (!configuredProviders.length) return 0;
    return filtered.filter(q => {
      const qResults = resultsByQ[q.id] || [];
      // Count questions that have at least one provider not yet done today
      return configuredProviders.some(p =>
        !qResults.some(r =>
          getProviderId(r.model) === p.id &&
          r.created_at && r.created_at.slice(0, 10) === today
        )
      );
    }).length;
  }, [filtered, resultsByQ, activeProviders, providerKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // Au moins un provider actif possède une clé API ? (sinon "Lancer tout" est impossible)
  const hasConfiguredProviders = useMemo(
    () => PROVIDERS.some(p => activeProviders.includes(p.id) && providerKeys[p.id]?.dec),
    [activeProviders, providerKeys] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Recalcul de la détection sur l'historique (sans re-interroger les modèles) ──
  // Re-passe detectBrand sur les réponses déjà stockées avec la liste de concurrents
  // actuelle, et met à jour competitors_mentioned / unknown_entities / positions.
  const recomputeDetection = async () => {
    if (isReadOnly) return; // lecture seule : pas d'écriture
    if (recomputing) return;
    const rows = (results && results.length ? results : allResults) || [];
    const real = rows.filter(r => r && r.id && !String(r.id).startsWith("tmp-") && r.answer);
    if (!real.length) { setRecomputeMsg("Aucun résultat à recalculer."); return; }
    const { brand_name = "", brand_aliases = [] } = brand || {};
    const comps = (competitors || []);
    // Toutes les marques du projet (pour brand_presences). On part de TOUS les sites
    // du projet (allSites) et non de site_brand seul — souvent incomplet sur les
    // anciens projets. Nom de marque : site_brand si présent, sinon le label du site.
    const brandList = (allSites || []).map(s => {
      const b = (siteBrandsMap || {})[s.id];
      return { siteId: s.id, brandName: (b && b.brand_name) || s.label || "", brandAliases: (b && b.brand_aliases) || [] };
    }).filter(b => b.siteId && b.brandName);
    if (!brandList.length && brand_name) brandList.push({ siteId: site.id, brandName: brand_name, brandAliases: brand_aliases });
    setRecomputing(true);
    setRecomputeMsg(`Recalcul… 0/${real.length}`);
    let done = 0, errs = 0;
    for (const r of real) {
      try {
        const d = detectBrand(r.answer || "", r.sources || [], brand_name, brand_aliases, comps);
        // Détection de TOUTES les marques → brand_presences (comme à l'interrogation).
        const brand_presences = {};
        for (const b of brandList) {
          const db = detectBrand(r.answer || "", r.sources || [], b.brandName, b.brandAliases, comps);
          brand_presences[b.siteId] = {
            mentioned: !!db.brandMentioned,
            mention_position:   db.mention?.position   ?? null,
            evocation_position: db.evocation?.position ?? null,
            citation_position:  db.citation?.position  ?? null,
            in_sources: !!db.brandInSources,
          };
        }
        await sbSaveGeoResult({
          question_id: r.question_id, project_id: projectId, site_id: site.id,
          model: r.model,
          answer: r.answer, answer_type: r.answer_type, intent_type: r.intent_type,
          sources: r.sources || [], source_types: r.source_types || [],
          brand_mentioned: d.brandMentioned, brand_position: d.brandPosition, brand_in_sources: d.brandInSources,
          competitors_mentioned: d.competitorsMentioned, unknown_entities: d.unknownEntities || [],
          brand_mention_position:   d.mention?.position   || null,
          brand_evocation_position: d.evocation?.position || null,
          brand_citation_position:  d.citation?.position  || null,
          brand_presences,
          input_tokens: r.input_tokens, output_tokens: r.output_tokens,
          web_searches: r.web_searches ?? null,
          created_at: r.created_at, // préserve la date d'origine
        });
        // Carré PAR MARQUE à la date d'origine.
        const provId  = getProviderId(r.model);
        const calDate = (r.created_at || new Date().toISOString()).slice(0, 10);
        for (const [sid, pres] of Object.entries(brand_presences)) {
          const pType = pres.mention_position != null ? "mention" : pres.evocation_position != null ? "evocation" : (pres.in_sources ? "citation" : null);
          await sbUpsertCalendarEntry(r.question_id, provId, calDate, !!(pres.mentioned || pType === "citation"), pType, pres.mention_position ?? null, sid);
        }
        done++;
      } catch (e) { errs++; console.error("recomputeDetection:", e); }
      setRecomputeMsg(`Recalcul… ${done + errs}/${real.length}`);
    }
    // Recharge le calendrier depuis la base → les carrés reflètent la détection à jour
    try { const fresh = (await Promise.all((Array.isArray(readSiteIds) && readSiteIds.length ? readSiteIds : [site.id]).map(sid => sbGetCalendarEntriesBatch(projectId, sid).catch(() => [])))).flat(); setCalendarEntries(fresh || []); } catch { /* best effort */ }
    setRecomputing(false);
    setRecomputeMsg(`Terminé : ${done} résultat(s) recalculé(s)${errs ? `, ${errs} erreur(s)` : ""}.`);
    onResultSaved?.(); // recharge les résultats → les tops se mettent à jour
  };

  return (
    <div>
      {/* ── Suivi chronologique : mentions / évocations / citations ── */}
      {calResults.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {/* Switch Cumulé / Comparaison — visible dès 2 marques sélectionnées */}
          {_readIds.length > 1 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <span style={{ display: "inline-flex", border: "0.5px solid #1A3C2E18", borderRadius: 20, overflow: "hidden" }}>
                {[["cumule", "Cumulé"], ["compare", "Comparaison"]].map(([v, lbl]) => (
                  <button key={v} onClick={() => setMecView(v)}
                    style={{ padding: "3px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
                      background: mecView === v ? "#1A7A4A10" : "transparent", color: mecView === v ? "#1A7A4A" : "#94A3B8" }}
                    title={v === "cumule" ? "Somme des marques sélectionnées" : "Une courbe et un jeu de chiffres par marque"}>
                    {lbl}
                  </button>
                ))}
              </span>
            </div>
          )}
          <PresenceTrendChart
            results={calResults}
            calendarEntries={calendarEntries}
            dailyRows={dailyRows}
            siteIds={_readIds}
            view={_readIds.length > 1 ? mecView : "cumule"}
            brands={(allSites || []).filter(s => _readIds.includes(s.id)).map(s => ({ id: s.id, label: s.label, color: s.color }))}
            compareMetric={compareMetric}
            onCompareMetricChange={setCompareMetric}
            minDate={earliestSelectableDate(project, calResults, calendarEntries)}
            title="Suivi Chronologique"
            compact
            mode={mecMode}
            onModeChange={setMecMode}
          />
        </div>
      )}

      {/* ── Onboarding : aucune question encore renseignée ── */}
      {questions.length === 0 && !isReadOnly && (
        <div style={{ border: "1px solid #1A3C2E22", borderRadius: 14, padding: "20px 22px", marginBottom: 22, background: "linear-gradient(180deg,#FFFFFF,#F6F8F7)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A3C2E", marginBottom: 3 }}>Pour lancer votre projet</div>
          <div style={{ fontSize: 12.5, color: "#1A3C2E", opacity: 0.75, marginBottom: 18 }}>Deux étapes pour commencer à mesurer votre visibilité dans les LLMs.</div>

          {/* Étape 1 — Configuration */}
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: "50%", background: "#1A3C2E", color: "#F0EBE0", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>1</span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1A3C2E" }}>Configurez vos accès API</div>
              <div style={{ fontSize: 12.5, color: "#1A3C2E", lineHeight: 1.6, marginTop: 3 }}>
                Rendez-vous dans l'onglet <strong>⚙ Configuration</strong> pour brancher vos clés API. <strong>Claude (Anthropic)</strong> et <strong>OpenAI</strong> sont indispensables pour certaines actions : Claude génère les questions et produit les analyses « Et maintenant ? » et l'audit ; OpenAI permet d'interroger ChatGPT. Sans au moins une clé, l'interrogation des modèles est impossible.
              </div>
            </div>
          </div>

          {/* Étape 2 — Questions */}
          <div style={{ display: "flex", gap: 12 }}>
            <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: "50%", background: "#1A3C2E", color: "#F0EBE0", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>2</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1A3C2E" }}>Renseignez vos questions</div>
              <div style={{ fontSize: 12.5, color: "#1A3C2E", lineHeight: 1.6, marginTop: 3, marginBottom: 10 }}>Quatre méthodes, au choix — chacune précise où agir :</div>
              <div style={{ display: "grid", gap: 8 }}>
                {[
                  ["a", "À partir de mots-clés", "Onglet ⚙ Mots-clés : ajoutez vos mots-clés, puis générez les questions associées."],
                  ["b", "À partir de l'URL du site", "Ici, onglet Questions → bouton « Générer depuis une URL » : la page est crawlée et l'IA en déduit des questions."],
                  ["c", "À partir d'un fichier CSV", "Ici, onglet Questions → bouton d'import CSV : une question par ligne."],
                  ["d", "À la main", "Ici, onglet Questions → bouton « + Ajouter » pour saisir vos questions une à une."],
                ].map(([k, t, d]) => (
                  <div key={k} style={{ display: "flex", gap: 8, background: "#1A3C2E06", borderRadius: 8, padding: "8px 10px" }}>
                    <span style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: "#E8541A" }}>{k})</span>
                    <div>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1A3C2E" }}>{t}</span>
                      <span style={{ fontSize: 12, color: "#1A3C2E", opacity: 0.85 }}> — {d}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Et maintenant ? — plan d'action priorisé ── */}
      <NextStepsAnalysis
        questions={questions}
        results={results}
        brand={brand}
        categories={categories}
        gscRows={gscRows}
        claudeKey={providerKeysRef.current["claude"]?.dec || ""}
        projectId={projectId}
        siteId={site?.id}
      />

      {/* ── Stats header (filtered) ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 6 }}>
        {recomputeMsg && <span style={{ fontSize: 11, color: recomputing ? "#C97820" : "#1A7A4A" }}>{recomputeMsg}</span>}
        <button onClick={recomputeDetection} disabled={recomputing}
          className="gt-btn gt-btn--ghost" style={{ fontSize: 11, opacity: recomputing ? 0.5 : 1 }}
          title="Re-détecte TOUTES les marques du projet et les concurrents sur les réponses déjà enregistrées (sans ré-interroger les modèles, donc sans coût). Remplit les carrés des marques ajoutées après coup.">
          {recomputing ? "Recalcul…" : "↻ Recalculer la détection"}
        </button>
      </div>
      <div data-tour="stats-header"><StatsHeader questions={filtered} results={calResults} brandName={brand_name} qualifiedCompetitors={competitors.filter(c => c.enabled !== false)} aliasMap={aliasMap} mode={mecMode} siteIds={_readIds} view={_readIds.length > 1 ? mecView : "cumule"} statBrands={(allSites || []).filter(s => _readIds.includes(s.id)).map(s => ({ id: s.id, label: s.label, color: s.color }))}
            onTopClick={(field, name) => { setSearchField(field); setFilterSearch(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }} /></div>

      {/* ══════════════════════════════════════════════════════
           ZONE AJOUT + FILTRES + ACTIONS
           Layout : 3 lignes séparées par des dividers 0.5px
           ══════════════════════════════════════════════════════ */}
      <div style={{ marginBottom: 20 }}>

        {/* ── Ligne 1 : Ajout de questions ── */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>

          {/* Saisie manuelle */}
          <input
            value={manualQ}
            onChange={e => setManualQ(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addManual()}
            placeholder="Ajouter une question…"
            className="gt-input"
            style={{ flex: "1 1 260px", minWidth: 200 }}
          />
          <button
            onClick={addManual}
            disabled={!manualQ.trim()}
            className="gt-btn"
            style={{ opacity: !manualQ.trim() ? 0.35 : 1 }}>
            + Ajouter
          </button>

          {/* Séparateur vertical */}
          <div style={{ width: "0.5px", height: 20, background: "#1A3C2E18", flexShrink: 0 }} />

          {/* Import CSV */}
          <input ref={csvInputRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; setCsvOverlay(false); importCsvQuestions(f); e.target.value = ""; }} />
          <button
            onClick={() => setCsvOverlay(true)}
            disabled={csvImporting}
            className="gt-btn gt-btn--ghost"
            style={{ opacity: csvImporting ? 0.4 : 1 }}>
            {csvImporting ? "Import…" : "↑ CSV"}
          </button>

          {csvOverlay && (
            <div onClick={() => setCsvOverlay(false)}
              style={{ position: "fixed", inset: 0, background: "rgba(26,60,46,0.28)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div onClick={e => e.stopPropagation()}
                style={{ background: "#fff", borderRadius: 14, padding: 22, width: 420, maxWidth: "100%", boxShadow: "0 12px 40px rgba(26,60,46,0.18)" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1A3C2E", marginBottom: 4 }}>Importer des questions (CSV)</div>
                <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 14 }}>Le fichier est lu par position de colonne. Les colonnes au-delà de la 4ᵉ sont ignorées.</div>
                {[
                  ["1", "Question", "le texte de la question (obligatoire)", "#1A7A4A"],
                  ["2", "Favori", "vrai/true/oui/1/⭐ → marquée favorite ; sinon non", "#C97820"],
                  ["3", "Catégorie", "nom de catégorie ; vide = ignorée ; créée si inconnue", "#2563EB"],
                  ["4", "Intention", "transactionnelle / informationnelle / notoriété ; vide = ignorée", "#7C3AED"],
                  ["5", "Marques concernées", "noms séparés par des virgules ; vide = toutes les marques du projet ; marque inconnue = ignorée", "#0891B2"],
                ].map(([n, title, desc, color]) => (
                  <div key={n} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                    <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 6, background: color + "18", color, fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1A3C2E" }}>Colonne {n} — {title}</div>
                      <div style={{ fontSize: 11, color: "#64748B" }}>{desc}</div>
                    </div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button onClick={() => setCsvOverlay(false)} className="gt-btn gt-btn--ghost">Annuler</button>
                  <button onClick={() => csvInputRef.current?.click()} className="gt-btn"
                    style={{ background: "#1A7A4A", color: "#fff", border: "none" }}>Choisir un fichier…</button>
                </div>
              </div>
            </div>
          )}

          {/* Séparateur vertical */}
          <div style={{ width: "0.5px", height: 20, background: "#1A3C2E18", flexShrink: 0 }} />

          {/* Catégories — inline compact (comme KeywordsTab) */}
          <CategoryManager
            projectId={projectId}
            categories={categories}
            setCategories={setCategories}
            compact
          />
        </div>

        {/* ── Ligne 2 : Filtres ── */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 10, borderBottom: "0.5px solid #1A3C2E08", marginBottom: 10 }}>

          {/* Recherche — choix du champ + saisie regex */}
          <select value={searchField} onChange={e => setSearchField(e.target.value)} className="gt-select" title="Sur quel texte appliquer la recherche">
            <option value="question">Questions</option>
            <option value="answer">Réponses</option>
            <option value="mention">Mentions</option>
            <option value="evocation">Évocations</option>
            <option value="citation">Citations</option>
          </select>
          <input
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            placeholder="Rechercher (regex)…"
            className="gt-input"
            style={{ width: 160 }}
          />

          {/* Catégorie */}
          <CatMultiSelect value={filterCat} categories={categories} onChange={v => setFilterCat(v)} placeholder="Catégorie" />

          {/* Mot-clé */}
          <select value={filterKeyword} onChange={e => setFilterKeyword(e.target.value)} className="gt-select">
            <option value="">Tous les mots-clés</option>
            {keywords.map(k => <option key={k.id} value={k.id}>{k.keyword}</option>)}
          </select>

          {/* Divider */}
          <div style={{ width: "0.5px", height: 16, background: "#1A3C2E12", flexShrink: 0 }} />

          {/* Pills de présence */}
          <button className={`gt-filter-pill${filterFav ? " gt-filter-pill--active" : ""}`} onClick={() => setFilterFav(f => !f)} title="Questions favorites">⭐ Favoris</button>
          <button className={`gt-filter-pill${filterPositioned ? " gt-filter-pill--active" : ""}`} onClick={() => setFilterPositioned(f => !f)} title="Marque présente dans le dernier résultat">Positionnée</button>
          <button className={`gt-filter-pill${filterLost ? " gt-filter-pill--active" : ""}`} onClick={() => setFilterLost(f => !f)} title="Positionnée dans les 30j, absente du dernier résultat">Perdue</button>

          {/* Divider */}
          <div style={{ width: "0.5px", height: 16, background: "#1A3C2E12", flexShrink: 0 }} />

          {/* Tri par résultat — discret */}
          <button
            onClick={() => setSortByResult(s => !s)}
            title="Trier par résultat : mentions (Top 1, 2, 3…) puis évocations, puis citations, puis le reste"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
              padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 500, cursor: "pointer",
              border: `0.5px solid ${sortByResult ? "#1A7A4A" : "#1A3C2E22"}`,
              background: sortByResult ? "#1A7A4A" : "transparent",
              color: sortByResult ? "#fff" : "#1A3C2E",
            }}>
            <span style={{ fontSize: 12 }}>⇅</span> Trier par résultat
          </button>

          {/* Reset — apparaît seulement si filtre actif */}
          {(filterSearch || filterCat.length || filterKeyword || filterFav || filterPositioned || filterLost || Object.keys(providerModes).length > 0 || sortByResult) && (
            <button
              onClick={() => { setFilterSearch(""); setFilterCat([]); setFilterKeyword(""); setFilterFav(false); setFilterPositioned(false); setFilterLost(false); setProviderModes({}); setSortByResult(false); }}
              className="gt-btn-icon"
              title="Effacer tous les filtres"
              style={{ fontSize: 12, color: "#1A3C2E" }}>
              ✕
            </button>
          )}

          {/* Compteur */}
          <span className="gt-caption" style={{ marginLeft: 4 }}>
            {filtered.length} question{filtered.length > 1 ? "s" : ""}
          </span>
        </div>

        {/* ── Ligne 3 : Providers + sélection + export + lancement ── */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>

          {/* Providers — pills */}
          <div className="geo-provider-pills" data-tour="provider-pills">
          {PROVIDERS.map(p => {
            const hasKey = p.external ? true : !!providerKeys[p.id]?.dec; // externe : pas de clé requise
            const mode = providerMode(p.id); // "used" | "unused" | "hidden"
            const mark = mode === "used" ? " ✓" : mode === "hidden" ? " ⦸" : "";
            const nextLabel = mode === "used" ? "cliquer : ne plus interroger"
                            : mode === "unused" ? "cliquer : masquer les lignes"
                            : "cliquer : réactiver";
            return (
              <button key={p.id}
                onClick={() => hasKey && cycleProviderMode(p.id)}
                className={`gt-filter-pill${mode === "used" && hasKey ? " gt-filter-pill--active" : ""}`}
                style={{
                  opacity: !hasKey ? 0.3 : mode === "used" ? 1 : mode === "unused" ? 0.55 : 0.4,
                  filter: (hasKey && mode !== "used") ? "grayscale(1)" : "none",
                  textDecoration: mode === "hidden" ? "line-through" : "none",
                  cursor: hasKey ? "pointer" : "not-allowed",
                }}
                title={!hasKey ? `Clé ${p.label} manquante`
                     : p.external ? `${p.label} — alimenté par le scraper local · ${mode === "hidden" ? "masqué" : "visible"} (${nextLabel})`
                     : mode === "used" ? `${p.label} — interrogé et visible (${nextLabel})`
                     : mode === "unused" ? `${p.label} — non interrogé, résultats visibles (${nextLabel})`
                     : `${p.label} — non interrogé et masqué (${nextLabel})`}>
                {p.label}{mark}
              </button>
            );
          })}

          </div>
          {/* Divider */}
          <div style={{ width: "0.5px", height: 16, background: "#1A3C2E12", flexShrink: 0 }} />

          {/* Sélection */}
          <button
            onClick={() => setSelected(new Set(filtered.map(q => q.id)))}
            className="gt-btn-icon"
            title="Tout sélectionner"
            style={{ fontSize: 11, color: "#1A3C2E", padding: "3px 8px" }}>
            Tout
          </button>
          {selected.size > 0 && (
            <>
              <button onClick={() => setSelected(new Set())} className="gt-btn-icon" style={{ fontSize: 11, color: "#1A3C2E", padding: "3px 8px" }}>Aucun</button>
              <span className="gt-caption" style={{ color: "#1A3C2E" }}>{selected.size} sél.</span>
              <CatSelect value={bulkCat} categories={categories} onChange={setBulkCat} placeholder="Catégoriser…" />
              {bulkCat && (
                <button onClick={applyBulkCat} className="gt-btn" style={{ padding: "3px 12px" }}>Appliquer</button>
              )}
            </>
          )}

          <div style={{ flex: 1 }} />
          <div className="geo-toolbar-actions">
          {/* Générer depuis une URL */}
          {!isReadOnly && (
            <button
              onClick={() => { setUrlGenOpen(o => !o); setUrlGenStatus(""); }}
              className={`gt-btn ${urlGenOpen ? "gt-btn--solid" : "gt-btn--ghost"}`}
              title="Générer des questions à partir du contenu d'une URL"
              style={{ padding: "3px 12px" }}>
              🌐 Générer depuis une URL
            </button>
          )}
          {/* Rafraîchir */}
          <button
            onClick={() => sbGetQuestions(projectId, site.id).then(setQuestions)}
            className="gt-btn-icon"
            title="Rafraîchir"
            style={{ fontSize: 13 }}>
            ↺
          </button>

          {/* Export */}
          <span data-tour="export-btn"><ExportFanoutBtn
            questions={filtered}
            results={results}
            brandName={brand?.brand_name || ""}
            brandAliases={brand?.brand_aliases || []}
            keywords={keywords}
            projectName={site?.name || "export"}
            hintsMap={hintsMap}
            latestResultByQ={latestResultByQ}
            lostByQ={lostByQ}
          />
          </span>

          {/* Lancer tout */}
          {!isReadOnly && (
            <>
              {!hasConfiguredProviders ? (
                <span
                  data-tour="run-all"
                  title="Aucun provider configuré : ajoutez au moins une clé API (Claude et/ou OpenAI) dans l'onglet ⚙ Configuration pour pouvoir lancer les interrogations."
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: "50%", fontSize: 15, color: "#C97820", background: "#FFFBEB", border: "1px solid #FDE68A", cursor: "help" }}>
                  ⚠
                </span>
              ) : (
                <button
                  data-tour="run-all"
                  onClick={runAllQuestions}
                  disabled={runAll || toRunCount === 0}
                  className={`gt-btn ${toRunCount > 0 ? "gt-btn--solid" : "gt-btn--ghost"}`}
                  title={toRunCount === 0 ? "Tout interrogé aujourd'hui" : `Interroger ${toRunCount} question${toRunCount > 1 ? "s" : ""} sans réponse`}>
                  {runAll ? "…" : toRunCount > 0 ? `▶ Lancer (${toRunCount})` : "✓ Généré"}
                </button>
              )}
              {runAll && (
                <button onClick={() => { stopAllRef.current = true; setRunAll(false); }} className="gt-btn gt-btn--ghost" style={{ borderColor: "#C0352A33", color: "#C0352A" }}>⏹</button>
              )}
            </>
          )}
          </div>
        </div>
      </div>

      {/* ── Panneau : Générer des questions depuis une URL ── */}
      {urlGenOpen && !isReadOnly && (
        <div style={{ margin: "0 0 16px", padding: "14px 16px", background: "#F6F8F7", border: "0.5px solid #1A3C2E14", borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A3C2E", marginBottom: 4 }}>Générer des questions depuis une URL</div>
          <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 12 }}>
            La page est crawlée légèrement, puis l'IA en déduit des questions de recherche. Les questions sont rattachées au site (sans mot-clé).
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={urlGenUrl}
              onChange={e => setUrlGenUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && urlGenStatus !== "crawl" && urlGenStatus !== "gen" && generateFromUrl()}
              placeholder="https://exemple.fr/page…"
              style={{ flex: "1 1 260px", padding: "7px 11px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 12 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: "#1A3C2E" }}>Nombre</span>
              <input type="range" min="10" max="25" value={urlGenCount}
                onChange={e => setUrlGenCount(parseInt(e.target.value, 10))}
                style={{ accentColor: "#1A3C2E", cursor: "pointer", width: 110 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E", minWidth: 20, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{urlGenCount}</span>
            </div>
            <button
              onClick={generateFromUrl}
              disabled={!urlGenUrl.trim() || urlGenStatus === "crawl" || urlGenStatus === "gen"}
              className="gt-btn gt-btn--solid"
              style={{ padding: "7px 16px", opacity: (!urlGenUrl.trim() || urlGenStatus === "crawl" || urlGenStatus === "gen") ? 0.5 : 1 }}>
              {urlGenStatus === "crawl" ? "⏳ Lecture de la page…" : urlGenStatus === "gen" ? "⏳ Génération…" : "Générer"}
            </button>
          </div>
          {urlGenStatus.startsWith("done:") && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#1A7A4A", fontWeight: 600 }}>
              ✓ {urlGenStatus.slice(5)} question{parseInt(urlGenStatus.slice(5), 10) > 1 ? "s" : ""} ajoutée{parseInt(urlGenStatus.slice(5), 10) > 1 ? "s" : ""}.
            </div>
          )}
          {urlGenStatus.startsWith("error:") && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#C0352A" }}>
              ✗ {urlGenStatus.slice(6)}
            </div>
          )}
        </div>
      )}

            {/* Questions list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: C.textLight, fontSize: 12 }}>
          {questions.length === 0 ? "Aucune question — générez-en depuis les mots-clés ou ajoutez-en manuellement" : "Aucune question ne correspond aux filtres"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}
          onDragOver={dragId ? (e => { e.preventDefault(); dragYRef.current = e.clientY; }) : undefined}>
          {filtered.map((q, idx) => {
            const qResults = resultsByQ[q.id] || [];
            const hasBrand = qResults.some(r => r.brand_mentioned === true || r.brand_mentioned === 1);
            const isRunning = running[q.id];
            const isSel = selected.has(q.id);
            const kwTag = keywords.find(k => k.id === q.keyword_id);
            return (
              <div key={q.id} className={`gt-item${isSel ? " gt-item--selected" : ""}`}
              onDragOver={dragId ? (e => e.preventDefault()) : undefined}
              onDrop={dragId ? (e => { e.preventDefault(); moveQuestion(dragId, q.id); setDragId(null); }) : undefined}
              style={{
              borderLeft: `2px solid ${hasBrand ? "#1A7A4A" : q.is_favorite ? "#C97820" : "#1A3C2E11"}`,
              paddingLeft: 12,
              borderRadius: 0,
              opacity: dragId === q.id ? 0.4 : 1,
            }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span
                    draggable
                    onDragStart={() => { setDragId(q.id); startAutoScroll(); }}
                    onDragEnd={() => { setDragId(null); stopAutoScroll(); }}
                    title="Glisser pour réordonner"
                    style={{ flexShrink: 0, marginTop: 1, cursor: "grab", color: "#CBD5E1", fontSize: 12, userSelect: "none", lineHeight: 1.4 }}>⠿</span>
                  <span style={{ flexShrink: 0, marginTop: 1, minWidth: 22, textAlign: "right", fontSize: 11, fontWeight: 600, color: "#1A3C2E", fontVariantNumeric: "tabular-nums", userSelect: "none" }}>{idx + 1}</span>
                  <input type="checkbox" checked={isSel} onChange={() => { setSelected(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; }); }} style={{ cursor: "pointer", flexShrink: 0, marginTop: 2 }} />
                  <button onClick={() => toggleFav(q.id, q.is_favorite)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, flexShrink: 0, opacity: q.is_favorite ? 0.9 : 0.2, transition: "opacity 0.2s" }}>⭐</button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Question text — edit mode or display */}
                    {editingQ?.id === q.id ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                        <input
                          autoFocus
                          value={editingQ.text}
                          onChange={e => setEditingQ(prev => ({ ...prev, text: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingQ(null); }}
                          style={{ flex: 1, padding: "5px 10px", border: `1px solid #2563EB`, borderRadius: 7, fontSize: 13, fontWeight: 600, color: C.text }}
                        />
                        <button onClick={saveEdit} style={{ padding: "4px 10px", background: "#2563EB", color: "#fff", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✓</button>
                        <button onClick={() => setEditingQ(null)} style={{ padding: "4px 8px", background: "#FAFAF8", color: C.textLight, border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 11, cursor: "pointer" }}>✕</button>
                      </div>
                    ) : (
                      <div className="gt-item-text">{q.question}</div>
                    )}
                    <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                      {/* ── Mot-clé : affichage + édition inline ── */}
                      {editingKw === q.id ? (
                        /* Mode édition : input autocomplete sur les keywords existants */
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <input
                            autoFocus
                            list={`kw-list-${q.id}`}
                            value={kwInput}
                            onChange={e => setKwInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") assignKeyword(q, kwInput);
                              if (e.key === "Escape") { setEditingKw(null); setKwInput(""); }
                            }}
                            placeholder="Mot-clé…"
                            style={{ fontSize: 10, padding: "2px 7px", border: "0.5px solid #1A3C2E33", borderRadius: 8, outline: "none", width: 120, color: "#1A3C2E" }}
                          />
                          <datalist id={`kw-list-${q.id}`}>
                            {keywords.map(k => <option key={k.id} value={k.keyword} />)}
                          </datalist>
                          <button onClick={() => assignKeyword(q, kwInput)}
                            style={{ fontSize: 10, padding: "2px 6px", background: "#1A3C2E", color: "#F0EBE0", border: "none", borderRadius: 5, cursor: "pointer" }}>✓</button>
                          {kwTag && (
                            <button onClick={() => assignKeyword(q, "")}
                              title="Retirer le mot-clé"
                              style={{ fontSize: 10, padding: "2px 5px", background: "none", border: "0.5px solid #C0352A22", borderRadius: 5, color: "#C0352A", cursor: "pointer" }}>✕</button>
                          )}
                          <button onClick={() => { setEditingKw(null); setKwInput(""); }}
                            style={{ fontSize: 10, color: "#1A3C2E", background: "none", border: "none", cursor: "pointer" }}>annuler</button>
                        </span>
                      ) : (
                        /* Mode affichage : badge cliquable */
                        <span
                          onClick={() => { setEditingKw(q.id); setKwInput(kwTag?.keyword || ""); }}
                          title="Cliquer pour assigner un mot-clé"
                          style={{ fontSize: 10, color: kwTag ? "#1A3C2E" : "#1A3C2E", background: kwTag ? "#FAFAF8" : "transparent", border: `0.5px solid ${kwTag ? "#1A3C2E0D" : "#1A3C2E11"}`, borderRadius: 10, padding: "1px 7px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 }}>
                          🔑 {kwTag ? kwTag.keyword : <em style={{ fontStyle: "italic" }}>ajouter un mot-clé</em>}
                          {kwTag?.search_volume > 0 && (
                            <span style={{ color: "#1A3C2E", marginLeft: 3 }}>
                              {kwTag.search_volume >= 1000 ? (kwTag.search_volume / 1000).toFixed(1) + "k" : kwTag.search_volume}
                            </span>
                          )}
                        </span>
                      )}
                      {/* Multi-catégories */}
                  {(Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : [])).map(tagId => {
                    const tagCat = categories.find(c => c.id === tagId);
                    return tagCat ? (
                      <span key={tagId} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 500, color: tagCat.color, background: "transparent", border: `0.5px solid ${tagCat.color}44`, borderRadius: 20, padding: "2px 9px" }}>
                        {tagCat.name}
                        <button onClick={e => { e.stopPropagation(); removeCatFromQuestion(q.id, tagId); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: tagCat.color, padding: 0, lineHeight: 1, opacity: 0.6 }}>×</button>
                      </span>
                    ) : null;
                  })}
                      {q.is_manual && <span style={{ fontSize: 10, color: "#1A3C2E", fontWeight: 400, fontStyle: "italic" }}>manuel</span>}
                      {hasBrand && <span style={{ fontSize: 10, color: "#1A7A4A", fontWeight: 500, letterSpacing: "0.01em" }}>✓ {brand_name}</span>}
                      {qResults.length > 0 && <span style={{ fontSize: 10, color: "#1A3C2E" }}>{qResults.length} réponse{qResults.length > 1 ? "s" : ""}</span>}
                    </div>
                    {/* Per-provider 30-day calendar */}

                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                    <SiteBrandSelect
                      value={Array.isArray(q.associated_sites) ? q.associated_sites : []}
                      sites={allSites}
                      onChange={ids => {
                        setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, associated_sites: ids } : qq));
                        sbSetQuestionSites(q.id, ids).catch(() => {});
                      }}
                    />
                    <IntentSelect
                      value={q.intent || null}
                      onChange={intent => {
                        setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, intent } : qq));
                        sbSetQuestionIntent(q.id, intent).catch(() => {});
                      }}
                    />
                    <TagSelect
                      values={Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : [])}
                      categories={categories}
                      onChange={tags => {
                        const newPrimary = tags[0] || null;
                        sbSetQuestionCategory(q.id, newPrimary).catch(() => {});
                        sbSetKeywordTags(q.id, tags).catch(() => {});
                        setQuestions(prev => prev.map(qq => qq.id === q.id ? { ...qq, category_id: newPrimary, tags } : qq));
                      }}
                      placeholder="Catégories…"
                    />
                    <button onClick={() => setEditingQ(editingQ?.id === q.id ? null : { id: q.id, text: q.question })}
                      style={{ padding: "3px 8px", border: "0.5px solid #1A3C2E18", borderRadius: 20, background: "transparent", color: "#1A3C2E", fontSize: 12, cursor: "pointer", fontWeight: 400 }}
                      title="Modifier">✎</button>
                    <button
                      onClick={() => {
                        const toRun = getProvidersToRun(q, true);
                        if (!toRun.length) return;
                        // Clear erreurs avant retry
                        toRun.forEach(p => setProviderErrors(prev => { const n={...prev}; delete n[`${q.id}-${p.id}`]; return n; }));
                        // AI Overview (externe) → enfile pour le scraper ; autres → API.
                        toRun.forEach(p => p.external ? enqueueAio(q.id) : runProvider(q, p));
                      }}
                      disabled={isRunning}
                      title="Lancer tous les providers"
                      style={{ padding: "4px 16px", border: "0.5px solid #1A3C2E33", borderRadius: 20, background: "transparent", color: "#1A3C2E", fontSize: 11, fontWeight: 500, cursor: isRunning ? "wait" : "pointer", opacity: isRunning ? 0.35 : 1, letterSpacing: "0.02em", transition: "opacity 0.2s" }}>
                      {isRunning ? "…" : "▶"}
                    </button>
                    <button onClick={() => deleteQ(q.id)} style={{ padding: "3px 8px", border: "none", background: "transparent", color: "#1A3C2E", fontSize: 12, cursor: "pointer", transition: "color 0.15s" }}>✕</button>
                  </div>
                </div>
                {/* One row per provider — calendar + info + accordion + run */}
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
                  {PROVIDERS.map(p => {
                    if (providerMode(p.id) === "hidden") return null; // provider masqué : aucune ligne
                    const pResults = qResults.filter(r => getProviderId(r.model) === p.id);
                    const hasKey = !!providerKeys[p.id]?.dec;
                    // Provider externe (AI Overview) : toujours affiché (alimenté par le scraper).
                    if (!hasKey && !p.external && !pResults.length) return null;
                    return (
                      <ProviderRow
                        key={p.id}
                        provider={p}
                        external={!!p.external}
                        onEnqueue={() => enqueueAio(q.id)}
                        onCancelQueue={() => cancelAio(q.id)}
                        queued={aioPending(q.id)}
                        brandSites={brandSitesFor(q)}
                        calResults={(calResultsByQ[q.id] || []).filter(r => getProviderId(r.model) === p.id)}
                        singleSiteProject={singleSiteProject}
                        results={pResults}
                        allProviderResults={qResults}
                        brandName={brand_name}
                        brandAliases={brand_aliases}
                        hasKey={hasKey}
                        isRunning={!!running[`${q.id}-${p.id}`]}
                        onRun={() => runProvider(q, p)}
                        questionId={q.id}
                        newCalEntry={newCalEntries[`${q.id}|${p.id}`] || null}
                        question={q.question}
                        brandDomain={brand?.brand_domain || ""}
                        claudeKey={providerKeysRef.current["claude"]?.dec || ""}
                        projectId={projectId}
                        siteId={site?.id}
                        savedHint={hintsMap[q.id]?.text || ""}
                        savedHintDate={hintsMap[q.id]?.date || null}
                        errorMsg={providerErrors[`${q.id}-${p.id}`] || null}
                      />
                    );
                  })}
                </div>
                {/* ── Hint at question level ── */}
                {(() => {
                  const claudeKey = providerKeysRef.current["claude"]?.dec || "";
                  // hintsMap[q.id] est toujours { text, date } ou undefined
                  const savedH     = hintsMap[q.id]?.text || "";
                  const savedHDate = hintsMap[q.id]?.date || null;
                  const anyResult = qResults.length > 0;
                  if (!anyResult) return null;
                  // Get sources from latest result across all providers
                  const latestResult = [...qResults].sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0))[0];
                  const hasBrandQ = isBrandPresent(latestResult);
                  return (
                    <div style={{ marginTop: 8 }}>
                      {savedH ? (
                        /* Hint exists — show toggle */
                        <HintPanelQuestion
                          questionId={q.id}
                          question={q.question}
                          sources={latestResult?.sources || []}
                          brandName={brand_name}
                          brandAliases={brand_aliases}
                          brandDomain={brand?.brand_domain || ""}
                          claudeKey={claudeKey}
                          hasBrand={hasBrandQ}
                          projectId={projectId}
                          siteId={site?.id}
                          savedHint={savedH}
                          savedHintDate={savedHDate}
                          onHintSaved={(text) => setHintsMap(prev => ({ ...prev, [q.id]: { text, date: new Date().toISOString() } }))}
                          initialOpen={false}
                        />
                      ) : claudeKey ? (
                        /* No hint — show generate button */
                        <HintPanelQuestion
                          questionId={q.id}
                          question={q.question}
                          sources={latestResult?.sources || []}
                          brandName={brand_name}
                          brandAliases={brand_aliases}
                          brandDomain={brand?.brand_domain || ""}
                          claudeKey={claudeKey}
                          hasBrand={hasBrandQ}
                          projectId={projectId}
                          siteId={site?.id}
                          savedHint=""
                          savedHintDate={null}
                          onHintSaved={(text) => setHintsMap(prev => ({ ...prev, [q.id]: { text, date: new Date().toISOString() } }))}
                          initialOpen={false}
                        />
                      ) : (
                        <div style={{ fontSize: 10, color: C.textLight, fontStyle: "italic", marginTop: 4 }}>
                          💡 Clé Claude manquante pour générer une recommandation
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── URL Index sub-tab ─────────────────────────────────────────────


function UrlsTab({ projectId, categories, brand, allResults }) {
  const [urls, setUrls]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  const [crawling, setCrawling]         = useState({});
  const [analyzingPage, setAnalyzingPage] = useState({});
  const [pageAnalysis, setPageAnalysis]   = useState({});
  const [filterType, setFilterType] = useState("all"); // all | brand | competitor | other
  const [filterTpl, setFilterTpl]   = useState("");
  const [sortBy, setSortBy]         = useState("citations"); // citations | domain | alpha
  const [search, setSearch]         = useState("");
  const [view, setView]             = useState("urls"); // urls | domains
  const [openCrawl, setOpenCrawl]   = useState(null);

  const brandName    = brand?.brand_name || "";
  const brandAliases = brand?.brand_aliases || [];
  const competitors  = brand?.competitors  || [];

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(false);
    sbGetUrlIndex(projectId)
      .then(data => {
      if (!Array.isArray(data)) { setUrls([]); setLoading(false); return; }

      // ── Normaliser et dédupliquer : regrouper www/non-www, http/https, slash final ──
      const normalizeUrl = (url) => {
        try {
          const u = new URL(url);
          // Normaliser : https, sans www, sans slash final
          return `${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`
            .toLowerCase()
            .replace(/^www\./, "");
        } catch { return url.toLowerCase().trim(); }
      };

      const normalDomain = (url) => {
        try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
      };

      // Grouper par URL normalisée
      const groups = {};
      data.forEach(entry => {
        const key = normalDomain(entry.url || "") + normalizeUrl(entry.url || "");
        if (!groups[key]) {
          groups[key] = { ...entry };
        } else {
          // Sommer les compteurs, garder l'URL la plus courte (sans www, avec https)
          groups[key].count_as_source = (groups[key].count_as_source || 0) + (entry.count_as_source || 0);
          groups[key].count_in_answer = (groups[key].count_in_answer || 0) + (entry.count_in_answer || 0);
          // Préférer l'URL avec www si pas encore normalisée, sinon la plus courte
          if ((entry.url || "").length < (groups[key].url || "").length) {
            groups[key].url = entry.url;
            groups[key].domain = entry.domain || normalDomain(entry.url || "");
          }
        }
      });

      setUrls(Object.values(groups));
      setLoading(false);
    })
      .catch(() => { setUrls([]); setLoading(false); setError(true); });
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Classify a URL
  const _norm = (s) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim();
  const _compact = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const brandDomainNorm = _norm(brand?.brand_domain || "");
  const classifyUrl = (u) => {
    const d = _norm(u.domain || u.url || "");
    const dRoot = _compact(d.split(".")[0]); // domaine sans TLD, compacté
    const brandTerms = [brandName, ...brandAliases].filter(Boolean);
    const knownComps = competitors.filter(Boolean).map(t => t.toLowerCase());

    // 1) Domaine de marque déclaré (ex. gestioncreditexpert.com)
    if (brandDomainNorm && (d === brandDomainNorm || d.endsWith("." + brandDomainNorm) || brandDomainNorm.endsWith("." + d))) return "brand";
    // 2) Nom de marque / alias compacté présent dans le domaine
    //    (gère « Gestion Credit expert » → « gestioncreditexpert »)
    if (brandTerms.some(t => { const c = _compact(t); if (c.length < 4) return false; return dRoot.includes(c) || (dRoot.length >= 5 && c.includes(dRoot)); })) return "brand";
    // 3) Repli : sous-chaîne brute (ancien comportement)
    if (brandTerms.some(t => d.includes(t.toLowerCase()))) return "brand";

    // Identified competitors from results
    const compNames = new Set();
    allResults.forEach(r => (r.competitors_mentioned || []).forEach(c => { if (c.name) compNames.add(c.name.toLowerCase()); }));
    const identifiedComps = [...compNames];

    if (knownComps.some(t => d.includes(t))) return "competitor_known";
    if (identifiedComps.some(t => d.includes(t) || t.includes(d.split(".")[0]))) return "competitor_identified";
    return "other";
  };
  // Map detailed class to display class
  const mapCls = (c) => c.startsWith("competitor") ? "competitor" : c;

  const classColors = {
    brand:      { color: "#059669", bg: "#ECFDF5", border: "#059669", label: `✓ ${brandName || "Marque"}`,     filterKey: "brand" },
    competitor: { color: "#DC2626", bg: "#FEF2F2", border: "#DC2626", label: "⚔️ Concurrents",                filterKey: "competitor" },
    other:      { color: "#64748B", bg: "#F8FAFC", border: "#E2E8F0", label: "🔗 Autre source",               filterKey: "other" },
  };

  const TEMPLATE_TYPES = ["article","landing","fiche","FAQ","comparatif","forum","media","institutionnel","autre"];

  const filtered = useMemo(() => urls.filter(u => {
    if (search && !u.url?.toLowerCase().includes(search.toLowerCase()) && !u.domain?.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTpl && u.template_type !== filterTpl) return false;
    if (filterType !== "all") {
      const cls = classifyUrl(u);
      if (filterType === "brand" && cls !== "brand") return false;
      if (filterType === "competitor" && !cls.startsWith("competitor")) return false;
      if (filterType === "other" && cls !== "other") return false;
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === "citations") return (b.count_as_source + b.count_in_answer) - (a.count_as_source + a.count_in_answer);
    if (sortBy === "domain") return (a.domain || "").localeCompare(b.domain || "");
    if (sortBy === "alpha") return (a.url || "").localeCompare(b.url || "");
    return 0;
  }), [urls, search, filterTpl, filterType, sortBy, brandName, brandAliases, competitors, allResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // Domain aggregation — repart de `filtered` pour que la recherche, le filtre de
  // classe (marque/concurrents/autre) et le filtre template s'appliquent AUSSI à la
  // vue Domaines, et applique le même tri (sortBy) que la vue URLs.
  const domains = useMemo(() => {
    const m = {};
    filtered.forEach(u => {
      if (!u.domain) return;
      if (!m[u.domain]) m[u.domain] = { domain: u.domain, count_as_source: 0, count_in_answer: 0, urls: [] };
      m[u.domain].count_as_source += u.count_as_source || 0;
      m[u.domain].count_in_answer += u.count_in_answer || 0;
      m[u.domain].urls.push(u);
    });
    return Object.values(m).sort((a, b) => {
      if (sortBy === "domain" || sortBy === "alpha") return (a.domain || "").localeCompare(b.domain || "");
      return (b.count_as_source + b.count_in_answer) - (a.count_as_source + a.count_in_answer);
    });
  }, [filtered, sortBy]);

  // Counts per class
  const classCounts = useMemo(() => {
    const c = { brand: 0, competitor: 0, other: 0 };
    urls.forEach(u => { const cls = mapCls(classifyUrl(u)); if (c[cls] !== undefined) c[cls]++; });
    return c;
  }, [urls, brandName, brandAliases, competitors, allResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const setThemeCat = async (id, catId) => {
    await sbUpdateUrlMeta(id, { theme_category_id: catId || null });
    setUrls(prev => prev.map(u => u.id === id ? { ...u, theme_category_id: catId || null } : u));
  };

  const setTemplate = async (id, tpl) => {
    await sbUpdateUrlMeta(id, { template_type: tpl || null });
    setUrls(prev => prev.map(u => u.id === id ? { ...u, template_type: tpl || null } : u));
  };

  const launchCrawl = async (urlEntry) => {
    setCrawling(c => ({ ...c, [urlEntry.id]: true }));
    await sbUpdateUrlMeta(urlEntry.id, { crawl_status: "pending" });
    setUrls(prev => prev.map(u => u.id === urlEntry.id ? { ...u, crawl_status: "pending" } : u));
    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlEntry.url }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Crawl failed");
      const sections = data.sections || [];
      await sbUpdateUrlMeta(urlEntry.id, { crawl_status: "done", crawl_sections: sections, crawl_at: new Date().toISOString() });
      setUrls(prev => prev.map(u => u.id === urlEntry.id ? { ...u, crawl_status: "done", crawl_sections: sections } : u));
      setOpenCrawl(urlEntry.id);
    } catch(e) {
      await sbUpdateUrlMeta(urlEntry.id, { crawl_status: "error" });
      setUrls(prev => prev.map(u => u.id === urlEntry.id ? { ...u, crawl_status: "error" } : u));
      console.error("Crawl échoué:", e.message);
    }
    setCrawling(c => ({ ...c, [urlEntry.id]: false }));
  };

  if (loading) return (
    <div style={{ textAlign: "center", padding: 40, color: C.textLight, fontSize: 12 }}>
      Chargement des sources citées…
    </div>
  );

  if (error || (!loading && urls.length === 0)) return (
    <div style={{ textAlign: "center", padding: 60, color: C.textLight }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔗</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
        {error ? "Table non disponible" : "Aucune source indexée"}
      </div>
      <div style={{ fontSize: 12 }}>
        {error
          ? "Exécutez migration-geo-v2.sql dans Supabase, puis interrogez des questions."
          : "Interrogez des questions pour voir apparaître les URLs citées."}
      </div>
    </div>
  );


  const analyzePageContent = async (urlEntry) => {
    const claudeKey = (function() {
      try {
        const s = sessionStorage.getItem("correl_session") || localStorage.getItem("correl_session");
        const sess = s ? JSON.parse(s) : null;
        return sess?.__claude_key || "";
      } catch { return ""; }
    })();
    setAnalyzingPage(prev => ({ ...prev, [urlEntry.id]: true }));
    try {
      const sections = (urlEntry.crawl_sections || []).slice(0, 20);
      const pageContent = sections.map(s => `[${s.type || "section"}] ${(s.text || s.title || s.content || "").slice(0, 300)}`).join("\n").slice(0, 3000);
      const prompt = [
        `Tu es expert GEO. Analyse cette page : ${urlEntry.url}`,
        "",
        pageContent ? `CONTENU :${("\n" + pageContent)}` : "(page non crawlée — analyse à partir de l'URL uniquement)",
        "",
        "Réponds UNIQUEMENT avec ce JSON (sans markdown) :",
        JSON.stringify({summary:"2 phrases",geo_signals:["signal"],opportunities:["action"],content_type:"type",seo_score:7}),
      ].join("\n");
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Claude ${res.status}`);
      const data = JSON.parse(raw);
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
      setPageAnalysis(prev => ({ ...prev, [urlEntry.id]: analysis }));
    } catch(e) {
      setPageAnalysis(prev => ({ ...prev, [urlEntry.id]: { error: e.message } }));
    }
    setAnalyzingPage(prev => ({ ...prev, [urlEntry.id]: false }));
  };

  return (
    <div>
      {/* ── Legend strip ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {Object.entries(classColors).map(([cls, meta]) => {
          const fk = meta.filterKey;
          const active = filterType === fk;
          const count = classCounts[cls] ?? 0;
          return (
            <button key={cls} onClick={() => setFilterType(active ? "all" : fk)}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "6px 14px",
                borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer",
                border: `2px solid ${active ? meta.color : meta.border}`,
                background: active ? meta.color : meta.bg,
                color: active ? "#fff" : meta.color,
                transition: "all 0.15s",
              }}>
              {meta.label}
              <span style={{ opacity: 0.75, fontWeight: 500 }}>({count})</span>
            </button>
          );
        })}
        {/* "Tout" reset */}
        {filterType !== "all" && (
          <button onClick={() => setFilterType("all")}
            style={{ padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "0.5px solid #1A3C2E0D", background: "#FAFAF8", color: C.textMid }}>
            ✕ Tout afficher
          </button>
        )}
      </div>

      {/* ── Filters + view toggle ── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher…"
          style={{ padding: "6px 10px", border: "0.5px solid #1A3C2E0D", borderRadius: 8, fontSize: 12, color: C.text, width: 220 }} />
        <select value={filterTpl} onChange={e => setFilterTpl(e.target.value)}
          style={{ padding: "5px 8px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 11, color: C.text }}>
          <option value="">Tous templates</option>
          {TEMPLATE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ padding: "5px 8px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 11, color: C.text }}>
          <option value="citations">Trier : + citées</option>
          <option value="domain">Trier : domaine</option>
          <option value="alpha">Trier : URL A→Z</option>
        </select>
        <span style={{ fontSize: 11, color: C.textLight }}>{filtered.length} URL{filtered.length > 1 ? "s" : ""} · {domains.length} domaine{domains.length > 1 ? "s" : ""}</span>

        {/* View toggle */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 3, background: "#FAFAF8", borderRadius: 8, padding: 3 }}>
          {[{ key: "urls", label: "🔗 URLs" }, { key: "domains", label: "🌐 Domaines" }].map(v => (
            <button key={v.key} onClick={() => setView(v.key)} style={{
              padding: "4px 14px", borderRadius: 6, fontSize: 12, fontWeight: view === v.key ? 700 : 400,
              border: "none", cursor: "pointer",
              background: view === v.key ? C.white : "transparent",
              color: view === v.key ? C.text : C.textLight,
              boxShadow: view === v.key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}>{v.label}</button>
          ))}
        </div>
      </div>

      {/* ── URLs view ── */}
      {view === "urls" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {filtered.map(u => {
            const cls  = mapCls(classifyUrl(u));
            const meta = classColors[cls];
            const isOpen = openCrawl === u.id;
            const hasSections = u.crawl_sections?.length > 0;
            const cat = categories.find(c => c.id === u.theme_category_id);
            return (
              <div key={u.id} style={{ background: meta.bg, border: `1.5px solid ${meta.border}33`, borderLeft: `4px solid ${meta.color}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", flexWrap: "wrap" }}>
                  {/* Counts */}
                  <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, background: `${meta.color}22`, color: meta.color, borderRadius: 5, padding: "2px 7px" }} title="Source">📎 {u.count_as_source}</span>
  
                  </div>
                  {/* Class badge */}
                  <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: meta.bg, border: `1px solid ${meta.color}44`, borderRadius: 10, padding: "1px 8px", flexShrink: 0 }}>
                    {meta.label}
                  </span>
                  {/* URL */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 12, color: meta.color, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stripQuery(u.url)}</span>
                      <a href={u.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                        style={{ flexShrink: 0, fontSize: 10, color: C.textLight, border: "0.5px solid #1A3C2E0D", borderRadius: 4, padding: "1px 5px", textDecoration: "none" }}>↗</a>
                    </div>
                    <div style={{ fontSize: 10, color: C.textLight }}>{u.domain}</div>
                  </div>
                  {/* Selectors */}
                  <div style={{ display: "flex", gap: 5, flexShrink: 0, flexWrap: "wrap" }}>
                    {cat && <span style={{ fontSize: 10, fontWeight: 700, color: cat.color, background: cat.color+"18", borderRadius: 10, padding: "1px 7px" }}>{cat.name}</span>}
                    <CatSelect value={u.theme_category_id} categories={categories} onChange={v => setThemeCat(u.id, v)} placeholder="Thème…" />
                    <select value={u.template_type || ""} onChange={e => setTemplate(u.id, e.target.value || null)}
                      style={{ padding: "3px 6px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 10, color: u.template_type ? C.text : C.textLight }}>
                      <option value="">Template…</option>
                      {TEMPLATE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  {/* Crawl button */}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {hasSections && (
                      <button onClick={() => setOpenCrawl(isOpen ? null : u.id)}
                        style={{ padding: "3px 8px", border: "0.5px solid #1A3C2E0D", borderRadius: 6, fontSize: 10, cursor: "pointer", background: isOpen ? C.bg : C.white, color: C.textMid }}>
                        {isOpen ? "▲" : "▼"} Sections
                      </button>
                    )}
                    <button onClick={() => launchCrawl(u)} disabled={crawling[u.id]}
                      title={u.crawl_status === "done" ? "Recrawler la page" : "Analyser le contenu de la page"}
                      style={{ padding: "3px 8px", border: `1px solid ${meta.color}`, borderRadius: 6, fontSize: 10, cursor: crawling[u.id] ? "wait" : "pointer", background: meta.bg, color: meta.color, fontWeight: 600 }}>
                      {crawling[u.id] ? "⏳" : u.crawl_status === "done" ? "🔄" : "🕷️"}
                    </button>
                    {u.crawl_status === "done" && (
                      <button
                        onClick={() => pageAnalysis[u.id] ? setPageAnalysis(prev => { const n = {...prev}; delete n[u.id]; return n; }) : analyzePageContent(u)}
                        disabled={!!analyzingPage[u.id]}
                        title="Analyser le contenu GEO de la page"
                        className="gt-btn-icon"
                        style={{ fontSize: 11, color: pageAnalysis[u.id] ? "#1A3C2E" : "#1A3C2E" }}>
                        {analyzingPage[u.id] ? "…" : pageAnalysis[u.id] ? "✦ ▲" : "✦"}
                      </button>
                    )}
                  </div>
                </div>
                {/* Crawl sections */}
                {isOpen && hasSections && (
                  <div style={{ borderTop: `1px solid ${meta.border}33`, background: "#FAFAF8", padding: "10px 14px" }}>
                    <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>Sections · {u.crawl_sections.length}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 7 }}>
                      {u.crawl_sections.map((sec, i) => (
                        <div key={i} style={{ background: "#fff", border: `1px solid ${sec.used_in_llm ? "#059669" : C.border}`, borderRadius: 7, padding: "8px 10px", borderLeft: `3px solid ${sec.used_in_llm ? "#059669" : C.border}` }}>
                          <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                            <span style={{ fontSize: 9, fontWeight: 700, color: "#7C3AED", background: "#F5F3FF", borderRadius: 4, padding: "1px 5px" }}>{sec.type}</span>
                            {sec.used_in_llm && <span style={{ fontSize: 9, color: "#059669", fontWeight: 600 }}>✓ LLM</span>}
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: C.text, marginBottom: 2 }}>{sec.title}</div>
                          <div style={{ fontSize: 10, color: C.textLight, lineHeight: 1.4 }}>{sec.summary}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              {/* Analyse GEO — accordéon au-dessus de la ligne URL */}
              {pageAnalysis[u.id] && (
                <div style={{ borderTop: "0.5px solid #1A3C2E08", padding: "12px 0 4px 0", marginBottom: 4 }}>
                  {pageAnalysis[u.id].error ? (
                    <div style={{ fontSize: 11, color: "#C0352A" }}>Erreur : {pageAnalysis[u.id].error}</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {/* Résumé */}
                      <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.6 }}>
                        {pageAnalysis[u.id].summary}
                      </div>
                      {/* Signaux + Opportunités */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div>
                          <div className="gt-label" style={{ marginBottom: 6, color: "#1A7A4A" }}>Signaux GEO</div>
                          {(pageAnalysis[u.id].geo_signals || []).map((s, i) => (
                            <div key={i} style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 3, paddingLeft: 8, borderLeft: "2px solid #1A7A4A22" }}>
                              {s}
                            </div>
                          ))}
                        </div>
                        <div>
                          <div className="gt-label" style={{ marginBottom: 6, color: "#C97820" }}>Opportunités</div>
                          {(pageAnalysis[u.id].opportunities || []).map((o, i) => (
                            <div key={i} style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 3, paddingLeft: 8, borderLeft: "2px solid #C9782022" }}>
                              {o}
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* Score GEO */}
                      {pageAnalysis[u.id].seo_score && (
                        <div style={{ fontSize: 10, color: "#1A3C2E" }}>
                          Score GEO estimé : {pageAnalysis[u.id].seo_score}/10
                          {pageAnalysis[u.id].content_type && ` · ${pageAnalysis[u.id].content_type}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/* ── Domains view ── */}
      {view === "domains" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {domains.map((d, i) => {
            const cls  = mapCls(classifyUrl({ domain: d.domain }));
            const meta = classColors[cls];
            const total = d.count_as_source + d.count_in_answer;
            const maxTotal = domains[0] ? domains[0].count_as_source + domains[0].count_in_answer : 1;
            return (
              <div key={d.domain} style={{ background: meta.bg, border: `1.5px solid ${meta.border}33`, borderLeft: `4px solid ${meta.color}`, borderRadius: 10, padding: "10px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: C.textLight, minWidth: 28 }}>#{i+1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{d.domain}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: meta.bg, border: `1px solid ${meta.color}44`, borderRadius: 10, padding: "1px 7px" }}>{meta.label}</span>
                      <span style={{ fontSize: 10, color: C.textLight }}>{d.urls.length} URL{d.urls.length > 1 ? "s" : ""}</span>
                    </div>
                    {/* Bar */}
                    <div style={{ height: 5, background: `${meta.color}22`, borderRadius: 3, overflow: "hidden", marginBottom: 4 }}>
                      <div style={{ height: "100%", width: `${(total / maxTotal) * 100}%`, background: meta.color, borderRadius: 3, transition: "width 0.4s" }} />
                    </div>
                    <div style={{ display: "flex", gap: 10, fontSize: 11, color: C.textLight }}>
                      <span>📎 {d.count_as_source} source{d.count_as_source > 1 ? "s" : ""}</span>

                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main GeoTab ───────────────────────────────────────────────────

// ── AutomationTab ────────────────────────────────────────────────
function AutomationTab({ projectId, site, user, providerKeys }) {
  const [schedule, setSchedule]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState(null);
  const [error, setError]         = useState("");

  const [active, setActive]       = useState(true);
  const [providers, setProviders] = useState(["openai"]);
  const [intervalDays, setIntervalDays] = useState(1); // tous les X jours (1 = quotidien)

  // Conversion fréquence <-> nombre de jours (compat presets + "every_N")
  const freqToDays = (f) => {
    if (typeof f === "string" && f.startsWith("every_")) return Math.max(1, parseInt(f.slice(6), 10) || 1);
    return f === "weekly" ? 7 : f === "biweekly" ? 14 : f === "monthly" ? 30 : 1;
  };
  const daysToFreq = (n) => n === 1 ? "daily" : n === 7 ? "weekly" : n === 14 ? "biweekly" : n === 30 ? "monthly" : `every_${n}`;
  const FREQ_PRESETS = [
    { days: 1,  label: "Quotidien"    },
    { days: 7,  label: "Hebdomadaire" },
    { days: 14, label: "Bi-mensuel"   },
    { days: 30, label: "Mensuel"      },
  ];
  const intervalLabel = intervalDays === 1 ? "chaque jour" : `tous les ${intervalDays} jours`;

  useEffect(() => {
    if (!projectId || !site?.id) return;
    setLoading(true);
    setSchedule(null); // masque immédiatement les stats du projet précédent pendant le chargement
    sbGetSchedule(projectId, site.id).then(s => {
      if (s) {
        setSchedule(s);
        setActive(s.active);
        setProviders(s.providers || ["openai"]);
        setIntervalDays(freqToDays(s.frequency));
      } else {
        // Aucune automatisation pour CE projet → réinitialiser le formulaire aux défauts
        setActive(true);
        setProviders(["openai"]);
        setIntervalDays(1);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const availableProviders = PROVIDERS.filter(p => !!providerKeys[p.id]?.dec);

  const save = async () => {
    if (!providers.length) { setError("Sélectionnez au moins un provider."); return; }
    setSaving(true); setError("");
    try {
      const s = await sbSaveSchedule({
        project_id: projectId, site_id: site.id,
        owner_email: user?.email || "",
        frequency: daysToFreq(intervalDays), providers, active, max_questions: 1000,
      });
      setSchedule(s);
    } catch(e) { setError(e.message); }
    setSaving(false);
  };

  const toggleActive = async () => {
    if (!schedule) return;
    const next = !active;
    setActive(next);
    await sbUpdateSchedule(schedule.id, { active: next });
    setSchedule(prev => ({ ...prev, active: next }));
  };

  const trigger = async () => {
    setTriggering(true); setTriggerResult(null); setError("");
    try {
      const res = await sbTriggerScheduler({ project_id: projectId, site_id: site.id });
      setTriggerResult(res);
    } catch(e) { setError(e.message); }
    setTriggering(false);
  };

  const toggleProvider = (id) => {
    setProviders(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

  if (loading) return (
    <div style={{ padding: 32, textAlign: "center", color: "#1A3C2E", fontSize: 13 }}>Chargement…</div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, maxWidth: 680 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <div className="gt-label" style={{ marginBottom: 4 }}>Automatisation</div>
          <div className="gt-heading" style={{ marginBottom: 4 }}>Interrogation automatique</div>
          <div className="gt-body-sm">Questions ⭐ favoris</div>
        </div>
        {schedule && (
          <button
            onClick={toggleActive}
            className={`gt-btn ${active ? "gt-btn--ghost" : "gt-btn--solid"}`}
            style={{ marginTop: 4 }}>
            {active ? "Désactiver" : "Activer"}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: "#FEF2F2", border: "0.5px solid #C0352A22", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#C0352A", marginBottom: 16 }}>{error}</div>
      )}

      {/* ── Info : seules les questions favorites sont interrogées ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", marginBottom: 20, background: "#F0FDF4", border: "0.5px solid #1A7A4A33", borderRadius: 8, fontSize: 12 }}>
        <span style={{ fontSize: 14, flexShrink: 0 }}>⭐</span>
        <span style={{ color: "#1A7A4A", lineHeight: 1.5 }}>
          Seules les <strong>questions favorites</strong> sont interrogées automatiquement, avec les providers sélectionnés ci-dessous. Les appels sont enregistrés en base et apparaissent dans l'onglet Questions à votre prochaine connexion.
        </span>
      </div>

      {/* Status si schedule existe */}
      {schedule && (
        <div className="geo-auto-kpi" style={{ gap: 10, marginBottom: 28 }}>
          {[
            { label: "Prochain run", value: fmtDate(schedule.next_run) },
            { label: "Dernier run",  value: fmtDate(schedule.last_run) },
            { label: "Questions",    value: schedule.last_run_count || 0 },
          ].map(k => (
            <div key={k.label} className="gt-kpi-card">
              <div className="gt-kpi-label" style={{ marginBottom: 6 }}>{k.label}</div>
              <div className="gt-body" style={{ fontWeight: 500 }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Fréquence d'interrogation : presets + slider « tous les X jours » ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="gt-label" style={{ marginBottom: 10 }}>Fréquence d'interrogation</div>
        <div className="geo-freq-grid" style={{ gap: 8, marginBottom: 14 }}>
          {FREQ_PRESETS.map(f => {
            const on = intervalDays === f.days;
            return (
              <button key={f.days} onClick={() => setIntervalDays(f.days)}
                style={{
                  padding: "12px 10px", textAlign: "center", cursor: "pointer",
                  border: on ? "1px solid #1A3C2E" : "0.5px solid #1A3C2E18",
                  borderRadius: 8, background: on ? "#1A3C2E" : "transparent", transition: "all 0.15s",
                }}>
                <div style={{ fontWeight: 500, fontSize: 12, color: on ? "#F0EBE0" : "#1A3C2E" }}>{f.label}</div>
                <div style={{ fontSize: 10, color: on ? "#F0EBE0" : "#8A8A82" }}>{f.days === 1 ? "1 jour" : `${f.days} jours`}</div>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input type="range" min={1} max={30} step={1} value={intervalDays}
            onChange={e => setIntervalDays(Number(e.target.value))}
            style={{ flex: 1, accentColor: "#1A3C2E" }} />
          <div style={{ minWidth: 130, textAlign: "right", fontSize: 13, fontWeight: 600, color: "#1A3C2E" }}>
            Interrogation <span style={{ color: "#E8541A" }}>{intervalLabel}</span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#8A8A82", marginTop: 6 }}>Glissez pour régler l'intervalle (1 à 30 jours), ou utilisez un préréglage.</div>
      </div>

      {/* ── Providers ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="gt-label" style={{ marginBottom: 12 }}>
          Providers à interroger
          {availableProviders.length === 0 && (
            <span style={{ marginLeft: 8, fontSize: 10, color: "#C0352A", textTransform: "none", fontWeight: 400, letterSpacing: 0 }}>
              — aucune clé configurée
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PROVIDERS.map(p => {
            const hasKey = !!providerKeys[p.id]?.dec;
            const sel = providers.includes(p.id);
            return (
              <button key={p.id} onClick={() => hasKey && toggleProvider(p.id)}
                title={!hasKey ? `Clé ${p.label} manquante` : undefined}
                className={`gt-filter-pill${sel && hasKey ? " gt-filter-pill--active" : ""}`}
                style={{ opacity: hasKey ? 1 : 0.3, cursor: hasKey ? "pointer" : "not-allowed" }}>
                {p.label}{!hasKey ? " ·" : sel ? " ✓" : ""}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Notification email ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", marginBottom: 20, background: "#FFFBF5", border: "0.5px solid #C9782033", borderRadius: 8, fontSize: 12 }}>
        <span style={{ fontSize: 14, flexShrink: 0 }}>✉️</span>
        <span style={{ color: "#8A5A1A", lineHeight: 1.5 }}>
          Un email récapitulatif est envoyé à <strong>{user?.email || "votre adresse"}</strong> après chaque interrogation automatique.
        </span>
      </div>

      {/* ── Bouton save ── */}
      <button onClick={save} disabled={saving || !providers.length}
        className={`gt-btn gt-btn--solid`}
        style={{ width: "100%", justifyContent: "center", padding: "11px 0", fontSize: 12, borderRadius: 8, opacity: (saving || !providers.length) ? 0.4 : 1 }}>
        {saving ? "Sauvegarde…" : schedule ? "Mettre à jour" : "Activer l'automatisation"}
      </button>

      {/* ── Test manuel ── */}
      {schedule && (
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "0.5px solid #1A3C2E08" }}>
          <div className="gt-label" style={{ marginBottom: 8 }}>Test manuel</div>
          <div className="gt-caption" style={{ marginBottom: 12 }}>
            Déclenche immédiatement l'interrogation des favoris en arrière-plan (jusqu'à 15 min). Les résultats apparaissent dans l'onglet Questions une fois terminé.
          </div>
          <button onClick={trigger} disabled={triggering}
            className="gt-btn"
            style={{ opacity: triggering ? 0.4 : 1 }}>
            {triggering ? "En cours…" : "▶ Lancer maintenant"}
          </button>
          {triggerResult && (
            <div style={{ marginTop: 10, fontSize: 11, color: "#1A7A4A", padding: "8px 12px", background: "transparent", border: "0.5px solid #1A7A4A22", borderRadius: 6, lineHeight: 1.5 }}>
              {triggerResult.dispatched
                ? "✓ Interrogation lancée en arrière-plan. Les questions favorites sont en cours d'interrogation — les résultats apparaîtront dans l'onglet Questions dans quelques minutes (rechargez la page pour les voir)."
                : `✓ ${triggerResult.processed || 0} schedule(s) — ${triggerResult.results?.[0]?.questions_processed || 0} question(s) traitée(s)`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}



// ── BrandConfigAccordion — wrapper qui ferme la card après save ───
function BrandConfigAccordion({ sites, projectId }) {
  const [openId, setOpenId] = useState(null);
  const [keys, setKeys] = useState({});

  if (!sites?.length) {
    return <div style={{ fontSize: 12, color: "#94A3B8", fontStyle: "italic" }}>Ajoutez un site pour configurer sa marque.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sites.map(site => {
        const isOpen = openId === site.id;
        const cardKey = keys[site.id] || site.id;
        return (
          <div key={site.id} style={{ border: `1px solid ${site.color}33`, borderRadius: 10, overflow: "hidden" }}>
            {/* Header accordéon */}
            <div onClick={() => setOpenId(isOpen ? null : site.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: isOpen ? site.bg : "#F8FAFC", cursor: "pointer", borderBottom: isOpen ? `1px solid ${site.color}22` : "none" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: site.color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: site.color, flex: 1 }}>{site.label}</span>
              <span style={{ fontSize: 11, color: "#94A3B8" }}>{isOpen ? "▲" : "▼"}</span>
            </div>
            {/* Contenu BrandConfigPanel */}
            {isOpen && (
              <div
                ref={el => {
                  if (!el) return;
                  // Intercepter le clic sur le bouton "Sauvegarder" de BrandConfigPanel
                  const handler = (e) => {
                    const btn = e.target.closest("button");
                    if (!btn) return;
                    const label = btn.textContent?.trim().toLowerCase();
                    if (label.includes("sauvegarder") || label.includes("save") || label.includes("enregistrer")) {
                      // Fermer l'accordéon après un court délai (laisse le save se terminer)
                      setTimeout(() => {
                        setOpenId(null);
                        // Reset la key pour forcer remount la prochaine fois
                        setKeys(prev => ({ ...prev, [site.id]: `${site.id}-${Date.now()}` }));
                      }, 300);
                    }
                    // Bouton Annuler → fermer immédiatement
                    if (label.includes("annuler") || label.includes("cancel")) {
                      setOpenId(null);
                    }
                  };
                  el.addEventListener("click", handler);
                  return () => el.removeEventListener("click", handler);
                }}
                style={{ padding: "12px 14px", background: "#fff" }}>
                <BrandConfigPanel key={cardKey} site={site} projectId={projectId} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ── FanoutSetupPanel — vue props-only, zéro état local projet ──────
function SetupSection({ icon, title, desc, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1A3C2E", marginBottom: desc ? 3 : 9, display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: 14 }}>{icon}</span>{title}
      </div>
      {desc && <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, marginBottom: 11, maxWidth: 620 }}>{desc}</div>}
      {children}
    </div>
  );
}

function FanoutSetupPanel({
  projects, currentProjectId, setCurrentProjectId, setProjects, ownerEmail,
  sites, setSites, smData, setSmData, smOverview = {}, setSmOverview,
  sfData, setSfData, gscData, setGscData, gaData, setGaData, bingData, setBingData,
  dbHistory, dbLoading, refreshHistory, confirmModal, setConfirmModal,
  project, projectId, onSaveProviderKeys,
  axes, onSaveAxes, onAxesChange,
  onSemrushVolumes,
}) {
  const [showHistory, setShowHistory] = useState(false);

  // Tout normalisé ici — jamais de .map() sur une valeur non-array
  const safeProjects = Array.isArray(projects) ? projects : [];
  const safeSites    = Array.isArray(sites)    ? sites    : [];
  const safeHistory  = Array.isArray(dbHistory)? dbHistory: [];
  const safeAxes     = Array.isArray(axes)     ? axes     : DEFAULT_AXES;

  const lastImports = {};
  for (const row of safeHistory) {
    const k = `${row.site_id}_${row.source}`;
    if (!lastImports[k] && row.storage_path) lastImports[k] = row;
  }

  return (
    <div style={{ maxWidth: 680 }}>

      {/* ── Projet actif ── */}
      <SetupSection icon="📁" title="Projet actif" desc="Sélectionnez le projet et les sites suivis. Vous pouvez en créer un nouveau, en supprimer, et rattacher autant de sites que nécessaire à comparer.">
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
              <select value={currentProjectId || ""} onChange={e => setCurrentProjectId(e.target.value)}
                style={{ width: "100%", padding: "7px 28px 7px 10px", border: `1.5px solid ${C.blue}`, borderRadius: 8, fontSize: 13, fontWeight: 600, color: C.blue, background: C.blueLight, cursor: "pointer", appearance: "none" }}>
                {safeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.blue, fontSize: 11 }}>▾</span>
            </div>
            <input
              value={safeProjects.find(p => p.id === currentProjectId)?.name || ""}
              onChange={e => {
                const name = e.target.value;
                setProjects(prev => (Array.isArray(prev) ? prev : []).map(p => p.id === currentProjectId ? { ...p, name } : p));
              }}
              onBlur={e => {
                const proj = safeProjects.find(p => p.id === currentProjectId);
                if (proj) sbSaveProject({ ...proj, name: e.target.value.trim() || proj.name }).catch(() => {});
              }}
              placeholder="Nom du projet"
              title="Renommer le projet actif"
              style={{ flex: 1, minWidth: 160, padding: "7px 10px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#1A3C2E", background: "#fff" }}
            />
            {safeProjects.length > 1 && (
              <button onClick={() => setConfirmModal?.({ message: `Supprimer "${safeProjects.find(p => p.id === currentProjectId)?.name}" ?`, onConfirm: () => {
                sbDeleteProject(currentProjectId).catch(() => {});
                setProjects(prev => { const next = prev.filter(x => x.id !== currentProjectId); if (next.length) setCurrentProjectId(next[0].id); return next; });
              }})} style={{ padding: "6px 10px", border: "1px solid #FECACA", borderRadius: 7, background: "#FEF2F2", cursor: "pointer", fontSize: 11, color: "#DC2626" }}>🗑</button>
            )}
            {safeProjects.length < 20 && (
              <button onClick={() => {
                const p = newProject(`Projet ${safeProjects.length + 1}`, [{ id: `site-${Date.now()}`, label: "Nouveau site", ...SITE_PALETTE[0] }], ownerEmail);
                setProjects(prev => [...prev, p]);
                setCurrentProjectId(p.id);
                sbSaveProject(p).catch(() => {});
              }} style={{ padding: "6px 10px", borderRadius: 7, border: `1.5px dashed ${C.blue}`, background: C.blueLight, color: C.blue, cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>+ Nouveau</button>
            )}
          </div>

          {/* Sites */}
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {safeSites.map(site => (
              <div key={site.id} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, border: `1px solid ${site.color}44`, background: site.bg }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: site.color, flexShrink: 0 }} />
                <input value={site.label} onChange={e => setSites(prev => (Array.isArray(prev) ? prev : []).map(s => s.id === site.id ? {...s, label: e.target.value} : s))}
                  style={{ fontSize: 12, fontWeight: 600, color: site.color, border: "none", outline: "none", background: "transparent", width: 100 }} />
                {safeSites.length > 1 && (
                  <button onClick={() => setConfirmModal?.({ message: `Supprimer "${site.label}" ?`, onConfirm: () => {
                    setSites(prev => (Array.isArray(prev) ? prev : []).filter(s => s.id !== site.id));
                    setSmData(p => { const n = {...p}; delete n[site.id]; return n; });
                  }})} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#DC2626", padding: 0 }}>✕</button>
                )}
              </div>
            ))}
            {(
              <button onClick={() => {
                const palette = SITE_PALETTE[safeSites.length % SITE_PALETTE.length] || SITE_PALETTE[0];
                const newId = `site-${Date.now()}`;
                setSites(prev => [...(Array.isArray(prev) ? prev : []), { id: newId, label: `Site ${safeSites.length + 1}`, ...palette }]);
                setSmData(p => ({...p, [newId]: []}));
              }} style={{ padding: "4px 10px", borderRadius: 20, border: `1px dashed ${C.border}`, background: "#fff", color: C.blue, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>+ Site</button>
            )}
          </div>

          {/* Historique */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: C.textLight }}>
              {dbLoading ? (<><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#F59E0B", marginRight: 5 }} />Chargement…</>)
                : safeHistory.length > 0 ? (<><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#059669", marginRight: 5 }} />{safeHistory.length} import{safeHistory.length > 1 ? "s" : ""} en base</>)
                : null}
            </span>
            <button onClick={() => { setShowHistory(h => !h); refreshHistory?.(); }}
              style={{ fontSize: 11, color: showHistory ? C.blue : C.textLight, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              {showHistory ? "▲ Masquer" : "📋 Historique"}
            </button>
          </div>
          {showHistory && (
            <div style={{ marginTop: 8, maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {safeHistory.slice(0, 20).map(row => {
                const site = safeSites.find(s => s.id === row.site_id);
                const lbl = { sf:"🐸 SF", gsc:"🔍 GSC", ga:"📊 GA4", bing:"🤖 Bing", sm:"📈 SM" }[row.source] || row.source;
                return (
                  <div key={row.id} style={{ display: "flex", gap: 8, padding: "4px 8px", background: "#FAFAF8", borderRadius: 5, fontSize: 10, alignItems: "center" }}>
                    <span style={{ color: site?.color || C.text, fontWeight: 600, minWidth: 60 }}>{site?.label || "—"}</span>
                    <span style={{ color: C.textMid }}>{lbl}</span>
                    <span style={{ color: C.textLight, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.filename}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SetupSection>

      {/* ── Gestion des providers et Clés API ── */}
      <SetupSection icon="🔑" title="Gestion des providers et Clés API" desc="Branchez les clés API des moteurs IA et choisissez ceux à interroger. Claude et OpenAI sont indispensables : Claude génère les questions, les analyses « Et maintenant ? » et l'audit, OpenAI interroge ChatGPT.">
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 16px" }}>
          <ProviderConfigPanel project={project} projectId={projectId} sites={safeSites} onSaveProviderKeys={onSaveProviderKeys} canSeeCosts={canSeeCosts} />
        </div>
      </SetupSection>

      {/* ── Configuration du suivi de marque ── */}
      <SetupSection icon="🏷️" title="Configuration du suivi de marque" desc="Déclarez le nom de votre marque, ses variantes, son domaine et vos concurrents. Ces éléments servent à détecter votre présence et celle des concurrents dans les réponses des LLMs.">
        <BrandConfigAccordion sites={safeSites} projectId={projectId} />
      </SetupSection>      {/* ── Génération à partir des mots-clés ── */}
      <div style={{ marginBottom: 24, paddingLeft: 16, borderLeft: "3px solid #1A4A7A22" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#1A3C2E", marginBottom: 3, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 16 }}>🔑</span>Génération à partir des mots clés
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.55, marginBottom: 16, maxWidth: 640 }}>Cette partie du setup concerne la génération des questions à partir des mots clés.</div>
      {/* ── Mots-clés — Axes de génération ── */}
      <SetupSection icon="🎯" title="Mots-clés — Axes de génération des questions" desc="Définissez les angles sous lesquels chaque mot-clé sera décliné en question, adaptés à votre secteur. Chaque mot-clé génèrera une question par axe ; pensez à sauvegarder.">
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {safeAxes.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#94A3B8", minWidth: 18, flexShrink: 0 }}>{i + 1}.</span>
                <input value={a} onChange={e => { const u = [...safeAxes]; u[i] = e.target.value; onAxesChange?.(u); }}
                  style={{ flex: 1, padding: "5px 9px", border: "1px solid #E2E8F0", borderRadius: 7, fontSize: 12, color: "#1E293B" }} />
                <button onClick={() => onAxesChange?.(safeAxes.filter((_, j) => j !== i))}
                  style={{ fontSize: 11, color: "#94A3B8", background: "none", border: "none", cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>✕</button>
              </div>
            ))}
            <button onClick={() => onAxesChange?.([...safeAxes, ""])}
              style={{ fontSize: 11, color: "#2563EB", background: "none", border: "1px dashed #E2E8F0", borderRadius: 7, padding: "5px 12px", cursor: "pointer", textAlign: "left", marginTop: 2 }}>
              + Ajouter un axe
            </button>
          </div>
          <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
            <button onClick={async () => { if (onSaveAxes) await onSaveAxes(safeAxes); }}
              style={{ padding: "6px 16px", background: "#1A3C2E", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              💾 Sauvegarder les axes
            </button>
          </div>
        </div>
      </SetupSection>

      {/* ── Ajout des volumes — Import Semrush ── */}
      <SetupSection icon="📈" title="Visibilité SEO — Import Semrush" desc="Pour chaque site, importez l'export « Domain Overview » (totaux mots-clés / trafic organiques du domaine) et l'export « Organic pages » (performance par page). Ces données alimentent la comparaison concurrentielle et l'audit.">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {safeSites.map(site => (
            <div key={site.id} style={{ flex: "1 1 200px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: site.color, marginBottom: 8 }}>{site.label}</div>
              <UploadCard label="Semrush" icon="📈" hint="Organic pages export" color={site.color}
                loaded={(smData||{})[site.id]?.length > 0} rows={(smData||{})[site.id]}
                onData={(_, rawText) => { const rows = parseSemrush(parseSemrushCSV(rawText)); setSmData(p => ({...p, [site.id]: rows})); }}
                onClear={() => setSmData(p => ({...p, [site.id]: []}))}
                rawMode siteId={site.id} source="sm" projectId={projectId}
                onAfterUpload={refreshHistory}
                onLoadFromHistory={async row => { try { const t = await sbDownload(row.storage_path); const rows = parseSemrush(parseSemrushCSV(t)); setSmData(p => ({...p, [site.id]: rows})); } catch { } }}
              />
              {(smData||{})[site.id]?.length > 0 && <div style={{ marginTop: 4, fontSize: 10, color: site.color, fontWeight: 600 }}>✓ {(smData||{})[site.id].length} pages</div>}
              {lastImports[`${site.id}_sm`]?.storage_path && !(smData||{})[site.id]?.length && (
                <button onClick={async () => { try { const t = await sbDownload(lastImports[`${site.id}_sm`].storage_path); const rows = parseSemrush(parseSemrushCSV(t)); setSmData(p => ({...p, [site.id]: rows})); } catch { } }}
                  style={{ marginTop: 4, width: "100%", padding: "3px 0", border: `1px solid ${site.color}`, borderRadius: 6, background: site.bg, color: site.color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>↩ Dernier</button>
              )}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #E2E8F0" }}>
                <UploadCard label="Overview" icon="📊" hint="Domain Overview export" color={site.color}
                  loaded={((smOverview||{})[site.id]||[]).length > 0} rows={(smOverview||{})[site.id]}
                  onData={(_, rawText) => { const ov = parseSemrushOverview(rawText); setSmOverview(p => ({...p, [site.id]: ov ? [ov] : []})); }}
                  onClear={() => setSmOverview(p => ({...p, [site.id]: []}))}
                  rawMode siteId={site.id} source="smov" projectId={projectId}
                  onAfterUpload={refreshHistory}
                  onLoadFromHistory={async row => { try { const t = await sbDownload(row.storage_path); const ov = parseSemrushOverview(t); setSmOverview(p => ({...p, [site.id]: ov ? [ov] : []})); } catch { } }}
                />
                {((smOverview||{})[site.id]||[])[0] && (() => {
                  const ov = ((smOverview||{})[site.id]||[])[0] || {};
                  const fmt = (n) => n == null ? "—" : Number(n).toLocaleString("fr-FR");
                  return <div style={{ marginTop: 4, fontSize: 10, color: site.color, fontWeight: 600 }}>✓ {fmt(ov.organic_keywords)} mots-clés · {fmt(ov.organic_traffic)} trafic</div>;
                })()}
                {lastImports[`${site.id}_smov`]?.storage_path && !((smOverview||{})[site.id]||[]).length && (
                  <button onClick={async () => { try { const t = await sbDownload(lastImports[`${site.id}_smov`].storage_path); const ov = parseSemrushOverview(t); setSmOverview(p => ({...p, [site.id]: ov ? [ov] : []})); } catch { } }}
                    style={{ marginTop: 4, width: "100%", padding: "3px 0", border: `1px solid ${site.color}`, borderRadius: 6, background: site.bg, color: site.color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>↩ Dernier</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </SetupSection>
      </div>{/* /Génération à partir des mots-clés */}



    </div>
  );
}


// ── Bouton « remonter en haut » — sticky, discret, bas à droite ──
function ScrollToTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      title="Remonter en haut"
      aria-label="Remonter en haut"
      style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 500,
        width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
        background: "#1A3C2E", color: "#F0EBE0", fontSize: 18, lineHeight: 1,
        boxShadow: "0 2px 10px rgba(0,0,0,0.18)", display: "flex", alignItems: "center", justifyContent: "center",
        opacity: 0.85, transition: "opacity 0.15s ease, transform 0.15s ease",
      }}
      onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.transform = "none"; }}
    >↑</button>
  );
}

export default function GeoTab({ sites, projectId, project, geoAxes, onSaveAxes, onSaveProviderKeys, user, canSeeCosts = false,
  // Props setup (nouvelles — passées depuis App.jsx)
  projects, currentProjectId, setCurrentProjectId, setProjects, ownerEmail,
  setSites, smData, setSmData, smOverview = {}, setSmOverview,
  sfData, setSfData, gscData, setGscData, gaData, setGaData, bingData, setBingData,
  dbHistory, dbLoading, refreshHistory, confirmModal, setConfirmModal,
  isReadOnly = false,
  autoStartTour = false,
  onTourStarted = null,
}) {
  const [subTab, setSubTab]         = useState("questions"); // questions | keywords | competitors | automation | urls | setup
  const [questionsKey, setQuestionsKey] = useState(0); // incremented to force QuestionsTab reload
  const [selectedSite, setSelectedSite] = useState(sites[0]?.id || "");
  // Démarrer le tour automatiquement si demandé
  useEffect(() => {
    if (autoStartTour) { setSubTab("questions"); setShowTour(true); onTourStarted?.(); }
  }, [autoStartTour]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selectedSite quand le projet change
  useEffect(() => {
    setSelectedSite(sites[0]?.id || "");
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Parse persisted settings from project
  const projectSettings = (() => {
    try { return project?.settings_json ? JSON.parse(project.settings_json) : {}; } catch { return {}; }
  })();

  const [model] = useState(projectSettings.model || "gpt-4o-mini"); // kept for variation generation (OpenAI completions endpoint)
  const [brand, setBrand]           = useState(null);
  const [runMode] = useState(projectSettings.runMode || "parallel"); // parallel | sequential
  const [semrushKeyDec, setSemrushKeyDec] = useState(() => decodeKey(project?.semrush_key_enc || ""));
  // Sync semrush key when project changes
  useEffect(() => {
    const dec = decodeKey(project?.semrush_key_enc || "");
    if (dec) setSemrushKeyDec(dec);
  }, [project?.id, project?.semrush_key_enc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [activeProviders, setActiveProviders] = useState(() => {
    // 1. Load from saved settings
    if (projectSettings.activeProviders?.length) return projectSettings.activeProviders;
    // 2. Fallback: all providers that have keys configured
    if (project) {
      const withKeys = PROVIDERS.filter(p => project[p.keyField]).map(p => p.id);
      if (withKeys.length) return withKeys;
    }
    return ["openai"];
  });
  // Provider key state: { id → { enc, dec, input, status } }
  const [providerKeys, setProviderKeys] = useState(() => {
    // Initialize synchronously from project prop so keys are available immediately
    const init = {};
    if (project) {
      PROVIDERS.forEach(p => {
        const enc = project[p.keyField] || "";
        if (enc) {
          const dec = decodeKey(enc);
          if (dec) init[p.id] = { enc, dec, input: "", status: "ok" };
        }
      });
    }
    return init;
  });
  const [apiKeyEnc, setApiKeyEnc]   = useState(project?.openai_key_enc || ""); // legacy for variation gen

  // Auto-save UI settings when they change
  useEffect(() => {
    if (!projectId) return;
    const timer = setTimeout(() => {
      const settings = { runMode, activeProviders, model };
      sbSaveProjectSettings(projectId, settings).catch(() => {});
    }, 800); // debounce 800ms
    return () => clearTimeout(timer);
  }, [runMode, activeProviders, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync all provider keys when project prop updates
  useEffect(() => {
    if (!project) return;
    const updates = {};
    PROVIDERS.forEach(p => {
      const enc = project[p.keyField] || "";
      if (enc) {
        const dec = decodeKey(enc);
        updates[p.id] = { enc, dec, input: "", status: dec ? "ok" : "error" };
      }
    });
    if (Object.keys(updates).length) setProviderKeys(prev => ({ ...prev, ...updates }));
    // Sync legacy openai key for variation generation
    if (project?.openai_key_enc && project.openai_key_enc !== apiKeyEnc) {
      setApiKeyEnc(project.openai_key_enc);
    }
  }, [project?.id, project?.openai_key_enc, project?.gemini_key_enc, project?.perplexity_key_enc, project?.claude_geo_key_enc, project?.semrush_key_enc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [apiKeyDec, setApiKeyDec]   = useState("");           // decrypted, only in memory

  // Sync activeProviders : ajouter automatiquement tout provider dont la clé est configurée
  // (s'exécute quand les clés changent — ne retire jamais un provider, ajoute seulement)
  useEffect(() => {
    if (!project) return;
    const withKeys = PROVIDERS.filter(p => project[p.keyField]).map(p => p.id);
    if (!withKeys.length) return;
    setActiveProviders(prev => {
      const missing = withKeys.filter(id => !prev.includes(id));
      if (!missing.length) return prev; // rien à ajouter
      return [...prev, ...missing];
    });
  }, [project?.openai_key_enc, project?.gemini_key_enc, project?.perplexity_key_enc, project?.claude_geo_key_enc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [allResults, setAllResults] = useState([]);
  const [keywords, setKeywords]     = useState([]); // lifted from KeywordsTab for cross-tab ordering
  const [categories, setCategories] = useState([]);
  const [axes, setAxes]             = useState(Array.isArray(geoAxes) ? geoAxes : DEFAULT_AXES);
  const [competitors, setCompetitors] = useState([]);
  const [aliasMap, setAliasMap] = useState({}); // alias(lower) → canonique
  const [showTour, setShowTour]       = useState(false);

  const safeSites = Array.isArray(sites) ? sites : [];
  const site = (Array.isArray(sites) ? sites : []).find(s => s.id === selectedSite) || (Array.isArray(sites) ? sites : [])[0];

  // ── Périmètre multi-sites du Suivi GEO ──────────────────────────────────
  // Tous les sites cochés par défaut (vue globale). Au moins un site.
  const [selectedSiteIds, setSelectedSiteIds] = useState((Array.isArray(sites) ? sites : []).map(s => s.id));
  useEffect(() => {
    setSelectedSiteIds((Array.isArray(sites) ? sites : []).map(s => s.id));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const effSiteIds   = selectedSiteIds.length ? selectedSiteIds : (Array.isArray(sites) ? sites : []).map(s => s.id);
  const activeSites  = (Array.isArray(sites) ? sites : []).filter(s => effSiteIds.includes(s.id));
  const primarySite  = activeSites[0] || site;
  const isMultiSite  = activeSites.length > 1;
  // Le site primaire pilote brand / aliasMap / concurrents (chargés via selectedSite).
  useEffect(() => {
    if (activeSites[0] && activeSites[0].id !== selectedSite) setSelectedSite(activeSites[0].id);
  }, [selectedSiteIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync axes when project changes
  useEffect(() => {
    setAxes(Array.isArray(geoAxes) ? geoAxes : DEFAULT_AXES);
  }, [geoAxes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load categories (project-wide, once)
  useEffect(() => {
    if (!projectId) return;
    sbGetCategories(projectId).then(setCategories);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load brand + results when project or site changes
  useEffect(() => {
    if (!projectId || !site?.id) return;
    sbGetBrand(projectId, site.id).then(b => { setBrand(b); });
    // Résultats de TOUS les sites du projet (source unique, indépendante de la
    // sélection) : un résultat porte brand_presences de toutes les marques.
    Promise.all((Array.isArray(sites) ? sites : []).map(s => sbGetGeoResults(projectId, s.id).catch(() => [])))
      .then(a => setAllResults(a.flat()));
    sbGetKeywords(projectId, site.id).then(kws => { setKeywords(kws || []); });
    sbGetCompetitors(projectId, site.id).then(c => { setCompetitors(c || []); });
    sbGetAliases(projectId, site.id).then(rows => {
      const map = {};
      (rows || []).forEach(a => { if (a.alias && a.canonical) map[a.alias.toLowerCase().trim()] = a.canonical.trim(); });
      setAliasMap(map);
    }).catch(() => {});
  }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [otherSiteBrands, setOtherSiteBrands] = useState([]); // toutes les autres marques du projet
  // Map site_id → { brand_name, brand_aliases } pour la détection multi-marques (Temps 2).
  const [siteBrandsMap, setSiteBrandsMap] = useState({});
  useEffect(() => {
    const list = Array.isArray(sites) ? sites : [];
    if (!projectId || !list.length) { setSiteBrandsMap({}); return; }
    let cancelled = false;
    Promise.all(list.map(s => sbGetBrand(projectId, s.id).then(b => [s.id, b]).catch(() => [s.id, null])))
      .then(pairs => {
        if (cancelled) return;
        const m = {};
        pairs.forEach(([sid, b]) => { if (b && b.brand_name) m[sid] = { brand_name: b.brand_name, brand_aliases: Array.isArray(b.brand_aliases) ? b.brand_aliases : [] }; });
        setSiteBrandsMap(m);
      });
    return () => { cancelled = true; };
  }, [projectId, sites]); // eslint-disable-line react-hooks/exhaustive-deps
  // Autres sites du projet → chargés comme « 2nd site suivi » (marques associées, tag bleu)
  useEffect(() => {
    const list = Array.isArray(sites) ? sites : [];
    const others = list.filter(s => s.id !== site?.id);
    if (!projectId || others.length === 0) { setOtherSiteBrands([]); return; }
    let cancelled = false;
    Promise.all(others.map(s =>
      sbGetBrand(projectId, s.id).then(b => (b ? { ...b, _siteColor: s.color, _siteLabel: s.label } : null)).catch(() => null)
    )).then(rows => { if (!cancelled) setOtherSiteBrands(rows.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [projectId, sites, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liste de concurrents enrichie : injecte les AUTRES sites du projet (marques associées),
  // virtuels et non éditables, tagués « 2nd site suivi » (bleu).
  const competitorsView = useMemo(() => {
    const base = Array.isArray(competitors) ? competitors : [];
    const def = COMP_CATEGORIES.find(c => c.key === "second_site");
    const virtuals = [];
    const seen = new Set(base.map(c => (c.name || "").toLowerCase()));
    (otherSiteBrands || []).forEach(b => {
      const name = b?.brand_name?.trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      virtuals.push({ id: `__site_${key}__`, name, category: "second_site", color: b._siteColor || def?.color || "#2563EB", enabled: true, _virtual: true });
    });
    return virtuals.length ? [...virtuals, ...base] : base;
  }, [competitors, otherSiteBrands]);

  // Decode key when enc changes
  useEffect(() => {
    if (!apiKeyEnc) return;
    const k = decodeKey(apiKeyEnc);
    setApiKeyDec(k);
  }, [apiKeyEnc]); // eslint-disable-line react-hooks/exhaustive-deps


  const GEO_TOUR_STEPS = [
    {
      target: "subnav",
      icon: "🧭",
      title: "Navigation Fan-outs",
      desc: "5 onglets pour piloter votre analyse GEO : Mots-clés → génération des questions, Questions → interrogation des LLMs, Concurrents → qualification, Automatisation → planifier les runs, Sources → URLs citées.",
      tip: "Démarrez toujours par ajouter vos mots-clés cibles.",
      position: "bottom",
      onActivate: () => { setSubTab("keywords"); },
    },
    {
      target: "keywords-section",
      icon: "🔑",
      title: "Mots-clés",
      desc: "Saisissez vos requêtes cibles (une par ligne) puis cliquez 'Générer toutes les questions'. L'IA crée automatiquement plusieurs questions par axe (meilleur, pistes, avis, objectif…). Import CSV possible.",
      tip: "5-10 mots-clés suffisent pour commencer. Ajoutez des volumes via Semrush.",
      position: "bottom",
      onActivate: () => { setSubTab("keywords"); },
    },
    {
      target: "stats-header",
      icon: "📊",
      title: "Tableau de bord de présence",
      desc: "3 métriques clés : Mention (dans un top numéroté LLM), Évocation (dans le corps du texte) et Citation (dans les sources). Se met à jour en temps réel après chaque interrogation.",
      tip: "Filtrez par provider pour comparer OpenAI, Gemini, Perplexity et Claude.",
      position: "bottom",
      onActivate: () => { setSubTab("questions"); },
    },
    {
      target: "provider-pills",
      icon: "🤖",
      title: "Filtres providers",
      desc: "Activez ou désactivez chaque provider pour filtrer l'affichage. Les pills sans clé configurée sont grisées. Configurez vos clés dans l'onglet 'Configuration'.",
      tip: "Perplexity et Gemini ont un accès web en temps réel — utile pour les requêtes récentes.",
      position: "bottom",
      onActivate: () => { setSubTab("questions"); },
    },
    {
      target: "run-all",
      icon: "▶",
      title: "Lancer les interrogations",
      desc: "Lance toutes les questions non encore interrogées aujourd'hui. Le bouton ▶ individuel force le rechargement pour une question. Un 💡 Hint GEO peut être généré pour chaque question sans présence.",
      tip: "Les résultats sont sauvegardés automatiquement dans Supabase — consultez l'Audit GEO pour l'historique.",
      position: "top",
      onActivate: () => { setSubTab("questions"); },
    },
    {
      target: "export-btn",
      icon: "📤",
      title: "Export CSV / PDF",
      desc: "Exportez les questions avec présence marque, les favoris ou toutes les questions. Filtrez par provider. Le PDF génère un rapport mis en page avec chiffres clés, concurrents et hints GEO.",
      tip: "Générez les 💡 Hints avant le PDF pour un rapport plus actionnable.",
      position: "top",
      onActivate: () => { setSubTab("questions"); },
    },
  ];

  return (
    <div style={{ fontFamily: "inherit" }}>

      {showTour && <TourGuide steps={GEO_TOUR_STEPS} onClose={() => setShowTour(false)} />}

      {/* ── Header ── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#1A3C2E", opacity: 0.5, marginBottom: 4 }}>Suivi GEO</div>
            <div style={{ fontSize: 22, fontWeight: 500, color: "#1A3C2E" }}>Votre visibilité dans les LLMs</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!isReadOnly && (
              <button onClick={() => { setSubTab("questions"); setShowTour(true); }}
                style={{ fontSize: 11, fontWeight: 500, color: "#1A3C2E", background: "#F0EBE0", border: "1px solid #1A3C2E22", borderRadius: 20, padding: "5px 14px", cursor: "pointer" }}>
                Guide
              </button>
            )}
            {isReadOnly && (
              <span style={{ fontSize: 11, fontWeight: 500, color: "#D97706", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 20, padding: "4px 12px" }}>
                Lecture seule
              </span>
            )}
          </div>
        </div>

      </div>

      {/* ── Sous-nav (toujours visible) — Questions mis en avant ; Configuration au même niveau ── */}
      <div data-tour="subnav" className="geo-subnav" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 24 }}>
        {[
          ...(!isReadOnly ? [{ key: "setup", label: "⚙ Configuration" }] : []),
          { key: "keywords",    label: "Mots-clés" },
          { key: "questions",   label: "Questions",      primary: true },
          { key: "competitors", label: "Concurrents" },
          { key: "urls",        label: "Sources" },
          { key: "automation",  label: "Automatisation" },
        ].map(t => {
          const active = subTab === t.key;
          const base = { padding: "6px 16px", fontSize: 12, borderRadius: 20, cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap" };
          const style = t.primary
            ? { ...base, fontWeight: 600, color: active ? "#F0EBE0" : "#1A3C2E", background: active ? "#1A3C2E" : "transparent", border: "1px solid #1A3C2E" }
            : { ...base, fontWeight: active ? 500 : 400, color: "#1A3C2E",
                background: active ? "#F0EBE0" : "transparent",
                border: active ? "1px solid #1A3C2E33" : "1px solid transparent",
                ...(t.right ? { marginLeft: "auto" } : {}) };
          return <button key={t.key} onClick={() => setSubTab(t.key)} style={style}>{t.label}</button>;
        })}
      </div>

      {/* ── Configuration ── */}
      {subTab === "setup" && (
        <FanoutSetupPanel
          projects={projects}
          currentProjectId={currentProjectId}
          setCurrentProjectId={setCurrentProjectId}
          setProjects={setProjects}
          ownerEmail={ownerEmail}
          sites={sites}
          setSites={setSites}
          smData={smData}
          setSmData={setSmData}
          smOverview={smOverview}
          setSmOverview={setSmOverview}
          sfData={sfData}
          setSfData={setSfData}
          gscData={gscData}
          setGscData={setGscData}
          gaData={gaData}
          setGaData={setGaData}
          bingData={bingData}
          setBingData={setBingData}
          dbHistory={dbHistory}
          dbLoading={dbLoading}
          refreshHistory={refreshHistory}
          confirmModal={confirmModal}
          setConfirmModal={setConfirmModal}
          project={project}
          projectId={projectId}
          onSaveProviderKeys={(keyPatch) => {
            setProjects?.(prev => prev.map(p => p.id === projectId ? { ...p, ...keyPatch } : p));
            onSaveProviderKeys?.(keyPatch);
          }}
          axes={axes}
          onSaveAxes={onSaveAxes}
          onAxesChange={(a) => setAxes(a)}
          onSemrushVolumes={async (siteId, parsedRows) => {
            const volMap = {};
            parsedRows.forEach(row => {
              const kw  = (row.keyword || row.Keyword || "").toLowerCase().trim();
              const vol = parseInt(row.volume || row.Volume || row["Search Volume"] || 0, 10);
              if (kw && !isNaN(vol)) volMap[kw] = vol;
            });
            if (!Object.keys(volMap).length) return;
            try {
              const kws = await sbGetKeywords(projectId, siteId);
              for (const kw of kws) {
                const vol = volMap[kw.keyword.toLowerCase().trim()];
                if (vol !== undefined && vol !== kw.search_volume)
                  await sbUpdateKeywordVolume(kw.id, vol, "semrush_csv").catch(() => {});
              }
              setQuestionsKey(k => k + 1);
            } catch(e) { console.warn("onSemrushVolumes error:", e); }
          }}
        />
      )}

      {/* ── Analyse ── */}
      {subTab !== "setup" && (<div>

        {/* Site switcher retiré : seul le site principal est suivi.
            Un éventuel 2e site est traité comme « 2nd site suivi » dans l'onglet Concurrents. */}

        {/* ── Mots-clés ── */}
        {subTab === "keywords" && (
          <div data-tour="keywords-section"><KeywordsTab
            site={site} projectId={projectId} apiKey={apiKeyDec} model={model}
            axes={axes} context={brand?.context || ""} categories={categories}
            setCategories={setCategories} onAxesChange={(a) => setAxes(a)}
            semrushKey={semrushKeyDec} providerKeys={providerKeys}
            onQuestionsGenerated={() => setQuestionsKey(k => k + 1)}
          /></div>
        )}

        {/* ── Questions ── */}
        <div style={{ display: subTab === "questions" ? "block" : "none" }}>
          {(Array.isArray(sites) ? sites : []).length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <SiteMultiSelect sites={safeSites} value={selectedSiteIds} onChange={setSelectedSiteIds} />
              {isMultiSite && (
                <span style={{ fontSize: 11, color: "#C97820", fontWeight: 600, background: "#FEF3E2", padding: "3px 10px", borderRadius: 12 }}>
                  Vue agrégée ({activeSites.length} sites)
                </span>
              )}
            </div>
          )}
          <QuestionsTab
            site={primarySite} projectId={projectId} project={project} apiKey={apiKeyDec} model={model}
            allSites={safeSites}
            readSiteIds={effSiteIds}
            siteBrandsMap={siteBrandsMap}
            gscRows={(effSiteIds && effSiteIds.length ? effSiteIds : [primarySite?.id]).flatMap(sid => project?.gscData?.[sid] || [])}
            aliasMap={aliasMap}
            brand={brand} categories={categories} setCategories={setCategories}
            allResults={allResults.filter(r => effSiteIds.includes(r.site_id))}
            onResultSaved={() => Promise.all((Array.isArray(sites) ? sites : []).map(s => sbGetGeoResults(projectId, s.id).catch(() => []))).then(a => setAllResults(a.flat()))}
            activeProviders={activeProviders} providerKeys={providerKeys}
            runMode={runMode} keywordsOrder={keywords.map(k => k.id)}
            refreshTrigger={questionsKey}
            competitors={competitorsView} setCompetitors={setCompetitors}
            isReadOnly={isReadOnly}
            webSearchSettings={project?.provider_web_search || {}}
            onSaveKey={(keyPatch) => {
              setProviderKeys(prev => {
                const next = { ...prev };
                PROVIDERS.forEach(p => {
                  if (keyPatch[p.keyField]) {
                    const dec = decodeKey(keyPatch[p.keyField]);
                    next[p.id] = { enc: keyPatch[p.keyField], dec, input: "", status: dec ? "ok" : "error" };
                  }
                });
                return next;
              });
              setProjects?.(prev => prev.map(proj => proj.id === projectId ? { ...proj, ...keyPatch } : proj));
              onSaveProviderKeys?.(keyPatch);
            }}
          />
        </div>

        {/* ── Concurrents ── */}
        {subTab === "competitors" && (
          <div style={{ background: "#fff", border: "1px solid #1A3C2E11", borderRadius: 14, padding: "20px 24px" }}>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 4 }}>Paysage concurrentiel</div>
            <div style={{ fontSize: 16, fontWeight: 500, color: "#1A3C2E", marginBottom: 4 }}>Concurrents</div>
            <div style={{ fontSize: 12, color: "#1A3C2E", marginBottom: 20 }}>
              Qualifiez les marques détectées dans les réponses LLM. Elles apparaissent dans les analyses et sont mises en valeur dans les réponses.
            </div>
            <CompetitorManager
              projectId={projectId} siteId={site?.id}
              allResults={allResults.filter(r => effSiteIds.includes(r.site_id))}
              competitors={competitorsView} setCompetitors={setCompetitors}
              brandLabel={brand?.brand_name || site?.name || "Votre marque"}
              aliasMap={aliasMap}
              sfData={sfData}
              smData={smData}
              smOverview={smOverview}
              sfPerimeter={getSitePerimeter(site)}
            />
          </div>
        )}

        {/* ── Automatisation ── */}
        {subTab === "automation" && (
          <AutomationTab projectId={projectId} site={site} user={user} providerKeys={providerKeys} />
        )}

        {/* ── Sources ── */}
        {subTab === "urls" && (
          <UrlsTab projectId={projectId} categories={categories} brand={brand}
            allResults={allResults.filter(r => effSiteIds.includes(r.site_id))}
            qualifiedCompetitors={competitors} />
        )}

      </div>)}
      <ScrollToTopButton />
    </div>
  );
}