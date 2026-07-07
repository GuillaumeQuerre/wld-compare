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
    const { model = "gemini-2.5-flash", prompt } = await request.json();
    const SAFE_MODEL = "gemini-2.5-flash"; // modèle courant, compatible grounding
    const SYSTEM = "Tu es un expert en recommandation d'entreprises et prestataires. Réponds directement et factuellement, sans mentionner les limites de tes connaissances.";

    const callGemini = async (m, useSearch) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
      const body = {
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
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

    let result = null, grounded = true, lastStatus = 0, lastErr = "";
    const triedModels = new Set();
    for (const a of attempts) {
      // Sur quota (429), rejouer le MÊME modèle ne ferait qu'aggraver la consommation :
      // on ne retente qu'un modèle différent (quotas séparés par modèle).
      if (lastStatus === 429 && triedModels.has(a.model)) continue;
      triedModels.add(a.model);
      const r = await callGemini(a.model, a.search);
      if (r.ok) { result = r.data; grounded = a.search; break; }
      lastStatus = r.status;
      lastErr = r.data?.error?.message || "";
      // Clé invalide / non autorisée : inutile d'insister avec les replis.
      if (r.status === 401 || r.status === 403) break;
    }

    if (!result) {
      return new Response(JSON.stringify({ error: lastErr || `Gemini HTTP ${lastStatus}` }), {
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