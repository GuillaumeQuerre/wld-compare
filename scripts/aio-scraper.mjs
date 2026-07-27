#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 *  aio-scraper.mjs — Récupération locale de l'AI Overview Google (solution C)
 *
 *  Se lance À LA MAIN sur ta machine (IP résidentielle = peu de CAPTCHA).
 *  Ouvre un vrai navigateur, tape chaque question sur Google, attend l'AI
 *  Overview, en récupère le texte + les sources, applique EXACTEMENT la même
 *  détection que l'app (detectBrand de geoEngine) et écrit le résultat dans
 *  geo_results — l'app l'affiche alors comme n'importe quel autre provider.
 *
 *  ── Installation (une fois) ─────────────────────────────────────────────
 *    npm i -D playwright
 *    npx playwright install chromium
 *
 *  ── Configuration (variables d'environnement) ───────────────────────────
 *    SUPABASE_URL   = https://xxxx.supabase.co
 *    SUPABASE_KEY   = <clé service_role OU anon avec droit d'écriture>
 *    PROJECT_ID     = <id du projet — le site est déduit automatiquement>
 *    SITE_ID        = (facultatif) forcer un site précis d'un projet multi-sites
 *    SITE_LABEL     = (facultatif) idem, par libellé/nom de marque
 *    BRAND_NAME     = "Linconyl"                 (repli si non trouvé en base)
 *    BRAND_ALIASES  = "Linconyl SAS,Lincony"     (facultatif, séparé par des virgules)
 *    GOOGLE_DOMAIN  = google.fr                  (défaut : google.fr)
 *    GOOGLE_HL      = fr                          (langue interface)
 *    HEADLESS       = false                       (défaut : false = navigateur visible)
 *    MAX_QUESTIONS  = 0                           (0 = toutes)
 *    MIN_DELAY_MS   = 6000                        (pause mini entre 2 recherches)
 *    MAX_DELAY_MS   = 12000                       (pause maxi — jitter anti-pattern)
 *
 *  ── Lancement ───────────────────────────────────────────────────────────
 *    SUPABASE_URL=... SUPABASE_KEY=... PROJECT_ID=... node aio-scraper.mjs
 *
 *  NOTE : Google modifie régulièrement le HTML de l'AI Overview. Les repères
 *  d'extraction sont regroupés dans AIO_CONFIG ci-dessous — c'est le seul
 *  endroit à ajuster si l'extraction se met à échouer.
 * ════════════════════════════════════════════════════════════════════════
 */

import { chromium } from "playwright";
import fs from "node:fs";
// ⚠️ Chemin vers le moteur de l'app — adapte-le si tu déplaces le script.
//    On réutilise la MÊME détection que l'app (aucune divergence possible).
import { detectBrand, getProviderId, calendarPresence } from "../src/lib/geoEngine.js";

// ── Chargement de .env (sans dépendance) — ne surcharge pas l'existant ────
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* pas de .env : on lit l'environnement / --env-file */ }
})();

// ── Config lue depuis l'environnement ────────────────────────────────────
const CFG = {
  supabaseUrl:  must("SUPABASE_URL"),
  supabaseKey:  must("SUPABASE_KEY"),
  projectId:    must("PROJECT_ID"),
  // SITE_ID facultatif : par défaut, on prend le site principal du projet.
  // Renseigne-le seulement pour cibler un autre site d'un projet multi-sites.
  siteId:       process.env.SITE_ID || "",
  siteLabel:    process.env.SITE_LABEL || "",
  brandName:    process.env.BRAND_NAME || "",
  brandAliases: (process.env.BRAND_ALIASES || "").split(",").map(s => s.trim()).filter(Boolean),
  googleDomain: process.env.GOOGLE_DOMAIN || "google.fr",
  hl:           process.env.GOOGLE_HL || "fr",
  headless:     process.env.HEADLESS === "true",
  maxQuestions: parseInt(process.env.MAX_QUESTIONS || "0", 10),
  minDelay:     parseInt(process.env.MIN_DELAY_MS || "6000", 10),
  maxDelay:     parseInt(process.env.MAX_DELAY_MS || "12000", 10),
};

// ── Repères d'extraction de l'AI Overview (à ajuster si Google change) ────
const AIO_CONFIG = {
  // Textes du bouton "Afficher plus / Show more" qui déplie l'AIO complet.
  expandButtonText: /afficher plus|voir plus|show more|plus d.informations|generate|display more/i,
  // Textes/labels indiquant la présence d'un bloc AI Overview.
  aioLabel: /aper[çc]u ia|ai overview|g[ée]n[ée]r[ée] par l.ia|ai-generated/i,
  // Sélecteurs candidats du conteneur AIO (on prend le premier qui matche).
  containerSelectors: [
    'div[data-attrid*="Overview"]',
    'div[jsname][data-hveid] div[data-attrid]',
    '#rso div[data-async-context] div[jscontroller]',
  ],
  // Délai d'apparition max de l'AIO après chargement de la SERP.
  waitMs: 9000,
};

// ════════════════════════════════════════════════════════════════════════

function must(name) {
  const v = process.env[name];
  if (!v) { console.error(`❌ Variable d'environnement manquante : ${name}`); process.exit(1); }
  return v;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => CFG.minDelay + Math.floor(Math.random() * Math.max(0, CFG.maxDelay - CFG.minDelay));

// ── Accès Supabase REST (lecture questions / marque, écriture résultats) ──
async function sb(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: CFG.supabaseKey,
      Authorization: `Bearer ${CFG.supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function loadContext() {
  // Questions du projet (on suit la marque du site courant)
  const questions = await sb(`geo_questions?project_id=eq.${enc(CFG.projectId)}&select=id,question,associated_sites&order=created_at.asc`);

  // ── Résolution du SITE depuis le PROJET (pas de SITE_ID à saisir) ──
  // On lit projects.sites_json et on choisit : le SITE_ID/SITE_LABEL fourni si présent,
  // sinon le site principal (le premier). Le site porte la marque à suivre.
  let siteId = CFG.siteId, brandName = CFG.brandName, brandAliases = CFG.brandAliases, competitors = [];
  let sitesParsed = [];
  try {
    const rows = await sb(`projects?id=eq.${enc(CFG.projectId)}&select=sites_json`);
    sitesParsed = rows?.[0]?.sites_json ? (typeof rows[0].sites_json === "string" ? JSON.parse(rows[0].sites_json) : rows[0].sites_json) : [];
  } catch { sitesParsed = []; }

  let site = null;
  if (CFG.siteId)        site = sitesParsed.find(s => s.id === CFG.siteId);
  else if (CFG.siteLabel) site = sitesParsed.find(s => (s.label || "").toLowerCase() === CFG.siteLabel.toLowerCase() || (s.brand_name || "").toLowerCase() === CFG.siteLabel.toLowerCase());
  if (!site) site = sitesParsed[0] || null; // site principal par défaut

  if (site) {
    siteId = site.id;
  }
  if (!siteId) { console.error("❌ Aucun site trouvé pour ce projet (sites_json vide). Renseigne SITE_ID en dernier recours."); process.exit(1); }

  // La marque n'est PAS dans sites_json : elle vit dans la table `site_brand`
  // (par project_id + site_id), exactement comme sbGetBrand() dans l'app.
  try {
    const brows = await sb(`site_brand?project_id=eq.${enc(CFG.projectId)}&site_id=eq.${enc(siteId)}&limit=1`);
    const b = brows?.[0];
    if (b?.brand_name) brandName = b.brand_name;
    if (Array.isArray(b?.brand_aliases) && b.brand_aliases.length) brandAliases = b.brand_aliases;
  } catch { /* repli sur BRAND_NAME de l'env */ }

  try {
    competitors = await sb(`geo_competitors?project_id=eq.${enc(CFG.projectId)}&select=name,domain`);
  } catch { competitors = []; }
  if (!brandName) { console.error("❌ Aucune marque trouvée dans site_brand pour ce site : renseigne BRAND_NAME en repli."); process.exit(1); }

  const siteName = site ? (site.label || site.brand_name || siteId) : siteId;
  return { questions, siteId, siteName, brandName, brandAliases, competitors, multiSite: sitesParsed.length > 1 };
}
const enc = encodeURIComponent;

// ── Extraction de l'AI Overview sur la page courante ─────────────────────
async function extractAIO(page) {
  // 1) Laisser le temps à l'AIO de s'injecter
  await sleep(1500);
  // 2) Tenter de déplier "Afficher plus"
  try {
    const btns = await page.locator("button, div[role='button'], a[role='button']").all();
    for (const b of btns) {
      const t = ((await b.textContent()) || "").trim();
      if (AIO_CONFIG.expandButtonText.test(t)) { await b.click({ timeout: 1500 }).catch(() => {}); await sleep(1200); break; }
    }
  } catch { /* pas de bouton : AIO peut-être déjà complet */ }

  // 3) Récupérer le bloc AIO : on cherche le conteneur le plus proche d'un label AIO
  const data = await page.evaluate((cfg) => {
    const labelRe = new RegExp(cfg.aioLabel, "i");
    // Trouver un élément-repère (label AIO), remonter à un conteneur de contenu.
    let container = null;
    const all = Array.from(document.querySelectorAll("div, section"));
    for (const el of all) {
      const txt = (el.innerText || "").slice(0, 120);
      if (labelRe.test(txt) && (el.innerText || "").length > 200) { container = el; break; }
    }
    // Repli : sélecteurs candidats
    if (!container) {
      for (const sel of cfg.containerSelectors) {
        const el = document.querySelector(sel);
        if (el && (el.innerText || "").length > 200) { container = el; break; }
      }
    }
    if (!container) return { found: false, text: "", sources: [] };
    // Texte : on retire le label et les libellés de bouton
    let text = (container.innerText || "").trim();
    text = text.replace(new RegExp(cfg.aioLabel, "gi"), "").replace(/^\s*\n/gm, "").trim();
    // Sources : liens sortants du bloc (hors liens Google internes)
    const seen = new Set(); const sources = [];
    container.querySelectorAll("a[href]").forEach(a => {
      let href = a.href || "";
      try {
        const u = new URL(href);
        if (/google\.|gstatic\.|googleusercontent\./.test(u.hostname)) return;
        // Google encapsule parfois l'URL réelle dans ?url=
        const real = u.searchParams.get("url") || href;
        if (!seen.has(real)) { seen.add(real); sources.push(real); }
      } catch { /* ignore */ }
    });
    return { found: true, text, sources };
  }, { aioLabel: AIO_CONFIG.aioLabel.source, containerSelectors: AIO_CONFIG.containerSelectors });

  return data;
}

async function handleConsent(page) {
  // Bandeau cookies Google (une fois). On refuse le non-essentiel.
  const labels = [/tout refuser/i, /reject all/i, /refuser/i, /j.accepte/i, /tout accepter/i, /accept all/i];
  for (const re of labels) {
    const btn = page.locator("button", { hasText: re }).first();
    if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 2000 }).catch(() => {}); await sleep(800); return; }
  }
}

async function run() {
  const { questions, siteId, siteName, brandName, brandAliases, competitors, multiSite } = await loadContext();
  const list = CFG.maxQuestions > 0 ? questions.slice(0, CFG.maxQuestions) : questions;
  console.log(`▶ Projet ${CFG.projectId} · site « ${siteName} »${multiSite ? " (projet multi-sites : site principal ou SITE_ID/SITE_LABEL)" : ""}`);
  console.log(`  ${list.length} question(s) · marque="${brandName}" · ${competitors.length} concurrent(s)`);

  const browser = await chromium.launch({ headless: CFG.headless, slowMo: CFG.headless ? 0 : 60 });
  const ctx = await browser.newContext({
    locale: CFG.hl === "fr" ? "fr-FR" : CFG.hl,
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  let ok = 0, aio = 0, skipped = 0;
  await page.goto(`https://www.${CFG.googleDomain}/`, { waitUntil: "domcontentloaded" });
  await handleConsent(page);

  for (const q of list) {
    try {
      const url = `https://www.${CFG.googleDomain}/search?q=${enc(q.question)}&hl=${CFG.hl}&gl=${CFG.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      // Détection CAPTCHA → on s'arrête proprement (solution C = surveillé à la main)
      if (/sorry\/index|recaptcha|unusual traffic/i.test(page.url()) || await page.locator("form#captcha-form").count().catch(() => 0)) {
        console.error("⛔ CAPTCHA détecté — arrêt. Relance plus tard (ralentis MIN_DELAY_MS).");
        break;
      }
      await sleep(AIO_CONFIG.waitMs > 4000 ? 3000 : AIO_CONFIG.waitMs);
      const { found, text, sources } = await extractAIO(page);

      const answer = found && text ? text : "(Aucun AI Overview affiché pour cette requête)";
      const d = detectBrand(answer, sources, brandName, brandAliases, competitors);
      const model = `AI Overview (${CFG.googleDomain})`;
      const now = new Date().toISOString();

      const record = {
        question_id: q.id, project_id: CFG.projectId, site_id: siteId, model,
        answer, answer_type: found ? "aio" : "no_aio", intent_type: null,
        sources, source_types: [],
        brand_mentioned: d.brandMentioned, brand_position: d.brandPosition, brand_in_sources: d.brandInSources,
        competitors_mentioned: d.competitorsMentioned, unknown_entities: d.unknownEntities || [],
        brand_mention_position:   d.mention?.position   || null,
        brand_evocation_position: d.evocation?.position || null,
        brand_citation_position:  d.citation?.position  || null,
        created_at: now,
      };
      await saveResult(record);

      // Calendrier (petits carrés) — même moteur partagé que l'app
      const { presType, mentionPos } = calendarPresence(d);
      await sb("geo_calendar_dates", { method: "POST", body: {
        question_id: q.id, provider_id: getProviderId(model),
        brand_present: d.brandMentioned === true,
        brand_mention:   presType === "mention"   ? 1 : 0,
        brand_citation:  presType === "citation"  ? 1 : 0,
        brand_evocation: presType === "evocation" ? 1 : 0,
        mention_position: presType === "mention" && mentionPos != null ? mentionPos : null,
        test_date: now.slice(0, 10),
      }}).catch(() => {});

      ok++; if (found) aio++;
      console.log(`  ${found ? "✅" : "○ "} ${found ? (d.mention?.position ? "top #" + d.mention.position : d.brandMentioned ? "présent" : "absent") : "pas d'AIO"} — ${q.question.slice(0, 60)}`);
    } catch (e) {
      skipped++; console.warn(`  ⚠️  ${q.question.slice(0, 60)} — ${e.message.slice(0, 80)}`);
    }
    await sleep(jitter());
  }

  await browser.close();
  console.log(`\n✔ Terminé : ${ok} enregistrées (${aio} avec AIO), ${skipped} en erreur.`);
}

async function saveResult(record) {
  // Insert avec repli si des colonnes "détail" manquent (schéma non migré)
  try { await sb("geo_results", { method: "POST", body: record }); }
  catch (e) {
    const { brand_mention_position, brand_evocation_position, brand_citation_position, unknown_entities, ...base } = record;
    await sb("geo_results", { method: "POST", body: base });
  }
}

run().catch(e => { console.error("Erreur fatale :", e); process.exit(1); });
