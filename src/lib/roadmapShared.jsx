// ════════════════════════════════════════════════════════════════════
// roadmapShared.jsx  →  src/lib/roadmapShared.jsx
// Source UNIQUE du plan d'action "Et maintenant ?" :
//   • generateRoadmap() : LE call (identique pour le Suivi GEO et l'audit).
//   • RoadmapView       : LE rendu (mêmes infos, même hiérarchie partout).
// Les deux onglets lisent/écrivent la même analyse persistée (kind="roadmap").
// ════════════════════════════════════════════════════════════════════

const RECO_MODEL_DEEP = "claude-sonnet-4-6";
const webSearchTool = (maxUses = 5) => ({ type: "web_search_20250305", name: "web_search", max_uses: maxUses });

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

function repairTruncatedJson(str) {
  if (!str) return null;
  let s = str.trim();
  const stack = [];
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; } else if (c === "\\") { esc = true; } else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); }
    else if (c === "}" || c === "]") { stack.pop(); }
    if ((c === "}" || c === "]") && stack.length >= 0) lastSafe = i;
  }
  let body = lastSafe >= 0 ? s.slice(0, lastSafe + 1) : s;
  const st2 = [];
  inStr = false; esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") st2.push(c);
    else if (c === "}" || c === "]") st2.pop();
  }
  body = body.replace(/,\s*$/, "");
  for (let i = st2.length - 1; i >= 0; i--) body += st2[i] === "{" ? "}" : "]";
  try { return JSON.parse(body); } catch { return null; }
}

// ── LE call partagé ───────────────────────────────────────────────────
export async function generateRoadmap({ questions = [], results = [], brand = null, categories = [], claudeKey, previousForComparison = null }) {
  if (!claudeKey) throw new Error("Clé Claude manquante.");
  if (!results.length) throw new Error("Aucun résultat à analyser.");

  const brandName    = brand?.brand_name   || "";
  const brandAliases = brand?.brand_aliases || [];
  const brandDomain  = brand?.brand_domain  || "";

  const resultsByQ = {};
  results.forEach(r => { (resultsByQ[r.question_id] = resultsByQ[r.question_id] || []).push(r); });
  const isMentioned = (qId) => (resultsByQ[qId] || []).some(r => r.brand_mentioned === true || r.brand_mentioned === 1);
  const brandPosOf = (qId) => {
    const rs = resultsByQ[qId] || [];
    const positions = rs.map(r => r.brand_mention_position || r.brand_position).filter(p => p != null && p > 0);
    return positions.length ? Math.min(...positions) : null;
  };
  const terms = [brandName, ...brandAliases].filter(Boolean).map(t => t.toLowerCase().trim());
  const isBrandQuestion = (q) => { const txt = (q.question || "").toLowerCase(); return terms.some(t => t.length >= 2 && txt.includes(t)); };

  const brandQs = questions.filter(isBrandQuestion);
  const brandQsData = brandQs.map(q => ({ question: q.question, mentioned: isMentioned(q.id), pos: brandPosOf(q.id) }));

  const catMap = {}; categories.forEach(c => { catMap[c.id] = c.name; });
  const byCat = {};
  questions.forEach(q => {
    const tags = Array.isArray(q.tags) ? q.tags : (q.category_id ? [q.category_id] : []);
    const cats = tags.length ? tags : ["__none__"];
    cats.forEach(cid => {
      const name = catMap[cid] || "Sans catégorie";
      if (!byCat[name]) byCat[name] = { total: 0, mentioned: 0 };
      byCat[name].total++;
      if (isMentioned(q.id)) byCat[name].mentioned++;
    });
  });

  const favs = questions.filter(q => q.is_favorite);
  const favClassified = favs.map(q => {
    const pos = brandPosOf(q.id); const ment = isMentioned(q.id); const kw = q.keyword_id;
    let bucket;
    if (ment && pos != null && pos <= 3) bucket = "defend";
    else if (ment && pos != null && pos >= 4 && pos <= 10) bucket = "watch";
    else if (!ment && kw) bucket = "conquest_priority";
    else bucket = "conquer";
    return { question: q.question, pos, mentioned: ment, bucket };
  });

  const total     = results.length;
  const withBrand = results.filter(r => r.brand_mentioned === true || r.brand_mentioned === 1).length;
  const presence  = total ? Math.round(withBrand / total * 100) : 0;

  const prompt = `Tu es un expert GEO (Generative Engine Optimization) senior. Tu produis un plan d'action stratégique pour "${brandName}" (${brandDomain}).

DONNÉES GLOBALES :
- Présence marque : ${withBrand}/${total} réponses (${presence}%)

QUESTIONS MARQUE (${brandQsData.length}) :
${brandQsData.slice(0, 12).map((q, i) => `${i+1}. "${q.question}" — ${q.mentioned ? "mentionnée" + (q.pos ? ` #${q.pos}` : "") : "absente"}`).join("\n") || "Aucune question marque"}

SYNTHÈSE PAR CATÉGORIE :
${Object.entries(byCat).map(([cat, s]) => `- ${cat} : ${s.mentioned}/${s.total} questions avec mention (${Math.round(s.mentioned/s.total*100)}%)`).join("\n") || "Aucune catégorie"}

QUESTIONS FAVORITES — PÉRIMÈTRE STRATÉGIQUE PRIORITAIRE (${favClassified.length}) :
${favClassified.slice(0, 25).map((f, i) => `${i+1}. "${f.question}" — ${f.bucket === "defend" ? "à défendre (lead)" : f.bucket === "watch" ? "à surveiller (top 4-10)" : f.bucket === "conquest_priority" ? "conquête prioritaire" : "à conquérir"}${f.pos ? ` #${f.pos}` : ""}`).join("\n") || "Aucune question favorite"}
IMPORTANT : les questions favorites sont le périmètre stratégique du client. Priorise EXPLICITEMENT les actions qui les concernent. Pour toute action de la roadmap liée à une question favorite, mets "favorite": true.
${previousForComparison ? `\nANALYSE PRÉCÉDENTE (pour comparaison) :\n${JSON.stringify(previousForComparison).slice(0, 1500)}` : ""}

---

Réponds UNIQUEMENT avec un objet JSON valide (sans markdown, sans backticks) de cette forme exacte :
{
  "diagnostic": { "verdict": "Le constat le plus LARGE : posture GEO globale de la marque en 2-3 phrases (présence, forces, blocage principal).", "levier_principal": "LE levier prioritaire n°1 pour progresser, en 1 phrase actionnable." },
  "brandAnalysis": "Analyse du ton et synthèse des réponses sur les questions marque (3-4 phrases). Puis 2-3 recommandations actionnables concrètes pour améliorer le GEO sur ces requêtes marque. Si aucune question marque, indique-le brièvement.",
  "categoryAnalysis": [
    { "category": "nom catégorie", "synthesis": "synthèse 1-2 phrases", "recommendation": "reco actionnable précise" }
  ],
  "roadmap": [
    { "action": "action concrète et précise", "category": "catégorie concernée ou 'Marque'", "target_url": "URL existante à optimiser OU /slug à créer", "page_exists": false, "priority": "haute", "impact": 8, "confidence": 7, "ease": 5, "favorite": false }
  ],
  ${previousForComparison ? `"comparison": { "better": "ce qui a mieux fonctionné", "worse": "ce qui a moins bien fonctionné", "done": "ce qui semble avoir été fait", "missing": "ce qui semble avoir manqué", "reinforce": "ce qui est à renforcer" }` : `"comparison": null`}
}

RÈGLES :
- LOGIQUE D'ENTONNOIR (du plus large au plus précis) : "diagnostic" = le constat global ; "brandAnalysis" + "categoryAnalysis" = niveau intermédiaire ; "roadmap" = actions précises et opérationnelles. Chaque niveau découle du précédent.
- UTILISE LA RECHERCHE WEB pour fonder tes recommandations sur des données réelles et récentes, et pour VÉRIFIER l'existence des pages : pour chaque action liée à une page, fais "site:<domaine> <sujet>". Renseigne "target_url" (URL existante vérifiée à optimiser, ou /slug à créer) et "page_exists" (true si une page couvre déjà le sujet, false sinon).
- "priority" ∈ {"haute","moyenne","basse"} : cohérent avec le score ICE (haute si ICE ≥ 24, moyenne si 18-23, basse sinon), mais relève à "haute" toute action liée à une question favorite.
- roadmap : 6 à 10 actions, triées priorité décroissante puis ICE décroissant. impact/confidence/ease sont des entiers de 1 à 10.
- Une action sur page EXISTANTE (optimiser) a un "ease" plus élevé qu'une création de zéro.
- Pour les actions liées aux questions marque, mets "category": "Marque".
- categoryAnalysis : une entrée par catégorie réelle ci-dessus (max 8).
- Recommandations spécifiques (URLs, formats, H1) — jamais génériques. Chaque action commence par un VERBE À L'INFINITIF.
- Réponds en français.`;

  const res = await fetch("/api/claude-geo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
    body: JSON.stringify({ model: RECO_MODEL_DEEP, max_tokens: 4096, tools: [webSearchTool(6)], messages: [{ role: "user", content: prompt }] }),
  });

  // Lire en TEXTE d'abord : si le service renvoie une page d'erreur non-JSON
  // (ex. timeout/limite de l'edge function → "The edge function…"), on évite
  // le cryptique « Unexpected token… is not valid JSON » et on explique.
  const rawBody = await res.text();
  let respData;
  try {
    respData = JSON.parse(rawBody);
  } catch {
    const snippet = rawBody.slice(0, 140).replace(/\s+/g, " ").trim();
    throw new Error(`Le service d'analyse n'a pas renvoyé de JSON (probable délai dépassé côté serveur sur l'appel avec recherche web). Réessaie dans un instant.${snippet ? ` [${res.status} — ${snippet}]` : ""}`);
  }
  if (!res.ok) throw new Error(respData.error?.message || `Claude ${res.status}`);
  const text = claudeFinalText(respData.content);

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const s = cleaned.indexOf("{"); const e = cleaned.lastIndexOf("}");
    let candidate = (s >= 0 && e > s) ? cleaned.slice(s, e + 1) : cleaned;
    try { parsed = JSON.parse(candidate); }
    catch {
      parsed = repairTruncatedJson(s >= 0 ? cleaned.slice(s) : cleaned);
      if (!parsed) throw new Error("Réponse de l'IA incomplète ou mal formée. Réessaie — si le problème persiste, réduis le nombre de questions.");
    }
  }
  parsed.favorites = favClassified;
  parsed.generated_at = new Date().toISOString();
  return parsed;
}

// ── Rendu inline minimal (gras/italique) pour brandAnalysis ───────────
function renderInline(text) {
  if (!text) return null;
  const parts = []; let rem = String(text); let k = 0;
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/;
  let m;
  while ((m = re.exec(rem))) {
    if (m.index > 0) parts.push(rem.slice(0, m.index));
    if (m[1] != null) parts.push(<strong key={k++}>{m[1]}</strong>);
    else parts.push(<em key={k++}>{m[2]}</em>);
    rem = rem.slice(m.index + m[0].length);
  }
  if (rem) parts.push(rem);
  return parts;
}
function renderMarkdownBlock(text) {
  if (!text) return null;
  return String(text).split("\n").map((line, i) => line.trim()
    ? <div key={i} style={{ marginBottom: 4 }}>{renderInline(line)}</div>
    : <div key={i} style={{ height: 6 }} />);
}

// ── LE rendu partagé (entonnoir : diagnostic → marque → catégories → plan) ──
export function RoadmapView({ data, exportSlot = null }) {
  if (!data || data.error) return null;

  const iceColor = (s) => s >= 24 ? "#1A7A4A" : s >= 18 ? "#C97820" : "#1A3C2E77";
  const PRIO_META = {
    haute:   { rank: 0, color: "#E8541A", label: "Haute" },
    moyenne: { rank: 1, color: "#C97820", label: "Moyenne" },
    basse:   { rank: 2, color: "#1A7A4A", label: "Basse" },
  };
  const prioOf = (r) => PRIO_META[(r.priority || "").toLowerCase()] || (() => {
    const ice = (r.impact || 0) + (r.confidence || 0) + (r.ease || 0);
    return ice >= 24 ? PRIO_META.haute : ice >= 18 ? PRIO_META.moyenne : PRIO_META.basse;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Diagnostic global — sommet de l'entonnoir */}
      {data.diagnostic && (data.diagnostic.verdict || data.diagnostic.levier_principal) && (
        <div style={{ backgroundColor: "#1A3C2E", borderRadius: 14, padding: "18px 20px", color: "#F0EBE0" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#E8541A", marginBottom: 8 }}>Diagnostic</div>
          {data.diagnostic.verdict && (
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5, color: "#F0EBE0", letterSpacing: "-0.01em" }}>{data.diagnostic.verdict}</div>
          )}
          {data.diagnostic.levier_principal && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid #F0EBE026", display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#E8541A", whiteSpace: "nowrap" }}>Levier n°1</span>
              <span style={{ fontSize: 13, lineHeight: 1.55, color: "#F0EBE0" }}>{data.diagnostic.levier_principal}</span>
            </div>
          )}
        </div>
      )}

      {/* Périmètre stratégique (favoris) */}
      {Array.isArray(data.favorites) && data.favorites.length > 0 && (() => {
        const counts = data.favorites.reduce((acc, f) => { acc[f.bucket] = (acc[f.bucket] || 0) + 1; return acc; }, {});
        const META = { defend: { l: "à défendre", c: "#1A7A4A" }, watch: { l: "à surveiller", c: "#C97820" }, conquest_priority: { l: "en conquête prioritaire", c: "#E8541A" }, conquer: { l: "à conquérir", c: "#1A3C2E77" } };
        return (
          <div style={{ background: "#FFFBF5", border: "0.5px solid #C9782022", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#C97820", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <span>★</span> Périmètre stratégique — {data.favorites.length} favori{data.favorites.length > 1 ? "s" : ""}
            </div>
            <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.7 }}>
              {["defend", "watch", "conquest_priority", "conquer"].filter(b => counts[b]).map((b, i, arr) => (
                <span key={b}><strong style={{ color: META[b].c }}>{counts[b]}</strong> {META[b].l}{i < arr.length - 1 ? " · " : ""}</span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 1 · Requêtes marque */}
      {data.brandAnalysis && (
        <div style={{ borderLeft: "2px solid #1A3C2E18", paddingLeft: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>1 · Requêtes marque  ·  vue d'ensemble</div>
          <div style={{ fontSize: 12, color: "#1A3C2E", lineHeight: 1.75 }}>{renderMarkdownBlock(data.brandAnalysis)}</div>
        </div>
      )}

      {/* 2 · Synthèse par catégorie */}
      {Array.isArray(data.categoryAnalysis) && data.categoryAnalysis.length > 0 && (
        <div style={{ borderLeft: "2px solid #C9782018", paddingLeft: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#C97820", marginBottom: 10 }}>2 · Synthèse par catégorie</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.categoryAnalysis.map((c, i) => (
              <div key={i} style={{ paddingBottom: 10, borderBottom: i < data.categoryAnalysis.length - 1 ? "0.5px solid #1A3C2E08" : "none" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#1A3C2E", marginBottom: 2 }}>{c.category}</div>
                <div style={{ fontSize: 11, color: "#1A3C2E", lineHeight: 1.6, marginBottom: 4 }}>{c.synthesis}</div>
                <div style={{ fontSize: 11, color: "#1A7A4A", lineHeight: 1.6 }}>→ {c.recommendation}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3 · Plan d'action priorisé */}
      {Array.isArray(data.roadmap) && data.roadmap.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#1A3C2E" }}>3 · Plan d'action priorisé  ·  du structurant au précis</div>
            {exportSlot}
          </div>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 540 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1A3C2E22" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>Action</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>Catégorie</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10 }} title="Impact">I</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10 }} title="Confidence">C</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10 }} title="Ease">E</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 600, color: "#1A3C2E", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {[...data.roadmap].sort((a, b) => {
                  if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
                  const pr = prioOf(a).rank - prioOf(b).rank; if (pr !== 0) return pr;
                  return ((b.impact||0)+(b.confidence||0)+(b.ease||0)) - ((a.impact||0)+(a.confidence||0)+(a.ease||0));
                }).map((r, i) => {
                  const ice = (r.impact || 0) + (r.confidence || 0) + (r.ease || 0);
                  const isBrand = (r.category || "").toLowerCase() === "marque";
                  const prio = prioOf(r);
                  return (
                    <tr key={i} style={{ borderBottom: "0.5px solid #1A3C2E0D", background: r.favorite ? "#FFFBF5" : "transparent", boxShadow: `inset 3px 0 0 ${prio.color}` }}>
                      <td style={{ padding: "8px 8px 8px 12px", color: "#1A3C2E", lineHeight: 1.4 }}>
                        <span style={{ display: "inline-block", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: prio.color, background: prio.color + "14", borderRadius: 4, padding: "1px 6px", marginRight: 6, verticalAlign: "1px" }}>{prio.label}</span>
                        {r.favorite && <span title="Concerne une question favorite" style={{ color: "#C97820", marginRight: 5 }}>★</span>}
                        {r.action}
                        {r.target_url && (
                          <div style={{ marginTop: 3, fontSize: 10 }}>
                            <span style={{ fontWeight: 700, color: r.page_exists ? "#1A7A4A" : "#C97820", marginRight: 5 }}>{r.page_exists ? "✓ Optimiser" : "+ Créer"}</span>
                            <span style={{ color: "#6B7A70", wordBreak: "break-all" }}>{r.target_url}</span>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: "#1A3C2E", background: isBrand ? "#1A3C2E11" : "transparent", border: `0.5px solid ${isBrand ? "#1A3C2E33" : "#1A3C2E11"}`, borderRadius: 10, padding: "1px 8px", whiteSpace: "nowrap" }}>{r.category || "—"}</span>
                      </td>
                      <td style={{ padding: "8px", textAlign: "center", color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{r.impact}</td>
                      <td style={{ padding: "8px", textAlign: "center", color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{r.confidence}</td>
                      <td style={{ padding: "8px", textAlign: "center", color: "#1A3C2E", fontVariantNumeric: "tabular-nums" }}>{r.ease}</td>
                      <td style={{ padding: "8px", textAlign: "center", fontWeight: 700, color: iceColor(ice), fontVariantNumeric: "tabular-nums" }}>{ice}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PISTE 3 — Analyse macro de sentiment / perception de la marque (IA)
// Analyse la tonalité et ce qui est dit de la marque dans les réponses
// où elle est présente. Appel Claude Sonnet, SANS recherche web (analyse
// du texte fourni uniquement). Persisté via kind="sentiment".
// ════════════════════════════════════════════════════════════════════
export async function generateSentiment({ results = [], brand = null, claudeKey }) {
  if (!claudeKey) throw new Error("Clé Claude manquante.");
  const brandName = brand?.brand_name || "la marque";
  const present = results.filter(r => r.brand_mentioned && (r.answer || "").trim());
  if (!present.length) throw new Error("Aucune réponse où la marque est présente à analyser.");

  // Échantillon borné (coût tokens) : jusqu'à 24 extraits de 600 car.
  const samples = present.slice(0, 24).map((r, i) => {
    const prov = (r.model || "").replace(/\s*\(.*/, "") || "IA";
    return `[${i + 1}] (${prov}) ${(r.answer || "").replace(/\s+/g, " ").slice(0, 600)}`;
  }).join("\n\n");

  const prompt = `Tu es analyste de réputation de marque. Analyse comment la marque « ${brandName} » est PERÇUE et PRÉSENTÉE dans les réponses ci-dessous, générées par des assistants IA (LLM) sur des questions où la marque apparaît.

RÉPONSES À ANALYSER :
${samples}

Évalue la TONALITÉ globale et le contenu de ce qui est dit sur la marque. Réponds UNIQUEMENT par un objet JSON valide (aucun texte autour, pas de balise markdown), au format EXACT :
{
  "overall": "positif" | "plutôt positif" | "neutre" | "mitigé" | "négatif",
  "score": <entier 0-100, 50 = strictement neutre, 100 = très positif>,
  "summary": "<2-3 phrases : comment la marque est globalement perçue et présentée>",
  "themes": [ { "label": "<thème abordé au sujet de la marque>", "tone": "positif"|"neutre"|"négatif", "detail": "<ce qui est dit, 1 phrase>" } ],
  "strengths": [ "<atout / point positif récurrent associé à la marque>" ],
  "watchouts": [ "<angle négatif, réserve, confusion ou risque d'image>" ],
  "quotes": [ { "text": "<extrait court et représentatif, < 140 caractères>", "tone": "positif"|"neutre"|"négatif" } ]
}
Contraintes : 3 à 5 thèmes, 1 à 4 strengths, 0 à 4 watchouts, 2 à 4 quotes. Sois factuel et strictement fidèle aux réponses fournies. N'invente rien. Si la marque n'est qu'évoquée sans jugement, dis-le (tonalité neutre).`;

  const res = await fetch("/api/claude-geo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-Key": claudeKey },
    body: JSON.stringify({ model: RECO_MODEL_DEEP, max_tokens: 2048, messages: [{ role: "user", content: prompt }] }),
  });
  const rawBody = await res.text();
  if (!res.ok) throw new Error(`Analyse impossible (${res.status}). ${rawBody.slice(0, 160)}`);
  let respData;
  try { respData = JSON.parse(rawBody); }
  catch { throw new Error("Réponse IA illisible (non-JSON)."); }

  const text = claudeFinalText(respData.content);
  let cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = (m && (() => { try { return JSON.parse(m[0]); } catch { return null; } })()) || repairTruncatedJson(cleaned);
  }
  if (!parsed) throw new Error("Analyse IA non exploitable.");

  parsed.generated_at = new Date().toISOString();
  parsed.n_analyzed = present.length;
  return parsed;
}

const SENT_TONE = {
  "positif":        { c: "#2D6A4F", bg: "#2D6A4F12", label: "Positif" },
  "plutôt positif": { c: "#2D6A4F", bg: "#2D6A4F10", label: "Plutôt positif" },
  "neutre":         { c: "#64748B", bg: "#64748B12", label: "Neutre" },
  "mitigé":         { c: "#C2790F", bg: "#C2790F12", label: "Mitigé" },
  "négatif":        { c: "#9B2335", bg: "#9B233512", label: "Négatif" },
};
const toneOf = (t) => SENT_TONE[(t || "").toLowerCase()] || SENT_TONE.neutre;

export function SentimentView({ data }) {
  if (!data) return null;
  const ov = toneOf(data.overall);
  const score = Math.max(0, Math.min(100, Number(data.score) || 50));
  return (
    <div>
      {/* Score + tonalité globale */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 auto" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 12px", borderRadius: 999, background: ov.bg, color: ov.c, fontWeight: 700, fontSize: 13 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: ov.c }} />{ov.label}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ position: "relative", height: 8, borderRadius: 999, background: "linear-gradient(90deg,#9B2335,#C2790F,#64748B,#2D6A4F)" }}>
            <div style={{ position: "absolute", top: -3, left: `calc(${score}% - 7px)`, width: 14, height: 14, borderRadius: "50%", background: "#fff", border: `2.5px solid ${ov.c}`, boxShadow: "0 1px 3px #0003" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "#94A3B8", marginTop: 4 }}><span>négatif</span><span style={{ fontWeight: 700, color: ov.c }}>{score}/100</span><span>positif</span></div>
        </div>
      </div>

      {data.summary && <p style={{ fontSize: 13, lineHeight: 1.6, color: "#1C1C1C", margin: "0 0 16px" }}>{data.summary}</p>}

      {/* Thèmes */}
      {Array.isArray(data.themes) && data.themes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>Ce qui est dit de la marque</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {data.themes.map((t, i) => {
              const to = toneOf(t.tone);
              return (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 12px", background: to.bg, borderRadius: 8, borderLeft: `2px solid ${to.c}` }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: to.c, flexShrink: 0, minWidth: 90 }}>{t.label}</span>
                  <span style={{ fontSize: 12, color: "#4A4A4A", lineHeight: 1.5 }}>{t.detail}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Atouts / Points de vigilance */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
        {Array.isArray(data.strengths) && data.strengths.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#2D6A4F", marginBottom: 8 }}>Atouts perçus</div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "#1C1C1C", lineHeight: 1.6 }}>
              {data.strengths.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
            </ul>
          </div>
        )}
        {Array.isArray(data.watchouts) && data.watchouts.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C2790F", marginBottom: 8 }}>Points de vigilance</div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "#1C1C1C", lineHeight: 1.6 }}>
              {data.watchouts.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Extraits représentatifs */}
      {Array.isArray(data.quotes) && data.quotes.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1A3C2E", marginBottom: 8 }}>Extraits représentatifs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.quotes.map((q, i) => {
              const to = toneOf(q.tone);
              return (
                <blockquote key={i} style={{ margin: 0, padding: "8px 14px", borderLeft: `3px solid ${to.c}`, background: "#1A3C2E06", borderRadius: "0 8px 8px 0", fontSize: 12, fontStyle: "italic", color: "#1C1C1C", lineHeight: 1.5 }}>
                  « {q.text} »
                </blockquote>
              );
            })}
          </div>
        </div>
      )}

      {data.generated_at && (
        <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 14 }}>
          Analyse de {data.n_analyzed || "?"} réponses · {new Date(data.generated_at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}