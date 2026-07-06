// components/GeoConfig.jsx
// Shared UI components for provider config and brand setup
// Used in both ImportTab (Section 3 & 4) and GeoTab

import { useState, useEffect } from "react";
import { C } from "../lib/constants";
import { sbSaveProviderKeys, sbSaveProviderWebSearch, sbSaveBrand, sbGetBrand } from "../lib/supabase";

function encodeKey(k) { try { return btoa(k); } catch { return ""; } }
function decodeKey(e) { try { return atob(e); } catch { return ""; } }

const PROVIDERS = [
  { id: "openai",     label: "OpenAI",     icon: "🟢", color: "#059669", keyField: "openai_key_enc",     keyPrefix: "sk-",      keyPlaceholder: "sk-…",      model: "gpt-4o-mini" },
  { id: "gemini",     label: "Gemini",     icon: "🔵", color: "#2563EB", keyField: "gemini_key_enc",     keyPrefix: "AIza",     keyPlaceholder: "AIza…",     model: "gemini-2.0-flash" },
  { id: "perplexity", label: "Perplexity", icon: "🟣", color: "#7C3AED", keyField: "perplexity_key_enc", keyPrefix: "pplx-",    keyPlaceholder: "pplx-…",    model: "sonar" },
  { id: "claude",     label: "Claude",     icon: "🟠", color: "#D97706", keyField: "claude_geo_key_enc", keyPrefix: "sk-ant-",  keyPlaceholder: "sk-ant-…",  model: "claude-haiku-4-5-20251001" },
];

// ── Catalogue de modèles par provider (avec tarifs API, USD / 1M tokens) ──
// Prix vérifiés juin 2026 — input/output par million de tokens.
// Modifiables ici si les tarifs évoluent.
export const MODEL_CATALOG = {
  openai: [
    { id: "gpt-4o-mini",  label: "GPT-4o mini",  in: 0.15, out: 0.60 },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", in: 0.40, out: 1.60 },
    { id: "gpt-4.1-nano", label: "GPT-4.1 nano", in: 0.10, out: 0.40 },
    { id: "gpt-4o",       label: "GPT-4o",        in: 2.50, out: 10.00 },
  ],
  gemini: [
    { id: "gemini-2.0-flash",      label: "Gemini 2.0 Flash",      in: 0.10, out: 0.40 },
    { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",      in: 0.30, out: 2.50 },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", in: 0.10, out: 0.40 },
  ],
  perplexity: [
    { id: "sonar",     label: "Sonar",     in: 1.00, out: 1.00 },
    { id: "sonar-pro", label: "Sonar Pro", in: 3.00, out: 15.00 },
  ],
  claude: [
    { id: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5",  in: 1.00, out: 5.00 },
    { id: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6", in: 3.00, out: 15.00 },
  ],
};

// Retrouve le tarif d'un modèle (ou le 1er du provider par défaut)
export function getModelPricing(providerId, modelId) {
  const list = MODEL_CATALOG[providerId] || [];
  return list.find(m => m.id === modelId) || list[0] || { in: 0, out: 0, label: modelId };
}

// ── Frais de recherche web (USD), facturés PAR APPEL, EN PLUS des tokens ──
// Ces frais n'apparaissent pas dans input/output_tokens et étaient donc oubliés
// dans l'estimation, alors qu'ils figurent bien sur les factures OpenAI/Anthropic/etc.
//  • OpenAI  : 10 $/1000 appels web_search (+ ~8k tokens de contenu déjà comptés en input).
//              L'app utilise search_context_size:"high" → coût réel souvent supérieur.
//  • Gemini  : ancrage Google Search ~35 $/1000 requêtes (hors quota gratuit).
//  • Perplexity : frais de requête Sonar (~5-8 $/1000) en plus des tokens.
//  • Claude  : l'INTERROGATION n'utilise pas la recherche web → 0.
//              (Les analyses reco/audit en Sonnet+web_search, elles, ne sont pas
//               journalisées dans geo_results et restent hors de ce suivi.)
export const WEB_SEARCH_FEE = {
  openai:     0.010,
  gemini:     0.035,
  perplexity: 0.006,
  claude:     0,
};

// ── Modes d'interrogation ─────────────────────────────────────────
// Chaque mode fait varier le nombre de tokens (et donc le coût) + le style.
// estIn/estOut = estimation moyenne de tokens entrée/sortie PAR question.
export const QUERY_MODES = {
  standard: {
    id: "standard", label: "Standard", icon: "◎",
    desc: "Mode actuel — réponse directe, favorise listes et citations.",
    estIn: 350, estOut: 600, maxTokens: 1024,
  },
  fidelity: {
    id: "fidelity", label: "Fiabilité navigateur", icon: "✓",
    desc: "Maximise la concordance avec une vraie recherche web. Prompt plus riche, réponse plus longue et sourcée.",
    estIn: 700, estOut: 1100, maxTokens: 2048,
  },
  discussion: {
    id: "discussion", label: "Discussion", icon: "⇄",
    desc: "Simule un échange de plusieurs messages pertinents autour de la question transactionnelle.",
    estIn: 1400, estOut: 1800, maxTokens: 3072,
  },
};
export const DEFAULT_MODE = "standard";


// ── ProviderConfigPanel ───────────────────────────────────────────
export function ProviderConfigPanel({ project, projectId, sites, onSaveProviderKeys }) {
  const [open, setOpen]       = useState(false);
  const [keys, setKeys]       = useState(() => {
    const init = {};
    if (project) {
      PROVIDERS.forEach(p => {
        const enc = project[p.keyField] || "";
        if (enc) { const dec = decodeKey(enc); init[p.id] = { enc, dec, input: "", status: "ok" }; }
        else init[p.id] = { enc: "", dec: "", input: "", status: "idle" };
      });
    }
    return init;
  });
  const [semrushInput, setSemrushInput] = useState("");
  const [semrushEnc,   setSemrushEnc]   = useState(project?.semrush_key_enc || "");

  // Choix de modèle + mode d'interrogation par provider (persistés en localStorage)
  const cfgKey = `geoProviderCfg_${projectId || "p"}`;
  const [providerCfg, setProviderCfg] = useState(() => {
    try { return JSON.parse(localStorage.getItem(cfgKey) || "{}"); } catch { return {}; }
  });
  const [nQuestions, setNQuestions] = useState(25); // pour l'estimateur de coût
  const updateCfg = (pid, patch) => {
    setProviderCfg(prev => {
      const next = { ...prev, [pid]: { ...(prev[pid] || {}), ...patch } };
      try { localStorage.setItem(cfgKey, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  };
  const cfgFor = (pid) => providerCfg[pid] || {};
  const modelIdFor = (p) => cfgFor(p.id).model || (MODEL_CATALOG[p.id]?.[0]?.id) || p.model;
  const modeIdFor  = (p) => cfgFor(p.id).mode || DEFAULT_MODE;
  // Recherche web : optionnelle (OpenAI, défaut ON), toujours active (Perplexity/Sonar
  // et Gemini/ancrage Google via le proxy), ou jamais utilisée à l'interrogation (Claude).
  const webSearchKind = (pid) => (pid === "perplexity" || pid === "gemini") ? "always" : pid === "claude" ? "never" : "optional";
  const webSearchMap = project?.provider_web_search || {};
  const webSearchOn = (p) => {
    const k = webSearchKind(p.id);
    if (k === "always") return true;
    if (k === "never")  return false;
    return webSearchMap[p.id] !== false; // défaut activé, persistance BDD
  };
  const toggleWebSearch = async (pid) => {
    const next = { ...webSearchMap, [pid]: !(webSearchMap[pid] !== false) };
    onSaveProviderKeys?.({ provider_web_search: next }); // maj optimiste du projet
    await sbSaveProviderWebSearch(projectId, next);
  };

  // Sync when project changes
  useEffect(() => {
    if (!project) return;
    const updates = {};
    PROVIDERS.forEach(p => {
      const enc = project[p.keyField] || "";
      const dec = enc ? decodeKey(enc) : "";
      updates[p.id] = { enc, dec, input: "", status: dec ? "ok" : "idle" };
    });
    setKeys(updates);
    setSemrushEnc(project.semrush_key_enc || "");
  }, [project?.id, project?.openai_key_enc, project?.gemini_key_enc, project?.perplexity_key_enc, project?.claude_geo_key_enc, project?.semrush_key_enc]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async (p) => {
    const k = keys[p.id]?.input?.trim();
    if (!k) return;
    const enc = encodeKey(k);
    const dec = decodeKey(enc);
    setKeys(prev => ({ ...prev, [p.id]: { enc, dec, input: "", status: "ok" } }));
    await sbSaveProviderKeys(projectId, { [p.keyField]: enc });
    onSaveProviderKeys?.({ [p.keyField]: enc });
  };

  const saveSemrush = async () => {
    const k = semrushInput.trim();
    if (!k) return;
    const enc = encodeKey(k);
    setSemrushEnc(enc);
    setSemrushInput("");
    await sbSaveProviderKeys(projectId, { semrush_key_enc: enc });
    onSaveProviderKeys?.({ semrush_key_enc: enc });
  };

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>⚙️ Gestion des Providers</span>
          <div style={{ display: "flex", gap: 4 }}>
            {PROVIDERS.map(p => (
              <span key={p.id} style={{ fontSize: 11, fontWeight: 700, color: keys[p.id]?.dec ? "#059669" : C.textLight }}>
                {keys[p.id]?.dec ? "●" : "○"}
              </span>
            ))}
          </div>
        </div>
        <span style={{ fontSize: 13, color: C.textLight }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 16 }}>
            {PROVIDERS.map(p => {
              const pk = keys[p.id] || { enc: "", dec: "", input: "", status: "idle" };
              const hasKey = !!pk.dec;
              return (
                <div key={p.id}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: p.color, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 6 }}>
                    {p.icon} {p.label}
                    {hasKey
                      ? <span style={{ color: "#059669", marginLeft: 6, fontWeight: 700 }}>✓ OK</span>
                      : <span style={{ color: C.textLight, marginLeft: 6, fontWeight: 400 }}>· non configuré</span>
                    }
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="password"
                      placeholder={hasKey ? "••••••••••• (déjà configurée)" : p.keyPlaceholder}
                      value={pk.input || ""}
                      onChange={e => setKeys(prev => ({ ...prev, [p.id]: { ...prev[p.id], input: e.target.value, status: "idle" } }))}
                      onKeyDown={e => e.key === "Enter" && saveKey(p)}
                      style={{ flex: 1, padding: "6px 10px", border: `1px solid ${hasKey ? "#059669" : C.border}`, borderRadius: 7, fontSize: 12, color: C.text, background: hasKey ? "#F0FDF4" : C.white }}
                    />
                    <button onClick={() => saveKey(p)} disabled={!pk.input?.trim()}
                      style={{ padding: "6px 12px", borderRadius: 7, background: p.color, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: pk.input?.trim() ? "pointer" : "not-allowed", opacity: pk.input?.trim() ? 1 : 0.5 }}>
                      ✓
                    </button>
                  </div>

                  {/* Modèle + mode + estimation de coût (seulement si clé fournie) */}
                  {hasKey && (() => {
                    const models = MODEL_CATALOG[p.id] || [];
                    const modelId = modelIdFor(p);
                    const modeId = modeIdFor(p);
                    const mode = QUERY_MODES[modeId] || QUERY_MODES[DEFAULT_MODE];
                    const pricing = getModelPricing(p.id, modelId);
                    // Coût d'une réponse = tokens + frais de recherche web (si active)
                    const webFee = webSearchOn(p) ? (WEB_SEARCH_FEE[p.id] || 0) : 0;
                    const costPerQ = (mode.estIn * pricing.in + mode.estOut * pricing.out) / 1e6 + webFee;
                    const totalCost = costPerQ * nQuestions;
                    const tokPerResp = mode.estIn + mode.estOut;
                    const costPer1k = ((pricing.in + pricing.out) / 2) / 1000; // moyenne in/out par 1000 tok
                    return (
                      <div style={{ marginTop: 8, padding: "10px 12px", background: "#FAFAF8", border: "0.5px solid #1A3C2E0D", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                        {/* Ligne modèle + mode */}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <label style={{ flex: "1 1 140px", minWidth: 0 }}>
                            <span style={{ fontSize: 9, color: "#1A3C2E", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Modèle</span>
                            <select value={modelId} onChange={e => updateCfg(p.id, { model: e.target.value })}
                              style={{ width: "100%", marginTop: 3, padding: "5px 8px", borderRadius: 6, border: "0.5px solid #1A3C2E22", fontSize: 12, background: "#fff", color: "#1A3C2E", cursor: "pointer" }}>
                              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                          </label>
                          <label style={{ flex: "1 1 140px", minWidth: 0 }}>
                            <span style={{ fontSize: 9, color: "#1A3C2E", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Mode d'interrogation</span>
                            <select value={modeId} onChange={e => updateCfg(p.id, { mode: e.target.value })}
                              style={{ width: "100%", marginTop: 3, padding: "5px 8px", borderRadius: 6, border: "0.5px solid #1A3C2E22", fontSize: 12, background: "#fff", color: "#1A3C2E", cursor: "pointer" }}>
                              {Object.values(QUERY_MODES).map(mo => <option key={mo.id} value={mo.id}>{mo.icon} {mo.label}</option>)}
                            </select>
                          </label>
                        </div>
                        <div style={{ fontSize: 10, color: "#1A3C2E", lineHeight: 1.4 }}>{mode.desc}</div>
                        {/* Recherche web (activer / désactiver) */}
                        {(() => {
                          const kind = webSearchKind(p.id);
                          const on = webSearchOn(p);
                          const fee = WEB_SEARCH_FEE[p.id] || 0;
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", paddingTop: 6, borderTop: "0.5px solid #1A3C2E0D" }}>
                              <span style={{ fontSize: 11, color: "#1A3C2E" }}>
                                🔍 Recherche web{fee > 0 && on ? <span style={{ color: "#C97820" }}> +${fee.toFixed(3)}/question</span> : null}
                              </span>
                              {kind === "optional" ? (
                                <button type="button" onClick={() => toggleWebSearch(p.id)}
                                  title={on ? "Désactiver la recherche web" : "Activer la recherche web"}
                                  style={{ width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", background: on ? p.color : "#CBD5E1", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                                  <span style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                                </button>
                              ) : (
                                <span style={{ fontSize: 10, color: "#8A8A82", fontStyle: "italic" }}>
                                  {kind === "always" ? "toujours active (Sonar)" : "non utilisée à l'interrogation"}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        {/* Estimation de coût */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 11, color: "#1A3C2E", alignItems: "baseline", paddingTop: 6, borderTop: "0.5px solid #1A3C2E0D" }}>
                          <span><span style={{ color: "#1A3C2E" }}>≈ </span><strong>{tokPerResp}</strong> tok/réponse</span>
                          <span><span style={{ color: "#1A3C2E" }}>×</span> <strong>{nQuestions}</strong> question{nQuestions > 1 ? "s" : ""}</span>
                          <span><span style={{ color: "#1A3C2E" }}>·</span> ${costPer1k.toFixed(5)}/1k tok</span>
                          <span style={{ marginLeft: "auto", fontWeight: 700, color: p.color }}>≈ ${totalCost.toFixed(totalCost < 0.01 ? 4 : totalCost < 1 ? 3 : 2)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Slider global : nombre de questions pour l'estimation */}
            {PROVIDERS.some(p => keys[p.id]?.dec) && (
              <div style={{ padding: "10px 12px", background: "#1A3C2E08", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#1A3C2E", textTransform: "uppercase", letterSpacing: 0.5 }}>Volume estimé</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E" }}>{nQuestions} questions</span>
                </div>
                <input type="range" min="1" max="200" value={nQuestions}
                  onChange={e => setNQuestions(parseInt(e.target.value, 10))}
                  style={{ width: "100%", accentColor: "#1A3C2E", cursor: "pointer" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#1A3C2E", marginTop: 2 }}>
                  <span>1</span><span>Total estimé pour l'ensemble des providers actifs ci-dessus</span><span>200</span>
                </div>
                {(() => {
                  const grand = PROVIDERS.filter(p => keys[p.id]?.dec).reduce((sum, p) => {
                    const mode = QUERY_MODES[modeIdFor(p)] || QUERY_MODES[DEFAULT_MODE];
                    const pr = getModelPricing(p.id, modelIdFor(p));
                    const webFee = webSearchOn(p) ? (WEB_SEARCH_FEE[p.id] || 0) : 0;
                    return sum + (((mode.estIn * pr.in + mode.estOut * pr.out) / 1e6) + webFee) * nQuestions;
                  }, 0);
                  return (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "0.5px solid #1A3C2E12", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 11, color: "#1A3C2E" }}>Coût total estimé (tous providers)</span>
                      <span style={{ fontSize: 16, fontWeight: 800, color: "#1A3C2E" }}>≈ ${grand.toFixed(grand < 1 ? 3 : 2)}</span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Semrush */}
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#FF642B", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 6 }}>
                📊 Semrush
                {semrushEnc
                  ? <span style={{ color: "#059669", marginLeft: 6, fontWeight: 700 }}>✓ OK</span>
                  : <span style={{ color: C.textLight, marginLeft: 6, fontWeight: 400 }}>· non configuré</span>
                }
                <span style={{ fontSize: 9, color: C.textLight, marginLeft: 6, fontWeight: 400, textTransform: "none" }}>volumes mots-clés</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  placeholder={semrushEnc ? "••••••••••• (déjà configurée)" : "Clé API Semrush…"}
                  value={semrushInput}
                  onChange={e => setSemrushInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveSemrush()}
                  style={{ flex: 1, padding: "6px 10px", border: `1px solid ${semrushEnc ? "#059669" : C.border}`, borderRadius: 7, fontSize: 12, color: C.text, background: semrushEnc ? "#F0FDF4" : C.white }}
                />
                <button onClick={saveSemrush} disabled={!semrushInput.trim()}
                  style={{ padding: "6px 12px", borderRadius: 7, background: "#FF642B", color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: semrushInput.trim() ? "pointer" : "not-allowed", opacity: semrushInput.trim() ? 1 : 0.5 }}>
                  ✓
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── BrandConfigPanel ──────────────────────────────────────────────
export function BrandConfigPanel({ site, projectId, onBrandSaved }) {
  const [brand, setBrand]         = useState(null);
  const [editing, setEditing]     = useState(false);
  const [draft, setDraft]         = useState({ brand_name: "", brand_domain: "", brand_aliases: "", competitors: "", context: "" });
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    if (!projectId || !site?.id) return;
    sbGetBrand(projectId, site.id).then(b => {
      if (b) {
        setBrand(b);
        setDraft({
          brand_name:    b.brand_name || "",
          brand_domain:  b.brand_domain || "",
          brand_aliases: (b.brand_aliases || []).join(", "),
          competitors:   (b.competitors || []).join(", "),
          context:       b.context || "",
        });
      }
    });
  }, [projectId, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    const b = {
      project_id:    projectId,
      site_id:       site.id,
      brand_name:    draft.brand_name.trim(),
      brand_domain:  draft.brand_domain.trim(),
      brand_aliases: draft.brand_aliases.split(",").map(s => s.trim()).filter(Boolean),
      competitors:   draft.competitors.split(",").map(s => s.trim()).filter(Boolean),
      context:       draft.context.trim(),
    };
    await sbSaveBrand(b);
    setBrand(b);
    setEditing(false);
    onBrandSaved?.(b);
    setSaving(false);
  };

  if (!site) return null;

  return (
    <div style={{ background: site.bg || C.bg, border: `1px solid ${site.color || C.border}33`, borderRadius: 14, padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: editing ? 14 : 0 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: site.color }}>🏷️ {site.label}</span>
          {brand?.brand_name && !editing && (
            <>
              <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>Marque : <strong>{brand.brand_name}</strong></span>
              {brand.brand_aliases?.length > 0 && (
                <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Alias</span>
                  {brand.brand_aliases.map((a, i) => (
                    <span key={i} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: `${site.color || C.blue}14`, color: site.color || C.text, fontWeight: 600 }}>{a}</span>
                  ))}
                </span>
              )}
              {brand.competitors?.length > 0 && (
                <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Concurrents</span>
                  {brand.competitors.map((c, i) => (
                    <span key={i} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: `${C.textLight}22`, color: C.text }}>{c}</span>
                  ))}
                </span>
              )}
            </>
          )}
          {!brand?.brand_name && !editing && <span style={{ fontSize: 11, color: C.textLight, fontStyle: "italic" }}>Aucune marque configurée pour ce site</span>}
        </div>
        <button onClick={() => setEditing(e => !e)}
          style={{ padding: "5px 12px", border: `1px solid ${site.color || C.border}`, borderRadius: 7, background: "transparent", color: site.color || C.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
          {editing ? "Annuler" : brand ? "✏️ Modifier" : "➕ Configurer"}
        </button>
      </div>

      {editing && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "Nom de la marque *", key: "brand_name", placeholder: "ex: Acme Corp", span: false },
            { label: "Domaine principal *", key: "brand_domain", placeholder: "ex: acme.com", span: false },
            { label: "Alias / variantes", key: "brand_aliases", placeholder: "ex: Acme, ACME Inc (séparés par virgule)", span: true },
            { label: "Concurrents", key: "competitors", placeholder: "ex: rival.com, concurrent.fr (séparés par virgule)", span: true },
            { label: "Contexte", key: "context", placeholder: "Décrivez votre activité en 1-2 phrases", span: true },
          ].map(f => (
            <div key={f.key} style={{ gridColumn: f.span ? "1 / -1" : "auto" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 5 }}>{f.label}</div>
              {f.key === "context" ? (
                <textarea rows={2} value={draft[f.key]} onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{ width: "100%", padding: "6px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
              ) : (
                <input value={draft[f.key]} onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{ width: "100%", padding: "6px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, boxSizing: "border-box" }} />
              )}
            </div>
          ))}
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={save} disabled={saving || !draft.brand_name.trim()}
              style={{ padding: "7px 20px", background: site.color || C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {saving ? "⏳…" : "💾 Sauvegarder"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}