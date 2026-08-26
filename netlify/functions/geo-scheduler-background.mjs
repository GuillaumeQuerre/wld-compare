// netlify/functions/geo-scheduler-background.mjs
// Netlify BACKGROUND FUNCTION (timeout 15 min, pas ~50s comme les Edge Functions)
// Interroge les questions FAVORITES des schedules actifs, sans session utilisateur.
// Déclenchée par : (1) le cron via geo-scheduler.js (edge), (2) le trigger manuel front.
// Le suffixe "-background" active le mode asynchrone Netlify : réponse 202 immédiate.

// ── Moteur partagé [Call + Identification] — MÊME code que l'onglet Questions ──
import { callProvider, detectBrand, buildPrompt, PROVIDER_LABEL, calendarPresence, webSearchEnabled } from "../../src/lib/geoEngine.js";

const SUPABASE_URL      = process.env.SUPABASE_URL              || "";
const SUPABASE_ANON     = process.env.SUPABASE_ANON             || "";
// FIX BUG 1 : utiliser la SERVICE_ROLE key pour bypasser les RLS policies
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY ||
                          process.env.SUPABASE_SERVICE_KEY      || "";

// ── Email de fin de run (Resend) ──────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM      = process.env.SCHEDULER_MAIL_FROM || "Dashboard GEO | Sonate <noreply@geo.sonate.group>";


// ── Supabase helpers ──────────────────────────────────────────────
// Lecture : clé service role — le scheduler est un job de confiance sans session
// utilisateur ; depuis le verrouillage RLS, l'anon ne peut plus rien lire, donc
// les lectures DOIVENT passer en service_role pour bypasser les RLS.
function sbReadHeaders() {
  const key = SUPABASE_SERVICE || SUPABASE_ANON;
  return {
    "apikey":        key,
    "Authorization": `Bearer ${key}`,
    "Content-Type":  "application/json",
  };
}

// Écriture : clé service role (bypasse les RLS — requis pour écrire sans session)
function sbWriteHeaders() {
  const key = SUPABASE_SERVICE || SUPABASE_ANON;
  return {
    "apikey":        key,
    "Authorization": `Bearer ${key}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbReadHeaders() });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`sbGet ${path}: ${res.status} — ${err.slice(0, 120)}`);
  }
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method:  "POST",
    headers: sbWriteHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`sbPost ${path}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method:  "PATCH",
    headers: sbWriteHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.warn(`sbPatch ${path}: ${res.status} — ${err.slice(0, 120)}`);
  }
  return res.ok;
}

// ── Key codec (base64, mirrors frontend encodeKey/decodeKey) ──────
function decodeKey(enc) {
  if (!enc) return "";
  try { return atob(enc); } catch { return ""; }
}

// ── Provider definitions ──────────────────────────────────────────
const PROVIDERS = {
  openai:     { model: "gpt-4o-mini",              keyField: "openai_key_enc" },
  gemini:     { model: "gemini-3.5-flash",          keyField: "gemini_key_enc" },
  perplexity: { model: "sonar",                    keyField: "perplexity_key_enc" },
  claude:     { model: "claude-haiku-4-5-20251001", keyField: "claude_geo_key_enc" },
};

// ── Throttle par provider (anti-429 RPM, surtout Gemini) — même logique que le front ──
// Intervalle minimum entre deux appels d'un MÊME provider ; files indépendantes par provider.
const PROVIDER_MIN_GAP_MS = { gemini: 3000, perplexity: 1500, openai: 0, claude: 0 };
const _providerGate = {};
function throttleProvider(providerId) {
  const gap = PROVIDER_MIN_GAP_MS[providerId] || 0;
  if (!gap) return Promise.resolve();
  const chain = _providerGate[providerId] || Promise.resolve();
  _providerGate[providerId] = chain.then(() => new Promise((res) => setTimeout(res, gap)));
  return chain;
}

// ── Process one schedule ──────────────────────────────────────────
async function processSchedule(schedule, project, brand, site, secondBrand = null, brandsMap = {}) {
  const providerIds = schedule.providers || ["openai"];
  const maxQ        = schedule.max_questions || 10;

  const questions = await sbGet(
    `geo_questions?project_id=eq.${encodeURIComponent(schedule.project_id)}&site_id=eq.${encodeURIComponent(schedule.site_id)}&is_favorite=eq.true&order=created_at.asc&limit=${maxQ}`
  );

  if (!questions.length) {
    console.log(`[scheduler] No favorite questions for ${schedule.project_id}/${schedule.site_id}`);
    return 0;
  }

  const brandName    = brand?.brand_name    || "";
  const brandAliases = brand?.brand_aliases || [];
  const context      = brand?.context       || "";
  // Concurrents (mêmes données que le PROP `competitors` de l'onglet Questions)
  const competitors  = await sbGet(
    `geo_competitors?project_id=eq.${encodeURIComponent(schedule.project_id)}&site_id=eq.${encodeURIComponent(schedule.site_id)}&select=name`
  ).catch(() => []);
  // 2e site → suivi comme concurrent « 2nd site suivi » (compté dans les détections), consolidé ici
  const secondName = secondBrand?.brand_name?.trim();
  if (secondName && !competitors.some(c => c.name?.toLowerCase() === secondName.toLowerCase())) {
    competitors.push({ name: secondName });
  }
  let savedCount = 0;

  for (const q of questions) {
    await Promise.all(providerIds.map(async (providerId) => {
      const pDef = PROVIDERS[providerId];
      if (!pDef) return;

      const apiKey = decodeKey(project[pDef.keyField]);
      if (!apiKey) {
        console.warn(`[scheduler] Missing key for ${providerId} on project ${schedule.project_id}`);
        return;
      }

      try {
        const prompt = buildPrompt(providerId, q.question, context);
        // Recherche web : réglage par projet (provider_web_search). Défaut ON pour OpenAI,
        // toujours ON pour Gemini/Perplexity, jamais pour Claude — identique à l'onglet Questions.
        const useWebSearch = webSearchEnabled(providerId, project.provider_web_search || {});
        await throttleProvider(providerId); // respecte l'intervalle mini du provider (anti-429 RPM)
        const parsed = await callProvider({ id: providerId, model: pDef.model }, apiKey, prompt, 2000, site, useWebSearch);
        const answer = parsed.answer || "";
        const sources = parsed.sources || [];

        const now = new Date().toISOString();

        // ── Détection marque (3 types) — MÊME moteur que l'onglet Questions ──
        const detected = detectBrand(answer, sources, brandName, brandAliases, competitors);
        const brandMentioned = detected.brandMentioned;

        // ── Temps 2 : présence par marque associée (même réponse, détections locales) ──
        const _assoc = Array.isArray(q.associated_sites) ? q.associated_sites : [];
        const brand_presences = {};
        if (_assoc.length) {
          const _toPres = (d) => ({
            mentioned: !!d.brandMentioned,
            mention_position:   d.mention?.position   ?? null,
            evocation_position: d.evocation?.position ?? null,
            citation_position:  d.citation?.position  ?? null,
            in_sources: !!d.brandInSources,
          });
          brand_presences[schedule.site_id] = _toPres(detected);
          for (const sid of _assoc) {
            if (sid === schedule.site_id) continue;
            const sb = brandsMap[`${schedule.project_id}__${sid}`];
            const bn = sb?.brand_name?.trim();
            if (!bn) continue;
            const d = detectBrand(answer, sources, bn, sb.brand_aliases || [], []);
            brand_presences[sid] = _toPres(d);
          }
        }

        // Type de présence + position pour le calendrier (moteur partagé — identique au manuel)
        const { presType: presTypeForCal, mentionPos: mentionPosForCal } = calendarPresence(detected);

        // ── 1. Sauvegarder dans geo_results ───────────────────────
        const record = {
          question_id:              q.id,
          project_id:               schedule.project_id,
          site_id:                  schedule.site_id,
          model:                    `${PROVIDER_LABEL[providerId] || providerId} (${pDef.model}) [auto]`,
          answer,
          answer_type:              parsed.answer_type || "Texte libre",
          intent_type:              parsed.intent_type || "Informative",
          sources,
          source_types:             parsed.source_types || [],
          brand_mentioned:          brandMentioned,
          brand_position:           detected.brandPosition,
          brand_in_sources:         detected.brandInSources,
          competitors_mentioned:    detected.competitorsMentioned || [],
          unknown_entities:         detected.unknownEntities || [],
          brand_mention_position:   detected.mention?.position   || null,
          brand_evocation_position: detected.evocation?.position || null,
          brand_citation_position:  detected.citation?.position  || null,
          ...(Object.keys(brand_presences).length ? { brand_presences } : {}),
          input_tokens:             parsed._input_tokens || 0,
          output_tokens:            parsed._output_tokens || 0,
          created_at:               now,
        };

        // Dédoublonnage : supprimer un éventuel résultat auto du même jour
        // pour ce couple (question, provider) puis insérer le nouveau.
        const today = now.slice(0, 10);
        try {
          await fetch(
            `${SUPABASE_URL}/rest/v1/geo_results?question_id=eq.${encodeURIComponent(q.id)}&model=eq.${encodeURIComponent(record.model)}&created_at=gte.${today}T00:00:00&created_at=lte.${today}T23:59:59`,
            { method: "DELETE", headers: { ...sbWriteHeaders(), "Prefer": "return=minimal" } }
          );
        } catch {}

        // Insert avec repli robuste : si une colonne « détail » manque en base
        // (migration non passée), on réessaie sans ces colonnes plutôt que de tout perdre.
        try {
          await sbPost("geo_results", record);
        } catch(insErr) {
          console.warn(`[scheduler] geo_results insert principal échoué (${insErr.message}) — repli sans colonnes détail`);
          try {
            const {
              brand_mention_position, brand_evocation_position, brand_citation_position,
              brand_presences, unknown_entities, source_types, answer_type, intent_type,
              ...base
            } = record;
            await sbPost("geo_results", base);
            console.warn(`[scheduler] geo_results sauvegardé via repli — pense à passer les migrations pour stocker les colonnes détail`);
          } catch(insErr2) {
            console.error(`[scheduler] geo_results ÉCHEC même après repli: ${insErr2.message}`);
            throw insErr2;
          }
        }

        // ── 2. Insérer dans geo_calendar_dates (même table que le front) ──
        // Schéma identique à sbAddCalendarEntry : brand_present + brand_mention/citation/evocation + test_date
        try {
          await sbPost("geo_calendar_dates", {
            question_id:     q.id,
            provider_id:     providerId,
            brand_present:   brandMentioned === true,
            brand_mention:   presTypeForCal === "mention"   ? 1 : 0,
            brand_citation:  presTypeForCal === "citation"  ? 1 : 0,
            brand_evocation: presTypeForCal === "evocation" ? 1 : 0,
            mention_position: presTypeForCal === "mention" && mentionPosForCal != null ? mentionPosForCal : null,
            test_date:       today,
          });
        } catch(calErr) {
          // Repli : si les colonnes ventilées (M/É/C + position) manquent, garder l'essentiel (carré présent/absent)
          try {
            await sbPost("geo_calendar_dates", { question_id: q.id, provider_id: providerId, brand_present: brandMentioned === true, test_date: today });
          } catch(calErr2) {
            console.warn(`[scheduler] calendar insert failed: ${calErr2.message}`);
          }
        }

        // ── 3. Mettre à jour le cache de la question (last_date, has_result) ──
        try {
          const cachePatch = { has_result: true, last_answer: answer, last_model: record.model, last_date: now };
          if (brandMentioned) Object.assign(cachePatch, { best_answer: answer, best_model: record.model, best_date: now });
          await sbPatch(`geo_questions?id=eq.${encodeURIComponent(q.id)}`, cachePatch);
        } catch {}

        savedCount++;
        console.log(`[scheduler] ✓ q=${q.id} provider=${providerId} brand=${brandMentioned} pres=${presTypeForCal}`);

      } catch(e) {
        console.error(`[scheduler] Error q=${q.id} provider=${providerId}:`, e.message);
      }
    }));
  }

  return savedCount;
}

// ── Main handler ──────────────────────────────────────────────────


// ── Email de notification de fin de run (via API Resend) ──────────
async function sendRunEmail(schedule, count, projectName) {
  const to = (schedule.owner_email || "").trim();
  if (!to) { console.warn("[scheduler] Pas d'owner_email — email ignoré"); return; }
  if (!RESEND_API_KEY) { console.warn("[scheduler] RESEND_API_KEY absente — email ignoré"); return; }

  const date = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });
  const providers = (schedule.providers || []).join(", ") || "—";
  const subject = `[Dashboard GEO] Interrogation automatique effectuée — ${count} question${count > 1 ? "s" : ""} favorite${count > 1 ? "s" : ""}`;
  const text =
    `Bonjour,\n\n` +
    `L'interrogation automatique de vos questions favorites a eu lieu le ${date}.\n\n` +
    `• Projet : ${projectName || schedule.project_id}\n` +
    `• Questions favorites interrogées : ${count}\n` +
    `• Providers interrogés : ${providers}\n\n` +
    `Les résultats sont disponibles dans l'onglet Questions de votre dashboard GEO.\n\n` +
    `— Dashboard GEO par Sonate`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[scheduler] Email Resend échoué (${res.status}): ${detail.slice(0, 200)}`);
    } else {
      console.log(`[scheduler] Email envoyé à ${to} (${count} question(s))`);
    }
  } catch (e) {
    console.error("[scheduler] Email Resend exception:", e.message);
  }
}

// ── computeNextRun ────────────────────────────────────────────────
function computeNextRun(frequency) {
  const d = new Date();
  let days = 7;
  if (typeof frequency === "string" && frequency.startsWith("every_")) {
    days = Math.max(1, parseInt(frequency.slice(6), 10) || 7);
  } else {
    switch (frequency) {
      case "daily":    days = 1;  break;
      case "weekly":   days = 7;  break;
      case "biweekly": days = 14; break;
      case "monthly":  days = 30; break;
      default:         days = 7;
    }
  }
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── Runner : traite les schedules dûs (ou forcés) ─────────────────
async function runScheduler({ forceRun = false, site = "", target = {} } = {}) {
  const SITE = site || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  const start = Date.now();
  const now = new Date().toISOString();

  // Sélection des schedules.
  // Si une cible est fournie (test manuel sur le projet courant) → uniquement ce schedule.
  let filter;
  if (target && target.project_id) {
    filter = `geo_schedules?active=eq.true&project_id=eq.${encodeURIComponent(target.project_id)}`
      + (target.site_id ? `&site_id=eq.${encodeURIComponent(target.site_id)}` : "")
      + `&limit=5`;
  } else if (forceRun) {
    filter = `geo_schedules?active=eq.true&order=next_run.asc&limit=50`;
  } else {
    filter = `geo_schedules?active=eq.true&next_run=lte.${encodeURIComponent(now)}&order=next_run.asc&limit=50`;
  }

  const schedules = await sbGet(filter);
  console.log(`[geo-scheduler-bg] ${forceRun ? "FORCED" : "SCHEDULED"} — ${schedules.length} schedules`);
  if (!schedules.length) return { ok: true, processed: 0, duration: Date.now() - start };

  const projectIds = [...new Set(schedules.map(s => s.project_id))];
  const projectsRaw = await sbGet(`projects?id=in.(${projectIds.join(",")})&select=*`);
  const projectsMap = Object.fromEntries(projectsRaw.map(p => [p.id, p]));
  const brandsRaw = await sbGet(`site_brand?project_id=in.(${projectIds.join(",")})&select=*`);
  const brandsMap = Object.fromEntries(brandsRaw.map(b => [`${b.project_id}__${b.site_id}`, b]));

  // Sites par projet (sites_json) → site principal = sites[0], 2e site = sites[1]
  const sitesOf = (project) => {
    try { return JSON.parse(project?.sites_json || "[]"); } catch { return []; }
  };

  const results = [];
  for (const schedule of schedules) {
    const project = projectsMap[schedule.project_id];
    if (!project) { console.warn(`[scheduler] Project not found: ${schedule.project_id}`); continue; }

    // ── Consolidation multi-sites ──
    // Si le projet a 2 sites, on ne suit QUE le site principal (sites[0]).
    // Le schedule propre au 2e site est ignoré (consolidé sur le principal).
    // La marque du 2e site est injectée comme concurrent « 2nd site suivi ».
    const projSites = sitesOf(project);
    const primaryId = projSites[0]?.id;
    const secondId  = projSites[1]?.id;
    if (secondId && schedule.site_id === secondId) {
      console.log(`[scheduler] Skip 2e site ${schedule.site_id} (consolidé sur le site principal ${primaryId})`);
      continue;
    }
    const secondBrand = (secondId && schedule.site_id === primaryId)
      ? (brandsMap[`${schedule.project_id}__${secondId}`] || null)
      : null;

    const brand = brandsMap[`${schedule.project_id}__${schedule.site_id}`] || null;

    let count = 0;
    try {
      count = await processSchedule(schedule, project, brand, SITE, secondBrand, brandsMap);
    } catch(e) {
      console.error(`[scheduler] Schedule ${schedule.id} failed:`, e.message);
    }
    const nextRun = computeNextRun(schedule.frequency);
    await sbPatch(`geo_schedules?id=eq.${schedule.id}`, { next_run: nextRun, last_run: now, last_run_count: count });
    await sendRunEmail(schedule, count, project?.name);
    results.push({ schedule_id: schedule.id, questions_processed: count, next_run: nextRun });
  }

  const duration = Date.now() - start;
  console.log(`[geo-scheduler-bg] Done in ${duration}ms — ${results.length} schedules`);
  return { ok: true, processed: results.length, results, duration };
}

// ── Handler Background Function (Netlify) ─────────────────────────
// Suffixe -background → timeout 15 min, retourne 202 immédiatement.
export default async (req) => {
  let forceRun = false;
  let origin = "";
  let target = { project_id: null, site_id: null };
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      forceRun = body?.force !== false; // POST manuel = forcé par défaut
      origin = body?.origin || "";
      if (body?.project_id) target = { project_id: body.project_id, site_id: body.site_id || null };
    }
  } catch {}

  // Le travail s'exécute ; Netlify maintient la fonction vivante jusqu'à 15 min.
  try {
    const out = await runScheduler({ forceRun, site: origin, target });
    console.log("[geo-scheduler-bg] result:", JSON.stringify(out).slice(0, 300));
  } catch(e) {
    console.error("[geo-scheduler-bg] fatal:", e.message);
  }
  // Les background functions renvoient 202 automatiquement ; ce return est ignoré.
  return new Response(null, { status: 202 });
};
