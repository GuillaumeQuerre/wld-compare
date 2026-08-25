// netlify/edge-functions/gemini-proxy.js
export default async function handler(request, context) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = request.headers.get("X-Gemini-Key") || "";
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Clé Gemini manquante dans X-Gemini-Key" }), {
      status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    let { model = "gemini-3.5-flash", prompt } = await request.json();
    const SAFE_MODEL = "gemini-3.5-flash"; // modèle courant, compatible grounding
    // Remappe tout modèle Gemini périmé (1.x / 2.x) vers le modèle courant : les
    // anciens projets ont encore "gemini-2.x" enregistré → évite l'erreur "no longer available".
    if (/^(models\/)?gemini-(1|2)\./.test(model)) model = SAFE_MODEL;
    const SYSTEM = "Tu es un expert en recommandation d'entreprises et prestataires. Réponds directement et factuellement, sans mentionner les limites de tes connaissances.";

    const callGemini = async (m, useSearch) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
      const body = {
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 16384 },
      };
      if (useSearch) body.tools = [{ google_search: {} }]; // Google Search grounding — temps réel
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await upstream.json(); } catch { data = {}; }
      return { ok: upstream.ok, status: upstream.status, data };
    };

    // Repli en cascade (inspiré d'OpenAI : on tente le mieux, puis on dégrade proprement) :
    //   1. modèle demandé + grounding
    //   2. modèle courant sûr + grounding (si le modèle demandé est retiré)
    //   3. modèle courant sûr SANS grounding (si l'outil de recherche échoue)
    const models = model === SAFE_MODEL ? [SAFE_MODEL] : [model, SAFE_MODEL];
    const attempts = models.map(m => ({ model: m, search: true }));
    attempts.push({ model: SAFE_MODEL, search: false });

    let result = null, grounded = true, lastStatus = 0, lastErr = "", lastData = null;
    const triedConfigs = new Set();
    for (const a of attempts) {
      // On ne rejoue jamais une config STRICTEMENT identique (même modèle + même grounding).
      // En revanche, sur un 429 on tente quand même le MÊME modèle sans grounding : la
      // recherche Google (grounding) a son PROPRE quota, distinct de celui du modèle.
      const key = `${a.model}:${a.search}`;
      if (triedConfigs.has(key)) continue;
      triedConfigs.add(key);
      const r = await callGemini(a.model, a.search);
      if (r.ok) {
        // 200 mais candidat SANS texte (fréquent quand le grounding ne renvoie que
        // des métadonnées) → on ne s'arrête pas, on tente la config suivante
        // (typiquement le même modèle sans grounding).
        const txt = r.data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join("") || "";
        if (txt) { result = r.data; grounded = a.search; break; }
        const fr = r.data?.candidates?.[0]?.finishReason || "?";
        const np = (r.data?.candidates?.[0]?.content?.parts || []).length;
        lastStatus = 200; lastErr = `réponse vide · finishReason=${fr} · parts=${np} · modèle=${a.model} · search=${a.search}`; lastData = r.data;
        continue;
      }
      lastStatus = r.status;
      lastErr = r.data?.error?.message || "";
      lastData = r.data;
      // Clé invalide / non autorisée : inutile d'insister avec les replis.
      if (r.status === 401 || r.status === 403) break;
    }

    if (!result) {
      // Diagnostic : extraire le métrique de quota (révèle free-tier vs payant).
      let quotaInfo = "";
      try {
        const details = lastData?.error?.details || [];
        const qf = details.find((d) => (d["@type"] || "").includes("QuotaFailure"));
        const v = qf?.violations?.[0];
        const id = v?.quotaId || v?.quotaMetric || "";
        if (id) quotaInfo = ` [quota: ${id}]`;
      } catch { /* noop */ }
      return new Response(JSON.stringify({ error: (lastErr || `Gemini HTTP ${lastStatus}`) + quotaInfo }), {
        status: lastStatus || 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Texte (potentiellement en plusieurs parts)
    const text = result?.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      ?.map(p => p.text)
      ?.join("") || "";

    // Sources de grounding (Google Search)
    const groundingChunks = result?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks.map(c => c?.web?.uri).filter(Boolean);

    const inTok = result?.usageMetadata?.promptTokenCount || 0;
    const outTok = result?.usageMetadata?.candidatesTokenCount || 0;

    return new Response(JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: inTok, completion_tokens: outTok },
      _sources: sources,                       // URLs réelles issues de Google Search
      _web_searches: grounded && sources.length ? 1 : 0,
      _raw: result,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Gemini proxy error: " + err.message }), {
      status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

export const config = { path: "/api/gemini" };