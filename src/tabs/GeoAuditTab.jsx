import { useState, useMemo, useCallback, useEffect } from "react";
import "./geo-responsive.css";
import TourGuide from "./TourGuide";
import { sbGetBrand, sbGetQuestions, sbGetGeoResults, sbGetUrlIndex,
  sbSaveProject, sbDeleteProject, sbDownload,
  sbGetCalendarEntriesBatch, sbGetKeywords, sbGetCategories, sbGetCompetitors, sbGetAliases,
  sbSaveGeoAnalysis, sbGetGeoAnalyses, sbGetCompareSettings } from "../lib/supabase";
import {
  urlPath, sfRowMetrics, gscRowMetrics, gaRowMetrics,
  computePagesToUnblock, computeCitabilityScores, computeOrphanCited,
  computeSeoGeoGap, computeReverseCannibalization, computeBingGap,
  computeBusinessValue, computeAITraffic,
  buildCSV, downloadCSV, CSV_COLUMNS,
} from "../lib/auditTools";
import UploadCard from "../components/UploadCard";
import { CompareTable, buildLlmComparison, COMPARE_ROWS, sfCompareStats, resolveSmStats, applySfPerimeter, getSitePerimeter, entityToolStats, entityUrlStats, citedUrlSet } from "../lib/compareEngine";
import PageTypeClassifier from "../components/PageTypeClassifier";
import { newProject } from "../lib/helpers";
import { C, SITE_PALETTE } from "../lib/constants";
import { buildGeoPagesCsv, downloadCsv } from "../lib/exportOptimisations";
import { generateRoadmap, RoadmapView, generateSentiment, SentimentView } from "../lib/roadmapShared";
import { exportAuditPptx, exportAuditPdf } from "../lib/auditExport";
import { detectBrand } from "../lib/geoEngine";
import { PresenceTrendChart, earliestSelectableDate, buildPresenceSeries, mecTotalsOf, classifyResult } from "../lib/presenceTrend";

// Catégories concurrents — miroir de GeoTab

function renderBold(text) {
  if (!text || !text.includes("**")) return text;
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i} style={{ fontSize: "1.05em" }}>{part}</strong> : part
  );
}

function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function dayKey(d) { return d.toISOString().slice(0, 10); }
function decodeKey(enc) { try { return enc ? atob(enc) : ""; } catch { return ""; } }
function getProviderId(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("gpt") || m.includes("openai")) return "openai";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("perplexity") || m.includes("sonar")) return "perplexity";
  if (m.includes("claude")) return "claude";
  return "other";
}


// ── Périmètre SF : sélection de preset + éditeur (par site) ──────────
function SfPerimeterControl({ site, totalCount = 0, scopedCount = 0, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState(null); // id du preset édité, ou "__new__"
  const presets = Array.isArray(site?.sf_presets) ? site.sf_presets : [];
  const activeId = site?.sf_activePreset || null;
  const active = presets.find(p => p.id === activeId) || null;
  const blank = { name: "", paths: "", indexableOnly: false, status200Only: false, minWords: "", maxDepth: "" };
  const [form, setForm] = useState(blank);

  const setActive = (id) => onUpdate({ sf_activePreset: id });
  const startEdit = (p) => {
    setEditId(p ? p.id : "__new__");
    setForm(p ? { name: p.name || "", paths: (p.paths || []).join("\n"), indexableOnly: !!p.indexableOnly, status200Only: !!p.status200Only, minWords: p.minWords ?? "", maxDepth: p.maxDepth ?? "" } : blank);
  };
  const savePreset = () => {
    const paths = form.paths.split("\n").map(x => x.trim()).filter(Boolean);
    const rec = {
      id: editId === "__new__" ? `sfp_${Date.now()}` : editId,
      name: form.name.trim() || "Périmètre",
      paths,
      indexableOnly: !!form.indexableOnly,
      status200Only: !!form.status200Only,
      minWords: form.minWords === "" ? null : parseInt(form.minWords, 10),
      maxDepth: form.maxDepth === "" ? null : parseInt(form.maxDepth, 10),
    };
    const next = editId === "__new__" ? [...presets, rec] : presets.map(p => p.id === editId ? rec : p);
    onUpdate({ sf_presets: next, sf_activePreset: rec.id });
    setEditId(null);
  };
  const deletePreset = (id) => {
    const next = presets.filter(p => p.id !== id);
    onUpdate({ sf_presets: next, sf_activePreset: activeId === id ? null : activeId });
    setEditId(null);
  };

  const badge = active ? active.name : "Tout le site";
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(o => !o)} title="Périmètre appliqué à toute l'analyse Screaming Frog"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer",
          border: `1px solid ${active ? "#1A7A4A" : "#1A3C2E33"}`, background: active ? "#1A7A4A" : "transparent", color: active ? "#fff" : "#1A3C2E" }}>
        🎯 Périmètre SF : {badge}
        {active && <span style={{ fontSize: 9, opacity: 0.85 }}>({scopedCount}/{totalCount})</span>}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 300, width: 300, background: "#fff", border: "0.5px solid #1A3C2E22", borderRadius: 10, boxShadow: "0 6px 24px rgba(26,60,46,0.14)", padding: 10 }}>
          {editId === null ? (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#1A3C2E99", marginBottom: 6 }}>Périmètre actif</div>
              <div onClick={() => setActive(null)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: !activeId ? "#1A7A4A12" : "transparent", color: "#1A3C2E", fontWeight: !activeId ? 700 : 500 }}>
                <span>Tout le site</span>{!activeId && <span style={{ color: "#1A7A4A" }}>✓</span>}
              </div>
              {presets.map(p => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, background: activeId === p.id ? "#1A7A4A12" : "transparent" }}>
                  <span onClick={() => setActive(p.id)} style={{ flex: 1, fontSize: 12, cursor: "pointer", color: "#1A3C2E", fontWeight: activeId === p.id ? 700 : 500 }}>{p.name}</span>
                  {activeId === p.id && <span style={{ color: "#1A7A4A", fontSize: 11 }}>✓</span>}
                  <button onClick={() => startEdit(p)} title="Éditer" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 11, color: "#94A3B8" }}>✎</button>
                </div>
              ))}
              <button onClick={() => startEdit(null)} style={{ marginTop: 8, width: "100%", padding: "6px 0", borderRadius: 6, border: "1px dashed #1A7A4A66", background: "#1A7A4A08", color: "#1A7A4A", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>+ Nouveau périmètre</button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#1A3C2E99", marginBottom: 8 }}>{editId === "__new__" ? "Nouveau périmètre" : "Éditer le périmètre"}</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Nom (ex. Blog indexable)"
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
              <div style={{ fontSize: 10, color: "#64748B", marginBottom: 3 }}>Chemins d'URL (un par ligne, préfixes)</div>
              <textarea value={form.paths} onChange={e => setForm(f => ({ ...f, paths: e.target.value }))} placeholder={"/blog/\n/produits/"} rows={3}
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 12, marginBottom: 8, boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1A3C2E", marginBottom: 5, cursor: "pointer" }}>
                <input type="checkbox" checked={form.indexableOnly} onChange={e => setForm(f => ({ ...f, indexableOnly: e.target.checked }))} /> Indexables uniquement
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1A3C2E", marginBottom: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={form.status200Only} onChange={e => setForm(f => ({ ...f, status200Only: e.target.checked }))} /> Code HTTP 200 uniquement
              </label>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#64748B", marginBottom: 3 }}>Mots ≥</div>
                  <input type="number" value={form.minWords} onChange={e => setForm(f => ({ ...f, minWords: e.target.value }))} placeholder="—"
                    style={{ width: "100%", padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 12, boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#64748B", marginBottom: 3 }}>Profondeur ≤</div>
                  <input type="number" value={form.maxDepth} onChange={e => setForm(f => ({ ...f, maxDepth: e.target.value }))} placeholder="—"
                    style={{ width: "100%", padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 12, boxSizing: "border-box" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={savePreset} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: "#1A7A4A", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Enregistrer</button>
                <button onClick={() => setEditId(null)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #E2E8F0", background: "transparent", color: "#64748B", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Annuler</button>
                {editId !== "__new__" && <button onClick={() => deletePreset(editId)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #E8541A44", background: "transparent", color: "#E8541A", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Suppr.</button>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── AuditSetupPanel — vue props-only, zéro état local projet ────────
function SetupSection({ icon, title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span>{icon}</span>{title}
      </div>
      {children}
    </div>
  );
}

function AuditSetupPanel({
  projects, currentProjectId, setCurrentProjectId, setProjects, ownerEmail,
  sites, setSites, sfData, setSfData, smData = {}, setSmData, smOverview = {}, setSmOverview, gscData, setGscData, gaData, setGaData, bingData, setBingData,
  dbHistory, dbLoading, refreshHistory, confirmModal, setConfirmModal,
  pageTypes, setPageTypes, project, projectId,
}) {
  const [showHistory, setShowHistory] = useState(false);

  const safeProjects = Array.isArray(projects) ? projects : [];
  const safeSites    = Array.isArray(sites)    ? sites    : [];
  const safeHistory  = Array.isArray(dbHistory)? dbHistory: [];

  const lastImports = {};
  for (const row of safeHistory) {
    const k = `${row.site_id}_${row.source}`;
    if (!lastImports[k] && row.storage_path) lastImports[k] = row;
  }

  return (
    <div style={{ maxWidth: 680 }}>

      {/* ── Projet actif ── */}
      <SetupSection icon="📁" title="Projet actif">
        <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
              <select value={currentProjectId || ""} onChange={e => setCurrentProjectId(e.target.value)}
                style={{ width: "100%", padding: "7px 28px 7px 10px", border: "1.5px solid #2563EB", borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#2563EB", background: "#EFF6FF", cursor: "pointer", appearance: "none" }}>
                {safeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "#2563EB", fontSize: 11 }}>▾</span>
            </div>
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
              }} style={{ padding: "6px 10px", borderRadius: 7, border: "1.5px dashed #2563EB", background: "#EFF6FF", color: "#2563EB", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>+ Nouveau</button>
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
                    [setSfData, setGscData, setGaData, setBingData].forEach(fn => fn?.(p => { const n={...p}; delete n[site.id]; return n; }));
                  }})} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#DC2626", padding: 0 }}>✕</button>
                )}
              </div>
            ))}
            {(
              <button onClick={() => {
                const palette = SITE_PALETTE[safeSites.length % SITE_PALETTE.length] || SITE_PALETTE[0];
                const newId = `site-${Date.now()}`;
                setSites(prev => [...(Array.isArray(prev) ? prev : []), { id: newId, label: `Site ${safeSites.length + 1}`, ...palette }]);
                [setSfData, setGscData, setGaData, setBingData].forEach(fn => fn?.(p => ({...p, [newId]: []})));
              }} style={{ padding: "4px 10px", borderRadius: 20, border: "1px dashed #E2E8F0", background: "#fff", color: "#2563EB", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>+ Site</button>
            )}
          </div>

          {/* Historique */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "#94A3B8" }}>
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: dbLoading ? "#F59E0B" : safeHistory.length > 0 ? "#059669" : "#CBD5E1", marginRight: 5 }} />
              {dbLoading ? "Chargement…" : `${safeHistory.length} imports en base`}
            </span>
            <button onClick={() => { setShowHistory(h => !h); refreshHistory?.(); }}
              style={{ fontSize: 11, color: showHistory ? "#2563EB" : "#94A3B8", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              {showHistory ? "▲ Masquer" : "📋 Historique"}
            </button>
          </div>
          {showHistory && (
            <div style={{ marginTop: 8, maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {safeHistory.slice(0, 20).map(row => {
                const site = safeSites.find(s => s.id === row.site_id);
                const lbl = { sf:"🐸 SF", gsc:"🔍 GSC", ga:"📊 GA4", bing:"🤖 Bing" }[row.source] || row.source;
                return (
                  <div key={row.id} style={{ display: "flex", gap: 8, padding: "4px 8px", background: "#F1F5F9", borderRadius: 5, fontSize: 10, alignItems: "center" }}>
                    <span style={{ color: site?.color || "#1E293B", fontWeight: 600, minWidth: 60 }}>{site?.label || "—"}</span>
                    <span style={{ color: "#64748B" }}>{lbl}</span>
                    <span style={{ color: "#94A3B8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.filename}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SetupSection>

      {/* ── Imports CSV ── */}
      <SetupSection icon="📥" title="Imports CSV — SF, GSC, GA4, Bing">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {safeSites.map(site => (
            <div key={site.id} style={{ flex: "1 1 200px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: site.color, marginBottom: 8 }}>{site.label}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { key: "sf",   label: "Screaming Frog", icon: "🐸", data: sfData,   setter: setSfData },
                  { key: "gsc",  label: "Search Console",  icon: "🔍", data: gscData,  setter: setGscData },
                  { key: "ga",   label: "Analytics 4",     icon: "📊", data: gaData,   setter: setGaData },
                  { key: "bing", label: "Bing Webmaster",  icon: "🤖", data: bingData, setter: setBingData },
                ].map(({ key, label, icon, data, setter }) => {
                  const hasData = data?.[site.id]?.length > 0;
                  const lastRow = lastImports[`${site.id}_${key}`];
                  return (
                    <UploadCard key={key} label={`${icon} ${label}`} siteId={site.id} source={key}
                      projectId={projectId} project={project}
                      hasData={hasData} lastImport={lastRow}
                      onParsed={rows => setter?.(prev => ({...prev, [site.id]: rows}))}
                      onDownload={lastRow ? () => sbDownload(lastRow.storage_path).then(rows => setter?.(prev => ({...prev, [site.id]: rows}))) : null}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SetupSection>

      {/* ── Classification des pages ── */}
      <SetupSection icon="🏷️" title="Classification des pages">
        <PageTypeClassifier projectId={projectId} sites={safeSites} pageTypes={pageTypes} setPageTypes={setPageTypes} />
      </SetupSection>

    </div>
  );
}


// ── Stat card ─────────────────────────────────────────────────────
// ── Analyse par catégorie de mots-clés ───────────────────────────
function CategoryAnalysisCard({ siteQuestions, siteResults, keywords, categories, brand, claudeKey }) {
  const [status, setStatus]   = useState("idle"); // idle | warning | loading | done | error
  const [analysis, setAnalysis] = useState("");
  const [open, setOpen]         = useState(false);

  // Construire la map keyword → category pour enrichir les questions
  const kwCatMap = useMemo(() => {
    const m = {};
    keywords.forEach(k => { if (k.category_id) m[k.id] = k.category_id; });
    return m;
  }, [keywords]);

  // Vérifier si des catégories sont assignées aux mots-clés
  const kwWithCat   = keywords.filter(k => k.category_id).length;
  const kwTotal     = keywords.length;
  const hasCats     = kwWithCat > 0;
  const catCoverage = kwTotal > 0 ? Math.round(kwWithCat / kwTotal * 100) : 0;

  // Grouper les questions par catégorie via keyword_id → category_id
  const byCategory = useMemo(() => {
    const map = {}; // category_id → { cat, questions, results }
    siteQuestions.forEach(q => {
      const catId = kwCatMap[q.keyword_id] || "__none__";
      if (!map[catId]) map[catId] = { questions: [], results: [] };
      map[catId].questions.push(q);
    });
    siteResults.forEach(r => {
      const q = siteQuestions.find(q => q.id === r.question_id);
      const catId = (q && kwCatMap[q.keyword_id]) || "__none__";
      if (!map[catId]) map[catId] = { questions: [], results: [] };
      map[catId].results.push(r);
    });
    return map;
  }, [siteQuestions, siteResults, kwCatMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const catStats = useMemo(() => {
    return Object.entries(byCategory)
      .filter(([id]) => id !== "__none__")
      .map(([id, { questions, results }]) => {
        const cat = categories.find(c => c.id === id);
        const total = results.length;
        const present = results.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
        const pct = total > 0 ? Math.round(present / total * 100) : null;
        return { id, cat, questions: questions.length, results: total, present, pct };
      })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  }, [byCategory, categories]); // eslint-disable-line react-hooks/exhaustive-deps

  const noneStats = byCategory["__none__"] ? (() => {
    const { questions, results } = byCategory["__none__"];
    const present = results.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
    return { questions: questions.length, results: results.length, present };
  })() : null;

  const run = async () => {
    if (!claudeKey) return;
    setStatus("loading"); setAnalysis(""); setOpen(true);
    const brandName = brand?.brand_name || "la marque";
    const rows = catStats.map(s =>
      `- ${s.cat?.name || s.id} : ${s.pct !== null ? s.pct + "%" : "—"} présence (${s.present}/${s.results} rép., ${s.questions} questions)`
    ).join("\n");
    const prompt = `Tu es un expert GEO (Generative Engine Optimization).
Voici la présence de "${brandName}" dans les réponses LLM, ventilée par catégorie de mots-clés :

${rows || "Aucune donnée de catégorie disponible."}

${noneStats ? `Questions non catégorisées : ${noneStats.results} réponses, ${Math.round((noneStats.present/Math.max(noneStats.results,1))*100)}% de présence.\n` : ""}

Analyse en 3 sections :
## Forces par catégorie
Quelles catégories ont la meilleure présence et pourquoi (2-3 phrases max par catégorie forte).

## Axes prioritaires
Les 3 catégories avec le plus grand potentiel de progression. Pour chacune : diagnostic et action concrète.

## Recommandation transversale
Une recommandation de contenu ou de stratégie qui s'applique à toutes les catégories faibles.

Sois direct, concis, actionnable. Pas de généralités.`;

    try {
      const res = await fetch("/api/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 900, messages: [{ role: "user", content: prompt }], apiKey: claudeKey }),
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || data.error?.message || "Erreur de génération.";
      setAnalysis(text);
      setStatus("done");
    } catch(e) {
      setAnalysis("Erreur : " + e.message);
      setStatus("error");
    }
  };

  const handleCTA = () => {
    if (!hasCats) {
      setStatus("warning");
    } else {
      run();
    }
  };

  // Couleur de présence
  const pctColor = (p) => p === null ? C.textLight : p >= 60 ? "#059669" : p >= 30 ? "#D97706" : "#DC2626";
  const pctBg    = (p) => p === null ? C.bg : p >= 60 ? "#ECFDF5" : p >= 30 ? "#FFFBEB" : "#FEF2F2";

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
      {/* Header */}
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, background: C.bg, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>📂</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Analyse par catégorie</div>
            <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>
              Présence de la marque ventilée par catégorie de mots-clés
            </div>
          </div>
        </div>
        <button
          onClick={handleCTA}
          disabled={status === "loading" || !claudeKey}
          style={{ padding: "5px 14px", background: (status === "loading" || !claudeKey) ? "transparent" : "#1A3C2E", color: (status === "loading" || !claudeKey) ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: (status === "loading" || !claudeKey) ? "default" : "pointer" }}
          title={!claudeKey ? "Aucune clé API Claude renseignée — ajoutez-la dans ⚙️ Providers" : undefined}
        >
          {status === "loading" ? "⏳ Analyse…" : "✦ Analyser par catégorie"}
        </button>
      </div>

      {/* Warning — pas de catégories */}
      {status === "warning" && (
        <div style={{ padding: "14px 20px", background: "#FFFBEB", borderBottom: `1px solid #FDE68A` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E", marginBottom: 4 }}>
            ⚠️ Aucun mot-clé catégorisé ({catCoverage}% des {kwTotal} mots-clés ont une catégorie)
          </div>
          <div style={{ fontSize: 11, color: "#B45309", marginBottom: 10 }}>
            Pour une analyse pertinente, catégorisez vos mots-clés dans <strong>Suivi GEO → Mots-clés</strong>.
            Les catégories s'appliquent aux questions liées au mot-clé.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={run} style={{ padding: "5px 14px", background: "#D97706", color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Analyser quand même
            </button>
            <button onClick={() => setStatus("idle")} style={{ padding: "5px 14px", background: "none", border: `1px solid #D97706`, color: "#D97706", borderRadius: 7, fontSize: 11, cursor: "pointer" }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Tableau des catégories — toujours visible */}
      {catStats.length > 0 && (
        <div style={{ padding: "14px 20px", borderBottom: status === "done" ? `1px solid ${C.border}` : "none" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.bg }}>
                {["Catégorie", "Questions", "Réponses", "Présence"].map(h => (
                  <th key={h} style={{ padding: "6px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catStats.map(s => (
                <tr key={s.id} style={{ borderBottom: `1px solid ${C.borderLight}` }}>
                  <td style={{ padding: "7px 12px", fontWeight: 600 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: s.cat?.color || "#94A3B8", marginRight: 8 }} />
                    {s.cat?.name || s.id}
                  </td>
                  <td style={{ padding: "7px 12px", color: C.textMid }}>{s.questions}</td>
                  <td style={{ padding: "7px 12px", color: C.textMid }}>{s.results}</td>
                  <td style={{ padding: "7px 12px" }}>
                    {s.pct !== null
                      ? <span style={{ fontWeight: 700, color: pctColor(s.pct), background: pctBg(s.pct), borderRadius: 5, padding: "2px 8px" }}>{s.pct}%</span>
                      : <span style={{ color: C.textLight, fontSize: 11 }}>—</span>}
                  </td>
                </tr>
              ))}
              {noneStats && noneStats.questions > 0 && (
                <tr style={{ borderBottom: `1px solid ${C.borderLight}`, opacity: 0.6 }}>
                  <td style={{ padding: "7px 12px", fontStyle: "italic", color: C.textLight }}>Non catégorisées</td>
                  <td style={{ padding: "7px 12px", color: C.textLight }}>{noneStats.questions}</td>
                  <td style={{ padding: "7px 12px", color: C.textLight }}>{noneStats.results}</td>
                  <td style={{ padding: "7px 12px", color: C.textLight }}>{noneStats.results > 0 ? Math.round(noneStats.present/noneStats.results*100)+"%" : "—"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {catStats.length === 0 && status !== "warning" && (
        <div style={{ padding: "14px 20px", fontSize: 12, color: C.textLight, fontStyle: "italic" }}>
          Catégorisez vos mots-clés dans Suivi GEO → Mots-clés pour voir la présence par axe thématique.
        </div>
      )}

      {/* Résultat analyse IA */}
      {status === "done" && analysis && (
        <div style={{ padding: "16px 20px" }}>
          <button onClick={() => setOpen(o => !o)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#1A3C2E", fontWeight: 500, padding: 0, marginBottom: open ? 10 : 0 }}>
            {open ? "▲ Masquer l'analyse IA" : "▼ Voir l'analyse IA"}
          </button>
          {open && (
            <div style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>
              {analysis.split("\n").map((line, i) => {
                if (line.startsWith("## ")) return <div key={i} style={{ fontWeight: 600, fontSize: 11, color: "#1A3C2E", marginTop: 12, marginBottom: 4, letterSpacing: "0.06em", textTransform: "uppercase" }}>{line.slice(3)}</div>;
                if (line.startsWith("- ")) return <div key={i} style={{ paddingLeft: 14, marginBottom: 3 }}>• {line.slice(2)}</div>;
                if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
                return <div key={i} style={{ marginBottom: 3 }}>{line}</div>;
              })}
            </div>
          )}
        </div>
      )}
      {status === "error" && (
        <div style={{ padding: "12px 20px", fontSize: 11, color: "#DC2626" }}>⚠️ {analysis}</div>
      )}
    </div>
  );
}

function Section({ icon, title, sub, children }) {
  return (
    <div style={{ background: "#fff", border: "0.5px solid #1A3C2E0D", borderRadius: 10, padding: "18px 20px", marginBottom: 12 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E" }}>
          {title}
        </div>
        {sub && <div style={{ fontSize: 11, color: "#1A3C2E", marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Scatter plot concurrents : citations (X) × position moy. (Y) ──
// ── FavoritesPerformance — met en avant les questions favorites ──
// 4 buckets : À défendre (#1-3) / À surveiller (#4-10) / Conquête prioritaire / À conquérir
// ── Mini graphe en barres verticales pour l'audit (style Fan-out) ──
// data: [{ name, count, kind }] · kind ∈ brand|competitor|other
function AuditBarChart({ data, accent = "#1A3C2E" }) {
  const [hover, setHover] = useState(null);
  const rows = (data || []).slice(0, 14);
  const max = rows.length ? Math.max(...rows.map(d => d.count)) : 0;
  const colorFor = (kind) => kind === "brand" ? "#1A7A4A" : kind === "competitor" ? "#C0352A" : "#9AAEA4";
  if (!rows.length) return <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic" }}>Aucune donnée</div>;
  return (
    <div>
      <div style={{ position: "relative", height: 140, display: "flex", alignItems: "flex-end", gap: rows.length > 9 ? 3 : 6, padding: "18px 0 0" }}>
        {rows.map((d, i) => {
          const h = max ? Math.max((d.count / max) * 100, 4) : 4;
          const isHover = hover === i;
          return (
            <div key={d.name + i}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", position: "relative" }}>
              {isHover && (
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: "50%", transform: "translateX(-50%)", background: "#1A3C2E", color: "#F0EBE0", borderRadius: 6, padding: "5px 9px", fontSize: 11, whiteSpace: "nowrap", zIndex: 5, boxShadow: "0 2px 8px #1A3C2E33", pointerEvents: "none" }}>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  <div style={{ opacity: 0.8 }}>{d.count} citation{d.count > 1 ? "s" : ""}</div>
                </div>
              )}
              <div style={{ width: "100%", height: `${h}%`, background: colorFor(d.kind), borderRadius: "3px 3px 0 0", opacity: isHover ? 1 : 0.88, transition: "opacity 0.12s", minHeight: 3 }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: rows.length > 9 ? 3 : 6, marginTop: 6, height: 64 }}>
        {rows.map((d, i) => (
          <div key={d.name + i} style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
            <span style={{ fontSize: 9, color: hover === i ? "#1A3C2E" : "#1A3C2E", whiteSpace: "nowrap", transform: "rotate(-45deg)", transformOrigin: "top left", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 80, display: "inline-block", marginTop: 2 }}>{d.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── FanoutAnalysisRecap — récupère l'analyse produite dans Fan-out ──
// Affiche (lecture seule) la dernière analyse "fanout" générée dans l'onglet
// Fan-outs (GeoAnalysis), pour la retrouver directement dans l'audit.
function FanoutAnalysisRecap({ projectId, siteId }) {
  const [sections, setSections] = useState(null);
  const [savedDate, setSavedDate] = useState(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!projectId || !siteId) { setSections(null); return; }
    let cancelled = false;
    sbGetGeoAnalyses(projectId, siteId, "fanout").then(rows => {
      if (cancelled || !rows?.length) { setSections(null); return; }
      const c = rows[0].content;
      if (c?.sections?.length) { setSections(c.sections); setSavedDate(rows[0].created_at); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]);

  if (!sections?.length) return null;

  const META = {
    "ÉTAT DES LIEUX":    { icon: "◎", color: "#1A3C2E" },
    "MAILLAGE INTERNE":  { icon: "⟶", color: "#1A3C2E" },
    "PAGES À CRÉER":     { icon: "✦", color: "#C97820" },
    "URLS CONCURRENTES": { icon: "↗", color: "#1A3C2E" },
  };
  const getMeta = (title) => {
    const key = Object.keys(META).find(k => (title || "").toUpperCase().includes(k));
    return META[key] || { icon: "•", color: "#1A3C2E" };
  };

  return (
    <div data-tour="audit-fanout-recap" style={{ display: "contents" }}>
      <Section title="Analyse Fan-out" sub="Recommandations générées dans l'onglet Suivi GEO">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          {savedDate && (
            <span style={{ fontSize: 10, color: "#1A3C2E" }}>
              Générée le {new Date(savedDate).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={() => setOpen(o => !o)}
            style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "0.5px solid #1A3C2E22", background: "transparent", color: "#1A3C2E", cursor: "pointer" }}>
            {open ? "Réduire" : "Déployer"}
          </button>
        </div>
        {open && sections.map((s, i) => {
          const meta = getMeta(s.title);
          if (s.title === "Erreur") return null;
          return (
            <div key={i} style={{ borderLeft: "2px solid #1A3C2E0D", paddingLeft: 16, paddingBottom: 16, marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: meta.color }}>{meta.icon}</span>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: meta.color }}>{s.title}</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: "#1A3C2E", whiteSpace: "pre-wrap" }}>{renderBold(s.body || "")}</div>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function FavoritesPerformance({ questions, results, projectId = null, siteId = null }) {
  // Overrides manuels de bucket par question (drag & drop), persistés en localStorage
  const storageKey = `geoFavBuckets_${projectId || "p"}_${siteId || "s"}`;
  const [overrides, setOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; }
  });
  const [dragOverBucket, setDragOverBucket] = useState(null);

  const persistOverrides = useCallback((next) => {
    setOverrides(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota */ }
  }, [storageKey]);

  const order = ["defend", "watch", "conquest_priority", "conquer"];

  const data = useMemo(() => {
    const favs = questions.filter(q => q.is_favorite);
    if (!favs.length) return null;
    const byQ = {};
    results.forEach(r => { (byQ[r.question_id] = byQ[r.question_id] || []).push(r); });
    const posOf = (qId) => {
      const rs = byQ[qId] || [];
      const ps = rs.map(r => r.brand_mention_position || r.brand_position).filter(p => p != null && p > 0);
      return ps.length ? Math.min(...ps) : null;
    };
    const mentioned = (qId) => (byQ[qId] || []).some(r => r.brand_mentioned === true || r.brand_mentioned === 1);
    const computedBucket = (q, pos, ment) => {
      if (ment && pos != null && pos <= 3) return "defend";
      if (ment && pos != null && pos >= 4 && pos <= 10) return "watch";
      if (!ment && q.keyword_id) return "conquest_priority";
      return "conquer";
    };
    const buckets = { defend: [], watch: [], conquest_priority: [], conquer: [] };
    favs.forEach(q => {
      const pos = posOf(q.id), ment = mentioned(q.id);
      const auto = computedBucket(q, pos, ment);
      const b = overrides[q.id] && order.includes(overrides[q.id]) ? overrides[q.id] : auto;
      buckets[b].push({ id: q.id, question: q.question, pos, moved: !!overrides[q.id] && overrides[q.id] !== auto });
    });
    return { buckets, total: favs.length };
  }, [questions, results, overrides]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return (
    <div style={{ fontSize: 12, color: "#1A3C2E", fontStyle: "italic", padding: "8px 0" }}>
      Aucune question favorite. Marquez vos questions stratégiques (★) dans l'onglet Suivi GEO pour les suivre ici.
    </div>
  );

  const META = {
    defend:            { label: "À défendre",          color: "#1A7A4A", desc: "La marque lead (#1-3)" },
    watch:             { label: "À surveiller",         color: "#C97820", desc: "Top 4-10" },
    conquest_priority: { label: "Conquête prioritaire", color: "#E8541A", desc: "Non positionnée · fort potentiel" },
    conquer:           { label: "À conquérir",          color: "#1A3C2E", desc: "Non positionnée" },
  };

  const moveToBucket = (qId, targetBucket) => {
    if (!qId || !order.includes(targetBucket)) return;
    persistOverrides({ ...overrides, [qId]: targetBucket });
  };
  const resetOverride = (qId) => {
    const next = { ...overrides };
    delete next[qId];
    persistOverrides(next);
  };

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#1A3C2E" }}>
          Glissez-déposez une question d'une colonne à l'autre pour ajuster sa priorité.
        </div>
        {hasOverrides && (
          <button onClick={() => persistOverrides({})}
            style={{ fontSize: 10, padding: "3px 10px", borderRadius: 6, border: "0.5px solid #1A3C2E22", background: "transparent", color: "#1A3C2E", cursor: "pointer" }}>
            ↺ Réinitialiser le classement
          </button>
        )}
      </div>

      {/* Barre de répartition */}
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#1A3C2E0C", marginBottom: 14 }}>
        {order.map(b => {
          const n = data.buckets[b].length;
          if (!n) return null;
          return <div key={b} style={{ width: `${n / data.total * 100}%`, background: META[b].color }} title={`${META[b].label} : ${n}`} />;
        })}
      </div>

      {/* Grille des 4 buckets (drop zones) */}
      <div className="audit-questions-grid">
        {order.map(b => {
          const items = data.buckets[b];
          const meta = META[b];
          const isDropTarget = dragOverBucket === b;
          return (
            <div key={b}
              onDragOver={(e) => { e.preventDefault(); if (dragOverBucket !== b) setDragOverBucket(b); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverBucket(null); }}
              onDrop={(e) => {
                e.preventDefault();
                const qId = e.dataTransfer.getData("text/plain");
                setDragOverBucket(null);
                if (qId) moveToBucket(qId, b);
              }}
              style={{
                border: `0.5px solid ${isDropTarget ? meta.color : "#1A3C2E"}`,
                background: isDropTarget ? `${meta.color}0A` : "transparent",
                borderRadius: 10, padding: "12px 14px", transition: "background 0.15s, border-color 0.15s",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>{meta.label}</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: meta.color, marginLeft: "auto" }}>{items.length}</span>
              </div>
              <div style={{ fontSize: 10, color: "#1A3C2E", marginBottom: 8 }}>{meta.desc}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 30, maxHeight: 200, overflowY: "auto" }}>
                {items.map((it) => (
                  <div key={it.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; }}
                    title={it.moved ? "Déplacée manuellement — double-clic pour rétablir le classement auto" : "Glissez pour déplacer"}
                    onDoubleClick={() => it.moved && resetOverride(it.id)}
                    style={{ fontSize: 11, color: "#1A3C2E", lineHeight: 1.4, display: "flex", gap: 6, alignItems: "baseline", cursor: "grab", padding: "3px 4px", borderRadius: 4, background: it.moved ? `${meta.color}0C` : "transparent" }}>
                    <span style={{ color: "#1A3C2E", flexShrink: 0, fontSize: 10 }}>⋮⋮</span>
                    <span style={{ flex: 1 }}>{it.question}{it.moved && <span style={{ color: meta.color, marginLeft: 4 }}>•</span>}</span>
                    {it.pos != null && <span style={{ fontSize: 10, color: meta.color, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>#{it.pos}</span>}
                  </div>
                ))}
                {!items.length && <div style={{ fontSize: 10, color: "#1A3C2E", fontStyle: "italic", padding: "8px 0", textAlign: "center" }}>Déposez ici</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GeoScoreBanner({ audit, auditFav = null, brand, site }) {
  const score = audit.presenceRate;
  const favScore = auditFav ? auditFav.presenceRate : null;
  const favDelta = favScore != null ? favScore - score : null;
  const level = score >= 70 ? { label: "Excellente",            color: "#1A7A4A", bar: "#1A7A4A" }
              : score >= 50 ? { label: "Bonne présence",           color: "#1A3C2E", bar: "#1A3C2E" }
              : score >= 30 ? { label: "Potentiel à développer",   color: "#C97820", bar: "#C97820" }
              :               { label: "Potentiel à exploiter",    color: "#C97820", bar: "#C97820" };
  return (
    <div style={{ background: "#fff", border: "0.5px solid #1A3C2E0D", borderRadius: 12, padding: "24px 28px", marginBottom: 18 }}>
      <div className="audit-banner-inner">
        {/* Score */}
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 8 }}>Présence GEO</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 52, fontWeight: 800, color: level.color, lineHeight: 1, letterSpacing: "-0.02em" }}>{score}</span>
            <span style={{ fontSize: 20, color: level.color, fontWeight: 600 }}>%</span>
          </div>
          <div style={{ marginTop: 10, height: 5, background: "#1A3C2E0C", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${score}%`, background: level.bar, borderRadius: 3, transition: "width 0.5s" }} />
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: level.color, fontWeight: 600 }}>{level.label}</div>
          {/* Score favoris en parallèle */}
          {favScore != null && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px solid #1A3C2E0C" }}>
              <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C97820", marginBottom: 3, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#C97820" }}>★</span> Favoris
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: "#C97820", lineHeight: 1, letterSpacing: "-0.02em" }}>{favScore}</span>
                <span style={{ fontSize: 13, color: "#C97820", fontWeight: 500 }}>%</span>
                {favDelta != null && favDelta !== 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: favDelta > 0 ? "#1A7A4A" : "#C0352A", marginLeft: 2 }}>
                    {favDelta > 0 ? "▲ +" : "▼ "}{favDelta} pts
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "#1A3C2E", marginTop: 3 }}>{auditFav.withBrand}/{auditFav.total} réponses favorites</div>
            </div>
          )}
        </div>

        {/* Séparateur */}
        <div className="audit-banner-sep" />

        {/* Barre proportion M/É/C */}
        <div style={{ flex: "0 0 auto", minWidth: 200 }}>
          <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 10 }}>Répartition</div>
          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#1A3C2E0C", marginBottom: 12 }}>
            {audit.total > 0 && <>
              <div style={{ width: `${(audit.withRanked||0)/audit.total*100}%`, background: "#1A7A4A" }} />
              <div style={{ width: `${(audit.withMentionOnly||0)/audit.total*100}%`, background: "#C97820" }} />
              <div style={{ width: `${(audit.withSourceOnly||0)/audit.total*100}%`, background: "#1A3C2E55" }} />
            </>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[
              { sym: "◎", label: "Mention",        val: audit.withRanked||0,      color: "#1A7A4A" },
              { sym: "⟶", label: "Évocation",      val: audit.withMentionOnly||0, color: "#C97820" },
              { sym: "↗",  label: "Citation seule", val: audit.withSourceOnly||0,  color: "#1A3C2E" },
            ].map(k => (
              <div key={k.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "#1A3C2E" }}><span style={{ color: k.color }}>{k.sym}</span> {k.label}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: k.color }}>{k.val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Séparateur */}
        <div className="audit-banner-sep" />

        {/* KPIs contextuels */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 10 }}>Contexte</div>
          <div className="audit-banner-context">
            {[
              { label: "Marque",                  val: brand?.brand_name || "—" },
              { label: "Site",                    val: site?.label || "—" },
              { label: "Questions",               val: audit.questions },
              { label: "Résultats",               val: audit.total },
              { label: "Pos. moy.",               val: audit.avgPos ? `#${audit.avgPos}` : "—" },
              { label: "Concurrents renseignés",  val: Object.keys(audit.compStats).length },
            ].map(k => (
              <div key={k.label}>
                <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 3, whiteSpace: "nowrap" }}>{k.label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1A3C2E" }}>{k.val}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Normalise une URL pour comparaison et groupement ─────────────
function normalizeUrl(raw) {
  if (!raw) return "";
  let u = raw.trim();
  // Supprimer le query string et fragment
  u = u.replace(/[?#].*$/, "");
  // Supprimer le slash final
  u = u.replace(/\/$/, "");
  // Supprimer https:// http://
  u = u.replace(/^https?:\/\//i, "");
  // Supprimer www.
  u = u.replace(/^www\./i, "");
  return u.toLowerCase();
}

function computeAudit(questions, results, urlIndex, brand, site, calendarEntries = [], keywords = [], competitors = [], aliasMap = {}, aggregation = null, brandSiteId = null) {
  // Canonicalisation par alias : un nom A est compté comme son canonique B.
  const _aliasLut = {};
  Object.entries(aliasMap || {}).forEach(([a, b]) => { _aliasLut[(a || "").toLowerCase().trim()] = b; });
  const canonName = (name) => { if (!name) return name; return _aliasLut[name.toLowerCase().trim()] || name; };

  // ── Multi-marques : normalisation de la présence par résultat ────────────
  // aggregation : null (comportement actuel, marque propriétaire du site)
  //             | "simple"     (vue globale : 1 présence max par question)
  //             | "cumulative" (vue globale : somme des présences de chaque marque)
  // brandSiteId : si défini, on lit la présence de CETTE marque (vue "une marque").
  // brand_presences[site_id] fournit la présence par marque (rempli au Temps 2) ;
  // à défaut, on se rabat sur les champs brand_* classiques (marque du site du résultat).
  const _qSites = {}; // question_id → liste de site_ids associés
  (questions || []).forEach(q => { _qSites[q.id] = Array.isArray(q.associated_sites) ? q.associated_sites : []; });
  const _presenceOf = (r, siteId) => {
    const bp = r.brand_presences && typeof r.brand_presences === "object" ? r.brand_presences[siteId] : null;
    if (bp) return {
      mentioned: !!bp.mentioned, mentionPos: bp.mention_position ?? null,
      evocPos: bp.evocation_position ?? null, citPos: bp.citation_position ?? null, inSources: !!bp.in_sources,
    };
    if (siteId === r.site_id) return {
      mentioned: r.brand_mentioned === true || r.brand_mentioned === 1,
      mentionPos: r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null),
      evocPos: r.brand_evocation_position ?? null, citPos: r.brand_citation_position ?? null,
      inSources: r.brand_in_sources === true || r.brand_in_sources === 1,
    };
    return null; // pas de donnée pour cette marque sur ce résultat (avant Temps 2)
  };
  const _applyPresence = (r, p) => ({
    ...r,
    brand_mentioned: p ? (p.mentioned || p.mentionPos != null || p.evocPos != null) : false,
    brand_mention_position: p ? p.mentionPos : null,
    brand_evocation_position: p ? p.evocPos : null,
    brand_citation_position: p ? p.citPos : null,
    brand_position: p ? p.mentionPos : null,
    brand_in_sources: p ? p.inSources : false,
  });
  // Marques à considérer pour un résultat = sites associés à sa question ∪ site du résultat.
  const _brandsFor = (r) => {
    const set = new Set([...(_qSites[r.question_id] || [])]);
    if (r.site_id) set.add(r.site_id);
    return [...set];
  };
  const _normalize = (rows) => {
    if (!aggregation && !brandSiteId) return rows; // comportement historique : inchangé
    if (brandSiteId) {
      // Vue "une marque" : présence de cette marque uniquement.
      return rows.map(r => _applyPresence(r, _presenceOf(r, brandSiteId)));
    }
    if (aggregation === "cumulative") {
      // Somme des présences : un clone par marque présente (concurrents/sources
      // conservés sur le 1er clone seulement pour ne pas gonfler leurs stats).
      const out = [];
      rows.forEach(r => {
        const brands = _brandsFor(r);
        let first = true;
        brands.forEach(sid => {
          const p = _presenceOf(r, sid);
          if (!p) return; // pas de donnée pour cette marque (avant Temps 2) → ignorée
          const present = p.mentioned || p.mentionPos != null || p.evocPos != null || p.inSources;
          const clone = _applyPresence(r, present ? p : null); // détectée absente → ligne absente (compte au dénominateur, pas au numérateur)
          if (!first) { clone.competitors_mentioned = []; clone.sources = []; clone.unknown_entities = []; }
          clone.id = `${r.id}~${sid}`;
          out.push(clone);
          first = false;
        });
        if (first) out.push(_applyPresence(r, null)); // aucune donnée → 1 ligne absente
      });
      return out;
    }
    // "simple" : 1 présence max par résultat = OU sur les marques (meilleure position).
    return rows.map(r => {
      const brands = _brandsFor(r);
      let best = null;
      brands.forEach(sid => {
        const p = _presenceOf(r, sid);
        if (!p) return;
        if (!best) { best = { ...p }; return; }
        best.mentioned = best.mentioned || p.mentioned;
        best.inSources = best.inSources || p.inSources;
        const lo = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);
        best.mentionPos = lo(best.mentionPos, p.mentionPos);
        best.evocPos = lo(best.evocPos, p.evocPos);
        best.citPos = lo(best.citPos, p.citPos);
      });
      return _applyPresence(r, best);
    });
  };

  // ── Instantané vs historique ─────────────────────────────────────
  // L'audit est un INSTANTANÉ : seul le DERNIER résultat par couple
  // (question, provider) compte dans les statistiques. L'historique complet
  // (allResults) ne sert qu'aux séries temporelles et à la détection des
  // positions perdues.
  const allResults = _normalize(results);
  const _snapKey = {};
  allResults.forEach(r => {
    const k = `${r.question_id || "?"}|${getProviderId(r.model)}${r.id && String(r.id).includes("~") ? "|" + String(r.id).split("~")[1] : ""}`;
    if (!_snapKey[k] || new Date(r.created_at || 0) > new Date(_snapKey[k].created_at || 0)) _snapKey[k] = r;
  });
  results = Object.values(_snapKey);
  const distinctRuns = results.length; // paires (question, provider) réellement testées
  const brandName = brand?.brand_name || "";
  const brandAliases = brand?.brand_aliases || [];
  const total = results.length;
  const withBrand = results.filter(r => r.brand_mentioned).length;
  const withSources = results.filter(r => r.brand_in_sources).length;
  const positions = results.filter(r => r.brand_position).map(r => r.brand_position);
  const avgPos = positions.length ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : null;

  // ── Positions moyennes par type de présence (Mention / Évocation / Citation) ──
  // Exploite brand_mention_position / brand_evocation_position / brand_citation_position
  const avgOf = (vals) => vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
  const mentionPositions   = results.map(r => r.brand_mention_position).filter(p => p != null && p > 0);
  const evocationPositions = results.map(r => r.brand_evocation_position).filter(p => p != null && p > 0);
  const citationPositions  = results.map(r => r.brand_citation_position).filter(p => p != null && p > 0);
  const avgMentionPos   = avgOf(mentionPositions);
  const avgEvocationPos = avgOf(evocationPositions);
  const avgCitationPos  = avgOf(citationPositions);
  const mentionCount    = mentionPositions.length;
  const evocationCount  = evocationPositions.length;
  const citationCount   = citationPositions.length;

  // ── Breakdown 3 types de présence (mutuellement exclusifs) ───────
  // Répartition EXCLUSIVE (pour la barre empilée) — mais fondée sur la MÊME
  // classification canonique que les compteurs et la chronologie, pour qu'une
  // réponse classée ne bascule jamais dans « citation seule ».
  const getPresType = (r) => {
    if (!r) return null;
    const c = classifyResult(r);
    if (c.mention) return "ranked";
    if (c.citation) return "source";
    if (c.evocation) return "mention";
    return null;
  };
  const withRanked      = results.filter(r => getPresType(r) === "ranked").length;
  const withSourceOnly  = results.filter(r => getPresType(r) === "source").length;
  const withMentionOnly = results.filter(r => getPresType(r) === "mention").length;

  // ── TrendChart — basé sur les résultats + geo_calendar_dates ─────
  // Combinaison des deux sources pour toujours avoir une tendance à jour :
  // 1. calendarEntries : entrées DB détaillées (par test)
  // 2. results : résultats en mémoire (toujours à jour après un run)
  const calByDate = {};

  // Source 1 : geo_calendar_dates (données historiques précises)
  calendarEntries.forEach(e => {
    const d = e.test_date || (e.created_at || "").slice(0, 10);
    if (!d) return;
    if (!calByDate[d]) calByDate[d] = { tested: 0, present: 0, mentions: 0, citations: 0, evocations: 0 };
    calByDate[d].tested++;
    if (e.brand_present === true || e.brand_present === 1) calByDate[d].present++;
    // Ventilation M/É/C depuis les colonnes du calendrier (brand_mention / brand_citation / brand_evocation)
    if (e.brand_mention === 1 || e.brand_mention === true || e.mention_position != null) calByDate[d].mentions++;
    else if (e.brand_citation === 1 || e.brand_citation === true) calByDate[d].citations++;
    else if (e.brand_evocation === 1 || e.brand_evocation === true || e.brand_present === true || e.brand_present === 1) calByDate[d].evocations++;
  });

  // Source 2 : résultats en mémoire — TOUJOURS ventiler M/É/C
  // On crée l'entrée si elle n'existe pas (nouveaux jours sans calendarEntries)
  // ET on enrichit les entrées existantes avec la ventilation précise
  const calByDateFromResults = {};
  allResults.forEach(r => {
    const d = (r.created_at || "").slice(0, 10);
    if (!d) return;
    if (!calByDateFromResults[d]) calByDateFromResults[d] = { tested: 0, present: 0, mentions: 0, citations: 0, evocations: 0 };
    calByDateFromResults[d].tested++;
    if (r.brand_mention_position != null || (r.brand_position != null && r.brand_position > 0)) {
      calByDateFromResults[d].mentions++;
      calByDateFromResults[d].present++;
    } else if (r.brand_in_sources) {
      calByDateFromResults[d].citations++;
      calByDateFromResults[d].present++;
    } else if (r.brand_mentioned === true || r.brand_mentioned === 1) {
      calByDateFromResults[d].evocations++;
      calByDateFromResults[d].present++;
    }
  });
  // Fusionner : calendarEntries a priorité pour tested/present (historique précis)
  // mais les results fournissent toujours la ventilation M/É/C
  Object.entries(calByDateFromResults).forEach(([d, rv]) => {
    if (!calByDate[d]) {
      // Jour non couvert par calendarEntries → utiliser les results directement
      calByDate[d] = rv;
    } else {
      // Le calendrier couvre TOUTES les interrogations du jour (une entrée par test) :
      // sa ventilation est prioritaire. On ne complète depuis les results que si le
      // calendrier n'a aucune ventilation alors qu'il y a de la présence (anciennes lignes).
      const calVent = calByDate[d].mentions + calByDate[d].citations + calByDate[d].evocations;
      if (calVent === 0 && calByDate[d].present > 0) {
        calByDate[d].mentions  = rv.mentions;
        calByDate[d].citations = rv.citations;
        calByDate[d].evocations= rv.evocations;
      }
    }
  });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const trendDays = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const day = calByDate[key] || { tested: 0, present: 0 };
    trendDays.push({
      date: key,
      tested:    day.tested,
      present:   day.present,
      mentions:  day.mentions  || 0,
      citations: day.citations || 0,
      evocations:day.evocations|| 0,
      rate: day.tested > 0 ? pct(day.present, day.tested) : null,
    });
  }

  // ── URLs marque — normalisation et cumul ─────────────────────
  const brandTerms = [brandName, ...brandAliases]
    .filter(v => typeof v === "string" && v.trim())
    .map(t => t.toLowerCase());
  const isBrandTerm = (str) => brandTerms.some(t => t && String(str || "").toLowerCase().includes(t));

  // Pré-calculer les noms de concurrents normalisés (objets ou strings)
  const competitorNames = competitors
    .map(c => typeof c === "string" ? c : c?.name)
    .filter(Boolean)
    .map(name => name.toLowerCase());

  // Grouper urlIndex par URL normalisée
  const normGroups = {};
  urlIndex.forEach(u => {
    const norm = normalizeUrl(u.url);
    if (!norm) return;
    if (!normGroups[norm]) normGroups[norm] = { norm, url: u.url, count_as_source: 0, count_in_answer: 0, domain: null, linkedQs: [], linkedKeywords: [] };
    normGroups[norm].count_as_source += u.count_as_source || 0;
    normGroups[norm].count_in_answer += u.count_in_answer || 0;
    if (!normGroups[norm].domain) normGroups[norm].domain = u.domain;
  });
  const mergedUrls = Object.values(normGroups).sort((a, b) => (b.count_as_source + b.count_in_answer) - (a.count_as_source + a.count_in_answer));

  const sortedUrls = mergedUrls;
  const brandUrls = mergedUrls.filter(u =>
    isBrandTerm(u.norm) || isBrandTerm(u.domain || "")
  );
  const competitorUrls = mergedUrls.filter(u =>
    !isBrandTerm(u.norm) && competitorNames.some(name => u.norm.includes(name))
  );
  const referenceUrls = mergedUrls
    .filter(u => !brandUrls.includes(u) && !competitorUrls.includes(u))
    .slice(0, 10);

  // urlDetails — relier les URLs marque aux questions
  const qMap = {};
  questions.forEach(q => { qMap[q.id] = q; });
  const urlDetails = brandUrls.map(u => {
    const linkedResults = results.filter(r =>
      (r.sources || []).some(s => normalizeUrl(s) === u.norm) ||
      (r.answer || "").includes(u.norm)
    );
    const linkedQIds = [...new Set(linkedResults.map(r => r.question_id))];
    const linkedQs = linkedQIds.map(id => qMap[id]).filter(Boolean);
    const linkedKeywords = [...new Set(linkedQs.map(q => q.keyword_id).filter(Boolean))];
    return { ...u, linkedQs, linkedKeywords };
  });

  const topDomains = {};
  sortedUrls.forEach(u => {
    if (!topDomains[u.norm]) topDomains[u.norm] = 0;
    topDomains[u.norm] += u.count_as_source + u.count_in_answer;
  });

  const urlsToOptimize = brandUrls.filter(u => u.count_as_source < 3).slice(0, 15);
  const urlsToRework   = brandUrls.filter(u => u.count_as_source === 0 && u.count_in_answer > 0).slice(0, 15);
  const urlsToInspire  = referenceUrls.filter(u => u.count_as_source >= 3).slice(0, 10);

  const intentCount = {};
  results.forEach(r => { if (r.intent_type) intentCount[r.intent_type] = (intentCount[r.intent_type] || 0) + 1; });
  const typeCount = {};
  results.forEach(r => { if (r.answer_type) typeCount[r.answer_type] = (typeCount[r.answer_type] || 0) + 1; });

  // ── UPGRADE 1 : Segmentation par intention (intent_type) avec perf M/É/C ──
  // Pour chaque intention, on compte les résultats et la présence de la marque.
  const intentStats = {};
  results.forEach(r => {
    const it = r.intent_type || "non classé";
    if (!intentStats[it]) intentStats[it] = { intent: it, total: 0, mentions: 0, evocations: 0, citations: 0, positions: [] };
    const s = intentStats[it];
    s.total++;
    const mPos = r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null);
    if (mPos != null && mPos > 0) { s.mentions++; s.positions.push(mPos); }
    else if (r.brand_mentioned === true || r.brand_mentioned === 1) s.evocations++;
    if (r.brand_in_sources === true || r.brand_in_sources === 1) s.citations++;
  });
  const intentStatsList = Object.values(intentStats)
    .map(s => ({ ...s, avgPos: s.positions.length ? (s.positions.reduce((a, b) => a + b, 0) / s.positions.length).toFixed(1) : null,
      presenceRate: s.total ? Math.round(((s.mentions + s.evocations) / s.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  // ── LOT A : Analyse par INTENTION MANUELLE de la question (tag utilisateur) ──
  // Jointure question → ses résultats (dédupliqués), agrégée par q.intent.
  const INTENT_META = {
    transactional: { label: "Transactionnelle", color: "#1A4A7A" },
    informational: { label: "Informationnelle", color: "#1A7A4A" },
    brand:         { label: "Notoriété de la marque", color: "#C97820" },
  };
  const qIntentTagged = questions.filter(q => q.intent && INTENT_META[q.intent]).length;
  const questionIntentStats = {};
  questions.forEach(q => {
    if (!q.intent || !INTENT_META[q.intent]) return;
    const it = q.intent;
    if (!questionIntentStats[it]) questionIntentStats[it] = { intent: it, label: INTENT_META[it].label, color: INTENT_META[it].color, questions: 0, total: 0, mentions: 0, evocations: 0, citations: 0, positions: [] };
    const st = questionIntentStats[it];
    st.questions++;
    (resultsByQ[q.id] || []).forEach(r => {
      st.total++;
      const mPos = r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null);
      if (mPos != null && mPos > 0) { st.mentions++; st.positions.push(mPos); }
      else if (r.brand_mentioned === true || r.brand_mentioned === 1) st.evocations++;
      if (r.brand_in_sources === true || r.brand_in_sources === 1) st.citations++;
    });
  });
  const questionIntentList = Object.values(questionIntentStats)
    .map(st => ({ ...st, avgPos: st.positions.length ? (st.positions.reduce((a, b) => a + b, 0) / st.positions.length).toFixed(1) : null,
      presenceRate: st.total ? Math.round(((st.mentions + st.evocations) / st.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  // ── UPGRADE 2 : Classification du type de page citée (via patterns d'URL) ──
  // produit · blog/article · catégorie · accueil · autre — sur les sources citées.
  const classifyPage = (url) => {
    let path = "";
    try { path = new URL(url).pathname.toLowerCase(); } catch { path = String(url || "").toLowerCase(); }
    if (path === "" || path === "/" ) return "accueil";
    if (/\/(blog|article|actualit|news|guide|magazine|ressource|conseil|dossier)s?\//.test(path) || (/\.(html?)$/.test(path) && /(blog|article|guide)/.test(path))) return "blog/article";
    if (/\/(produit|product|offre|service|solution|prestation)s?\//.test(path)) return "produit/service";
    if (/\/(categorie|category|collection|gamme|univers)s?\//.test(path)) return "catégorie";
    if (/\/(a-propos|about|qui-sommes|equipe|contact|mentions|cgv|cgu)/.test(path)) return "institutionnel";
    if (path.split("/").filter(Boolean).length <= 1) return "accueil";
    return "autre";
  };
  const pageTypeStats = {};
  results.forEach(r => {
    (r.sources || []).forEach(url => {
      const t = classifyPage(url);
      if (!pageTypeStats[t]) pageTypeStats[t] = { type: t, count: 0, brand: 0 };
      pageTypeStats[t].count++;
      // est-ce une URL de la marque ?
      const bd = (brand?.brand_domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      if (bd && String(url).toLowerCase().includes(bd)) pageTypeStats[t].brand++;
    });
  });
  const pageTypeStatsList = Object.values(pageTypeStats).sort((a, b) => b.count - a.count);

  // ── UPGRADE 3 : Évolution temporelle des MENTIONS sur 30 jours ──
  // Par jour : nb de mentions (position de marque détectée) parmi les résultats du jour.
  const mentionByDay = {};
  allResults.forEach(r => {
    if (!r.created_at) return;
    const key = String(r.created_at).slice(0, 10);
    if (!mentionByDay[key]) mentionByDay[key] = { mentions: 0, evocations: 0, citations: 0, total: 0 };
    const d = mentionByDay[key];
    d.total++;
    const mPos = r.brand_mention_position ?? (r.brand_position > 0 ? r.brand_position : null);
    if (mPos != null && mPos > 0) d.mentions++;
    else if (r.brand_mentioned === true || r.brand_mentioned === 1) d.evocations++;
    if (r.brand_in_sources === true || r.brand_in_sources === 1) d.citations++;
  });
  const mentionTrend = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(today); dt.setDate(dt.getDate() - i);
    const key = dayKey(dt);
    const d = mentionByDay[key] || { mentions: 0, evocations: 0, citations: 0, total: 0 };
    mentionTrend.push({ date: key, ...d });
  }

  // ── Présence dans le temps : taux de présence par JOUR DE TEST (jours actifs uniquement) ──
  // Les deux séries temporelles sont construites sur calByDate : la FUSION du
  // calendrier (une entrée par interrogation, toutes dates) et des résultats en
  // mémoire — un point par date de test réelle.
  // ── Séries temporelles : produites par le MODULE PARTAGÉ (même définition que le
  // graphique à l'écran et que les exports), puis restreintes aux jours interrogés.
  const _allDates = [
    ...results.map(r => (r.created_at || "").slice(0, 10)),
    ...(calendarEntries || []).map(e => e.test_date || (e.created_at || "").slice(0, 10)),
  ].filter(Boolean).sort();
  const _sharedSeries = _allDates.length
    ? buildPresenceSeries({ results, calendarEntries, from: _allDates[0], to: dayKey(new Date()) })
    : [];
  const _activeSeries = _sharedSeries.filter(d => d.tested > 0);
  const presenceTrend = _activeSeries.map(d => ({ date: d.date, tested: d.tested, present: d.present, rate: d.rate }));
  const mecTrend = _activeSeries.map(d => ({ date: d.date, tested: d.tested, mentions: d.mentions, evocations: d.evocations, citations: d.citations }));

  const compStats = {};
  // 1. Depuis competitors_mentioned (résultats récents)
  // Chaque entrée concurrent : { name, mentioned, position, in_sources }
  // → Mention = position numérotée · Évocation = citée sans position · Citation = dans les sources
  results.forEach(r => (r.competitors_mentioned || []).forEach(c => {
    if (!c.name) return;
    const cname = canonName(c.name); // alias → canonique (sommation)
    if (!compStats[cname]) compStats[cname] = { mentions: 0, evocations: 0, citations: 0, positions: [], category: null, color: null };
    const st = compStats[cname];
    // Position de mention fiable (mention_position) avec repli sur position (rétrocompat ancien format)
    const mPos = c.mention_position != null ? c.mention_position : (c.position != null && c.position > 0 ? c.position : null);
    if (mPos != null && mPos > 0) { st.mentions++; st.positions.push(mPos); }
    else if (c.mentioned || c.evocation_position != null) { st.evocations++; }
    if (c.in_sources || c.citation_position != null) { st.citations++; }
  }));

  // 2. Enrichir avec les concurrents qualifiés (catégorie + recherche rétroactive)
  competitors.forEach(comp => {
    const key = comp.name;
    if (!compStats[key]) compStats[key] = { mentions: 0, evocations: 0, citations: 0, positions: [], category: null, color: null, enabled: true };
    // Attacher la catégorie, la couleur et le statut actif depuis geo_competitors
    compStats[key].category = comp.category || "other";
    compStats[key].color    = comp.color || "#64748B";
    compStats[key].enabled  = comp.enabled !== false;
    // Recherche rétroactive dans les réponses non encore comptées
    const re = new RegExp(comp.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    results.forEach(r => {
      const alreadyCounted = (r.competitors_mentioned || []).some(c => c.name?.toLowerCase() === key.toLowerCase());
      if (!alreadyCounted && re.test(r.answer || "")) {
        // Apparition dans le texte sans position structurée → évocation
        compStats[key].evocations = (compStats[key].evocations || 0) + 1;
      }
    });
  });

  const presenceRate = pct(withBrand, total);

  // ── Questions 25 max — favoris d'abord, puis par volume de keyword ─
  const kwVolMap = {};
  keywords.forEach(k => { if (k.search_volume > 0) kwVolMap[k.id] = k.search_volume; });

  // Trier toutes les questions : favoris d'abord, puis par volume desc, puis par création
  const sortedQuestions = [...questions].sort((a, b) => {
    if (a.is_favorite && !b.is_favorite) return -1;
    if (!a.is_favorite && b.is_favorite) return 1;
    const va = kwVolMap[a.keyword_id] || 0;
    const vb = kwVolMap[b.keyword_id] || 0;
    if (vb !== va) return vb - va;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  const hasResult = (q) => results.some(r => r.question_id === q.id);
  // hasMention : présence dans un top numéroté — même logique que getPresType("ranked")
  const hasMention  = (q) => results.some(r => r.question_id === q.id && (
    r.brand_mention_position != null ||
    (r.brand_position != null && r.brand_position > 0 && (r.brand_mentioned === true || r.brand_mentioned === 1))
  ));

  const withResults = sortedQuestions.filter(hasResult);
  const withoutRes  = sortedQuestions.filter(q => !hasResult(q));

  // presentBrandQs : questions avec MENTION (top LLM) — max 10
  const presentBrandQs = withResults
    .filter(hasMention)
    .slice(0, 10)
    .map(q => ({ question: q.question, isFav: !!q.is_favorite, volume: kwVolMap[q.keyword_id] || 0 }));

  // missingBrandQs : "Questions sans mentions" — favoris d'abord, puis par volume — max 10
  const missingBrandQs = [
    ...withResults.filter(q => q.is_favorite && !hasMention(q)),
    ...withResults.filter(q => !q.is_favorite && !hasMention(q))
      .sort((a, b) => (kwVolMap[b.keyword_id] || 0) - (kwVolMap[a.keyword_id] || 0)),
    ...withoutRes.filter(q => q.is_favorite),
  ].slice(0, 10)
   .map(q => ({ question: q.question, isFav: !!q.is_favorite, volume: kwVolMap[q.keyword_id] || 0 }));

  const hasFavFilter = questions.some(q => q.is_favorite);
  const favCount = questions.filter(q => q.is_favorite).length;

  // ── Statut par question : À défendre / À surveiller / Conquête prioritaire ──
  // Basé sur le DERNIER résultat par (question, provider). "Conquête" inclut les
  // positions perdues : la marque était présente auparavant mais ne l'est plus.
  // Les résultats sont déjà dédupliqués au dernier passage par (question, provider) ;
  // l'historique complet (allResults) sert à détecter les positions PERDUES.
  const _everByQ = {};
  allResults.forEach(r => { if (r.brand_mentioned === true || r.brand_mentioned === 1) _everByQ[r.question_id] = true; });
  const _nowByQ = {};
  results.forEach(r => {
    const q = r.question_id; if (!q) return;
    if (!_nowByQ[q]) _nowByQ[q] = { providers: 0, present: 0 };
    _nowByQ[q].providers++;
    if (r.brand_mentioned === true || r.brand_mentioned === 1) _nowByQ[q].present++;
  });
  const _stRank = { conquest: 0, watch: 1, defend: 2 };
  const questionStatus = questions
    .filter(q => _nowByQ[q.id])
    .map(q => {
      const st = _nowByQ[q.id];
      const status = st.present === 0 ? "conquest" : (st.present < st.providers ? "watch" : "defend");
      return { question: q.question, status, lost: status === "conquest" && !!_everByQ[q.id], presentOn: st.present, providersOn: st.providers, isFav: !!q.is_favorite };
    })
    .sort((a, b) => (_stRank[a.status] - _stRank[b.status]) || ((b.lost ? 1 : 0) - (a.lost ? 1 : 0)));

  const leads = [];
  if (presenceRate < 30) leads.push({ priority: "🔴 Priorité haute", label: "Présence < 30%", reco: "Créer des contenus de recommandation",
    why: "Votre marque est presque absente des réponses IA : sans contenu ciblé, les moteurs génératifs n'ont rien à citer sur vous face aux questions de vos prospects.",
    how: "Produisez des pages qui répondent frontalement aux questions sans présence, structurées en listes comparatives explicites (« meilleurs X », « X ou Y ») que les LLMs reprennent facilement.",
    howMuch: "Ciblez d'abord les 10 à 15 questions à plus fort volume sans mention, une page ou section dédiée par groupe de questions." });
  if (presenceRate >= 30 && presenceRate < 50) leads.push({ priority: "🟠 À améliorer", label: `Présence ${presenceRate}%`, reco: "Enrichir les pages existantes",
    why: "Votre présence est partielle : les pages existent mais ne répondent pas assez directement aux questions fan-out pour être citées de façon régulière.",
    how: "Ajoutez sur vos pages des sections dédiées aux comparatifs et aux questions précises, avec une réponse claire dès le premier paragraphe.",
    howMuch: "Reprenez en priorité les pages déjà proches du top 3, une dizaine à retravailler pour commencer." });
  if (avgPos && parseFloat(avgPos) > 3) leads.push({ priority: "🟠 Position", label: `Position moyenne ${avgPos}`, reco: "Remonter en top 3 des réponses",
    why: "Votre position moyenne se situe au delà du top 3 : les IA vous mentionnent mais rarement en tête, là où se concentre la visibilité réelle.",
    how: "Répondez à la question dès la première phrase, structurez en listes ordonnées et renforcez les signaux d'autorité (sources, données chiffrées).",
    howMuch: "Concentrez l'effort sur les questions où vous êtes en position 4 à 8, les gains les plus accessibles." });
  if (withSources < withBrand) leads.push({ priority: "🟡 Sources", label: "Peu cité en source", reco: "Renforcer l'autorité des pages",
    why: "Votre marque est évoquée mais peu citée comme source : les IA parlent de vous sans pointer vers vos pages, ce qui limite le trafic et la crédibilité.",
    how: "Obtenez des backlinks depuis les domaines fréquemment cités dans votre secteur et soumettez vos URLs prioritaires à IndexNow.",
    howMuch: "Concentrez l'effort sur 5 à 8 URLs stratégiques plutôt que de le disperser." });
  if (Object.keys(compStats).length > 0) {
    const topComp = Object.entries(compStats).sort((a, b) => b[1].mentions - a[1].mentions)[0];
    leads.push({ priority: "🟠 Concurrence", label: `${topComp[0]} dominant`, reco: `Contrer ${topComp[0]}`,
      why: `${topComp[0]} capte une large part des réponses IA sur votre périmètre, au détriment de votre visibilité.`,
      how: "Analysez ses pages les mieux citées et créez des alternatives plus complètes, avec données propriétaires et avis d'experts qu'il n'a pas.",
      howMuch: "Commencez par les 3 à 5 questions où il apparaît et où vous êtes absent." });
  }
  leads.push({ priority: "📝 Contenu", label: "Volume et structure", reco: "Structurer des contenus complets",
    why: "Les pages courtes ou mal structurées sont moins bien comprises et citées par les moteurs génératifs.",
    how: "Visez 1 500 à 2 500 mots sur les pages à forte intention, avec des H2/H3 clairs, une FAQ en bas de page et un schema JSON-LD Organization + FAQ.",
    howMuch: "Appliquez ce standard à vos pages piliers en priorité, pas à l'ensemble du site." });
  leads.push({ priority: "🔗 Maillage", label: "Hubs thématiques", reco: "Créer des hubs de contenu",
    why: "Un maillage interne fort signale aux LLMs quelles pages font autorité sur chaque thème.",
    how: "Regroupez toutes les pages liées à un même axe fan-out autour d'une page hub, avec des liens internes descriptifs.",
    howMuch: "Un hub par axe stratégique majeur suffit pour commencer, soit 3 à 5 hubs." });


  const providerStats = {};
  results.forEach(r => {
    const pid = getProviderId(r.model);
    if (!providerStats[pid]) providerStats[pid] = { total: 0, withBrand: 0 };
    providerStats[pid].total++;
    if (r.brand_mentioned) providerStats[pid].withBrand++;
  });


  // ── Top 5 concurrents depuis les mentions ─────────────────────
  // La marque ne doit jamais figurer parmi ses propres concurrents.
  const _brandCanonSet = new Set([brandName, ...brandAliases].filter(Boolean).map(t => canonName(t).toLowerCase().trim()));
  const competitorsRanked = Object.entries(compStats)
    .filter(([name]) => { const c = canonName(name).toLowerCase().trim(); return c && !_brandCanonSet.has(c); })
    .filter(([, s]) => (s.mentions || 0) + (s.evocations || 0) + (s.citations || 0) > 0)
    .sort((a, b) => {
      // tri : d'abord par mentions, puis par meilleure position moyenne, puis évocations
      const ma = a[1].mentions || 0, mb = b[1].mentions || 0;
      if (mb !== ma) return mb - ma;
      const pa = a[1].positions?.length ? a[1].positions.reduce((x,y)=>x+y,0)/a[1].positions.length : 999;
      const pb = b[1].positions?.length ? b[1].positions.reduce((x,y)=>x+y,0)/b[1].positions.length : 999;
      if (pa !== pb) return pa - pb;
      return (b[1].evocations||0) - (a[1].evocations||0);
    });
  const top5Competitors = competitorsRanked.slice(0, 5);

  // ── Analyse par catégorie des questions ───────────────────────
  const resultsByQ = {};
  results.forEach(r => {
    if (!resultsByQ[r.question_id]) resultsByQ[r.question_id] = [];
    resultsByQ[r.question_id].push(r);
  });
  const byQuestionCategory = {};
  questions.forEach(q => {
    const catIds = Array.isArray(q.tags) && q.tags.length > 0
      ? q.tags : (q.category_id ? [q.category_id] : ["__none__"]);
    catIds.forEach(catId => {
      if (!byQuestionCategory[catId]) byQuestionCategory[catId] = { total: 0, withBrand: 0, positions: [], qCount: 0, volume: 0 };
      const qResults = resultsByQ[q.id] || [];
      byQuestionCategory[catId].qCount++;
      byQuestionCategory[catId].volume += (kwVolMap[q.keyword_id] || 0);
      byQuestionCategory[catId].total += qResults.length;
      qResults.forEach(r => {
        if (r.brand_mentioned === true || r.brand_mentioned === 1) byQuestionCategory[catId].withBrand++;
        const pos = r.brand_mention_position || r.brand_position;
        if (pos) byQuestionCategory[catId].positions.push(pos);
      });
    });
  });
  Object.keys(byQuestionCategory).forEach(catId => {
    const c = byQuestionCategory[catId];
    c.presenceRate = c.total ? Math.round(c.withBrand / c.total * 100) : 0;
    c.avgPos = c.positions.length ? (c.positions.reduce((a, b) => a + b, 0) / c.positions.length).toFixed(1) : null;
    // Piste 1 — opportunité = volume de recherche × déficit de présence (fort volume + faible présence = prioritaire)
    c.opportunity = Math.round((c.volume || 0) * (1 - c.presenceRate / 100));
  });

  // ── URLs marque : 2 listes (propres + externes) ───────────────
  const brandDomainClean = (brand?.brand_domain || "").toLowerCase().replace("www.", "");
  const allBrandTerms = [brandName, ...brandAliases, brand?.brand_domain || ""].filter(Boolean).map(t => t.toLowerCase());
  const brandOwnUrls = sortedUrls.filter(u =>
    brandDomainClean && (u.url || "").toLowerCase().replace("www.", "").includes(brandDomainClean)
  ).slice(0, 15);
  const brandExternalUrls = sortedUrls.filter(u => {
    if (!u.url) return false;
    try {
      const parsed = new URL(u.url);
      const domain = parsed.hostname.replace("www.", "").toLowerCase();
      if (brandDomainClean && domain.includes(brandDomainClean)) return false;
      const slug = (parsed.pathname + parsed.search).toLowerCase();
      return allBrandTerms.some(t => t.length > 2 && slug.includes(t.replace(/\s+/g, "-")));
    } catch { return false; }
  }).slice(0, 10);

  // ── Part de voix & co-occurrence concurrentielle (marque + top 5) ──
  const _coLabels = [brandName || "Marque", ...top5Competitors.map(([n]) => n)];
  const _coIdx = {}; _coLabels.forEach((n, i) => { if (_coIdx[canonName(n)] == null) _coIdx[canonName(n)] = i; });
  const _N = _coLabels.length;
  const coCounts = Array.from({ length: _N }, () => new Array(_N).fill(0));
  const sovCounts = new Array(_N).fill(0);
  results.forEach(r => {
    const present = new Set();
    if (r.brand_mentioned === true || r.brand_mentioned === 1) present.add(0);
    (r.competitors_mentioned || []).forEach(c => {
      if (!c.name) return;
      const sig = (c.mention_position != null && c.mention_position > 0) || c.mentioned || c.in_sources || c.evocation_position != null || c.citation_position != null || (c.position != null && c.position > 0);
      if (!sig) return;
      const idx = _coIdx[canonName(c.name)];
      if (idx != null) present.add(idx);
    });
    const arr = [...present];
    arr.forEach(i => { sovCounts[i]++; });
    for (let x = 0; x < arr.length; x++) for (let y = 0; y < arr.length; y++) coCounts[arr[x]][arr[y]]++;
  });
  const sovTotal = sovCounts.reduce((a, b) => a + b, 0) || 1;
  const shareOfVoice = _coLabels.map((name, i) => ({ name, count: sovCounts[i], pct: Math.round((sovCounts[i] / sovTotal) * 100) }));
  const coMatrix = { labels: _coLabels, counts: coCounts, totals: sovCounts };

  // ── Funnel de visibilité (du plus large au plus précis) ──
  const visibilityFunnel = [
    { label: "Réponses analysées", value: total, sub: "périmètre testé" },
    { label: "Marque mentionnée", value: mentionCount, sub: "présente dans un classement" },
    { label: "Marque évoquée", value: evocationCount, sub: "présente dans le texte" },
    { label: "Citée comme source", value: citationCount, sub: "URL en source" },
  ];

  // ── Angles morts : questions testées où NI la marque NI un concurrent n'apparaît ──
  const _byQ = {};
  results.forEach(r => { (_byQ[r.question_id] = _byQ[r.question_id] || []).push(r); });
  const blindSpots = [];
  questions.forEach(q => {
    const rs = _byQ[q.id] || [];
    if (!rs.length) return; // jamais interrogée → on ne la compte pas comme angle mort
    const brandSomewhere = rs.some(r => r.brand_mentioned);
    const compSomewhere = rs.some(r => (r.competitors_mentioned || []).some(c =>
      (c.mention_position != null && c.mention_position > 0) || c.mentioned || c.in_sources || c.evocation_position != null || c.citation_position != null || (c.position != null && c.position > 0)
    ));
    if (!brandSomewhere && !compSomewhere) blindSpots.push({ id: q.id, question: q.question, providers: rs.length });
  });

  // ── Lot B1 : stats de comparaison LLM par site (marque + concurrents) ──
  // URLs citées distinctes + citations de la meilleure URL, par entité.
  const _brandUrlHits = {};
  results.forEach(r => {
    if (!r.brand_in_sources) return;
    (r.sources || []).forEach(u => {
      const nu = normalizeUrl(u);
      if (nu && brandUrls.some(b => b.norm === nu || (b.url && normalizeUrl(b.url) === nu))) _brandUrlHits[nu] = (_brandUrlHits[nu] || 0) + 1;
    });
  });
  const _brandBestUrl = Object.values(_brandUrlHits).sort((a, b) => b - a)[0] || 0;
  const compareBrandStats = {
    mentions: mentionCount, evocations: evocationCount, citations: citationCount,
    avgPos: avgMentionPos ? parseFloat(avgMentionPos) : null,
    urlsCited: Object.keys(_brandUrlHits).length || brandOwnUrls.length || 0,
    bestUrlHits: _brandBestUrl,
  };
  // Concurrents : URLs citées estimées via compStats (citations) — l'URL par concurrent
  // n'est pas structurée en base aujourd'hui, on renseigne ce qu'on a de fiable.
  const compareCompEntries = competitors
    .filter(c => c.deep_compare === true)
    .slice(0, 5)
    .map(c => {
      // Re-détection sur le texte des réponses (snapshot) plutôt que le figé
      // competitors_mentioned → un concurrent ajouté après coup est bien compté.
      const st = { mentions: 0, evocations: 0, citations: 0, positions: [] };
      results.forEach(r => {
        const d = detectBrand(r.answer || "", r.sources || [], c.name, c.aliases || [], []);
        const mPos = d.mention?.position ?? null;
        if (mPos != null && mPos > 0) { st.mentions++; st.positions.push(mPos); }
        else if (d.brandMentioned || d.evocation?.position != null) st.evocations++;
        if (d.brandInSources || d.citation?.position != null) st.citations++;
      });
      const avg = st.positions.length ? (st.positions.reduce((a, b) => a + b, 0) / st.positions.length) : null;
      const u = entityUrlStats(results, c.name, c.domain);
      return {
        key: c.id, label: c.name, color: c.color || "#64748B",
        stats: {
          mentions: st.mentions, evocations: st.evocations, citations: st.citations,
          avgPos: avg != null ? Math.round(avg * 10) / 10 : null,
          urlsCited: u.urlsCited || null, bestUrlHits: u.bestUrlHits || null,
        },
      };
    });

  return { total, withBrand, withSources, withRanked, withSourceOnly, withMentionOnly, avgPos, avgMentionPos, avgEvocationPos, avgCitationPos, mentionCount, evocationCount, citationCount, presenceRate, trendDays, sortedUrls, brandUrls, brandOwnUrls, brandExternalUrls, urlDetails, competitorUrls, referenceUrls, topDomains, intentCount, typeCount, intentStatsList, pageTypeStatsList, questionIntentList, qIntentTagged, mentionTrend, compStats, top5Competitors, competitorsRanked, byQuestionCategory, urlsToOptimize, urlsToRework, urlsToInspire, leads, questions: questions.length, providerStats, missingBrandQs, presentBrandQs, hasFavFilter, favCount, shareOfVoice, coMatrix, visibilityFunnel, blindSpots, presenceTrend, mecTrend, mecTotals: mecTotalsOf(results), distinctRuns, questionStatus, compareBrandStats, compareCompEntries, _rawResults: results };
}


// ── Évolution des mentions : axe fixe de 30 jours, points aux dates d'interrogation ──

function RoadmapAuditPanel({ roadmapData, setRoadmapData, questions, results, brand, categories, claudeKey, projectId, siteId, onTextReady }) {
  const [status, setStatus] = useState("idle");
  const [err, setErr] = useState(null);

  // Alimente le PDF (section "Analyse IA détaillée") avec un résumé texte du plan.
  useEffect(() => {
    if (!roadmapData) return;
    const d = roadmapData.diagnostic || {};
    const lines = [];
    if (d.verdict) lines.push(`Verdict : ${d.verdict}`);
    if (d.levier_principal) lines.push(`Levier n°1 : ${d.levier_principal}`);
    (roadmapData.roadmap || []).slice(0, 10).forEach(r => lines.push(`- [${(r.priority || "").toUpperCase()}] ${r.action}${r.target_url ? ` (${r.page_exists ? "optimiser" : "créer"} ${r.target_url})` : ""}`));
    onTextReady?.(lines.join("\n"));
  }, [roadmapData]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!claudeKey || !results.length || status === "loading") return;
    setStatus("loading"); setErr(null);
    try {
      const parsed = await generateRoadmap({ questions, results, brand, categories, claudeKey, previousForComparison: roadmapData });
      setRoadmapData(parsed);
      if (projectId && siteId) sbSaveGeoAnalysis({ project_id: projectId, site_id: siteId, kind: "roadmap", content: parsed }).catch(() => {});
      setStatus("done");
    } catch (e) { setErr(e.message); setStatus("error"); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E" }}>Et maintenant ?</div>
          <div style={{ fontSize: 11, color: "#1A3C2E99" }}>
            {roadmapData?.generated_at
              ? `Généré le ${new Date(roadmapData.generated_at).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · même analyse que l'onglet Suivi GEO`
              : "Analyse unique, partagée avec l'onglet Suivi GEO"}
          </div>
        </div>
        <button onClick={run} disabled={status === "loading" || !claudeKey || !results.length}
          title={!claudeKey ? "Aucune clé API Claude renseignée — ajoutez-la dans \u2699\ufe0f Providers" : (!results.length ? "Aucun résultat à analyser" : undefined)}
          style={{ padding: "5px 14px", background: (status === "loading" || !claudeKey || !results.length) ? "transparent" : "#1A3C2E", color: (status === "loading" || !claudeKey || !results.length) ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: (status === "loading" || !claudeKey || !results.length) ? "default" : "pointer" }}>
          {status === "loading" ? "⏳ Analyse…" : roadmapData ? "↺ Régénérer" : "✦ Générer le plan"}
        </button>
      </div>
      {err && <div style={{ fontSize: 11, color: "#C0352A", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{err}</div>}
      {roadmapData
        ? <RoadmapView data={roadmapData} />
        : <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.6, background: "#1A3C2E08", borderRadius: 10, padding: "14px 16px" }}>Aucun plan généré pour l'instant. Cliquez « Générer le plan » : il s'affichera ici et dans l'onglet Suivi GEO (c'est la même analyse).</div>}
    </div>
  );
}

// ── Matrice de corrélation interactive ───────────────────────────
// Calcule la corrélation de Pearson entre 2 vecteurs
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((s,x,i)=>s+(x-mx)*(ys[i]-my),0);
  const dx  = Math.sqrt(xs.reduce((s,x)=>s+(x-mx)**2,0));
  const dy  = Math.sqrt(ys.reduce((s,y)=>s+(y-my)**2,0));
  if (dx===0||dy===0) return null;
  return parseFloat((num/(dx*dy)).toFixed(3));
}

function CorrelationMatrix({ sfRows = [], gscRows = [], gaRows = [], bingData = {}, results, audit, sfCorrFilter, setSfCorrFilter }) {
  // ── Définitions des sources disponibles ──────────────────────
  const SOURCES = [
    { key: "fanout", label: "Fan-outs",       available: results.length > 0 },
    { key: "sf",     label: "Screaming Frog", available: sfRows.length > 0 },
    { key: "gsc",    label: "GSC",            available: gscRows.length > 0 },
    { key: "ga",     label: "Analytics",      available: gaRows.length > 0 },
    { key: "bing",   label: "Bing",           available: Object.keys(bingData || {}).length > 0 },
  ];

  const [srcA, setSrcA] = useState("sf");
  const [srcB, setSrcB] = useState("fanout");

  // ── Calculer la matrice selon les 2 sources choisies ─────────
  const matrix = useMemo(() => {
    // ── Présence GEO par URL citée ────────────────────────────────
    // On rapproche chaque source d'outils avec le GEO PAR LA MÊME CLÉ (URL).
    // Corréler par index de position (ancien bug) n'avait aucun sens car
    // les questions GEO et les URLs d'outils sont des entités différentes.
    //
    // geoByUrl[urlPath] = taux de citation de cette URL dans les réponses LLM
    const geoByUrl = {};
    (results || []).forEach(r => {
      (r.sources || []).forEach(src => {
        const u = typeof src === "string" ? src : (src?.url || src?.link || "");
        const p = urlPath(u);
        if (!p) return;
        if (!geoByUrl[p]) geoByUrl[p] = { citations: 0 };
        geoByUrl[p].citations++;
      });
    });

    // Helper : corrélation entre une métrique d'outil (par URL) et les citations GEO (par URL)
    // sur l'INTERSECTION des URLs présentes dans les deux jeux.
    const corrByUrl = (toolIdx, metricKey) => {
      const xs = [], ys = [];
      Object.entries(toolIdx).forEach(([p, m]) => {
        if (geoByUrl[p] === undefined) return; // URL absente du GEO → exclue
        const xv = m[metricKey];
        if (xv == null || !Number.isFinite(xv)) return;
        xs.push(xv);
        ys.push(geoByUrl[p].citations);
      });
      return { r: pearson(xs, ys), n: xs.length };
    };

    // ── Construire les index d'outils par URL ─────────────────────
    const sfIdx = {}; (sfRows || []).forEach(row => { const s = sfRowMetrics(row); const p = urlPath(s.url); if (p) sfIdx[p] = s; });
    const gscIdx = {}; (gscRows || []).forEach(row => { const g = gscRowMetrics(row); const p = urlPath(g.url); if (p) gscIdx[p] = g; });
    const gaIdx  = {}; (gaRows  || []).forEach(row => { const g = gaRowMetrics(row);  const p = urlPath(g.url); if (p) gaIdx[p]  = g; });

    // ── SF × GEO ───────────────────────────────────────────────────
    if ((srcA === "sf" || srcB === "sf") && (srcA === "fanout" || srcB === "fanout")) {
      const dims = [
        { key: "inlinks",    label: "Liens entrants" },
        { key: "crawlDepth", label: "Profondeur de crawl" },
        { key: "wordCount",  label: "Nombre de mots" },
        { key: "titleLen",   label: "Longueur du title" },
        { key: "metaLen",    label: "Longueur meta desc." },
        { key: "flesch",     label: "Lisibilité (Flesch)" },
      ];
      return dims.map(d => { const { r, n } = corrByUrl(sfIdx, d.key); return { dimA: d.label, dimB: "Citations GEO", r, n }; })
        .filter(x => x.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    }

    // ── GSC × GEO ──────────────────────────────────────────────────
    if ((srcA === "gsc" || srcB === "gsc") && (srcA === "fanout" || srcB === "fanout")) {
      const dims = [
        { key: "clicks",      label: "Clics GSC" },
        { key: "impressions", label: "Impressions GSC" },
        { key: "ctr",         label: "CTR GSC" },
        { key: "position",    label: "Position GSC" },
      ];
      return dims.map(d => { const { r, n } = corrByUrl(gscIdx, d.key); return { dimA: d.label, dimB: "Citations GEO", r, n }; })
        .filter(x => x.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    }

    // ── GA × GEO ───────────────────────────────────────────────────
    if ((srcA === "ga" || srcB === "ga") && (srcA === "fanout" || srcB === "fanout")) {
      const dims = [
        { key: "sessions",    label: "Sessions GA" },
        { key: "views",       label: "Vues GA" },
        { key: "conversions", label: "Conversions GA" },
        { key: "revenue",     label: "Revenus GA" },
      ];
      return dims.map(d => { const { r, n } = corrByUrl(gaIdx, d.key); return { dimA: d.label, dimB: "Citations GEO", r, n }; })
        .filter(x => x.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    }

    // ── SF × GSC (croisement technique × SEO, par URL) ─────────────
    if ((srcA === "sf" || srcB === "sf") && (srcA === "gsc" || srcB === "gsc")) {
      const rows = [];
      const pairs = [
        { sf: "wordCount", g: "clicks",      label: "Nb mots × Clics" },
        { sf: "inlinks",   g: "impressions", label: "Liens entrants × Impressions" },
        { sf: "crawlDepth",g: "position",    label: "Profondeur × Position" },
      ];
      pairs.forEach(pr => {
        const px = [], py = [];
        Object.entries(sfIdx).forEach(([p, s]) => {
          const g = gscIdx[p]; if (!g) return;
          const xv = s[pr.sf], yv = g[pr.g];
          if (xv == null || yv == null) return;
          px.push(xv); py.push(yv);
        });
        const r = pearson(px, py);
        if (r !== null) rows.push({ dimA: pr.label.split(" × ")[0], dimB: pr.label.split(" × ")[1], r, n: px.length });
      });
      return rows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    }

    // ── Bing × GEO : pas d'alignement par URL fiable → afficher un message via tableau vide ──
    if (srcA === "bing" || srcB === "bing") {
      return [];
    }

    return [];
  }, [srcA, srcB, sfRows, gscRows, gaRows, bingData, results]); // eslint-disable-line react-hooks/exhaustive-deps

  const srcADef = SOURCES.find(s=>s.key===srcA);
  const srcBDef = SOURCES.find(s=>s.key===srcB);

  return (
    <div>
      {/* Sélecteur 2 sources */}
      <div className="audit-corr-sources">
        <div>
          <div style={{ fontSize: 10, color: "#1A3C2E", marginBottom: 5, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>Source A</div>
          <div className="audit-corr-source-btns">
            {SOURCES.map(s => (
              <button key={s.key} onClick={() => { setSrcA(s.key); if (s.key === srcB) setSrcB(srcA); }}
                disabled={!s.available}
                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, cursor: s.available ? "pointer" : "not-allowed",
                  border: "0.5px solid " + (srcA===s.key ? "#1A3C2E" : "#1A3C2E22"),
                  background: srcA===s.key ? "#1A3C2E" : "transparent",
                  color: srcA===s.key ? "#F0EBE0" : s.available ? "#1A3C2E" : "#1A3C2E",
                  fontWeight: srcA===s.key ? 500 : 400,
                }}>
                {s.label}{!s.available ? " ·" : ""}
              </button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 18, color: "#1A3C2E", fontWeight: 300 }}>×</div>
        <div>
          <div style={{ fontSize: 10, color: "#1A3C2E", marginBottom: 5, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>Source B</div>
          <div style={{ display: "flex", gap: 4 }}>
            {SOURCES.filter(s => s.key !== srcA).map(s => (
              <button key={s.key} onClick={() => setSrcB(s.key)}
                disabled={!s.available}
                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, cursor: s.available ? "pointer" : "not-allowed",
                  border: "0.5px solid " + (srcB===s.key ? "#1A7A4A" : "#1A3C2E22"),
                  background: srcB===s.key ? "#1A7A4A" : "transparent",
                  color: srcB===s.key ? "#F0EBE0" : s.available ? "#1A3C2E" : "#1A3C2E",
                  fontWeight: srcB===s.key ? 500 : 400,
                }}>
                {s.label}{!s.available ? " ·" : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Légende */}
      <div style={{ display: "flex", gap: 16, marginBottom: 14, fontSize: 10, color: "#1A3C2E" }}>
        <span><span style={{ fontWeight: 600, color: "#1A7A4A" }}>▲ ≥ 0.4</span> Corrélation forte positive</span>
        <span><span style={{ fontWeight: 600, color: "#C0352A" }}>▼ ≤ -0.4</span> Corrélation forte négative</span>
        <span><span style={{ color: "#1A3C2E" }}>±0.1–0.4</span> Corrélation faible</span>
      </div>

      {/* Matrice */}
      {matrix.length === 0 ? (
        <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic", padding: "12px 0" }}>
          {(srcA === "bing" || srcB === "bing")
            ? "La corrélation avec Bing n'est pas fiable : les données Bing ne sont pas alignables par URL avec la présence GEO. Croisez plutôt SF, GSC ou GA avec les Fan-outs."
            : srcADef?.available && srcBDef?.available
            ? `Aucune URL commune entre ${srcADef.label} et ${srcBDef.label} (corrélation calculée sur l'intersection des URLs). Vérifiez que les exports couvrent les mêmes pages.`
            : `Importez ${!srcADef?.available ? srcADef?.label : srcBDef?.label} dans Setup pour activer cette corrélation.`}
        </div>
      ) : (
        <div className="audit-corr-table-wrap">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid #1A3C2E12" }}>
                <th style={{ padding: "7px 0", textAlign: "left", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>{srcADef?.label}</th>
                <th style={{ padding: "7px 12px", textAlign: "left", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A7A4A" }}>{srcBDef?.label}</th>
                <th style={{ padding: "7px 12px", textAlign: "center", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>Corrélation r</th>
                <th style={{ padding: "7px 12px", textAlign: "left", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>Intensité</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((row, i) => {
                const r = row.r;
                const pos = r > 0;
                const abs = Math.abs(r);
                const strong = abs >= 0.4;
                const barW = Math.round(abs * 100);
                const color = strong ? (pos ? "#1A7A4A" : "#C0352A") : (pos ? "#1A7A4A88" : "#C0352A88");
                return (
                  <tr key={i} style={{ borderBottom: "0.5px solid #1A3C2E06" }}>
                    <td style={{ padding: "7px 0", color: "#1A3C2E", fontSize: 11 }}>{row.dimA}</td>
                    <td style={{ padding: "7px 12px", color: "#1A3C2E", fontSize: 11 }}>{row.dimB}</td>
                    <td style={{ padding: "7px 12px", textAlign: "center" }}>
                      <span style={{ fontSize: 12, fontWeight: strong ? 700 : 500, color }}>
                        {pos ? "▲" : "▼"} {r > 0 ? "+" : ""}{r.toFixed(2)}
                      </span>
                    </td>
                    <td style={{ padding: "7px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 60, height: 4, background: "#1A3C2E08", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ width: `${barW}%`, height: "100%", background: color, borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 9, color: "#1A3C2E" }}>
                          {abs >= 0.7 ? "Très forte" : abs >= 0.4 ? "Forte" : abs >= 0.2 ? "Modérée" : "Faible"}
                          {row.n != null && <span style={{ marginLeft: 6, color: row.n < 10 ? "#C0352A" : "#1A3C2E" }}>n={row.n}{row.n < 10 ? " ⚠" : ""}</span>}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ── Analyseur de pages concurrentes ──────────────────────────
function CompetitorPageAnalyzer({ competitors, audit, claudeKey }) {
  const [selected, setSelected] = useState(null);  // nom du concurrent sélectionné
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "done" | "error"
  const [result, setResult] = useState(null);

  // Pré-remplir l'URL quand on sélectionne un concurrent
  const handleSelect = (name) => {
    setSelected(name);
    setResult(null);
    setStatus("idle");
    // Chercher le domaine dans les URL sources du concurrent
    const comp = competitors.find(c => c.name === name);
    const guessDomain = comp?.domain || comp?.website ||
      Object.entries(audit.compStats[name]?.urls || {})
        .sort((a,b) => b[1]-a[1])[0]?.[0] || "";
    setUrl(guessDomain ? `https://${guessDomain.replace(/^https?:\/\//, "")}` : "");
  };

  const analyze = async () => {
    if (!url || !claudeKey || !selected) return;
    setStatus("loading"); setResult(null);
    const compStats = audit.compStats[selected] || {};
    const prompt = `Tu es expert GEO (Generative Engine Optimization). Analyse cette page concurrente et produis un rapport structuré.

CONCURRENT : ${selected}
URL analysée : ${url}
Données de présence LLM :
- Mentions (tops LLM) : ${compStats.mentions || 0}
- Évocations (corps texte) : ${compStats.evocations || 0}
- Citations (sources) : ${compStats.citations || 0}
- Position moy. : ${compStats.positions?.length ? (compStats.positions.reduce((a,b)=>a+b,0)/compStats.positions.length).toFixed(1) : "—"}

En imaginant que tu analyses la page ${url}, produis exactement 4 sections :

## POURQUOI LES LLM LES CITENT
[2-3 raisons concrètes basées sur leur présence mesurée : autorité, structure, format des contenus]

## FORCES DE LEUR CONTENU GEO
[3-4 points forts que tu inféres de leurs performances LLM : exhaustivité, format, données, maillage]

## LACUNES ET ANGLES À EXPLOITER
[3-4 angles non couverts ou faiblement couverts qu'Altaroc pourrait exploiter pour dépasser ce concurrent]

## ACTIONS PRIORITAIRES
[3 actions concrètes avec format : "Créer/Optimiser/Publier [X] pour [objectif GEO]"]

Commence DIRECTEMENT par ## POURQUOI LES LLM LES CITENT. Sois précis et actionnable.`;

    try {
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
      });
      const raw = await res.text();
      if (raw.trimStart().startsWith("<")) throw new Error("Proxy claude-geo introuvable");
      const data = JSON.parse(raw);
      if (!res.ok) throw new Error(data.error?.message || `Erreur ${res.status}`);
      const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();
      const sections = text.split(/^## /m).filter(Boolean).map(s => {
        const nl = s.indexOf("\n");
        return { title: s.slice(0, nl).trim(), body: s.slice(nl+1).trim() };
      });
      setResult(sections);
      setStatus("done");
    } catch(e) {
      setResult([{ title: "Erreur", body: e.message }]);
      setStatus("error");
    }
  };

  const compNames = Object.keys(audit.compStats || {}).filter(k => (audit.compStats[k].mentions||0) + (audit.compStats[k].evocations||0) > 0).slice(0, 10);
  if (!compNames.length) return (
    <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic", paddingTop: 8 }}>
      Interrogez des questions pour détecter des concurrents.
    </div>
  );

  const SECTION_COLORS = {
    "POURQUOI LES LLM LES CITENT": "#1A3C2E",
    "FORCES DE LEUR CONTENU GEO":  "#1A7A4A",
    "LACUNES ET ANGLES":            "#C97820",
    "ACTIONS PRIORITAIRES":         "#1A3C2E",
  };
  const getSectionColor = (title) => {
    const key = Object.keys(SECTION_COLORS).find(k => title.includes(k));
    return SECTION_COLORS[key] || "#1A3C2E77";
  };

  return (
    <div style={{ paddingTop: 16, borderTop: "0.5px solid #1A3C2E0C", marginTop: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Analyser un concurrent</div>

      {/* Sélecteur concurrent */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {compNames.map(name => (
          <button key={name} onClick={() => handleSelect(name)} style={{
            padding: "4px 11px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "0.5px solid #1A3C2E22",
            background: selected === name ? "#1A3C2E" : "transparent",
            color: selected === name ? "#F0EBE0" : "#1A3C2E",
            fontWeight: selected === name ? 500 : 400,
          }}>{name}</button>
        ))}
      </div>

      {/* URL + lancer */}
      {selected && (
        <div className="audit-comp-analyzer-input">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={`https://${selected.toLowerCase().replace(/\s+/g,"-")}.com`}
            style={{ flex: 1, fontSize: 11, padding: "5px 10px", border: "0.5px solid #1A3C2E18", borderRadius: 6, outline: "none", color: "#1A3C2E", background: "#fff" }}
          />
          <button onClick={analyze} disabled={!url || !claudeKey || status === "loading"}
            title={!claudeKey ? "Aucune clé API Claude renseignée — ajoutez-la dans ⚙️ Providers" : (!url ? "Saisissez une URL de concurrent à analyser" : undefined)}
            style={{ padding: "5px 14px", background: (!url||!claudeKey||status==="loading") ? "transparent" : "#1A3C2E", color: (!url||!claudeKey||status==="loading") ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: (!url||!claudeKey||status==="loading") ? "default" : "pointer" }}>
            {status === "loading" ? "⏳ Analyse…" : "✦ Analyser"}
          </button>
        </div>
      )}

      {/* Résultats */}
      {status === "done" && result && (
        <div style={{ borderTop: "0.5px solid #1A3C2E0C", paddingTop: 14 }}>
          {result.map((s, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${getSectionColor(s.title)}22`, paddingLeft: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: getSectionColor(s.title), marginBottom: 5 }}>{s.title}</div>
              <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.7 }}>
                {s.body.split("\n").map((line, j) => {
                  if (!line.trim()) return <div key={j} style={{ height: 4 }} />;
                  if (line.startsWith("- ") || line.startsWith("• ")) return <div key={j} style={{ paddingLeft: 10, marginBottom: 2 }}>· {renderBold(line.slice(2))}</div>;
                  return <div key={j} style={{ marginBottom: 2 }}>{renderBold(line)}</div>;
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {status === "error" && result && (
        <div style={{ fontSize: 11, color: "#C0352A", paddingTop: 8 }}>{result[0]?.body}</div>
      )}
    </div>
  );
}


// ── AuditHintPanel — hint GEO par question dans l'Audit ──────────
// Reprend le même fonctionnement que HintPanelQuestion dans GeoTab
function AuditHintPanel({ question, claudeKey, brandName }) {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [hint, setHint]     = useState("");
  const [open, setOpen]     = useState(false);

  const run = async () => {
    if (!claudeKey || status === "loading") return;
    setStatus("loading"); setOpen(false);

    const prompt = `Tu es un expert GEO (Generative Engine Optimization). La marque "${brandName}" n'apparaît pas dans les réponses LLM à la question suivante :

"${question}"

Produis une recommandation GEO courte et directement actionnable (5-7 lignes max) :
- Identifie pourquoi la marque est absente
- Suggère 2-3 actions concrètes (type de contenu, format, structure) pour y apparaître
- Commence directement par la recommandation, sans intro

Sois précis et cite des formats concrets (liste, FAQ, comparatif, données chiffrées, etc.).`;

    try {
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const raw = await res.text();
      const data = JSON.parse(raw);
      if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      setHint(text || "Aucune recommandation générée.");
      setStatus("done");
      setOpen(true);
    } catch(e) {
      setHint(`Erreur : ${e.message}`);
      setStatus("error");
      setOpen(true);
    }
  };

  const noKey = !claudeKey;
  const tip = noKey
    ? "Aucune clé API Claude renseignée — ajoutez-la dans ⚙️ Providers"
    : status === "loading" ? "Génération du hint…"
    : hint ? (open ? "Masquer le hint GEO" : "Voir le hint GEO")
    : "Générer un hint GEO";

  return (
    <>
      <button
        onClick={hint ? () => setOpen(o => !o) : run}
        disabled={noKey || status === "loading"}
        title={tip}
        style={{ flexShrink: 0, fontSize: 13, lineHeight: 1, background: hint ? "#FFFBEB" : "none", border: hint ? "0.5px solid #C9782033" : "none", borderRadius: 5, padding: hint ? "1px 5px" : "0 3px", cursor: noKey ? "not-allowed" : "pointer", opacity: noKey ? 0.35 : (status === "loading" ? 0.6 : 1), filter: noKey ? "grayscale(1)" : "none" }}>
        {status === "loading" ? "⏳" : "💡"}
      </button>
      {open && hint && (
        <div style={{ flexBasis: "100%", width: "100%", marginTop: 6, padding: "8px 10px", background: "#FFFBEB", border: "0.5px solid #C9782022", borderRadius: 6, fontSize: 11, lineHeight: 1.7, color: status === "error" ? "#C0352A" : "#92400E" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
            <button onClick={run} disabled={status === "loading"} title="Regénérer" style={{ fontSize: 9, color: "#1A3C2E", background: "none", border: "none", cursor: "pointer", padding: 0 }}>↺ Regénérer</button>
          </div>
          {status === "error" ? hint : hint.split("\n").map((line, i) => {
            if (!line.trim()) return <div key={i} style={{ height: 4 }} />;
            if (line.startsWith("- ") || line.startsWith("• ")) return <div key={i} style={{ paddingLeft: 10, marginBottom: 2 }}>· {line.slice(2)}</div>;
            return <div key={i} style={{ marginBottom: 2 }}>{line}</div>;
          })}
        </div>
      )}
    </>
  );
}


function FanoutAnalysis({ questions, results, brand, claudeKey, projectId = null, siteId = null }) {
  const [status, setStatus] = useState("idle");
  const [sections, setSections] = useState([]);
  const [open, setOpen] = useState(false);
  const [savedDate, setSavedDate] = useState(null);

  const brandName   = brand?.brand_name   || "";
  const brandDomain = brand?.brand_domain || "";
  const brandAliases = brand?.brand_aliases || [];

  // Recharger la dernière analyse fan-out persistée
  useEffect(() => {
    if (!projectId || !siteId) return;
    let cancelled = false;
    sbGetGeoAnalyses(projectId, siteId, "audit-fanout").then(rows => {
      if (cancelled || !rows?.length) return;
      const c = rows[0].content;
      if (c?.sections?.length) {
        setSections(c.sections);
        setStatus("done");
        setSavedDate(rows[0].created_at);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!claudeKey || !results.length) return;
    setStatus("loading"); setSections([]); setOpen(true);

    const total     = results.length;
    const withBrand = results.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
    const withSrc   = results.filter(r => r.brand_in_sources).length;
    const positions = results.filter(r => r.brand_position).map(r => r.brand_position);
    const avgPos    = positions.length ? (positions.reduce((a,b)=>a+b,0)/positions.length).toFixed(1) : null;
    const presence  = total ? Math.round(withBrand/total*100) : 0;

    const qMap = {}; questions.forEach(q => { qMap[q.id] = q.question; });
    const missing = [...new Set(results.filter(r=>!(r.brand_mentioned===true||r.brand_mentioned===1)).map(r=>qMap[r.question_id]).filter(Boolean))].slice(0,8);
    const present = [...new Set(results.filter(r=>r.brand_mentioned===true||r.brand_mentioned===1).map(r=>qMap[r.question_id]).filter(Boolean))].slice(0,5);

    const compCount = {};
    results.forEach(r => (r.competitors_mentioned||[]).forEach(c=>{ if(c.name) compCount[c.name]=(compCount[c.name]||0)+1; }));
    const topComps = Object.entries(compCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

    const urlCount = {};
    results.forEach(r=>(r.sources||[]).forEach(url=>{ urlCount[url]=(urlCount[url]||0)+1; }));
    const allTerms = [brandName,...brandAliases].filter(Boolean).map(t=>t.toLowerCase());
    const brandUrls2 = Object.entries(urlCount).filter(([u])=>allTerms.some(t=>u.toLowerCase().includes(t))).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const competitorUrls2 = Object.entries(urlCount).filter(([u])=>!allTerms.some(t=>u.toLowerCase().includes(t))).sort((a,b)=>b[1]-a[1]).slice(0,10);

    const provStats = {};
    results.forEach(r=>{
      const pid = (r.model||"").toLowerCase().includes("openai")||(r.model||"").toLowerCase().includes("gpt")?"OpenAI":(r.model||"").toLowerCase().includes("gemini")?"Gemini":(r.model||"").toLowerCase().includes("perplexity")||(r.model||"").toLowerCase().includes("sonar")?"Perplexity":(r.model||"").toLowerCase().includes("claude")?"Claude":"Autre";
      if(!provStats[pid]) provStats[pid]={total:0,withBrand:0};
      provStats[pid].total++;
      if(r.brand_mentioned===true||r.brand_mentioned===1) provStats[pid].withBrand++;
    });

    const prompt = `Tu es un expert GEO (Generative Engine Optimization) senior. Analyse la présence de "${brandName}" (${brandDomain||"—"}) dans les LLMs et produis des recommandations précises et actionnables.

DONNÉES DE PRÉSENCE :
- Présence totale : ${withBrand}/${total} réponses (${presence}%)
- Citée en source : ${withSrc} fois
- Position moyenne : ${avgPos ? "#"+avgPos : "non mesurée"}

PAR PROVIDER :
${Object.entries(provStats).map(([p,s])=>`- ${p}: ${s.withBrand}/${s.total} (${Math.round(s.withBrand/s.total*100)}%)`).join("\n")}

QUESTIONS AVEC PRÉSENCE (${present.length}) :
${present.map((q,i)=>`${i+1}. ${q}`).join("\n")||"Aucune"}

QUESTIONS SANS PRÉSENCE — PRIORITÉS (${missing.length}) :
${missing.map((q,i)=>`${i+1}. ${q}`).join("\n")||"Aucune"}

QUESTIONS FAVORITES — PÉRIMÈTRE STRATÉGIQUE (${(questions||[]).filter(q=>q.is_favorite).length}) :
${(questions||[]).filter(q=>q.is_favorite).map((q,i)=>`${i+1}. ${q.question}`).join("\n")||"Aucune"}
(Priorise EXPLICITEMENT les recommandations qui concernent ces questions favorites.)

TOP CONCURRENTS CITÉS :
${topComps.map(([n,c])=>`- ${n}: ${c}×`).join("\n")||"Aucun"}

URLS MARQUE EN SOURCE :
${brandUrls2.map(([u,c])=>`- ${u} (${c}×)`).join("\n")||"Aucune"}

TOP URLS CONCURRENTES :
${competitorUrls2.slice(0,8).map(([u,c])=>`- ${u} (${c}×)`).join("\n")||"Aucune"}

---

Produis exactement 4 sections dans ce format :

## ÉTAT DES LIEUX
[Diagnostic factuel en 4-5 points. Cite les chiffres exacts. Compare les providers.]

## MAILLAGE INTERNE — PAGES À RELIER
[2-4 recommandations de maillage interne sur ${brandDomain||"le site"} basées sur les thèmes des questions sans présence.]

## PAGES À CRÉER OU ADAPTER
[3-5 pages à créer/adapter. Pour chaque : H1 suggéré + angle éditorial + question cible.]

## URLS CONCURRENTES — CE QUI FONCTIONNE
[Pour 3-5 URLs concurrentes les plus citées : pourquoi les LLMs les citent et comment reproduire.]

RÈGLES : Commence DIRECTEMENT par ## ÉTAT DES LIEUX. Recommandations concrètes avec H1 suggérés. Pas de généralités.`;

    try {
      const res = await fetch("/api/claude-geo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1800, messages: [{ role: "user", content: prompt }] }),
      });
      const raw = await res.text();
      if (raw.trimStart().startsWith("<")) throw new Error("Proxy claude-geo introuvable");
      const data = JSON.parse(raw);
      if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
      const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();
      const parsed = text.split(/^## /m).filter(Boolean).map(s => {
        const idx = s.indexOf("\n");
        return { title: s.slice(0, idx).trim(), body: s.slice(idx+1).trim() };
      });
      setSections(parsed);
      setStatus("done");
      const now = new Date().toISOString();
      setSavedDate(now);
      if (projectId && siteId) {
        sbSaveGeoAnalysis({ project_id: projectId, site_id: siteId, kind: "audit-fanout", content: { sections: parsed, generated_at: now } }).catch(() => {});
      }
    } catch(e) {
      setSections([{ title: "Erreur", body: e.message }]);
      setStatus("error");
    }
  };

  const SECTION_META = {
    "ÉTAT DES LIEUX":    { icon: "◎", color: "#1A3C2E" },
    "MAILLAGE INTERNE":  { icon: "⟶", color: "#1A3C2E" },
    "PAGES À CRÉER":     { icon: "✦", color: "#C97820" },
    "URLS CONCURRENTES": { icon: "↗", color: "#1A3C2E" },
  };
  const getMeta = (title) => {
    const key = Object.keys(SECTION_META).find(k => title.includes(k));
    return SECTION_META[key] || { icon: "·", color: "#1A3C2E" };
  };

  if (!results.length) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: open && status === "done" ? 16 : 0 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 3 }}>Analyse GEO</div>
          <div style={{ fontSize: 13, color: "#1A3C2E", letterSpacing: "-0.005em" }}>Recommandations actionnables · {results.length} réponses</div>
          {savedDate && <div style={{ fontSize: 10, color: "#1A3C2E", marginTop: 2 }}>Dernière analyse : {new Date(savedDate).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {status === "done" && (
            <button onClick={() => setOpen(o => !o)}
              style={{ padding: "4px 12px", border: "0.5px solid #1A3C2E18", borderRadius: 6, background: "transparent", cursor: "pointer", fontSize: 11, color: "#1A3C2E" }}>
              {open ? "Masquer" : "Voir l'analyse"}
            </button>
          )}
          <button onClick={run} disabled={status === "loading" || !claudeKey}
            style={{ padding: "5px 14px", background: (!claudeKey || status === "loading") ? "transparent" : "#1A3C2E", color: (!claudeKey || status === "loading") ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: (!claudeKey || status === "loading") ? "default" : "pointer" }}
            title={!claudeKey ? "Aucune clé API Claude renseignée — ajoutez-la dans ⚙️ Providers" : undefined}>
            {status === "loading" ? "⏳ Analyse…" : status === "done" ? "↺ Relancer" : "✦ Analyser"}
          </button>
        </div>
      </div>

      {open && status === "done" && sections.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 0, borderTop: "0.5px solid #1A3C2E0D", paddingTop: 16 }}>
          {sections.map((s, i) => {
            const meta = getMeta(s.title);
            if (s.title === "Erreur") return <div key={i} style={{ fontSize: 12, color: "#C0352A", padding: "10px 0" }}>{s.body}</div>;
            return (
              <div key={i} style={{ borderLeft: "2px solid #1A3C2E0D", paddingLeft: 16, paddingBottom: 16, marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: meta.color, fontWeight: 500 }}>{meta.icon}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: meta.color }}>{s.title}</span>
                </div>
                <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.75 }}>
                  {s.body.split("\n").map((line, j) => {
                    if (!line.trim()) return <div key={j} style={{ height: 6 }} />;
                    if (line.startsWith("- ") || line.startsWith("• ")) return <div key={j} style={{ paddingLeft: 12, marginBottom: 3 }}>· {renderBold(line.slice(2))}</div>;
                    return <div key={j} style={{ marginBottom: 3 }}>{renderBold(line)}</div>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolModuleCard({ title, tier, icon, available, enabled, onToggle, count, children, onExport, exportLabel = "Exporter le lot" }) {
  const tierColor = tier === 1 ? "#1A7A4A" : tier === 2 ? "#C97820" : "#1A3C2E77";
  return (
    <div style={{ border: "0.5px solid #1A3C2E12", borderRadius: 10, marginBottom: 12, background: "#fff", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: enabled && available ? "0.5px solid #1A3C2E0C" : "none" }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#1A3C2E" }}>{title}</span>
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.05em", color: tierColor, background: `${tierColor}14`, borderRadius: 8, padding: "1px 6px" }}>TIER {tier}</span>
            {available && count != null && <span style={{ fontSize: 10, color: "#1A3C2E" }}>{count} résultat{count > 1 ? "s" : ""}</span>}
          </div>
          {!available && <div style={{ fontSize: 10, color: "#C0352A", marginTop: 2 }}>Données manquantes — importez la source requise dans Setup</div>}
        </div>
        {/* Switch on/off */}
        <button
          onClick={() => available && onToggle()}
          disabled={!available}
          title={available ? (enabled ? "Désactiver ce module" : "Activer ce module") : "Source non importée"}
          style={{
            width: 38, height: 22, borderRadius: 11, border: "none", flexShrink: 0,
            background: !available ? "#1A3C2E11" : enabled ? "#1A7A4A" : "#1A3C2E22",
            position: "relative", cursor: available ? "pointer" : "not-allowed", transition: "background 0.15s",
          }}>
          <span style={{ position: "absolute", top: 2, left: enabled && available ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s", boxShadow: "0 1px 2px #0002" }} />
        </button>
      </div>
      {enabled && available && (
        <div style={{ padding: "12px 16px" }}>
          {children}
          {onExport && count > 0 && (
            <button onClick={onExport} className="gt-btn gt-btn--ghost" style={{ fontSize: 10, padding: "4px 12px", marginTop: 10 }}>
              ↓ {exportLabel} ({count})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Mini-tableau compact réutilisable pour les modules
function ModuleTable({ columns, rows, limit = 8 }) {
  if (!rows?.length) return <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic" }}>Aucun résultat.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 420 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1A3C2E18" }}>
            {columns.map(c => <th key={c.key} style={{ textAlign: c.num ? "center" : "left", padding: "5px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={i} style={{ borderBottom: "0.5px solid #1A3C2E0A" }}>
              {columns.map(c => (
                <td key={c.key} style={{ padding: "5px 8px", textAlign: c.num ? "center" : "left", color: c.accent ? "#C97820" : "#1A3C2E", fontVariantNumeric: c.num ? "tabular-nums" : "normal", maxWidth: c.key === "url" ? 220 : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: c.key === "url" ? "nowrap" : "normal" }}>
                  {c.fmt ? c.fmt(r[c.key], r) : (typeof r[c.key] === "boolean" ? (r[c.key] ? "Oui" : "Non") : r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <div style={{ fontSize: 10, color: "#1A3C2E", marginTop: 6 }}>+ {rows.length - limit} autres (export complet ci-dessous)</div>}
    </div>
  );
}

function ToolModulesSection({ audit, sfRows, gscRows, gaRows, bingData, brand, competitors = [], claudeKey = "" }) {
  // État d'activation des modules (tous off par défaut sauf Tier 1)
  const [enabled, setEnabled] = useState({
    seoGap: true, unblock: true, business: true,       // Tier 1
    citability: false, orphan: false,                   // Tier 2
    aiTraffic: false, cannibal: false, bing: false,     // Tier 3
  });
  const toggle = (k) => setEnabled(e => ({ ...e, [k]: !e[k] }));

  const brandName = (brand?.brand_name || "marque").toLowerCase().replace(/\s+/g, "-");
  const dateF = new Date().toISOString().slice(0, 10);
  const citedSet = useMemo(() => new Set((audit.brandOwnUrls || audit.brandUrls || []).map(u => urlPath(typeof u === "string" ? u : (u.url || u.address || "")))), [audit]);

  // Calculs (mémoïsés, seulement si la source existe)
  const seoGap     = useMemo(() => gscRows?.length ? computeSeoGeoGap(audit, gscRows) : [], [audit, gscRows]);
  const unblock    = useMemo(() => sfRows?.length ? computePagesToUnblock(audit, sfRows) : [], [audit, sfRows]);
  const business   = useMemo(() => gaRows?.length ? computeBusinessValue(audit, gaRows) : null, [audit, gaRows]);
  const citability = useMemo(() => sfRows?.length ? computeCitabilityScores(sfRows, citedSet) : [], [sfRows, citedSet]);
  const orphan     = useMemo(() => sfRows?.length ? computeOrphanCited(audit, sfRows) : [], [audit, sfRows]);
  const aiTraffic  = useMemo(() => gaRows?.length ? computeAITraffic(gaRows) : null, [gaRows]);
  const cannibal   = useMemo(() => gscRows?.length ? computeReverseCannibalization(gscRows) : [], [gscRows]);
  const bingGap    = useMemo(() => Object.keys(bingData || {}).length ? computeBingGap(audit, bingData) : [], [audit, bingData]);

  const exp = (cols, rows, name) => downloadCSV(buildCSV(cols, rows), `${name}-${brandName}-${dateF}.csv`);

  const hasSF   = sfRows?.length > 0;
  const hasGSC  = gscRows?.length > 0;
  const hasGA   = gaRows?.length > 0;
  const hasBing = Object.keys(bingData || {}).length > 0;

  return (
    <div>
      <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 14, lineHeight: 1.5 }}>
        Croisez vos imports d'outils (Screaming Frog, Search Console, Analytics, Bing) avec la présence GEO. Activez les modules pertinents · chaque lot est exportable en CSV avec ses métriques.
      </div>

      {/* ── TIER 1 ── */}
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#1A7A4A", marginBottom: 8 }}>Tier 1 · Quick wins</div>

      <ToolModuleCard title="Écart SEO ↔ GEO" tier={1} icon="🔍" available={hasGSC} enabled={enabled.seoGap} onToggle={() => toggle("seoGap")} count={seoGap.length}
        onExport={() => exp(CSV_COLUMNS.seoGap, seoGap, "ecart-seo-geo")} exportLabel="Exporter les URLs">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Pages performantes sur Google mais <strong>absentes des réponses IA</strong> — le contenu existe, il faut le rendre citable.</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "clicks", label: "Clics", num: true }, { key: "impressions", label: "Impr.", num: true }, { key: "position", label: "Pos.", num: true, fmt: v => v ? "#" + v.toFixed(0) : "—" }]} rows={seoGap} />
      </ToolModuleCard>

      <ToolModuleCard title="Pages citées à débloquer" tier={1} icon="🔧" available={hasSF} enabled={enabled.unblock} onToggle={() => toggle("unblock")} count={unblock.length}
        onExport={() => exp(CSV_COLUMNS.unblock, unblock, "pages-a-debloquer")} exportLabel="Exporter les URLs">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>URLs <strong>citées par l'IA</strong> mais freinées techniquement (indexabilité, profondeur, contenu court).</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "citations", label: "Cit. IA", num: true }, { key: "issues", label: "Freins", accent: true }]} rows={unblock} />
      </ToolModuleCard>

      <ToolModuleCard title="Valeur business des pages (GA)" tier={1} icon="💰" available={hasGA} enabled={enabled.business} onToggle={() => toggle("business")} count={business?.highValueNotCited?.length || 0}
        onExport={() => exp(CSV_COLUMNS.business, business?.highValueNotCited || [], "pages-valeur-non-citees")} exportLabel="Exporter les URLs">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Pages à <strong>forte valeur business</strong> (sessions/revenus GA) mais non citées par l'IA — priorité absolue.</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "sessions", label: "Sessions", num: true }, business?.hasRevenue ? { key: "revenue", label: "Revenus", num: true } : { key: "views", label: "Vues", num: true }]} rows={business?.highValueNotCited || []} />
      </ToolModuleCard>

      {/* ── TIER 2 ── */}
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#C97820", margin: "18px 0 8px" }}>Tier 2 · Fort impact</div>

      <ToolModuleCard title="Score de citabilité (SF)" tier={2} icon="📐" available={hasSF} enabled={enabled.citability} onToggle={() => toggle("citability")} count={citability.length}
        onExport={() => exp(CSV_COLUMNS.citability, citability, "score-citabilite")} exportLabel="Exporter le lot">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Note d'extractibilité par les LLM (structure, longueur, lisibilité). Les <strong>scores faibles</strong> sont vos quick wins.</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "score", label: "Score", num: true, fmt: v => v + "/100" }, { key: "wordCount", label: "Mots", num: true }, { key: "cited", label: "Citée", num: true, fmt: v => v ? "✓" : "—" }]} rows={citability} />
      </ToolModuleCard>

      <ToolModuleCard title="Contenus orphelins citables" tier={2} icon="🔗" available={hasSF} enabled={enabled.orphan} onToggle={() => toggle("orphan")} count={orphan.length}
        onExport={() => exp(CSV_COLUMNS.orphan, orphan, "contenus-orphelins")} exportLabel="Exporter les URLs">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Pages citées par l'IA mais <strong>peu maillées</strong> en interne — renforcer les liens entrants.</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "inlinks", label: "Liens entrants", num: true }, { key: "crawlDepth", label: "Profondeur", num: true }]} rows={orphan} />
      </ToolModuleCard>

      {/* ── TIER 3 ── */}
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#1A3C2E", margin: "18px 0 8px" }}>Tier 3 · Différenciants</div>

      <ToolModuleCard title="Trafic IA entrant (GA4)" tier={3} icon="📈" available={hasGA} enabled={enabled.aiTraffic} onToggle={() => toggle("aiTraffic")} count={aiTraffic?.rows?.length || 0}
        onExport={() => exp(CSV_COLUMNS.aiTraffic, aiTraffic?.rows || [], "trafic-ia-entrant")} exportLabel="Exporter le détail">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Sessions réellement référées par les moteurs IA (ChatGPT, Perplexity, Gemini…). {!aiTraffic?.detected && <em>Aucune session IA détectée dans l'export GA actuel.</em>}</div>
        {aiTraffic?.detected && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            {Object.entries(aiTraffic.byEngine).map(([eng, s]) => (
              <div key={eng} style={{ fontSize: 11, padding: "4px 10px", border: "0.5px solid #1A3C2E12", borderRadius: 8 }}>{eng} · <strong>{s}</strong></div>
            ))}
          </div>
        )}
      </ToolModuleCard>

      <ToolModuleCard title="Cannibalisation inverse (GSC)" tier={3} icon="⚠️" available={hasGSC} enabled={enabled.cannibal} onToggle={() => toggle("cannibal")} count={cannibal.length}
        onExport={() => exp(CSV_COLUMNS.cannibal, cannibal, "cannibalisation-inverse")} exportLabel="Exporter les URLs">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Pages bien positionnées mais <strong>faible CTR</strong> — l'IA capte probablement le clic. GEO défensif.</div>
        <ModuleTable columns={[{ key: "url", label: "URL" }, { key: "impressions", label: "Impr.", num: true }, { key: "ctr", label: "CTR %", num: true, fmt: v => v.toFixed(1) }, { key: "position", label: "Pos.", num: true, fmt: v => "#" + v.toFixed(0) }]} rows={cannibal} />
      </ToolModuleCard>

      <ToolModuleCard title="Comparatif Bing / Copilot" tier={3} icon="🅑" available={hasBing} enabled={enabled.bing} onToggle={() => toggle("bing")} count={bingGap.length}
        onExport={() => exp(CSV_COLUMNS.bing, bingGap, "comparatif-bing")} exportLabel="Exporter le lot">
        <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 8 }}>Présence Bing (alimente Copilot &amp; ChatGPT Search). Un écart fort signale un problème d'indexation Bing spécifique.</div>
        <ModuleTable columns={[{ key: "topic", label: "Sujet / URL" }, { key: "bingValue", label: "Présence Bing", num: true }]} rows={bingGap} />
      </ToolModuleCard>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────
// ════════ Nouveaux visuels GEO (palette Sonate) ════════
const SON = { green: "#1A3C2E", greenMid: "#2D5A42", greenSoft: "#7E9A8C", accent: "#E8541A", cream: "#F5F0E8", creamDark: "#E8E0CE", ink: "#1C1C1C", inkMid: "#4A4A4A", inkLight: "#94A3B8", ok: "#2D6A4F", warn: "#C2790F", danger: "#9B2335" };

// Funnel de visibilité : du périmètre testé à la citation comme source.
function VisibilityFunnel({ funnel }) {
  if (!Array.isArray(funnel) || !funnel.length) return null;
  const total = Math.max(1, funnel[0].value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {funnel.map((f, i) => {
        const w = Math.max(6, Math.round((f.value / total) * 100));
        const pct = i === 0 ? null : Math.round((f.value / total) * 100);
        const shade = i === 0 ? SON.greenSoft : i === 1 ? SON.greenMid : i === 2 ? SON.green : SON.accent;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 150, flexShrink: 0, textAlign: "right" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: SON.green }}>{f.label}</div>
              <div style={{ fontSize: 10, color: SON.inkLight }}>{f.sub}</div>
            </div>
            <div style={{ flex: 1, position: "relative", height: 30, background: "#1A3C2E08", borderRadius: 6 }}>
              <div style={{ width: `${w}%`, height: "100%", background: shade, borderRadius: 6, display: "flex", alignItems: "center", paddingLeft: 10, transition: "width .3s" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>{f.value}</span>
              </div>
            </div>
            <div style={{ width: 64, flexShrink: 0, fontSize: 11, textAlign: "right", color: pct != null ? SON.inkMid : "transparent", fontWeight: 600 }}>{pct != null ? `${pct}% des réponses` : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

// Part de voix : barre empilée 100 % (marque en accent, concurrents en neutre).
function ShareOfVoice({ sov }) {
  if (!Array.isArray(sov) || !sov.length || sov.every(s => s.count === 0)) return null;
  const palette = [SON.accent, "#3D6354", "#5E8071", "#88A99B", "#AEC5BA", "#CBDBD2"];
  const shown = sov.filter(s => s.count > 0);
  return (
    <div>
      <div style={{ display: "flex", height: 30, borderRadius: 6, overflow: "hidden", border: "1px solid #1A3C2E14" }}>
        {shown.map((s, i) => (
          <div key={i} title={`${s.name} — ${s.pct}% (${s.count})`} style={{ width: `${s.pct}%`, background: palette[i] || SON.greenSoft, minWidth: s.pct > 0 ? 2 : 0 }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 10 }}>
        {shown.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: palette[i] || SON.greenSoft, flexShrink: 0 }} />
            <span style={{ fontWeight: i === 0 ? 700 : 500, color: i === 0 ? SON.accent : SON.green }}>{s.name}{i === 0 ? " (vous)" : ""}</span>
            <span style={{ color: SON.inkMid }}>{s.pct}% · {s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Matrice de co-occurrence : nb de réponses où 2 acteurs sont cités ensemble.
function CoOccurrenceMatrix({ coMatrix }) {
  const labels = coMatrix?.labels || [];
  const counts = coMatrix?.counts || [];
  if (labels.length < 2) return <div style={{ fontSize: 11, color: SON.inkLight, fontStyle: "italic", padding: "12px 0" }}>Pas assez de concurrents détectés pour la matrice de co-occurrence.</div>;
  let mx = 1; for (let i = 0; i < counts.length; i++) for (let j = 0; j < counts.length; j++) if (i !== j) mx = Math.max(mx, counts[i][j]);
  const short = (s) => (s || "").length > 12 ? (s.slice(0, 11) + "…") : s;
  const cellBg = (i, j, v) => {
    if (i === j) return "#1A3C2E0D";
    if (!v) return "#fff";
    const t = v / mx;
    return `rgba(232,84,26,${(0.10 + t * 0.75).toFixed(2)})`; // dégradé orange
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }} />
            {labels.map((l, j) => (
              <th key={j} title={l} style={{ padding: "6px 8px", fontWeight: 600, color: j === 0 ? SON.accent : SON.green, borderBottom: `2px solid ${SON.creamDark}`, whiteSpace: "nowrap", fontSize: 10 }}>{short(l)}{j === 0 ? " ★" : ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((rl, i) => (
            <tr key={i}>
              <th title={rl} style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600, color: i === 0 ? SON.accent : SON.green, whiteSpace: "nowrap", fontSize: 10 }}>{short(rl)}{i === 0 ? " ★" : ""}</th>
              {labels.map((_, j) => {
                const v = counts[i]?.[j] || 0;
                return (
                  <td key={j} title={`${labels[i]} ∩ ${labels[j]} : ${v} réponse${v > 1 ? "s" : ""}`} style={{ textAlign: "center", padding: "6px 8px", minWidth: 38, background: cellBg(i, j, v), color: i === j ? SON.green : (v ? SON.ink : "#CBD5E1"), fontWeight: i === j ? 700 : (v ? 600 : 400), border: "1px solid #1A3C2E0A" }}>{v}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10.5, color: SON.inkLight, marginTop: 8, lineHeight: 1.5 }}>
        Diagonale = nombre de réponses citant l'acteur. Hors diagonale = réponses où les deux acteurs sont cités <strong>ensemble</strong> (plus c'est orange, plus ils se disputent les mêmes réponses).
      </div>
    </div>
  );
}

// Piste 3 — Panneau « Perception de la marque » (sentiment IA, autonome + persistant).
function SentimentAuditPanel({ results, brand, claudeKey, projectId, siteId, onData }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle");
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!projectId || !siteId) return;
    let cancelled = false;
    sbGetGeoAnalyses(projectId, siteId, "sentiment").then(rows => {
      if (!cancelled && rows?.length) setData(rows[0].content);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, siteId]);

  // Remonte les données de perception au parent (pour l'export PPTX/PDF)
  useEffect(() => { if (data) onData?.(data); }, [data, onData]);

  const presentCount = (results || []).filter(r => r.brand_mentioned && (r.answer || "").trim()).length;
  const disabled = status === "loading" || !claudeKey || !presentCount;

  const run = async () => {
    if (disabled) return;
    setStatus("loading"); setErr(null);
    try {
      const parsed = await generateSentiment({ results, brand, claudeKey });
      setData(parsed);
      if (projectId && siteId) sbSaveGeoAnalysis({ project_id: projectId, site_id: siteId, kind: "sentiment", content: parsed }).catch(() => {});
      setStatus("done");
    } catch (e) { setErr(e.message); setStatus("error"); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: "#1A3C2E99" }}>
          {data?.generated_at
            ? `Tonalité et image de la marque dans ${data.n_analyzed || presentCount} réponses où elle apparaît`
            : `${presentCount} réponse${presentCount > 1 ? "s" : ""} où la marque apparaît, analysable${presentCount > 1 ? "s" : ""} par l'IA`}
        </div>
        <button onClick={run} disabled={disabled}
          title={!claudeKey ? "Aucune clé API Claude renseignée — ajoutez-la dans \u2699\ufe0f Providers" : (!presentCount ? "Aucune réponse où la marque est présente" : undefined)}
          style={{ padding: "5px 14px", background: disabled ? "transparent" : "#1A3C2E", color: disabled ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: disabled ? "default" : "pointer" }}>
          {status === "loading" ? "⏳ Analyse…" : data ? "↺ Ré-analyser" : "✦ Analyser le sentiment"}
        </button>
      </div>
      {err && <div style={{ fontSize: 11, color: "#C0352A", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{err}</div>}
      {data
        ? <SentimentView data={data} />
        : <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.6, background: "#1A3C2E08", borderRadius: 10, padding: "14px 16px" }}>Aucune analyse de perception générée. Cliquez « Analyser le sentiment » : l'IA évalue la tonalité (positif / neutre / négatif), ce qui est dit de la marque, ses atouts perçus et les points de vigilance.</div>}
    </div>
  );
}

export default function GeoAuditTab({
  sites, projectId, project = null, corrMatrix = [], metrics = [], resultVals = [], bingData = {},
  // Props setup depuis App.jsx
  projects, currentProjectId, setCurrentProjectId, setProjects, ownerEmail,
  setSites, sfData, setSfData, smData, setSmData, smOverview, setSmOverview, gscData, setGscData, gaData, setGaData,
  setBingData, dbHistory, dbLoading, refreshHistory,
  confirmModal, setConfirmModal, pageTypes, setPageTypes,
  isReadOnly = false, autoStartTour = false, onTourStarted = null,
}) {
  const [mainTab, setMainTab]           = useState("audit");
  // Vue globale par défaut ("__global__") ou un site précis.
  const [selectedSite, setSelectedSite] = useState("__global__");
  const [aggMode, setAggMode]           = useState("simple"); // "simple" | "cumulative" (vue globale)
  const [globalQuestions, setGlobalQuestions] = useState([]);
  const [globalResults, setGlobalResults]     = useState([]);
  const [globalLoading, setGlobalLoading]     = useState(false);
  // Sync selectedSite quand le projet change → repart en vue globale
  useEffect(() => {
    setSelectedSite("__global__");
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [roadmapData, setRoadmapData]   = useState(null);
  const [exporting, setExporting]       = useState(false);
  const [sentimentData, setSentimentData] = useState(null);
  const [showTour, setShowTour]         = useState(false);
  const [sfCorrFilter, setSfCorrFilter] = useState("all"); // "all" | "gsc" | "bing" | "fanout"
  const [showAllComp, setShowAllComp]   = useState(false); // tableau Paysage concurrentiel : voir toutes les marques
  const [brand, setBrand]               = useState(null);
  const [questions, setQuestions]       = useState([]);
  const [results, setResults]           = useState([]);
  const [urlIndex, setUrlIndex]         = useState([]);
  const [calendarEntries, setCalendarEntries] = useState([]); // geo_calendar_dates — 30 derniers jours
  const [keywords, setKeywords]         = useState([]); // pour tri par volume
  const [categories, setCategories]     = useState([]); // catégories de mots-clés
  const [competitors, setCompetitors]   = useState([]); // concurrents qualifiés
  const [compareRows, setCompareRows]   = useState(null); // lignes incluses dans la comparaison (null = toutes)
  const [loading, setLoading]           = useState(true);
  const [aliasMap, setAliasMap]         = useState({}); // alias(lower) → canonique

  const isGlobal = selectedSite === "__global__";
  const site = (Array.isArray(sites) ? sites : []).find(s => s.id === selectedSite) || (Array.isArray(sites) ? sites : [])[0];

  useEffect(() => {
    if (!projectId) return;
    sbGetCompareSettings(projectId).then(cfg => {
      setCompareRows(cfg && Array.isArray(cfg.compare_rows) && cfg.compare_rows.length ? cfg.compare_rows : COMPARE_ROWS.map(r => r.id));
    });
  }, [projectId]);
  const claudeKey = decodeKey(project?.claude_geo_key_enc || "");

  const refreshData = useCallback(() => {
    if (!projectId || !site?.id) return;
    setLoading(true);
    Promise.all([sbGetBrand(projectId, site.id), sbGetQuestions(projectId, site.id), sbGetGeoResults(projectId, site.id), sbGetUrlIndex(projectId), sbGetCalendarEntriesBatch(projectId, site.id), sbGetKeywords(projectId, site.id), sbGetCategories(projectId), sbGetCompetitors(projectId, site.id), sbGetAliases(projectId, site.id)])
      .then(([b, q, r, u, cal, kws, cats, comps, aliasRows]) => {
        setBrand(b); setQuestions(q); setResults(r); setUrlIndex(u);
        setCalendarEntries(cal || []); setKeywords(kws || []); setCategories(cats || []);
        const amap = {};
        (aliasRows || []).forEach(a => { if (a.alias && a.canonical) amap[a.alias.toLowerCase().trim()] = a.canonical.trim(); });
        setAliasMap(amap);
        // Init enabled : top-5 par mentions, le reste désactivé (seulement si aucun n'a été configuré)
        const compList = comps || [];
        const hasAnyConfig = compList.some(c => c.enabled === true || c.enabled === false);
        if (!hasAnyConfig && compList.length > 5) {
          // Top-5 par meilleure position moyenne (avgPos la plus basse = mieux placé)
          const sorted = [...compList].sort((a, b) => {
            const posA = (a.avg_position != null) ? a.avg_position : 9999;
            const posB = (b.avg_position != null) ? b.avg_position : 9999;
            return posA - posB;
          });
          const top5ids = new Set(sorted.slice(0, 5).map(c => c.id));
          setCompetitors(compList.map(c => ({ ...c, enabled: top5ids.has(c.id) })));
        } else {
          setCompetitors(compList);
        }
        setLoading(false);
      });
  }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refreshData(); }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Vue globale : charge questions + résultats de TOUS les sites du projet ──
  useEffect(() => {
    if (!projectId || !isGlobal) return;
    const list = Array.isArray(sites) ? sites : [];
    if (!list.length) return;
    let cancelled = false;
    setGlobalLoading(true);
    Promise.all(list.map(s => Promise.all([
      sbGetQuestions(projectId, s.id).catch(() => []),
      sbGetGeoResults(projectId, s.id).catch(() => []),
    ]))).then(pairs => {
      if (cancelled) return;
      const allQ = [], allR = [];
      pairs.forEach(([qs, rs]) => { allQ.push(...(qs || [])); allR.push(...(rs || [])); });
      setGlobalQuestions(allQ); setGlobalResults(allR); setGlobalLoading(false);
    }).catch(() => { if (!cancelled) setGlobalLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, isGlobal, sites]); // eslint-disable-line react-hooks/exhaustive-deps

  // Charger l'analyse roadmap "Et maintenant ?" (générée dans Fan-outs) pour l'export présentation
  useEffect(() => {
    if (!projectId || !site?.id) return;
    let cancelled = false;
    sbGetGeoAnalyses(projectId, site.id, "roadmap").then(rows => {
      if (!cancelled && rows?.length) setRoadmapData(rows[0].content);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, site?.id]);

  // Période de suivi (jours) — défaut 30 = 1 mois coulant. 0 = tout l'historique.
  const [periodDays, setPeriodDays] = useState(30);
  const siteResultsAll = useMemo(() => results.filter(r => r.site_id === site?.id), [results, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const siteResults   = useMemo(() => {
    if (!periodDays) return siteResultsAll;
    const since = Date.now() - periodDays * 86400000;
    const filtered = siteResultsAll.filter(r => {
      const t = r.created_at ? new Date(r.created_at).getTime() : null;
      return t == null ? true : t >= since;
    });
    return filtered.length ? filtered : siteResultsAll; // repli si la période ne retient rien
  }, [siteResultsAll, periodDays]);
  const siteQuestions = useMemo(() => questions.filter(q => q.site_id === site?.id), [questions, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const siteUrls      = useMemo(() => urlIndex.filter(u => u.project_id === projectId), [urlIndex, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sélection des données selon la vue (globale vs marque) ──────────────
  // Vue globale : questions + résultats de tous les sites, agrégation simple/cumulée.
  // Vue marque : chemin existant (résultats du site, marque propriétaire).
  const globalResultsPeriod = useMemo(() => {
    if (!periodDays) return globalResults;
    const since = Date.now() - periodDays * 86400000;
    const f = globalResults.filter(r => { const t = r.created_at ? new Date(r.created_at).getTime() : null; return t == null ? true : t >= since; });
    return f.length ? f : globalResults;
  }, [globalResults, periodDays]);
  const effQuestions  = isGlobal ? globalQuestions : siteQuestions;
  const effResults    = isGlobal ? globalResultsPeriod : siteResults;
  const effAggregation = isGlobal ? aggMode : null;
  const audit         = useMemo(() => computeAudit(effQuestions, effResults, siteUrls, brand, site, calendarEntries, keywords, competitors, aliasMap, effAggregation, null), [effQuestions, effResults, siteUrls, brand, site, calendarEntries, keywords, competitors, aliasMap, effAggregation]);
  // ── Audit recalculé sur le sous-ensemble FAVORIS (affichage parallèle) ──
  const favQuestions  = useMemo(() => siteQuestions.filter(q => q.is_favorite), [siteQuestions]);
  const favQIds       = useMemo(() => new Set(favQuestions.map(q => q.id)), [favQuestions]);
  const favResults    = useMemo(() => siteResults.filter(r => favQIds.has(r.question_id)), [siteResults, favQIds]);
  const auditFav      = useMemo(() => favQuestions.length ? computeAudit(favQuestions, favResults, siteUrls, brand, site, calendarEntries, keywords, competitors) : null, [favQuestions, favResults, siteUrls, brand, site, calendarEntries, keywords, competitors]); // eslint-disable-line react-hooks/exhaustive-deps
  // Périmètre SF : filtre global appliqué à toute analyse SF de l'audit.
  // Intervalle courant de la chronologie M/E/C : remonte par le graphique, sert aux exports.
  const [mecRange, setMecRange] = useState(null);
  const mecFloor = useMemo(() => earliestSelectableDate(project, effResults, calendarEntries), [project, effResults, calendarEntries]);
  const sfPerimeter   = useMemo(() => getSitePerimeter(site), [site]);
  const sfRowsScoped  = useMemo(() => applySfPerimeter((sfData || {})[site?.id] || [], sfPerimeter), [sfData, site, sfPerimeter]);
  // Stats outils par concurrent (pour les exports) : { compId: {sf_*, sm_*} }
  const compareCompTool = useMemo(() => {
    const m = {};
    (audit?.compareCompEntries || []).forEach(ce => {
      const comp = (competitors || []).find(c => c.id === ce.key);
      const ts = entityToolStats(comp?.tool_imports);
      if (ts) m[ce.key] = ts;
    });
    return m;
  }, [audit, competitors]);
  const updateSitePerimeter = (patch) => {
    if (!site?.id || !setSites) return;
    setSites(prev => (Array.isArray(prev) ? prev : []).map(s => s.id === site.id ? { ...s, ...patch } : s));
  };
  const noData        = !effResults.length;


  // Démarrer le tour automatiquement si demandé (depuis HomeTab) — après loading et noData
  useEffect(() => {
    if (autoStartTour && !loading && !noData) { setShowTour(true); onTourStarted?.(); }
  }, [autoStartTour, loading, noData]); // eslint-disable-line react-hooks/exhaustive-deps

  const AUDIT_TOUR_STEPS = [
    {
      target: "audit-score",
      icon: "📊",
      title: "Présence GEO",
      desc: "Le score de présence GEO indique le % de réponses LLM où votre marque est citée. 3 types sont mesurés : Mention (dans un top numéroté), Évocation (corps du texte) et Citation (dans les sources). Visez > 50%.",
      tip: "Un score < 30% indique un fort potentiel à exploiter — consultez le Plan d'action.",
      position: "bottom",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-visibility",
      icon: "📡",
      title: "Visibilité marque",
      desc: "Détaille la présence par provider LLM (OpenAI, Gemini, Perplexity, Claude) avec leur taux respectif. La tendance 30 jours montre l'évolution avec 3 courbes distinctes (Mention, Évocation, Citation). Les questions avec et sans présence sont listées.",
      tip: "Les questions sans mentions (✗) sont vos priorités — utilisez le 💡 Hint GEO pour chacune.",
      position: "bottom",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-fanout",
      icon: "✦",
      title: "Analyse Fan-out IA",
      desc: "Claude analyse vos données de présence et produit 4 recommandations actionnables : État des lieux, Maillage interne à relier, Pages à créer ou adapter, URLs concurrentes à surveiller. Relancez après chaque batch d'interrogations.",
      tip: "Cette analyse est basée sur vos données réelles — plus vous interrogez de questions, plus elle est précise.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-competitors",
      icon: "⚔️",
      title: "Paysage concurrentiel",
      desc: "Tableau Marque × Mention/Évocation/Citation pour votre marque (REF) et les 5 principaux concurrents détectés dans les réponses LLM. L'analyseur de pages permet de décrypter pourquoi un concurrent est plus cité.",
      tip: "Qualifiez vos concurrents dans Suivi GEO → Concurrents pour enrichir cette section.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-corr",
      icon: "🔀",
      title: "Matrice de corrélation",
      desc: "Croisez 2 sources de données (Screaming Frog, GSC, Bing, Fan-outs) pour découvrir des corrélations entre vos métriques SEO/techniques et votre présence GEO. Le coefficient r va de -1 (corrélation négative) à +1 (positive).",
      tip: "Une corrélation forte SF × Fan-outs révèle quel critère technique influence le plus votre visibilité LLM.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-sources",
      icon: "🔗",
      title: "Sources & URLs",
      desc: "Top domaines cités dans les réponses LLM, liste des URLs de votre marque (domaine propre) et présences externes (slug contenant la marque). Identifiez les pages performantes à renforcer et celles à créer.",
      tip: "Les URLs 'À booster' ont des mentions dans les réponses mais pas dans les sources — optimisez leur référencement externe.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-plan",
      icon: "🎯",
      title: "Plan d'action",
      desc: "Pistes prioritaires générées automatiquement depuis vos données : présence par provider, questions sans mention, URLs à optimiser. L'analyse IA détaillée de Claude fournit un rapport complet avec des recommandations sourcées.",
      tip: "Générez l'analyse IA avant d'exporter le PDF pour un rapport plus riche.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
    {
      target: "audit-export",
      icon: "⬇",
      title: "Export PDF",
      desc: "Génère un rapport PDF complet au design Sonate : cover verte, score GEO, KPIs, concurrents, URLs, plan d'action et analyse IA. Partagez-le directement avec votre client ou équipe.",
      tip: "Le PDF reflète l'état des données au moment de la génération — exportez après chaque session d'interrogation.",
      position: "top",
      onActivate: () => setMainTab("audit"),
    },
  ];
  return (
    <div>
      {showTour && (
        <TourGuide steps={AUDIT_TOUR_STEPS} onClose={() => setShowTour(false)} />
      )}
      {/* ── Header compact : titre + onglets + actions sur une ligne ── */}
      <div className="audit-header">
        {/* Gauche : titre + onglets */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A3C2E", letterSpacing: "-0.01em" }}>Audit GEO</div>
          <div style={{ display: "inline-flex", gap: 1, background: "#1A3C2E0C", borderRadius: 7, padding: "2px" }}>
            {[{ key: "setup", label: "Setup" }, { key: "audit", label: "Génération" }].map(t => (
              <button key={t.key} onClick={() => setMainTab(t.key)} style={{
                padding: "4px 14px", borderRadius: 5, fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", transition: "all 0.12s",
                background: mainTab === t.key ? "#1A3C2E" : "transparent",
                color: mainTab === t.key ? "#F0EBE0" : "#1A3C2E",
              }}>{t.label}</button>
            ))}
          </div>
        </div>
        {/* Droite : actions */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={refreshData} disabled={loading}
            style={{ fontSize: 11, color: "#1A3C2E", background: "transparent", border: "0.5px solid #1A3C2E18", borderRadius: 6, padding: "4px 10px", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.4 : 1 }}>
            {loading ? "⏳" : "↺"}
          </button>
          <button onClick={() => setShowTour(true)} disabled={noData || loading}
            style={{ fontSize: 11, color: "#1A3C2E", background: "transparent", border: "0.5px solid #1A3C2E18", borderRadius: 6, padding: "4px 10px", cursor: noData || loading ? "not-allowed" : "pointer", opacity: noData || loading ? 0.4 : 1 }}>
            Guide
          </button>
        </div>
      </div>

      {/* ── Setup ── */}
      {mainTab === "setup" && (
        <AuditSetupPanel
          projects={projects} currentProjectId={currentProjectId} setCurrentProjectId={setCurrentProjectId}
          setProjects={setProjects} ownerEmail={ownerEmail} sites={sites} setSites={setSites}
          sfData={sfData} setSfData={setSfData} smData={smData} setSmData={setSmData} smOverview={smOverview} setSmOverview={setSmOverview} gscData={gscData} setGscData={setGscData}
          gaData={gaData} setGaData={setGaData} bingData={bingData} setBingData={setBingData}
          dbHistory={dbHistory} dbLoading={dbLoading} refreshHistory={refreshHistory}
          confirmModal={confirmModal} setConfirmModal={setConfirmModal}
          pageTypes={pageTypes} setPageTypes={setPageTypes} project={project} projectId={projectId}
        />
      )}

      {/* ── Génération Audit GEO ── */}
      {mainTab === "audit" && (
        <div>
          {/* Sélecteur de site + Export — barre fine */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {(Array.isArray(sites) ? sites : []).length > 1 && (
                <button onClick={() => setSelectedSite("__global__")}
                  title="Vue globale : agrège toutes les marques du projet"
                  style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1px solid ${isGlobal ? "#1A3C2E" : "#1A3C2E33"}`, background: isGlobal ? "#1A3C2E" : "transparent", color: isGlobal ? "#fff" : "#1A3C2E" }}>
                  ◎ Vue globale
                </button>
              )}
              {(Array.isArray(sites) ? sites : []).length > 1 && (Array.isArray(sites) ? sites : []).map(s => (
                <button key={s.id} onClick={() => setSelectedSite(s.id)} style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: "pointer", border: `1px solid ${s.color}33`, background: selectedSite === s.id ? s.color : "transparent", color: selectedSite === s.id ? "#fff" : s.color }}>{s.label}</button>
              ))}
              {/* Switch Simple / Cumulée — actif en vue globale uniquement */}
              {isGlobal && (Array.isArray(sites) ? sites : []).length > 1 && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 0, marginLeft: 4, background: "#1A3C2E0A", borderRadius: 7, padding: 2 }}>
                  {[
                    { id: "simple", label: "Simple", tip: "Une présence par question : si plusieurs marques associées sont présentes sur une question, on compte 1 seule fois (au moins une marque présente)." },
                    { id: "cumulative", label: "Cumulée", tip: "Somme des présences : chaque marque associée présente est comptée. 3 marques présentes en mention sur une question = 3 mentions." },
                  ].map(m => (
                    <button key={m.id} onClick={() => setAggMode(m.id)} title={m.tip}
                      style={{ padding: "3px 11px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 5, cursor: "pointer",
                        background: aggMode === m.id ? "#fff" : "transparent", color: aggMode === m.id ? "#1A3C2E" : "#1A3C2E88",
                        boxShadow: aggMode === m.id ? "0 1px 3px #1A3C2E1A" : "none" }}>
                      {m.label}
                    </button>
                  ))}
                  <span title="Simple : au moins une marque présente compte 1 par question. Cumulée : on somme les présences de chaque marque associée."
                    style={{ marginLeft: 4, marginRight: 4, fontSize: 11, color: "#1A3C2E66", cursor: "help" }}>ⓘ</span>
                </div>
              )}
              {isGlobal && globalLoading && (
                <span style={{ fontSize: 10, color: "#C97820", marginLeft: 2 }}>agrégation…</span>
              )}
              {!isGlobal && ((sfData || {})[site?.id] || []).length > 0 && (
                <SfPerimeterControl site={site} totalCount={((sfData || {})[site?.id] || []).length} scopedCount={sfRowsScoped.length} onUpdate={updateSitePerimeter} />
              )}
            </div>
            <span data-tour="audit-export" style={{ display: "inline-flex", gap: 8 }}>
              <button onClick={async () => { setExporting(true); try { await exportAuditPptx({ ...audit, compareRows, compareBrandTool: { ...(sfCompareStats(sfRowsScoped, citedUrlSet(effResults)) || {}), ...(resolveSmStats(((smOverview || {})[site?.id] || [])[0], (smData || {})[site?.id]) || {}) }, compareCompTool, mecSeries: mecRange?.series || [], mecRangeLabel: mecRange ? `${mecRange.from} → ${mecRange.to}` : null }, brand, site, roadmapData, categories, sentimentData); } catch(e) { console.error(e); } finally { setExporting(false); } }}
                disabled={noData || exporting}
                title="PowerPoint éditable (.pptx) : score, visibilité, concurrence, sources, plan d'action"
                style={{ padding: "4px 12px", background: noData ? "transparent" : "#1A3C2E", color: noData ? "#1A3C2E" : "#F0EBE0", border: "0.5px solid #1A3C2E22", borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: noData ? "not-allowed" : "pointer" }}>
                {exporting ? "…" : "⬇ PowerPoint"}
              </button>
              <button onClick={async () => { setExporting(true); try { await exportAuditPdf({ ...audit, compareRows, compareBrandTool: { ...(sfCompareStats(sfRowsScoped, citedUrlSet(effResults)) || {}), ...(resolveSmStats(((smOverview || {})[site?.id] || [])[0], (smData || {})[site?.id]) || {}) }, compareCompTool, mecSeries: mecRange?.series || [], mecRangeLabel: mecRange ? `${mecRange.from} → ${mecRange.to}` : null }, brand, site, roadmapData, categories, sentimentData); } catch(e) { console.error(e); } finally { setExporting(false); } }}
                disabled={noData || exporting}
                title="PDF prêt à présenter — même contenu que le PowerPoint"
                style={{ padding: "4px 12px", background: "transparent", color: "#1A3C2E", border: "0.5px solid #1A3C2E22", borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: noData ? "not-allowed" : "pointer" }}>
                {exporting ? "…" : "⬇ PDF"}
              </button>
              <button onClick={() => { try { downloadCsv(buildGeoPagesCsv({ audit, keywords }), `optimisations_geo_${new Date().toISOString().slice(0,10)}.csv`); } catch(e) { console.error(e); } }}
                disabled={noData}
                title="Par page auditée : mots-clés liés + actions GEO, format inspiré du template Sheets"
                style={{ padding: "4px 12px", background: "transparent", color: "#1A3C2E", border: "0.5px solid #1A3C2E22", borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: noData ? "not-allowed" : "pointer" }}>
                ⬇ Optimisations GEO
              </button>
            </span>
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: 60, color: "#1A3C2E", fontSize: 12 }}>Chargement des données…</div>
          ) : noData ? (
            <div style={{ textAlign: "center", padding: 60, color: "#1A3C2E" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#1A3C2E", marginBottom: 6 }}>Aucun résultat disponible</div>
              <div style={{ fontSize: 12 }}>Interrogez des questions dans l'onglet Suivi GEO pour générer des données d'audit</div>
            </div>
          ) : (<>

            {/* ══════════════════════════════════════════════════════
                BLOC 1 — SYNTHÈSE EXÉCUTIVE
                Présence GEO + KPIs clés en un coup d'œil
            ══════════════════════════════════════════════════════ */}
            {/* Sélecteur de période de suivi (défaut : 1 mois coulant) */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#1A3C2E" }}>Période de suivi</span>
              <select value={periodDays} onChange={e => setPeriodDays(parseInt(e.target.value, 10))}
                style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #1A3C2E22", fontSize: 12, background: "#fff", color: "#1A3C2E", cursor: "pointer" }}>
                <option value={7}>7 derniers jours</option>
                <option value={30}>1 mois coulant</option>
                <option value={90}>3 mois</option>
                <option value={180}>6 mois</option>
                <option value={365}>12 mois</option>
                <option value={0}>Tout l'historique</option>
              </select>
            </div>
            <div data-tour="audit-score"><GeoScoreBanner audit={audit} auditFav={auditFav} brand={brand} site={site} /></div>

            {/* ══════════════════════════════════════════════════════
                BLOC 2 — VISIBILITÉ MARQUE
                Présence par provider + tendance 30j + questions
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-visibility" style={{ display: "contents" }}><Section title="Visibilité marque" sub="Présence dans les réponses LLM par provider et dans le temps">

              {/* Providers — ligne épurée */}
              {Object.keys(audit.providerStats).length > 0 && (
                <div className="audit-providers-row">
                  {Object.entries(audit.providerStats).map(([pid, s]) => {
                    const rate = pct(s.withBrand, s.total);
                    const color = rate >= 50 ? "#1A7A4A" : rate > 0 ? "#C97820" : "#1A3C2E33";
                    return (
                      <div key={pid} style={{ padding: "11px 16px", border: "0.5px solid #1A3C2E12", borderRadius: 8, background: "#fff", minWidth: 100 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 5 }}>{pid}</div>
                        <div style={{ fontSize: 23, fontWeight: 800, color, lineHeight: 1, letterSpacing: "-0.01em" }}>{rate}<span style={{ fontSize: 12, fontWeight: 500 }}>%</span></div>
                        <div style={{ fontSize: 11, color: "#1A3C2E99", marginTop: 3 }}>{s.withBrand}/{s.total}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Note : pourquoi les providers diffèrent */}
              {Object.keys(audit.providerStats).length > 1 && (() => {
                const rows = Object.entries(audit.providerStats).map(([pid, s]) => ({ pid, rate: pct(s.withBrand, s.total) })).sort((a, b) => b.rate - a.rate);
                const top = rows[0], low = rows[rows.length - 1];
                return (
                  <div style={{ fontSize: 11, color: "#1A3C2E99", lineHeight: 1.6, marginTop: -6, marginBottom: 16, maxWidth: 720 }}>
                    Les écarts entre moteurs sont normaux : chaque IA s'appuie sur des sources différentes (recherche web pour ChatGPT, Gemini et Perplexity, connaissances internes pour Claude) et sur ses propres critères de sélection.
                    {top && low && top.pid !== low.pid && top.rate !== low.rate ? ` Ici, ${top.pid} vous cite le plus (${top.rate}%) et ${low.pid} le moins (${low.rate}%) : un écart marqué signale que vos contenus sont mieux relayés par certaines sources que d'autres.` : ""}
                  </div>
                );
              })()}

              {/* Positions moyennes par type de présence (Mention / Évocation / Citation) */}
              {(audit.mentionCount > 0 || audit.evocationCount > 0 || audit.citationCount > 0) && (
                <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
                  {[
                    { label: "Mention",   icon: "◎", color: "#1A7A4A", pos: audit.avgMentionPos,   count: audit.mentionCount,   hint: "Position moyenne dans les tops numérotés" },
                    { label: "Évocation", icon: "⟶", color: "#C97820", pos: audit.avgEvocationPos, count: audit.evocationCount, hint: "Rang moyen d'apparition dans le corps du texte" },
                    { label: "Citation",  icon: "↗", color: "#1A3C2E", pos: audit.avgCitationPos,  count: audit.citationCount,  hint: "Rang moyen dans les sources citées" },
                  ].map(m => (
                    <div key={m.label} title={m.hint} style={{ flex: "1 1 150px", minWidth: 140, padding: "12px 16px", border: "0.5px solid #1A3C2E12", borderRadius: 8, background: "#fff" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, color: m.color }}>{m.icon}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99" }}>{m.label}</span>
                      </div>
                      <div style={{ fontSize: 23, fontWeight: 800, color: m.pos ? m.color : "#1A3C2E", lineHeight: 1, letterSpacing: "-0.01em" }}>
                        {m.pos ? <>#{m.pos}<span style={{ fontSize: 11, fontWeight: 500, color: "#1A3C2E99" }}> moy.</span></> : "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "#1A3C2E99", marginTop: 4 }}>moyenne sur {m.count} position{m.count > 1 ? "s" : ""} relevée{m.count > 1 ? "s" : ""}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Funnel de visibilité — du périmètre testé à la citation comme source */}
              {Array.isArray(audit.visibilityFunnel) && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Funnel de visibilité</div>
                  <VisibilityFunnel funnel={audit.visibilityFunnel} />
                </div>
              )}

              {/* ── Présence dans le temps : taux par jour de test ── */}
              {Array.isArray(audit.presenceTrend) && audit.presenceTrend.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 10 }}>Présence dans le temps</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {audit.presenceTrend.slice(-12).map(d => (
                      <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 74, flexShrink: 0, fontSize: 11, color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{d.date.slice(5)}</span>
                        <div style={{ flex: 1, height: 14, background: "#1A3C2E08", borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ width: `${Math.max(1, d.rate)}%`, height: "100%", background: d.rate >= 50 ? "#1A7A4A" : d.rate > 0 ? "#C97820" : "#1A3C2E22", borderRadius: 4 }} />
                        </div>
                        <span style={{ width: 110, flexShrink: 0, fontSize: 11, fontWeight: 700, color: "#1A3C2E", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.rate}% <span style={{ fontWeight: 400, color: "#1A3C2E99" }}>({d.present}/{d.tested})</span></span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 8 }}>Taux de présence de la marque par jour de test (réponses avec marque / réponses analysées ce jour).</div>
                </div>
              )}

              {/* Évolution chronologique — 3 courbes M/É/C sur un axe de jours continu */}
              <div className="audit-trend-wrap" style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 8 }}>Évolution chronologique</div>
                <PresenceTrendChart
                  results={effResults}
                  calendarEntries={calendarEntries}
                  minDate={mecFloor}
                  title="Mentions · Évocations · Citations"
                  onRangeChange={setMecRange}
                />
              </div>

              {/* ── LOT A : Analyse par intention manuelle de la question ── */}
              {(audit.questionIntentList || []).length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 4 }}>Analyse par intention de question</div>
                  <div style={{ fontSize: 10.5, color: "#94A3B8", marginBottom: 12 }}>Présence de la marque selon l'intention que vous avez taguée sur chaque question ({audit.qIntentTagged} question{audit.qIntentTagged > 1 ? "s" : ""} taguée{audit.qIntentTagged > 1 ? "s" : ""}).</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {audit.questionIntentList.map(st => (
                      <div key={st.intent} style={{ border: `0.5px solid ${st.color}22`, borderRadius: 8, padding: "10px 14px", background: `${st.color}08` }}>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: st.color }}>{st.label}</div>
                          <div style={{ fontSize: 11, color: "#1A3C2E99" }}>{st.questions} question{st.questions > 1 ? "s" : ""} · {st.total} réponse{st.total > 1 ? "s" : ""}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                          <div style={{ flex: 1, height: 16, background: "#1A3C2E08", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${st.presenceRate}%`, height: "100%", background: st.color, borderRadius: 4 }} />
                          </div>
                          <div style={{ width: 92, flexShrink: 0, fontSize: 13, fontWeight: 700, color: st.color, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{st.presenceRate}% <span style={{ fontSize: 10, fontWeight: 400, color: "#1A3C2E99" }}>présence</span></div>
                        </div>
                        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#1A3C2E" }}>
                          <span>◎ {st.mentions} mention{st.mentions > 1 ? "s" : ""}</span>
                          <span>→ {st.evocations} évocation{st.evocations > 1 ? "s" : ""}</span>
                          <span>↗ {st.citations} citation{st.citations > 1 ? "s" : ""}</span>
                          {st.avgPos && <span style={{ color: "#1A3C2E99" }}>pos. moy. #{st.avgPos}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Segmentation par intention ── */}
              {(audit.intentStatsList || []).length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>Performance par intention de recherche</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "#1A3C2E", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          <th style={{ padding: "6px 8px" }}>Intention</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Résultats</th>
                          <th style={{ padding: "6px 8px", textAlign: "right", color: "#1A7A4A" }}>◎ Mentions</th>
                          <th style={{ padding: "6px 8px", textAlign: "right", color: "#C97820" }}>⟶ Évoc.</th>
                          <th style={{ padding: "6px 8px", textAlign: "right", color: "#1A3C2E" }}>↗ Cit.</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Pos. moy.</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Présence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.intentStatsList.map(s => (
                          <tr key={s.intent} style={{ borderTop: "0.5px solid #1A3C2E0D" }}>
                            <td style={{ padding: "6px 8px", fontWeight: 600, color: "#1A3C2E" }}>{s.intent}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#1A3C2E" }}>{s.total}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#1A7A4A" }}>{s.mentions}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#C97820" }}>{s.evocations}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#1A3C2E" }}>{s.citations}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{s.avgPos ? `#${s.avgPos}` : "—"}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: s.presenceRate >= 50 ? "#1A7A4A" : s.presenceRate >= 20 ? "#C97820" : "#C0352A" }}>{s.presenceRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Priorisation par volume de recherche (piste 1) ── */}
              {(() => {
                const nameOf = (id) => id === "__none__" ? "Non catégorisé" : ((categories || []).find(c => c.id === id)?.name || id);
                const rows = Object.entries(audit.byQuestionCategory || {})
                  .map(([id, c]) => ({ id, name: nameOf(id), volume: c.volume || 0, presenceRate: c.presenceRate || 0, opportunity: c.opportunity || 0 }))
                  .filter(r => r.volume > 0)
                  .sort((a, b) => b.volume - a.volume)
                  .slice(0, 10);
                if (!rows.length) return null;
                const maxVol = Math.max(...rows.map(r => r.volume), 1);
                const topOpp = Math.max(...rows.map(r => r.opportunity), 0);
                const fmt = v => v >= 1000 ? (v / 1000).toFixed(1).replace(".0", "") + "k" : String(v);
                return (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 4 }}>Priorisation par volume de recherche</div>
                    <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 10 }}>Catégories triées par volume de recherche cumulé (Semrush). Un fort volume avec une présence faible signale une priorité GEO à fort impact.</div>
                    <div>
                      {rows.map((r, i) => {
                        const w = Math.max(4, Math.round((r.volume / maxVol) * 100));
                        const isOpp = topOpp > 0 && r.opportunity >= topOpp * 0.6 && r.presenceRate < 40;
                        return (
                          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: i ? "0.5px solid #1A3C2E0D" : "none" }}>
                            <div title={r.name} style={{ width: 160, flexShrink: 0, fontSize: 12, color: "#1A3C2E", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {isOpp && <span title="Fort volume, présence faible — priorité GEO">🎯 </span>}{r.name}
                            </div>
                            <div style={{ flex: 1, height: 16, background: "#1A3C2E08", borderRadius: 4, overflow: "hidden" }}>
                              <div style={{ width: `${w}%`, height: "100%", background: isOpp ? "#E8541A" : "#2D5A42", borderRadius: 4 }} />
                            </div>
                            <span style={{ width: 64, flexShrink: 0, fontSize: 12, fontWeight: 700, color: "#1A3C2E", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(r.volume)}</span>
                            <span style={{ width: 96, flexShrink: 0, fontSize: 10.5, textAlign: "right", color: r.presenceRate < 40 ? "#C0352A" : "#4A4A4A" }}>{r.presenceRate}% présence</span>
                          </div>
                        );
                      })}
                    </div>
                    {topOpp > 0 && <div style={{ marginTop: 8, fontSize: 10.5, color: "#94A3B8", lineHeight: 1.5 }}>🎯 Catégorie à fort volume et faible présence : priorité pour maximiser l'impact de vos contenus GEO.</div>}
                  </div>
                );
              })()}

              {/* ── Type de page citée ── */}
              {(audit.pageTypeStatsList || []).length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>Type de page citée en source</div>
                  <div style={{ fontSize: 11, color: "#1A3C2E", marginBottom: 10 }}>Nature des URLs citées par les IA (toutes marques). Le compteur « dont marque » indique vos propres pages.</div>
                  {(() => {
                    const max = Math.max(...audit.pageTypeStatsList.map(p => p.count), 1);
                    const COLORS = { "accueil": "#1A3C2E", "produit/service": "#1A7A4A", "blog/article": "#C97820", "catégorie": "#7C3AED", "institutionnel": "#64748B", "autre": "#9AAEA4" };
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {audit.pageTypeStatsList.map(p => (
                          <div key={p.type} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ fontSize: 12, color: "#1A3C2E", minWidth: 120 }}>{p.type}</span>
                            <div style={{ flex: 1, height: 16, background: "#1A3C2E08", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                              <div style={{ width: `${(p.count / max) * 100}%`, height: "100%", background: COLORS[p.type] || "#9AAEA4", borderRadius: 4 }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#1A3C2E", minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.count}</span>
                            {p.brand > 0 && <span style={{ fontSize: 10, color: "#1A7A4A", minWidth: 70 }}>dont {p.brand} marque</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Questions ◎ mention / ✗ favorites sans mention */}
              <div className="audit-questions-grid">
                <div>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A7A4A", marginBottom: 8 }}>◎ Avec mention · {audit.presentBrandQs.length}</div>
                  {audit.presentBrandQs.length ? audit.presentBrandQs.map((q, i) => (
                    <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: "0.5px solid #1A3C2E08", display: "flex", gap: 6, alignItems: "baseline" }}>
                      <span style={{ color: "#1A7A4A", flexShrink: 0, fontSize: 10 }}>◎</span>
                      {q.isFav && <span style={{ flexShrink: 0, fontSize: 10, color: "#C97820" }}>★</span>}
                      <span style={{ flex: 1, color: "#1A3C2E", lineHeight: 1.5 }}>{q.question}</span>
                      {q.volume > 0 && <span style={{ fontSize: 10, color: "#1A3C2E", flexShrink: 0 }}>{q.volume >= 1000 ? (q.volume/1000).toFixed(1)+"k" : q.volume}</span>}
                    </div>
                  )) : <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic" }}>Aucune mention dans un top LLM</div>}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C0352A", marginBottom: 8 }}>Questions sans mentions · {audit.missingBrandQs.length}</div>
                  {audit.missingBrandQs.length ? audit.missingBrandQs.map((q, i) => (
                    <div key={i} style={{ padding: "5px 0", borderBottom: "0.5px solid #1A3C2E08" }}>
                      <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                        <span style={{ color: "#C0352A", flexShrink: 0, fontSize: 10 }}>✗</span>
                        {q.isFav && <span style={{ flexShrink: 0, fontSize: 10, color: "#C97820" }}>★</span>}
                        <span style={{ flex: 1, minWidth: 0, color: "#1A3C2E", lineHeight: 1.5 }}>{q.question}</span>
                        {q.volume > 0 && <span style={{ fontSize: 10, color: "#1A3C2E", flexShrink: 0 }}>{q.volume >= 1000 ? (q.volume/1000).toFixed(1)+"k" : q.volume}</span>}
                        <AuditHintPanel question={q.question} claudeKey={claudeKey} brandName={brand?.brand_name || ""} />
                      </div>
                    </div>
                  )) : <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic" }}>Toutes les questions ont une mention !</div>}
                </div>
              </div>

              {/* Analyse Fan-out */}
              <div data-tour="audit-fanout" style={{ marginTop: 18, paddingTop: 16, borderTop: "0.5px solid #1A3C2E0C" }}>
                <FanoutAnalysis questions={siteQuestions} results={siteResults} brand={brand} claudeKey={claudeKey} projectId={projectId} siteId={site?.id} />
              </div>
            </Section>

            </div>{/* ══════════════════════════════════════════════════════
                BLOC 2B — ANALYSE PAR CATÉGORIE
            ══════════════════════════════════════════════════════ */}
            {/* ── Perception de la marque (sentiment IA) ── */}
            <Section title="Perception de la marque" sub="Analyse IA de la tonalité et de l'image dans les réponses">
              <SentimentAuditPanel key={site?.id || "site"} results={siteResults} brand={brand} claudeKey={claudeKey} projectId={projectId} siteId={site?.id} onData={setSentimentData} />
            </Section>

            <CategoryAnalysisCard
              siteQuestions={siteQuestions}
              siteResults={siteResults}
              keywords={keywords}
              categories={categories}
              brand={brand}
              claudeKey={claudeKey}
            />

            {/* ══════════════════════════════════════════════════════
                BLOC 2bis — PERFORMANCE DES FAVORIS
                Met en avant le périmètre stratégique (questions ★)
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-favorites" style={{ display: "contents" }}><Section title="Performance des favoris" sub="Vos questions stratégiques (★) classées par niveau de maîtrise">
              <FavoritesPerformance questions={siteQuestions} results={siteResults} projectId={projectId} siteId={site?.id} />
            </Section></div>

            {/* ══════════════════════════════════════════════════════
                BLOC 3 — ANALYSE CONCURRENTIELLE
                Concurrents + intentions + types de réponses
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-competitors" style={{ display: "contents" }}><Section title="Paysage concurrentiel" sub="Concurrents détectés dans les réponses LLM — analysez leurs pages">

              {/* Part de voix — marque vs concurrents */}
              {Array.isArray(audit.shareOfVoice) && audit.shareOfVoice.some(s => s.count > 0) && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Part de voix dans les réponses</div>
                  <ShareOfVoice sov={audit.shareOfVoice} />
                </div>
              )}

              {/* ── Lot B1 : Comparaison approfondie (concurrents cochés dans l'onglet Concurrents) ── */}
              {Array.isArray(audit.compareCompEntries) && audit.compareCompEntries.length > 0 && (() => {
                const sfStats = sfCompareStats(sfRowsScoped, citedUrlSet(effResults));
                const smStats = resolveSmStats(((smOverview || {})[site?.id] || [])[0], (smData || {})[site?.id]);
                const brandTool = { ...(sfStats || {}), ...(smStats || {}) };
                const toolStatsByCol = Object.keys(brandTool).length ? { __brand__: brandTool } : {};
                const importStatus = { __brand__: { sf: !!sfStats, semrush: !!smStats } };
                (audit.compareCompEntries || []).forEach(ce => {
                  const comp = (competitors || []).find(c => c.id === ce.key);
                  const ts = entityToolStats(comp?.tool_imports);
                  if (ts) toolStatsByCol[ce.key] = ts;
                  const ti = comp?.tool_imports || {};
                  importStatus[ce.key] = { sf: !!ti.sf, semrush: !!(ti.sm_overview || ti.sm_pages) };
                });
                const view = buildLlmComparison(brand?.brand_name || "Votre marque", audit.compareBrandStats, audit.compareCompEntries, toolStatsByCol);
                return (
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E99", marginBottom: 4 }}>Comparaison approfondie</div>
                    <div style={{ fontSize: 10.5, color: "#94A3B8", marginBottom: 12 }}>Votre marque face à {audit.compareCompEntries.length} concurrent{audit.compareCompEntries.length > 1 ? "s" : ""} sélectionné{audit.compareCompEntries.length > 1 ? "s" : ""}. La cellule encadrée est la meilleure valeur de chaque ligne. Réglez les lignes affichées dans l'onglet Concurrents.</div>
                    <CompareTable columns={view.columns} data={view.data} includedRows={compareRows} mode="audit" importStatus={importStatus} />
                  </div>
                );
              })()}

              {/* Tableau M/É/C top 5 concurrents */}
              {(() => {
                const brandName = brand?.brand_name || "Marque";
                const ranked = audit.competitorsRanked?.length ? audit.competitorsRanked : (audit.top5Competitors || []);
                const shown = showAllComp ? ranked : ranked.slice(0, 8);
                const allRows = [
                  { name: brandName, stats: { mentions: audit.mecTotals?.mentions||0, evocations: audit.mecTotals?.evocations||0, citations: audit.mecTotals?.citations||0, positions: audit.avgMentionPos ? [parseFloat(audit.avgMentionPos)] : [] }, isRef: true },
                  ...shown.map(([name, s]) => ({ name, stats: s, isRef: false })),
                ];
                return (
                  <div className="audit-comp-table-wrap">
                    <table className="audit-comp-table">
                      <thead>
                        <tr style={{ borderBottom: "0.5px solid #1A3C2E12" }}>
                          <th style={{ padding: "7px 0", textAlign: "left", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>Marque</th>
                          <th style={{ padding: "7px 10px", textAlign: "center", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A7A4A" }}>◎ Mention</th>
                          <th style={{ padding: "7px 10px", textAlign: "center", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C97820" }}>⟶ Évocation</th>
                          <th style={{ padding: "7px 10px", textAlign: "center", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>↗ Citation</th>
                          <th style={{ padding: "7px 10px", textAlign: "center", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E" }}>Pos.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allRows.map((row, i) => {
                          const s = row.stats;
                          const pos = (s.positions || []);
                          const avgPos = pos.length ? (pos.reduce((a, b) => a + b, 0) / pos.length).toFixed(1) : null;
                          return (
                            <tr key={i} style={{ borderBottom: "0.5px solid #1A3C2E06", background: row.isRef ? "#F0EBE018" : "transparent" }}>
                              <td style={{ padding: "8px 0" }}>
                                <span style={{ fontSize: 12, fontWeight: row.isRef ? 600 : 400, color: "#1A3C2E" }}>{row.name}</span>
                                {row.isRef && <span style={{ marginLeft: 6, fontSize: 8, background: "#1A3C2E", color: "#F0EBE0", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.06em" }}>REF</span>}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "center", fontSize: 14, fontWeight: 600, color: (s.mentions||0) > 0 ? "#1A7A4A" : "#1A3C2E" }}>{s.mentions || 0}</td>
                              <td style={{ padding: "8px 10px", textAlign: "center", fontSize: 14, fontWeight: 600, color: (s.evocations||0) > 0 ? "#C97820" : "#1A3C2E" }}>{s.evocations || 0}</td>
                              <td style={{ padding: "8px 10px", textAlign: "center", fontSize: 14, fontWeight: 600, color: (s.citations||0) > 0 ? "#1A3C2E" : "#1A3C2E" }}>{s.citations || 0}</td>
                              <td style={{ padding: "8px 10px", textAlign: "center", fontSize: 12, color: "#1A3C2E" }}>{avgPos ? `#${avgPos}` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* Voir toutes les marques détectées */}
              {(audit.competitorsRanked?.length || 0) > 8 && (
                <button onClick={() => setShowAllComp(v => !v)}
                  style={{ marginTop: 10, fontSize: 11, padding: "5px 12px", borderRadius: 6, border: "0.5px solid #1A3C2E22", background: "transparent", color: "#1A3C2E", cursor: "pointer" }}>
                  {showAllComp ? "▲ Afficher moins" : `▼ Voir toutes les marques (${audit.competitorsRanked.length})`}
                </button>
              )}

              {/* Matrice de co-occurrence — marque + top 5 concurrents */}
              {audit.coMatrix && (audit.coMatrix.labels || []).length >= 2 && (
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: "0.5px solid #1A3C2E0C" }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Matrice de co-occurrence — qui apparaît avec qui</div>
                  <CoOccurrenceMatrix coMatrix={audit.coMatrix} />
                </div>
              )}

              {/* Angles morts — questions où personne ne ressort */}
              {Array.isArray(audit.blindSpots) && audit.blindSpots.length > 0 && (
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: "0.5px solid #1A3C2E0C" }}>
                  <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 4 }}>Angles morts — {audit.blindSpots.length} question{audit.blindSpots.length > 1 ? "s" : ""} sans aucun acteur</div>
                  <div style={{ fontSize: 11, color: "#1A3C2E99", marginBottom: 10 }}>Questions où ni votre marque ni aucun concurrent n'apparaît : terrain libre à conquérir en priorité (contenu dédié, citations).</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {audit.blindSpots.slice(0, 12).map(b => (
                      <div key={b.id} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12, color: "#1C1C1C", padding: "6px 10px", background: "#E8541A0A", borderLeft: "2px solid #E8541A", borderRadius: 6 }}>
                        <span style={{ color: "#E8541A", fontWeight: 700, flexShrink: 0 }}>○</span>
                        <span style={{ lineHeight: 1.45 }}>{b.question}</span>
                      </div>
                    ))}
                  </div>
                  {audit.blindSpots.length > 12 && <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 8 }}>+ {audit.blindSpots.length - 12} autres</div>}
                </div>
              )}

              {/* Analyseur de pages concurrentes */}
              <CompetitorPageAnalyzer
                competitors={competitors}
                audit={audit}
                claudeKey={claudeKey}
              />
            </Section>
            </div>{/* ══════════════════════════════════════════════════════
                BLOC 4 — ANALYSE DES SOURCES & URLS
                Top domaines + URLs marque catégorisées
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-sources" style={{ display: "contents" }}><Section title="Sources & URLs" sub="URLs de la marque citées dans les réponses LLM">

              {/* Export de la liste des sources — par URL ou par domaine (point 6) */}
              {audit.sortedUrls.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10.5, color: "#1A3C2E99", marginRight: "auto" }}>Exporter la liste des sources&nbsp;:</span>
                  <button
                    onClick={() => {
                      const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
                      const rows = [...audit.sortedUrls]
                        .map(u => ({ url: u.url || u.norm, domain: u.domain || "", src: u.count_as_source || 0, ans: u.count_in_answer || 0 }))
                        .sort((a, b) => (b.src + b.ans) - (a.src + a.ans));
                      const csv = ["URL,Domaine,Citée en source,Présente dans réponse,Total",
                        ...rows.map(r => [esc(r.url), esc(r.domain), r.src, r.ans, r.src + r.ans].join(","))].join("\n");
                      downloadCsv("\uFEFF" + csv, `sources_urls_${(brand?.brand_name || "audit").replace(/\s+/g, "_")}.csv`);
                    }}
                    style={{ padding: "4px 12px", border: "0.5px solid #1A3C2E22", borderRadius: 6, background: "transparent", color: "#1A3C2E", fontSize: 10.5, fontWeight: 500, cursor: "pointer" }}>
                    ↓ Sources par URL
                  </button>
                  <button
                    onClick={() => {
                      const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
                      const byDom = {};
                      audit.sortedUrls.forEach(u => {
                        const d = u.domain || "(inconnu)";
                        if (!byDom[d]) byDom[d] = { total: 0, urls: 0 };
                        byDom[d].total += (u.count_as_source || 0) + (u.count_in_answer || 0);
                        byDom[d].urls += 1;
                      });
                      const rows = Object.entries(byDom).map(([d, v]) => ({ d, ...v })).sort((a, b) => b.total - a.total);
                      const csv = ["Domaine,Total citations,Nb URLs",
                        ...rows.map(r => [esc(r.d), r.total, r.urls].join(","))].join("\n");
                      downloadCsv("\uFEFF" + csv, `sources_domaines_${(brand?.brand_name || "audit").replace(/\s+/g, "_")}.csv`);
                    }}
                    style={{ padding: "4px 12px", border: "0.5px solid #1A3C2E22", borderRadius: 6, background: "transparent", color: "#1A3C2E", fontSize: 10.5, fontWeight: 500, cursor: "pointer" }}>
                    ↓ Sources par domaine
                  </button>
                </div>
              )}

              {/* Top domaines — graphe en barres (style Fan-out) */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Top domaines cités</div>
                <AuditBarChart
                  accent="#1A3C2E"
                  data={Object.entries(audit.topDomains).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([d, cnt]) => {
                    const isComp  = audit.competitorUrls.some(u => u.domain === d);
                    const isBrand = audit.brandUrls.some(u => u.domain === d);
                    return { name: d, count: cnt, kind: isBrand ? "brand" : isComp ? "competitor" : "other" };
                  })}
                />
                {/* Légende */}
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
                  {[["#1A7A4A","Votre marque"],["#C0352A","Concurrent"],["#9AAEA4","Autre"]].map(([c,l]) => (
                    <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "#1A3C2E" }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{l}
                    </span>
                  ))}
                </div>
                {/* Sources d'autorité à cibler — RP / netlinking */}
                {(() => {
                  const authority = Object.entries(audit.topDomains)
                    .filter(([d]) => !audit.brandUrls.some(u => u.domain === d) && !audit.competitorUrls.some(u => u.domain === d))
                    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d);
                  if (!authority.length) return null;
                  return (
                    <div style={{ marginTop: 12, fontSize: 11, color: "#1A3C2E", background: "#1A3C2E08", borderLeft: "2px solid #E8541A", borderRadius: 6, padding: "9px 12px", lineHeight: 1.55 }}>
                      <strong>Sources d'autorité à cibler.</strong> Les LLM s'appuient le plus sur&nbsp;: {authority.map((d, i) => <span key={d} style={{ fontWeight: 600 }}>{d}{i < authority.length - 1 ? ", " : ""}</span>)}. Cherchez à y être cité, publié ou lié (RP, contributions, fiches comparatives) — c'est là que se gagne la visibilité GEO.
                    </div>
                  );
                })()}
              </div>

              {/* Tableau URLs marque */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 500, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>URLs de la marque citées</div>
                {audit.brandUrls.length === 0 ? (
                  <div style={{ fontSize: 11, color: "#1A3C2E", fontStyle: "italic" }}>Aucune URL de la marque détectée dans les sources</div>
                ) : (
                  <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 480 }}>
                    <thead>
                      <tr style={{ background: "#FAFAF8" }}>
                        {["URL", "Citations src", "Mentions rép.", "Questions liées", "Statut"].map(h => (
                          <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 10, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {audit.brandUrls.slice(0, 20).map((u, i) => {
                        const src = u.count_as_source || 0;
                        const rep = u.count_in_answer || 0;
                        const detail = (audit.urlDetails || []).find(d => d.norm === u.norm);
                        const qCount = detail?.linkedQs?.length || 0;
                        const status = src >= 3 ? { label: "✓ Performante", color: "#1A7A4A", bg: "#F0F7F3" }
                                     : rep > 0 && src === 0 ? { label: "⚠ À sourcer", color: "#DC2626", bg: "#FEF2F2" }
                                     : src > 0 ? { label: "↑ À booster", color: "#D97706", bg: "#FFFBEB" }
                                     : { label: "— Peu citée", color: "#1A3C2E", bg: C.bg };
                        // Afficher la version normalisée (sans https, www, slash final)
                        const displayUrl = u.norm || u.url.replace(/^https?:\/\//, "");
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.borderLight}` }}>
                            <td style={{ padding: "8px 12px", maxWidth: 260, wordBreak: "break-all" }}>
                              <a href={u.url} target="_blank" rel="noreferrer" style={{ color: "#1A3C2E", fontSize: 11, textDecoration: "none" }}>{displayUrl}</a>
                            </td>
                            <td style={{ padding: "8px 12px", textAlign: "center", fontWeight: 700, color: src > 0 ? "#1A7A4A" : C.textLight }}>{src}</td>
                            <td style={{ padding: "8px 12px", textAlign: "center", fontWeight: 700, color: rep > 0 ? "#1A3C2E" : C.textLight }}>{rep}</td>
                            <td style={{ padding: "8px 12px", textAlign: "center", color: qCount > 0 ? C.text : C.textLight }}>
                              {qCount > 0 ? `${qCount} question${qCount > 1 ? "s" : ""}` : "—"}
                            </td>
                            <td style={{ padding: "8px 12px" }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: status.color, background: status.bg, borderRadius: 6, padding: "2px 8px" }}>{status.label}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </Section>
            </div>

            {/* ══════════════════════════════════════════════════════
                 BLOC 4ter — ANALYSE FAN-OUT (récupérée de l'onglet Suivi GEO)
            ══════════════════════════════════════════════════════ */}
            <FanoutAnalysisRecap projectId={projectId} siteId={site?.id} />

            {/* ══════════════════════════════════════════════════════
                 BLOC 4bis — MODULES OUTILS (SF / GSC / GA / Bing)
                 Croisements actionnables + export CSV par lot
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-tools" style={{ display: "contents" }}><Section title="Modules d'analyse outils" sub="Exploitez vos imports SF · GSC · GA · Bing — activez les modules pertinents, exportez chaque lot">
              <ToolModulesSection
                audit={audit}
                brand={brand}
                competitors={competitors}
                claudeKey={claudeKey}
                sfRows={sfRowsScoped}
                gscRows={(gscData && site) ? (gscData[site.id] || []) : []}
                gaRows={(gaData && site) ? (gaData[site.id] || []) : []}
                bingData={(bingData && site) ? (bingData[site.id] || {}) : {}}
              />
            </Section></div>

            {/* ══════════════════════════════════════════════════════
                 BLOC 5 — MATRICE DE CORRÉLATION INTERACTIVE
                 Croisement 2 sources parmi SF / GSC / Bing / Fan-outs
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-corr" style={{ display: "contents" }}><Section title="Matrice de corrélation" sub="Croisez 2 sources de données pour identifier les corrélations avec votre présence GEO">
              <CorrelationMatrix
                sfRows={sfRowsScoped}
                gscRows={(gscData && site) ? (gscData[site.id] || []) : []}
                gaRows={(gaData && site) ? (gaData[site.id] || []) : []}
                bingData={(bingData && site) ? (bingData[site.id] || {}) : {}}
                results={siteResults}
                audit={audit}
                sfCorrFilter={sfCorrFilter}
                setSfCorrFilter={setSfCorrFilter}
              />
            </Section>
            </div>

            {/* ══════════════════════════════════════════════════════
                BLOC 6 — PLAN D'ACTION
                Pistes prioritaires + analyse Fan-out IA
            ══════════════════════════════════════════════════════ */}
            {/* ══════════════════════════════════════════════════════
                BLOC 6 — PLAN D'ACTION
            ══════════════════════════════════════════════════════ */}
            <div data-tour="audit-plan" style={{ display: "contents" }}><Section title="Plan d'action" sub="Recommandations prioritaires et analyse IA">

              {/* Pistes prioritaires — style épuré */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 10 }}>Pistes prioritaires</div>
                {audit.leads.map((l, i) => {
                  const accentColor = l.priority.includes("🔴") ? "#C0352A" : l.priority.includes("🟠") ? "#C97820" : l.priority.includes("🟡") ? "#C97820" : "#1A7A4A";
                  return (
                    <div key={i} style={{ paddingLeft: 12, borderLeft: `2px solid ${accentColor}22`, marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: accentColor, marginBottom: 3, letterSpacing: "0.04em" }}>{l.label}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E", marginBottom: 5 }}>{l.reco}</div>
                      <div style={{ fontSize: 11.5, color: "#1A3C2E", lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 3 }}>
                        <div><span style={{ fontWeight: 600, color: accentColor }}>Pourquoi</span> · {l.why}</div>
                        <div><span style={{ fontWeight: 600, color: accentColor }}>Comment</span> · {l.how}</div>
                        <div><span style={{ fontWeight: 600, color: accentColor }}>Combien</span> · {l.howMuch}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Analyse IA */}
              <div style={{ paddingTop: 16, borderTop: "0.5px solid #1A3C2E0C" }}>
                <RoadmapAuditPanel roadmapData={roadmapData} setRoadmapData={setRoadmapData} questions={siteQuestions} results={siteResults} brand={brand} categories={categories} claudeKey={claudeKey} projectId={projectId} siteId={site?.id} />
              </div>
            </Section>
            </div>

          </>)}
        </div>
      )}
    </div>
  );
}