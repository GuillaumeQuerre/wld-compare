#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 *  diagnose-aio.mjs — Diagnostic de bout en bout de la file AI Overview
 *
 *  Teste, contre ta VRAIE base Supabase (le même chemin que le scraper),
 *  chaque maillon qui peut bloquer une demande sur « en attente » :
 *    1. la table geo_scrape_queue existe et est lisible
 *    2. on peut INSÉRER une demande (sinon l'enfilage échoue → 403/404)
 *    3. on peut la RELIRE (le scraper la verrait)
 *    4. on peut la passer à « done » (UPDATE — sinon elle reste pending à vie)
 *    5. on peut la SUPPRIMER (nettoyage)
 *    6. bonus : la colonne site_id existe sur geo_calendar_dates (carrés par marque)
 *
 *  ── Lancement ───────────────────────────────────────────────────────────
 *    SUPABASE_URL=https://xxxx.supabase.co \
 *    SUPABASE_KEY=<clé service_role ou anon, la MÊME que le scraper> \
 *    node diagnose-aio.mjs
 *
 *  Utilise les mêmes variables que aio-scraper.mjs. Aucune dépendance.
 * ════════════════════════════════════════════════════════════════════════
 */

// Charge un .env local s'il existe (loader zéro-dépendance).
// IMPORTANT : détecte si une variable de session ($env: PowerShell) masque le .env.
import { readFileSync, existsSync } from "node:fs";
const envFileVals = {};
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m) {
      const val = m[2].replace(/^["']|["']$/g, "");
      envFileVals[m[1]] = val;
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  }
}
// Avertit si une variable de session diffère du .env (le shell l'emporte → piège)
for (const name of ["SUPABASE_URL", "SUPABASE_KEY"]) {
  if (envFileVals[name] && process.env[name] && envFileVals[name] !== process.env[name]) {
    console.log(`⚠️  ${name} : une variable de SESSION masque ton .env.`);
    console.log(`    Session utilisée : longueur ${process.env[name].length} · commence par « ${process.env[name].slice(0, 6)} »`);
    console.log(`    .env (ignoré)    : longueur ${envFileVals[name].length} · commence par « ${envFileVals[name].slice(0, 6)} »`);
    console.log(`    → Ouvre un NOUVEAU terminal, ou lance : Remove-Item Env:\\${name}\n`);
  }
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  console.error("❌ SUPABASE_URL et SUPABASE_KEY sont requis.\n" +
    "   Exemple : SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=... node diagnose-aio.mjs");
  process.exit(1);
}

// Normalise l'URL : retire un éventuel /rest/v1 déjà présent dans SUPABASE_URL
// (sinon on obtient .../rest/v1/rest/v1 → 404 sur tout).
const base = URL.replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/rest/v1";
const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

// Détecte le type de clé + affiche des infos SÛRES (longueur, début/fin, format)
// pour révéler une clé tronquée, un placeholder ou un nouveau format.
const keyInfo = (() => {
  const k = KEY || "";
  let format = "inconnu";
  if (k.startsWith("eyJ")) format = "JWT (anon/service_role)";
  else if (k.startsWith("sb_secret_")) format = "clé secrète (nouveau format)";
  else if (k.startsWith("sb_publishable_")) format = "clé publishable (nouveau format)";
  else if (k.includes("ta_vraie_clé") || k.includes("...")) format = "⚠️ PLACEHOLDER non remplacé";
  let role = "inconnu";
  if (k.startsWith("eyJ")) {
    try { role = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).role || "inconnu"; } catch { /* */ }
  }
  const masked = k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-4)}` : "(trop courte)";
  return { format, role, len: k.length, masked };
})();

const line = (ok, label, detail = "") =>
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? "  →  " + detail : ""}`);

async function req(method, path, body) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: { ...headers, Prefer: method === "POST" ? "return=representation" : "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let text = "";
  try { text = await res.text(); } catch { /* ignore */ }
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, text, json };
}

const TEST_PROJECT = "diag-" + Date.now();
const TEST_SITE = "diag-site";
const TEST_Q = "diag-question";

console.log("\n════════ DIAGNOSTIC FILE AI OVERVIEW ════════");
console.log(`Base   : ${base}`);
console.log(`Clé    : format « ${keyInfo.format} »${keyInfo.role !== "inconnu" ? ` · rôle ${keyInfo.role}` : ""}`);
console.log(`         longueur ${keyInfo.len} · ${keyInfo.masked}`);
if (!KEY.startsWith("eyJ") && !KEY.startsWith("sb_")) {
  console.log("         ⚠️  Une clé valide commence par « eyJ » (JWT) ou « sb_secret_ » (nouveau format).");
  console.log("             La tienne ne correspond à aucun → c'est probablement la MAUVAISE valeur.");
}
console.log("──────────────────────────────────────────────\n");

let insertedId = null;
let fatal = false;

// ── [1] La table existe et est lisible ───────────────────────────────────
{
  const r = await req("GET", "geo_scrape_queue?limit=1");
  if (r.status === 404) { line(false, "[1] Table geo_scrape_queue lisible", "404 — la table N'EXISTE PAS (migration_scrape_queue.sql non passée)"); fatal = true; }
  else if (r.status === 401 || r.status === 403) { line(false, "[1] Table geo_scrape_queue lisible", `${r.status} — droits SELECT refusés (RLS/grants). Lance fix_403_scrape_queue.sql`); fatal = true; }
  else if (r.ok) line(true, "[1] Table geo_scrape_queue lisible");
  else { line(false, "[1] Table geo_scrape_queue lisible", `${r.status} — ${r.text.slice(0, 120)}`); fatal = true; }
}

// ── [2] INSERT (enfilage) ────────────────────────────────────────────────
if (!fatal) {
  const r = await req("POST", "geo_scrape_queue", [{
    project_id: TEST_PROJECT, site_id: TEST_SITE, question_id: TEST_Q, status: "pending",
    requested_at: new Date().toISOString(),
  }]);
  if (r.ok && r.json?.[0]?.id) { insertedId = r.json[0].id; line(true, "[2] INSERT d'une demande (enfilage)", `id ${insertedId}`); }
  else if (r.status === 403) line(false, "[2] INSERT d'une demande (enfilage)", "403 — droits INSERT refusés → c'est CE qui bloque l'enfilage. Lance fix_403_scrape_queue.sql");
  else if (r.status === 400) line(false, "[2] INSERT d'une demande (enfilage)", `400 — payload/colonne : ${r.text.slice(0, 160)}`);
  else line(false, "[2] INSERT d'une demande (enfilage)", `${r.status} — ${r.text.slice(0, 160)}`);
}

// ── [3] SELECT du pending (ce que voit le scraper) ───────────────────────
if (insertedId) {
  const r = await req("GET", `geo_scrape_queue?project_id=eq.${TEST_PROJECT}&status=eq.pending&select=id,question_id,site_id,status`);
  if (r.ok && Array.isArray(r.json) && r.json.length) line(true, "[3] Le scraper VERRAIT la demande (SELECT pending)", `${r.json.length} en attente`);
  else line(false, "[3] Le scraper VERRAIT la demande (SELECT pending)", `${r.status} — ${r.text.slice(0, 120)}`);
}

// ── [4] UPDATE → done (sinon reste pending à vie) ────────────────────────
if (insertedId) {
  const r = await req("PATCH", `geo_scrape_queue?id=eq.${insertedId}`, { status: "done", done_at: new Date().toISOString() });
  if (r.ok) line(true, "[4] Passage à « done » (UPDATE)");
  else if (r.status === 403) line(false, "[4] Passage à « done » (UPDATE)", "403 — droits UPDATE refusés → le scraper ne peut PAS clore la demande, elle reste « en attente » à vie. fix_403 doit accorder UPDATE.");
  else line(false, "[4] Passage à « done » (UPDATE)", `${r.status} — ${r.text.slice(0, 120)}`);
}

// ── [5] DELETE (nettoyage de la ligne de test) ───────────────────────────
if (insertedId) {
  const r = await req("DELETE", `geo_scrape_queue?id=eq.${insertedId}`);
  line(r.ok, "[5] Nettoyage de la demande de test (DELETE)", r.ok ? "" : `${r.status} (ligne de test id ${insertedId} à supprimer à la main)`);
}

// ── [6] Bonus : colonne site_id sur le calendrier (carrés par marque) ────
{
  const r = await req("GET", "geo_calendar_dates?select=site_id&limit=1");
  if (r.ok) line(true, "[6] Colonne site_id sur geo_calendar_dates", "présente → carrés par marque possibles");
  else if (r.status === 400 && /site_id/.test(r.text)) line(false, "[6] Colonne site_id sur geo_calendar_dates", "ABSENTE → carrés par marque impossibles. Lance migration_calendar_per_brand.sql");
  else line(false, "[6] Colonne site_id sur geo_calendar_dates", `${r.status} — ${r.text.slice(0, 120)}`);
}

// ── [7] CRITIQUE : colonne brand_presences sur geo_results ───────────────
// Sans elle, la présence par marque est SILENCIEUSEMENT supprimée à chaque
// sauvegarde (sbSaveGeoResult retombe sur les colonnes de base) → chiffres et
// courbes vides « ni sur la marque, ni sur les autres ».
{
  const r = await req("GET", "geo_results?select=brand_presences&limit=1");
  if (r.ok) line(true, "[7] Colonne brand_presences sur geo_results", "présente → présence par marque sauvegardée");
  else if (r.status === 400 && /brand_presences/.test(r.text)) line(false, "[7] Colonne brand_presences sur geo_results", "ABSENTE → LA présence par marque n'est PAS sauvegardée. Lance migration_multibrand.sql");
  else line(false, "[7] Colonne brand_presences sur geo_results", `${r.status} — ${r.text.slice(0, 120)}`);
}

console.log("\n──────────────────────────────────────────────");
console.log("Lecture : le premier ❌ indique le maillon qui casse.");
console.log("  • [1]/[2] 404      → migration_scrape_queue.sql à passer");
console.log("  • [2]/[4] 403      → fix_403_scrape_queue.sql (INSERT + UPDATE)");
console.log("  • [4] 403 seul     → la demande s'enfile mais ne se clôt jamais → « en attente » perpétuel");
console.log("  • tout ✅ mais bloqué en vrai → le SCRAPER ne tourne pas (WATCH=true node aio-scraper.mjs)");
console.log("════════════════════════════════════════════════\n");
