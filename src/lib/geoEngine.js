// ════════════════════════════════════════════════════════════════════
// geoEngine.js — Moteur partagé [Call + Identification] GEO
//
// SOURCE DE VÉRITÉ UNIQUE utilisée à la fois par l'onglet Questions (GeoTab)
// et par le scheduler automatique (netlify/functions/geo-scheduler-background).
// Toute logique d'appel des providers (proxies + web search) et d'identification
// des présences (mention / évocation / citation) vit ICI — pas de copie.
//
// Environnement-agnostique : pas de React, pas de DOM, pas de localStorage.
// Utilise uniquement `fetch` (dispo côté navigateur ET côté fonction Netlify).
// Les proxies sont des routes relatives côté front (base="") ; le scheduler
// passe une base absolue (origine du déploiement).
// ════════════════════════════════════════════════════════════════════

// Modèles par défaut par provider (alignés avec l'onglet Questions).
export const PROVIDER_MODELS = {
  openai:     "gpt-4o-mini",
  gemini:     "gemini-2.5-flash",
  perplexity: "sonar",
  claude:     "claude-haiku-4-5-20251001",
};
export const PROVIDER_LABEL = { openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude" };

// ── Construction des prompts — IDENTIQUE à runProvider (onglet Questions) ──
export function buildPrompt(providerId, question, context = "", mode = "standard") {
  const baseContext = context ? `Contexte : "${context}"\n` : "";
  const q = `Question : ${question}`;
  let prompt;
  if (providerId === "claude") {
    prompt = `${baseContext}Tu es un expert en recommandation d'entreprises et prestataires. Réponds à la question suivante en te basant sur tes connaissances pour donner une liste de vrais acteurs, entreprises ou prestataires du marché.
RÈGLE : Ne dis jamais que tu n'as pas accès au web ou aux avis récents. Donne directement des recommandations concrètes avec les vrais noms d'entreprises que tu connais.
Réponds en texte libre structuré. Liste les acteurs avec une courte description de chacun.
Pour chaque acteur, indique son site web réel (URL complète https://…) afin qu'il apparaisse comme source.
${q}`;
  } else if (providerId === "gemini") {
    prompt = `${baseContext}Tu as accès à Google Search en temps réel. Utilise-le pour trouver les meilleurs acteurs, entreprises et prestataires actuels.
Réponds avec une liste de vrais acteurs du marché, leurs sites web et leurs caractéristiques principales.
Sois direct et factuel. Cite les sources que tu as consultées.
${q}`;
  } else {
    prompt = [baseContext, "Tu es un assistant IA avec accès au web. Réponds directement et complètement à la question.", "RÈGLE ABSOLUE : Ne pose jamais de question de clarification. Donne directement une liste de recommandations concrètes.", "Pour chaque acteur recommandé : donne le nom, le site web, et une description courte.", "Sois factuel, précis, et cite tes sources.", q].filter(Boolean).join("\n");
  }
  if (mode === "fidelity") {
    prompt += "\n\nConsigne de fiabilité : réponds comme le ferait un moteur de recherche web récent. Donne une réponse complète, structurée et SOURCÉE (URLs réelles), en privilégiant la concordance avec ce qu'un utilisateur trouverait dans son navigateur.";
  } else if (mode === "discussion") {
    prompt += "\n\nConsigne de discussion : simule un échange réaliste de plusieurs messages autour de cette question transactionnelle (questions de suivi pertinentes + réponses), puis conclus par une synthèse des acteurs recommandés.";
  }
  return prompt;
}

export function extractDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

export function getProviderId(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("openai") || m.includes("gpt")) return "openai";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("perplexity") || m.includes("sonar")) return "perplexity";
  if (m.includes("claude")) return "claude";
  return "other";
}

export function extractOpenAIUrls(data) {
  // Extract real URLs from annotations (url_citation type) in Responses API
  const urls = [];
  const seen = new Set();
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      // annotations array contains url_citation objects
      for (const ann of part.annotations || []) {
        if (ann.type === "url_citation" && ann.url && !seen.has(ann.url)) {
          seen.add(ann.url);
          urls.push(ann.url);
        }
      }
    }
  }
  return urls;
}

export function parseOpenAIResponse(data, endpoint = "responses") {
  const usage = data.usage || {};
  const inTok = usage.input_tokens || usage.prompt_tokens || 0;
  const outTok = usage.output_tokens || usage.completion_tokens || 0;

  let rawText = "";
  if (endpoint === "responses") {
    for (const item of data.output || []) {
      if (item.type !== "message") continue;
      for (const part of item.content || []) {
        if (part.type === "output_text") rawText += part.text;
      }
    }
  } else {
    rawText = data.choices?.[0]?.message?.content || "";
  }

  // Extract real URLs from annotations FIRST (before parsing JSON)
  const realUrls = extractOpenAIUrls(data);

  // Also extract URLs directly from the answer text (markdown links + plain URLs)
  const urlRe = /https?:\/\/[^\s\])"'>]+/g;
  const HALLUCINATION = [/exemple\d*\./i, /example\d*\./i, /site\d+\./i, /domaine\d*\./i, /placeholder/i, /turn\d+search/i];
  const textUrls = [...rawText.matchAll(urlRe)]
    .map(m => m[0].replace(/[.,;:)]+$/, "")) // strip trailing punctuation
    .filter(u => !HALLUCINATION.some(p => p.test(u)));

  // Merge: annotations first (most reliable), then text URLs
  const allUrls = [...new Set([...realUrls, ...textUrls])];

  // Try to parse JSON schema response
  let parsed = { answer: rawText, answer_type: "Texte libre", intent_type: "Informative", sources: [], source_types: [] };
  const s = rawText.lastIndexOf("{");
  const e = rawText.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      const jsonParsed = JSON.parse(rawText.substring(s, e + 1));
      if (jsonParsed.answer) {
        parsed = jsonParsed;
        // Replace turn0searchX sources with real URLs
        const fakeSources = (parsed.sources || []).filter(u => /turn\d+search/i.test(u) || !u.startsWith("http"));
        if (fakeSources.length > 0 || allUrls.length > 0) {
          parsed.sources = allUrls;
        }
      }
    } catch {}
  }

  // If answer is still the raw JSON text, extract readable answer
  if (parsed.answer && parsed.answer.startsWith("{")) {
    parsed.answer = rawText; // use raw text as answer
  }

  // Final URL dedup and hallucination filter
  parsed.sources = [...new Set(allUrls)].filter(u => !HALLUCINATION.some(p => p.test(u)));
  parsed._input_tokens = inTok;
  parsed._output_tokens = outTok;
  // Nb de recherches web réellement effectuées (Responses API) — pour les coûts réels.
  parsed._web_searches = endpoint === "responses"
    ? (data.output || []).filter(it => it.type === "web_search_call").length
    : 0;
  return parsed;
}

export function parseTextResponse(text, inTok, outTok, extraSources = []) {
  // Try to extract JSON if model returned it
  const s = text.lastIndexOf("{"); const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      const parsed = JSON.parse(text.substring(s, e + 1));
      if (parsed.answer) {
        parsed._input_tokens = inTok; parsed._output_tokens = outTok;
        // Extraire aussi les URLs citées dans le corps de la réponse (Claude cite inline)
        const urlReJson = /https?:\/\/[^\s\])"'>]+/g;
        const HALL = [/exemple\d*\./i, /example\d*\./i, /site\d+\./i, /domaine\d*\./i, /placeholder/i];
        const inlineUrls = [...String(parsed.answer).matchAll(urlReJson)].map(m => m[0]).filter(u => !HALL.some(p => p.test(u)));
        parsed.sources = [...new Set([...(parsed.sources || []), ...extraSources, ...inlineUrls])].filter(Boolean);
        return parsed;
      }
    } catch {}
  }
  // Fallback: treat entire text as answer, extract URLs
  const HALLUCINATION = [/exemple\d*\./i, /example\d*\./i, /site\d+\./i, /domaine\d*\./i, /placeholder/i];
  const urlRe = /https?:\/\/[^\s\])"'>]+/g;
  const foundUrls = [...text.matchAll(urlRe)].map(m => m[0]).filter(u => !HALLUCINATION.some(p => p.test(u)));
  const allSources = [...new Set([...foundUrls, ...extraSources])];
  return {
    answer: text, answer_type: "Texte libre", intent_type: "Informative",
    sources: allSources, source_types: [],
    _input_tokens: inTok, _output_tokens: outTok,
  };
}

// Désactivé DURABLEMENT seulement si l'API Responses / web_search est réellement
// indisponible pour ce compte (tier sans web_search). Un échec transitoire
// (429 / 5xx / réseau) ne désactive PAS : on retombe juste pour CET appel et on
// réessaie la recherche web à l'appel suivant — plus de perte silencieuse de session.
let openaiResponsesUnsupported = false;

export async function callProvider(provider, apiKey, prompt, maxTokens = 2000, base = "", webSearch = true) {
  if (provider.id === "openai") {
    // Tentative 1 : Responses API avec web_search (Tier 1+).
    if (webSearch && !openaiResponsesUnsupported) {
      try {
        const resA = await fetch(`${base}/api/openai`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Openai-Key": apiKey, "X-Openai-Endpoint": "responses" },
          body: JSON.stringify({
            model: provider.model,
            input: prompt,
            tools: [{ type: "web_search_preview", search_context_size: "high" }],
            max_output_tokens: Math.max(maxTokens * 4, 2000),
          }),
        });
        const rawA = await resA.text();
        if (resA.ok && !rawA.trimStart().startsWith("<")) {
          try { return parseOpenAIResponse(JSON.parse(rawA), "responses"); } catch { /* JSON illisible → repli ponctuel, sans désactiver */ }
        } else {
          // Distinguer "non supporté" (désactiver durablement) d'un échec transitoire.
          let errMsg = "";
          try { const eb = JSON.parse(rawA); errMsg = (eb?.error?.message || eb?.error || "").toString().toLowerCase(); } catch {}
          const unsupported = (resA.status === 400 || resA.status === 403 || resA.status === 404)
            && /web_search|tool|responses|not supported|unsupported|unknown|model/.test(errMsg);
          if (unsupported) openaiResponsesUnsupported = true;
          // sinon (429 / 5xx / message générique) : transitoire → repli pour cet appel, réessai au suivant.
        }
      } catch { /* erreur réseau : transitoire → repli pour cet appel, pas de désactivation durable */ }
    }

    // Tentative 2 : Chat Completions (toujours disponible).
    const res = await fetch(`${base}/api/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Openai-Key": apiKey, "X-Openai-Endpoint": "completions" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "system", content: "Tu es un expert en recommandation d'entreprises et prestataires. Réponds directement et factuellement." }, { role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: maxTokens,
      }),
    });
    const raw = await res.text();
    if (raw.trimStart().startsWith("<")) throw new Error("Proxy /api/openai introuvable (réponse HTML)");
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`Réponse OpenAI illisible (${res.status}) : ${raw.slice(0, 120)}`); }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || `OpenAI ${res.status}`;
      const hint = res.status === 429 ? " — quota dépassé, vérifiez votre plan/facturation OpenAI"
                 : res.status === 401 ? " — clé invalide"
                 : res.status >= 500 ? " — erreur serveur OpenAI, réessayez dans un instant" : "";
      throw new Error(msg + hint);
    }
    return parseOpenAIResponse(data, "completions");
  }

  if (provider.id === "gemini") {
    const res = await fetch(`${base}/api/gemini`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gemini-Key": apiKey },
      body: JSON.stringify({ model: provider.model, prompt }),
    });
    const raw = await res.text();
    if (raw.trimStart().startsWith("<")) throw new Error("Proxy /api/gemini introuvable (réponse HTML)");
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`Réponse Gemini illisible (${res.status}) : ${raw.slice(0, 120)}`); }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || `Gemini ${res.status}`;
      const hint = res.status === 429 ? " — quota Gemini dépassé. Activez la facturation sur le PROJET Google Cloud de la clé (AI Studio → Set up Billing → Tier 1). Compter 24-48 h après upgrade free→payant, et vérifier les limites RPM/RPD du modèle."
                 : (res.status === 401 || res.status === 403) ? " — clé Gemini invalide ou non autorisée"
                 : res.status === 404 ? " — modèle Gemini introuvable (peut-être retiré)"
                 : res.status >= 500 ? " — erreur serveur Gemini, réessayez dans un instant" : "";
      throw new Error(msg + hint);
    }
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("Réponse Gemini vide — vérifiez la clé API ou réessayez");
    const groundingSources = data._sources || []; // real URLs from Google Search
    const _g = parseTextResponse(text, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0, groundingSources);
    _g._web_searches = data._web_searches != null ? data._web_searches : (groundingSources.length ? 1 : 0);
    return _g;
  }

  if (provider.id === "perplexity") {
    const res = await fetch(`${base}/api/perplexity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Perplexity-Key": apiKey },
      body: JSON.stringify({ model: provider.model, prompt }),
    });
    const raw = await res.text();
    if (raw.trimStart().startsWith("<")) throw new Error("Proxy /api/perplexity introuvable");
    const data = JSON.parse(raw);
    if (!res.ok) throw new Error(data.error?.message || `Perplexity ${res.status}`);
    const text = data.choices?.[0]?.message?.content || "";
    // Perplexity returns citations separately
    const citations = data._citations || [];
    const _p = parseTextResponse(text, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0, citations); _p._web_searches = 1; return _p;
  }

  if (provider.id === "claude") {
    const res = await fetch(`${base}/api/claude-geo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-Key": apiKey },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4000,
        system: "Tu es un expert en recommandation d'entreprises et prestataires. Réponds directement sans mentionner les limites de tes connaissances.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const raw = await res.text();
    if (raw.trimStart().startsWith("<")) throw new Error("Proxy /api/claude-geo introuvable — ajoutez claude-geo-proxy.js dans netlify/edge-functions/");
    if (!res.ok) {
      let errMsg = `Claude ${res.status}`;
      try { errMsg = JSON.parse(raw)?.error?.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    const data = JSON.parse(raw);
    const text = data.content?.[0]?.text || "";
    if (!text) throw new Error("Réponse Claude vide — vérifiez la clé API");
    const _c = parseTextResponse(text, data.usage?.input_tokens || 0, data.usage?.output_tokens || 0); _c._web_searches = 0; return _c;
  }

  throw new Error(`Provider inconnu: ${provider.id}`);
}

export function detectBrand(answer, sources, brandName, brandAliases = [], competitors = []) {
  // Normalisation casse + accents : « ÉLÉAS » et « Eleas » doivent matcher.
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  const lines = (answer || "").split("\n");
  // Pattern d'item de top : "1. Titre", "2) Titre", "• 3. Titre"
  const topItemRe = /^\s*(?:[•\-*]\s*)?(\d+)[.)]\s*(.+)/;

  // ── Reconstruction des séquences de liste classées (fiabilité du "Top") ──
  // On ne se fie PAS au numéro littéral écrit par le LLM (sous-listes, redémarrages…).
  // On prend la position ORDINALE réelle dans la séquence contiguë la plus longue.
  const subBulletRe = /^\s*[•\-*]\s+\S/;
  // Item de top "en-tête" SANS numéro : lien markdown (option. gras) ou titre gras / heading.
  // Couvre le format type "[Nom](url)", "**[Nom](url)**", "**Nom**", "### Nom".
  const headingLinkRe = /^\s*(?:[•\-*]\s*)?\*{0,2}\[([^\]]{2,90})\]\([^)]*\)\*{0,2}\s*(?:[—:-].*)?$/;
  const headingBoldRe = /^\s*(?:#{1,4}\s*)?\*\*([^*\n]{2,90})\*\*\s*:?\s*$/;
  const headingPlainRe = /^\s*#{1,4}\s*([^\n]{2,90})$/;
  const matchHeading = (s) => {
    const lvl = (s.match(/^\s*(#{1,4})/)?.[1] || "").length;
    let m = s.match(headingLinkRe); if (m) return { title: m[1].replace(/\*/g, "").trim(), level: lvl };
    m = s.match(headingBoldRe);    if (m) return { title: m[1].trim(), level: lvl };
    m = s.match(headingPlainRe);   if (m) return { title: m[1].replace(/[[\]]|\(.*\)/g, "").replace(/\*/g, "").trim(), level: lvl };
    return null;
  };
  const isDetailLine = (s) => {
    const t = s.trim();
    if (!t) return true;
    if (subBulletRe.test(t) && !topItemRe.test(t)) return true;
    if (/^\s{2,}\S/.test(s)) return true;
    if (/^[A-Za-zÀ-ÿ' ]{2,20}\s*:/.test(t) && t.length < 80) return true;
    if (/^_.*_$/.test(t)) return true; // ligne en italique (ex. "_Le Mans, France_")
    return false;
  };
  const sequences = [];
  let current = null, prevNum = null, seqType = null, prevLevel = null; // seqType: "num" | "head" | null
  for (const raw of lines) {
    const m = raw.match(topItemRe);
    if (m) {
      const num = parseInt(m[1], 10);
      const continues = current && seqType === "num" && prevNum != null && (num === prevNum + 1 || num === prevNum);
      if (!continues) { current = []; sequences.push(current); seqType = "num"; }
      current.push({ num, text: m[2], ordinal: current.length + 1 });
      prevNum = num;
      continue;
    }
    const head = matchHeading(raw);
    if (head) {
      // Segmentation par NIVEAU : les H2 (titres de section) ne se mélangent pas avec
      // les H3 (souvent les marques classées). Un changement de niveau ouvre une nouvelle
      // séquence, pour que les marques en H3 soient classées entre elles et comptées
      // comme des mentions même quand les H2 ne sont pas des marques.
      const continues = current && seqType === "head" && prevLevel === head.level;
      if (!continues) { current = []; sequences.push(current); seqType = "head"; prevNum = null; }
      current.push({ num: null, text: head.title, ordinal: current.length + 1, level: head.level });
      prevLevel = head.level;
      continue;
    }
    if (isDetailLine(raw)) continue;
    // En mode "en-têtes", la prose entre items (localisation, description) ne casse PAS
    // la séquence : seuls les en-têtes ajoutent des items, le reste est ignoré.
    if (seqType === "head") continue;
    // Sinon (liste numérotée ou hors séquence), une ligne de prose termine la séquence.
    current = null; prevNum = null; seqType = null; prevLevel = null;
  }
  // La (les) vraie(s) liste(s) classée(s) = séquences d'au moins 2 items, plus longue d'abord.
  const ranked = sequences.filter(s => s.length >= 2).sort((a, b) => b.length - a.length);
  // On cherche d'abord dans les listes classées (positions fiables), puis en repli dans
  // les items isolés (ex. une marque seule sous une catégorie) pour ne rien manquer.
  const searchSeqs = ranked.length ? [...ranked, ...sequences.filter(s => s.length < 2)] : sequences;

  // Lignes narratives (hors items de top et hors métadonnées) — pour l'évocation.
  const narrativeLines = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (topItemRe.test(line)) continue;
    if (
      stripped.startsWith("http") || stripped.startsWith("[") ||
      stripped.startsWith("- Site") || stripped.startsWith("- Description") ||
      stripped.startsWith("Source") || stripped.match(/^\d+\.\s*https?:/)
    ) continue;
    narrativeLines.push(stripped);
  }

  // Sources = sources fournies + URLs extraites du texte.
  const urlRe = /https?:\/\/[^\s),'"\]]+/g;
  const textUrls = [...(answer || "").matchAll(urlRe)].map(m => m[0].replace(/[.,;:]+$/, ""));
  const allSources = [...new Set([...(Array.isArray(sources) ? sources : []), ...textUrls])];
  const normSources = allSources.map(s => norm(s).replace(/^www\./, "").replace(/https?:\/\//, ""));

  // ── MOTEUR UNIQUE de détection M/É/C pour une entité (marque OU concurrent) ──
  // terms : liste de noms/alias normalisés à chercher.
  // Renvoie { mentionPosition, evocationPosition, citationPosition }.
  function detectEntity(terms) {
    const T = terms.filter(Boolean);
    if (!T.length) return { mentionPosition: null, evocationPosition: null, citationPosition: null };
    // Match sur LIMITES DE MOTS pour éviter les faux positifs par sous-chaîne
    // (ex. « Eleas » ne doit pas matcher « Eleastic »). Insensible casse+accents.
    // Une frontière = début/fin de chaîne ou caractère non alphanumérique.
    const wordHit = (haystack, term) => {
      if (!term) return false;
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // \p{L}\p{N} = lettre/chiffre Unicode ; frontière manuelle car \b est ASCII-only
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "u");
      return re.test(haystack);
    };
    const hit = (text) => { const t = norm(text); return T.some(term => wordHit(t, term)); };

    // MENTION — position ordinale réelle dans la 1ère séquence où l'entité apparaît.
    let mentionPosition = null;
    for (const seq of searchSeqs) {
      for (const item of seq) {
        if (hit(item.text)) { mentionPosition = item.ordinal; break; }
      }
      if (mentionPosition !== null) break;
    }

    // ÉVOCATION — 1ère ligne narrative qui cite l'entité (rang dans le récit).
    let evocationPosition = null;
    let narrativeCount = 0;
    for (const nl of narrativeLines) {
      narrativeCount++;
      if (hit(nl) && evocationPosition === null) { evocationPosition = narrativeCount; break; }
    }

    // CITATION — 1ère source où le nom apparaît comme SEGMENT délimité de l'URL
    // (entre début/fin, /, ., -, _). Évite les faux positifs (« aw » ∈ « lawfirm »).
    let citationPosition = null;
    const domainTerms = T.map(t => t.replace(/\s+/g, "")).filter(Boolean);
    const segHit = (url, term) => {
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(url);
    };
    for (let i = 0; i < normSources.length; i++) {
      if (domainTerms.some(d => segHit(normSources[i], d))) { citationPosition = i + 1; break; }
    }

    return { mentionPosition, evocationPosition, citationPosition };
  }

  // ── MARQUE ──
  const brandTerms = [brandName, ...brandAliases].filter(Boolean).map(norm);
  const b = detectEntity(brandTerms);
  const mentionPosition = b.mentionPosition;
  const evocationPosition = b.evocationPosition;
  const citationPosition = b.citationPosition;

  // ── CONCURRENTS — MÊME moteur fiable, avec positions M/É/C ──
  const allCompetitorNames = competitors.filter(Boolean).map(c => (typeof c === "string" ? c : c.name)).filter(Boolean);
  const competitorsMentioned = allCompetitorNames
    .map(name => {
      const d = detectEntity([norm(name)]);
      const mentioned = d.mentionPosition !== null || d.evocationPosition !== null;
      return {
        name,
        mentioned,
        // position = position de MENTION (top). null si pas dans un top classé.
        position: d.mentionPosition,
        mention_position:   d.mentionPosition,
        evocation_position: d.evocationPosition,
        citation_position:  d.citationPosition,
        in_sources: d.citationPosition !== null,
      };
    })
    .filter(c => c.mentioned || c.in_sources);

  // ── Autres entités présentes dans les tops (à identifier) ──
  // On parcourt TOUTES les séquences classées (pas seulement la plus longue) et on
  // calcule pour chaque entité inconnue son triplet M/É/C via le même moteur fiable,
  // afin qu'elles apparaissent correctement dans Top mentions / évocations / citations.
  const knownTerms = [brandName, ...(brandAliases || []), ...allCompetitorNames].map(norm).filter(Boolean);
  const seenUnknown = new Set();
  const unknownEntities = [];
  for (const seq of (ranked.length ? ranked : sequences)) {
    for (const item of seq) {
      const txt = (item.text || "").trim();
      if (!txt) continue;
      let nameRaw = txt.split(/[:–\-(]/)[0].trim().replace(/\*\*/g, "").replace(/[.,;]+$/, "").trim();
      if (nameRaw.length < 2 || nameRaw.length > 40 || nameRaw.split(/\s+/).length > 5) continue;
      const low = norm(nameRaw);
      if (!low) continue;
      if (knownTerms.some(t => low.includes(t) || t.includes(low))) continue; // marque/concurrent connu
      if (seenUnknown.has(low)) continue;
      seenUnknown.add(low);
      const d = detectEntity([low]);
      unknownEntities.push({
        name: nameRaw,
        position: d.mentionPosition != null ? d.mentionPosition : item.ordinal,
        mention_position:   d.mentionPosition,
        evocation_position: d.evocationPosition,
        citation_position:  d.citationPosition,
        in_sources: d.citationPosition !== null,
      });
    }
  }

  return {
    // Champs structurés
    mention:   { present: mentionPosition !== null,   position: mentionPosition },
    evocation: { present: evocationPosition !== null, position: evocationPosition },
    citation:  { present: citationPosition !== null,  position: citationPosition },

    // Rétrocompat — champs utilisés par le reste de l'app
    brandMentioned:       mentionPosition !== null || evocationPosition !== null,
    brandPosition:        mentionPosition,
    brandInSources:       citationPosition !== null,
    competitorsMentioned,
    unknownEntities,
  };
}

// ── Présence calendrier (type + position) — MÊME logique que l'onglet Questions ──
// Détermine ce qu'affiche le carré de suivi : « mention » porte la position (numéro),
// sinon « evocation » / « citation ». Source unique partagée front + scheduler.
// Priorité IDENTIQUE au manuel : mention > évocation > citation.
export function calendarPresence(detected) {
  const mentionPos = detected?.mention?.position || null;
  const presType = mentionPos != null ? "mention"
    : detected?.brandMentioned ? "evocation"
    : detected?.brandInSources ? "citation"
    : null;
  return { presType, mentionPos };
}

// ── Recherche web activée pour ce provider ? — logique partagée (front + scheduler + UI) ──
// settings = projects.provider_web_search, ex. {"openai": false}.
//  • OpenAI : optionnel, activé par défaut (désactivé si explicitement false).
//  • Gemini / Perplexity : toujours (ancrage Google / Sonar intégrés).
//  • Claude : jamais à l'interrogation.
export function webSearchEnabled(providerId, settings) {
  if (providerId === "gemini" || providerId === "perplexity") return true;
  if (providerId === "claude") return false;
  return !(settings && settings[providerId] === false);
}