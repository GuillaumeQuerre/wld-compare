// netlify/edge-functions/supabase-proxy.js
export default async function(request) {
  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")  || "";
  const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON") || "";

  const authHeader = request.headers.get("authorization") || "";
  let userToken = null;
  if (authHeader.startsWith("Bearer ")) {
    userToken = authHeader.slice(7);
    if (!userToken) return new Response("Token invalide", { status: 401 });
  }

  const url = new URL(request.url);
  const supaPath  = url.pathname.replace("/api/supabase", "");
  // Seules les API données (REST) et fichiers (Storage) sont relayées.
  // L'authentification passe exclusivement par /api/auth (auth-proxy),
  // sinon /auth/v1/signup ou /auth/v1/token contourneraient la vérification d'email.
  if (!/^\/(rest|storage)\/v1\//.test(supaPath) || supaPath.includes("..")) {
    return new Response(JSON.stringify({ error: "Chemin non autorisé" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }
  const targetUrl = SUPABASE_URL + supaPath + url.search;

  // Build clean headers — only pass what Supabase needs
  const cleanHeaders = new Headers();
  cleanHeaders.set("apikey", SUPABASE_ANON);
  cleanHeaders.set("Authorization", userToken ? `Bearer ${userToken}` : `Bearer ${SUPABASE_ANON}`);

  // Pass content-type for POST/PATCH
  const ct = request.headers.get("content-type");
  if (ct) cleanHeaders.set("Content-Type", ct);

  // Pass Supabase-specific headers
  const prefer = request.headers.get("prefer");
  if (prefer) cleanHeaders.set("Prefer", prefer);

  const onConflict = request.headers.get("on-conflict");
  if (onConflict) cleanHeaders.set("on-conflict", onConflict);

  const xUpsert = request.headers.get("x-upsert");
  if (xUpsert) cleanHeaders.set("x-upsert", xUpsert);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: cleanHeaders,
    body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
  });

  return new Response(response.body, {
    status:  response.status,
    headers: response.headers,
  });
}

export const config = { path: "/api/supabase/*" };