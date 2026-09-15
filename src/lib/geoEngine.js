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
  if (m.includes("ai overview") || m.includes("aioverview") || m.includes("apercu ia") || m.includes("aperçu ia")) return "aio";
  return "other";
}

function extractOpenAIUrls(data) {
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

function parseOpenAIResponse(data, endpoint = "responses") {
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

function parseTextResponse(text, inTok, outTok, extraSources = []) {
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
    if (!text) {
      const diag = typeof data.error === "string" ? data.error : (data?.error?.message || "");
      throw new Error(diag ? `Gemini vide — ${diag}` : "Réponse Gemini vide — vérifiez la clé API ou réessayez");
    }
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

// ════════════════════════════════════════════════════════════════════
// DÉTECTION DES PRÉSENCES — qualification PAR OCCURRENCE
//
// Refonte : on ne reconstruit plus une « séquence globale » de la réponse.
// Chaque LIGNE est qualifiée par sa MISE EN FORME — titre numéroté, titre (#),
// amorce en gras, ligne-lien, puce, prose — et la position d'une entité est son
// rang PARMI LES LIGNES DE MÊME FORME (et de même niveau d'imbrication).
//   • forme structurée (numéroté / titre / gras / lien / puce) ⇒ MENTION
//   • prose (et lignes de détail imbriquées)                   ⇒ ÉVOCATION
//
// Deux conséquences voulues :
//  • un top en gras (Gemini/Perplexity) n'est plus décalé par les titres (#)
//    ou les puces qui l'entourent : chaque forme se classe séparément, et un
//    changement de forme ne « redémarre » plus le classement à 1 ;
//  • les lignes de MÉTADONNÉES répétitives des fiches type Google Business
//    (« **Fermé · Ouvre à 09:00 · 4,6 (131 avis)** », « Site web : … »,
//    téléphones, adresses, horaires) sont écartées : elles avaient la forme
//    d'un item en gras et décalaient tous les rangs d'un cran par fiche.
// ════════════════════════════════════════════════════════════════════
export function detectBrand(answer, sources, brandName, brandAliases = [], competitors = []) {
  // Normalisation casse + accents : « ÉLÉAS » et « Eleas » doivent matcher.
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

  // Noms connus (marque + alias + concurrents configures) : un en-tete qui correspond
  // a une entite mesuree ne doit JAMAIS etre ecarte par le filtre "titre de section"
  // ni par le filtre "metadonnees repetitives".
  const knownEntityTerms = [brandName, ...(brandAliases || []),
    ...(competitors || []).filter(Boolean).map(c => (typeof c === "string" ? c : c && c.name))]
    .filter(Boolean).map(norm).filter(t => t.length >= 3);

  // Les titres peuvent être des LIENS markdown : "**[Linconyl Angers : …](url)**".
  // On travaille sur la version « sans lien » pour l'analyse textuelle, tout en
  // gardant la ligne brute pour reconnaître la forme « ligne-lien ».
  const MD_LINK_RE = /\[([^\]]+)\]\((?:[^)]*)\)/g;
  const stripLinks = (s) => String(s || "").replace(MD_LINK_RE, "$1");
  const rawLines = String(answer || "").split("\n");

  // ── Formes reconnues (une regex par forme) ──
  const topItemRe      = /^\s*(?:[•\-*]\s*)?(\d+)[.)]\s*(.+)/;                                        // "1. Titre" / "2) Titre"
  const headingPlainRe = /^\s*#{1,4}\s*([^\n]{2,90})$/;                                               // "### Titre"
  const headingBoldRe  = /^\s*#{1,4}\s*\*\*([^*\n]{2,90})\*\*\s*:?\s*$/;                              // "### **Titre**"
  const boldLeadRe     = /^\s*(?:[•\-*]\s+)?\*\*\s*(?:(\d+)[.)]\s*)?([^*\n]{2,80}?)\s*\*\*\s*(?:[:：—–-].*)?$/; // "**Marque** : …"
  const linkLineRe     = /^\s*(?:[•\-*]\s*)?\[([^\]]{2,90})\]\([^)]*\)\s*(?:[—–:-].*)?$/;             // "[Marque](url) — …"
  const bulletRe       = /^[•\-*]\s+(.{2,80})$/;                                                      // "- Marque" (colonne 0)

  // Un titre de SECTION n'est pas une entité classée : l'inclure décalait le rang
  // (ex. "Comment choisir" + "Les criteres" avant les marques => 3e affiche #5).
  const sectionTitleRe = /^(comment|pourquoi|quel|quelle|quels|quelles|quand|combien|conclusion|en resume|en bref|faq|foire aux questions|sommaire|introduction|methodologie|notre methode|criteres|les criteres|a retenir|pour aller plus loin|sources|references|avant de choisir|notre selection|notre avis)\b/;
  const isKnownEntity = (title) => { const t = norm(title); return knownEntityTerms.some(k => t.includes(k)); };
  const isSectionTitle = (title) => { const t = norm(title); return (t.endsWith("?") || sectionTitleRe.test(t)) && !isKnownEntity(title); };

  // ── MÉTADONNÉES : jamais classées, jamais narratives ──
  // Les fiches locales (AI Overviews / Gemini / Perplexity) répètent, sous chaque
  // établissement, un bloc « Fermé · Ouvre à 09:00 · 4,6 (131 avis) », un numéro,
  // une adresse, des horaires. Ces lignes ont la forme d'items (gras, puce) et
  // faussaient à la fois le comptage des rangs et la détection d'évocation.
  const META_FRAGMENT_RES = [
    /^(?:ferme|fermee|fermes|ouvert|ouverte|ouvre|closed|open|opens|closes)\b/,        // statut d'ouverture
    /\b\d+[.,]\d+\s*\(\s*[\d\s.,]+\s*(?:avis|reviews?|notes?)\s*\)/,       // "4,6 (131 avis)"
    /^\d+[.,]\d+\s*(?:\/\s*5)?$/,                                                      // "4,6" / "4,6/5"
    /^[\d\s.,]+\s*(?:avis|reviews?|notes?)$/,                              // "131 avis"
    /^(?:site(?:\s*(?:web|internet))?|website|adresse|address|itineraire|directions|appeler|tel|telephone|phone|mobile|fax|email|e-mail|mail|horaires?|ouverture|prix|tarifs?|note|avis|rating|source|description|categorie|type|reserver|commander)\s*[:：]/,
    /^\+?\d[\d\s().-]{7,}$/,                                               // numéro de téléphone seul
    /^https?:\/\//,
    /^\d{1,4}(?:\s*(?:bis|ter))?\s+(?:rue|av|ave|avenue|bd|boulevard|place|chemin|route|impasse|allee|quai|cours|square|zone|za|zi)\b/, // adresse postale
    /^\d{5}\s+\S/,                                                                      // code postal + ville
    /^(?:lun|mar|mer|jeu|ven|sam|dim|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/,
    /^(?:\d{1,2}\s*[h:]\s*\d{0,2})(?:\s*[–—-]\s*\d{1,2}\s*[h:]\s*\d{0,2})?$/,           // "09:00 – 18:00"
  ];
  const isMetaFragment = (t) => !!t && META_FRAGMENT_RES.some(re => re.test(t));
  // Ligne de métadonnées = la ligne entière est un fragment meta, OU elle est faite
  // exclusivement de fragments meta séparés par « · » / « | » / « • ».
  const isMetaLine = (text) => {
    const t = norm(String(text).replace(/\*+/g, "").replace(/^\s*[•\-*]\s+/, ""));
    if (!t) return false;
    if (isMetaFragment(t)) return true;
    const parts = t.split(/\s*[·•|]\s*/).map(p => p.trim()).filter(Boolean);
    return parts.length >= 2 && parts.every(isMetaFragment);
  };

  // Répétition : même « squelette » (chiffres neutralisés) vu 3 fois ou plus dans la
  // réponse ⇒ gabarit de métadonnées, même s'il n'est pas dans la liste ci-dessus.
  const metaSignature = (t) => norm(String(t).replace(/\*+/g, "")).replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const sigCount = new Map();
  for (const raw of rawLines) {
    const sig = metaSignature(stripLinks(raw).trim());
    if (sig) sigCount.set(sig, (sigCount.get(sig) || 0) + 1);
  }
  const isRepetitiveMeta = (text) => {
    const sig = metaSignature(text);
    if (!sig || (sigCount.get(sig) || 0) < 3) return false;
    if (isKnownEntity(text)) return false;
    // Un gabarit de métadonnées porte PLUSIEURS valeurs variables (note, horaire,
    // compteur d'avis) ou des champs séparés — pas un simple nom répété qui
    // contiendrait un chiffre (« Studio 54 », « Groupe 3F »).
    const parts = sig.split(/\s*[·•|]\s*/).filter(Boolean).length;
    const digitGroups = (sig.match(/#/g) || []).length;
    return parts >= 2 || (digitGroups >= 2 && sig.length >= 12);
  };

  // ── PASSE UNIQUE : qualification de chaque ligne par sa forme ──
  // items  : toutes les lignes retenues, dans l'ordre du document.
  // buckets: un classement PAR FORME (et par niveau) — c'est lui qui donne le rang.
  const items = [];
  const buckets = new Map();
  const push = (form, bucket, text, lineIndex) => {
    let arr = buckets.get(bucket);
    if (!arr) { arr = []; buckets.set(bucket, arr); }
    const item = { form, bucket, text, lineIndex, ordinal: arr.length + 1 };
    arr.push(item);
    items.push(item);
  };

  rawLines.forEach((raw, lineIndex) => {
    const plain = stripLinks(raw);
    const trimmed = plain.trim();
    if (!trimmed) return;
    // Métadonnées : écartées du classement ET du récit.
    if (isMetaLine(trimmed) || isRepetitiveMeta(trimmed)) return;

    // Niveau d'imbrication : une sous-liste ne se classe pas avec la liste mère.
    const indent = (plain.match(/^[ \t]*/)?.[0] || "").replace(/\t/g, "  ").length;
    const nested = indent >= 2;

    // 1. Titre NUMÉROTÉ — classement explicite du modèle, valable même imbriqué.
    const num = plain.match(topItemRe);
    if (num) { push("numbered", `numbered@${Math.min(Math.floor(indent / 2), 3)}`, num[2].trim(), lineIndex); return; }

    // Au-delà du premier niveau, seules les listes numérotées restent des rangs :
    // gras/lien/puce imbriqués sont des détails de fiche ⇒ prose (évocation).
    if (!nested) {
      // 2. TITRE markdown (#) — un classement par niveau de titre (H2 ≠ H3).
      const level = (plain.match(/^(#{1,4})\s/)?.[1] || "").length;
      if (level) {
        const h = plain.match(headingBoldRe) || plain.match(headingPlainRe);
        if (h) {
          const title = h[1].replace(/[*[\]]/g, "").trim();
          if (isSectionTitle(title)) return;
          push("heading", `heading@${level}`, title, lineIndex); return;
        }
      }

      // 3. Amorce en GRAS — "**Marque** : …", "* **Marque** — …", "**2. Marque**".
      const bold = plain.match(boldLeadRe);
      if (bold) {
        const title = bold[2].trim();
        if (isSectionTitle(title)) return;
        push("bold", "bold@0", title, lineIndex); return;
      }

      // 4. LIGNE-LIEN — "[Marque](url)" seule sur sa ligne (fréquent en AI Overviews).
      const link = raw.match(linkLineRe);
      if (link) {
        const title = link[1].replace(/\*/g, "").trim();
        if (isSectionTitle(title)) return;
        push("link", "link@0", title, lineIndex); return;
      }

      // 5. PUCE simple en colonne 0 — un top peut être présenté ainsi.
      const bul = plain.match(bulletRe);
      if (bul) {
        const title = bul[1].trim();
        if (isSectionTitle(title)) return;
        push("bullet", "bullet@0", title, lineIndex); return;
      }
    }

    // 6. Tout le reste = PROSE (récit, descriptions, lignes de détail imbriquées).
    //    Une occurrence ici ne vaut jamais mention : c'est une ÉVOCATION.
    push("prose", "prose", trimmed, lineIndex);
  });

  // Formes structurées réellement « classantes » : celles qui contiennent au moins
  // deux items. Un item isolé reste exploitable (repli) mais ne fabrique pas un top.
  const rankedBuckets = new Set([...buckets.entries()].filter(([k, v]) => k !== "prose" && v.length >= 2).map(([k]) => k));

  // Sources = sources fournies + URLs extraites du texte.
  const urlRe = /https?:\/\/[^\s),'"\]]+/g;
  const textUrls = [...String(answer || "").matchAll(urlRe)].map(m => m[0].replace(/[.,;:]+$/, ""));
  const allSources = [...new Set([...(Array.isArray(sources) ? sources : []), ...textUrls])];
  const normSources = allSources.map(s => norm(s).replace(/^www\./, "").replace(/https?:\/\//, ""));

  // ── MOTEUR UNIQUE de détection M/É/C pour une entité (marque OU concurrent) ──
  // terms : liste de noms/alias normalisés à chercher.
  // Renvoie { mentionPosition, mentionForm, evocationPosition, citationPosition }.
  function detectEntity(terms) {
    const T = terms.filter(Boolean);
    if (!T.length) return { mentionPosition: null, mentionForm: null, evocationPosition: null, citationPosition: null };
    // Match sur LIMITES DE MOTS pour éviter les faux positifs par sous-chaîne
    // (ex. « Eleas » ne doit pas matcher « Eleastic »). Insensible casse+accents.
    const wordHit = (haystack, term) => {
      if (!term) return false;
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // \p{L}\p{N} = lettre/chiffre Unicode ; frontière manuelle car \b est ASCII-only
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "u");
      return re.test(haystack);
    };
    const hit = (text) => { const t = norm(text); return T.some(term => wordHit(t, term)); };

    // Première occurrence STRUCTURÉE (⇒ mention) et première occurrence en PROSE
    // (⇒ évocation), dans l'ordre du document. La position est le rang de l'item
    // DANS SON PROPRE CLASSEMENT (lignes de même forme et même niveau).
    let mention = null, fallbackMention = null, evocation = null;
    for (const it of items) {
      if (!hit(it.text)) continue;
      if (it.form === "prose") { if (!evocation) evocation = it; continue; }
      if (rankedBuckets.has(it.bucket)) { if (!mention) mention = it; }
      else if (!fallbackMention) fallbackMention = it;
      if (mention && evocation) break;
    }
    // Repli : entité seule sous sa forme (ex. une marque isolée sous une catégorie).
    if (!mention) mention = fallbackMention;

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

    return {
      mentionPosition:   mention ? mention.ordinal : null,
      mentionForm:       mention ? mention.form : null,
      evocationPosition: evocation ? evocation.ordinal : null,
      citationPosition,
    };
  }

  // ── MARQUE ──
  // Un nom de marque saisi sous forme de domaine (« Albus.fr », « sofia.dev »)
  // ne matchait pas la marque citée sans extension (« Albus ») : la mention
  // n'était pas relevée du tout. On ajoute donc la racine comme alias implicite.
  const stripTld = (n) => {
    const m = String(n || "").trim().match(/^(.+?)\.(fr|com|net|org|io|dev|eu|be|ch|ca|co|app|ai|fr\.net)$/i);
    return m ? m[1] : null;
  };
  const _implicit = [brandName, ...brandAliases].map(stripTld).filter(Boolean);
  const brandTerms = [...new Set([brandName, ...brandAliases, ..._implicit].filter(Boolean).map(norm))];
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
        mention_form:       d.mentionForm,
        evocation_position: d.evocationPosition,
        citation_position:  d.citationPosition,
        in_sources: d.citationPosition !== null,
      };
    })
    .filter(c => c.mentioned || c.in_sources);

  // ── Autres entités présentes dans les tops (à identifier) ──
  // On parcourt tous les items STRUCTURÉS (toutes formes confondues) et on calcule
  // pour chaque entité inconnue son triplet M/É/C via le même moteur fiable.
  const knownTerms = [brandName, ...(brandAliases || []), ...allCompetitorNames].map(norm).filter(Boolean);
  const seenUnknown = new Set();
  const unknownEntities = [];
  // Une puce descriptive ("Un artisan local", "Devis gratuit") a la même forme
  // qu'un item de top : on écarte les amorces qui ne peuvent pas ouvrir un nom
  // d'entreprise. « Le / La / Les / De » restent admis (La Poste, Le Bon Coin…).
  const notAnEntityRe = /^(?:un|une|des|du|ce|cet|cette|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leur|leurs|je|tu|il|elle|on|nous|vous|ils|elles|et|ou|mais|donc|car|si|pour|par|avec|sans|sur|sous|dans|chez|vers|entre|plus|moins|tres|aussi|egalement|environ|selon|idem|devis|tarif|tarifs|prix|note|avis|contact|horaire|horaires|adresse|disponible|disponibilite|intervention|interventions|garantie|delai|delais|paiement|livraison)\s+\S/;
  const structured = items.filter(it => it.form !== "prose");
  const scanned = structured.some(it => rankedBuckets.has(it.bucket))
    ? structured.filter(it => rankedBuckets.has(it.bucket))
    : structured;
  for (const item of scanned) {
    const txt = (item.text || "").trim();
    if (!txt) continue;
    let nameRaw = txt.split(/[:–\-(]/)[0].trim().replace(/\*\*/g, "").replace(/[.,;]+$/, "").trim();
    if (nameRaw.length < 2 || nameRaw.length > 40 || nameRaw.split(/\s+/).length > 5) continue;
    const low = norm(nameRaw);
    if (!low) continue;
    if (notAnEntityRe.test(low)) continue; // puce descriptive, pas une entité
    if (knownTerms.some(t => low.includes(t) || t.includes(low))) continue; // marque/concurrent connu
    if (seenUnknown.has(low)) continue;
    seenUnknown.add(low);
    const d = detectEntity([low]);
    unknownEntities.push({
      name: nameRaw,
      position: d.mentionPosition != null ? d.mentionPosition : item.ordinal,
      mention_position:   d.mentionPosition,
      mention_form:       d.mentionForm,
      evocation_position: d.evocationPosition,
      citation_position:  d.citationPosition,
      in_sources: d.citationPosition !== null,
    });
  }

  return {
    // Champs structurés
    mention:   { present: mentionPosition !== null,   position: mentionPosition, form: b.mentionForm },
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