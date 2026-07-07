// netlify/functions/geo-scheduler-cron.mjs
// ─────────────────────────────────────────────────────────────────────────────
// FONCTION PLANIFIÉE (cron horaire).
//
// Pourquoi ce fichier existe : les Edge Functions Netlify ne supportent PAS le
// cron (`schedule`). Seules les Functions RÉGULIÈRES le font. L'ancien déclencheur
// (netlify/edge-functions/geo-scheduler.js) portait un `schedule` qui était donc
// silencieusement ignoré → l'automatisation ne se déclenchait jamais toute seule
// (seul le trigger manuel du front fonctionnait).
//
// Cette fonction s'exécute chaque heure et déclenche la background function
// geo-scheduler-background (fire-and-forget). Celle-ci sélectionne les schedules
// dûs (next_run <= now) et les traite (timeout 15 min).
//
// Note : les fonctions planifiées ne peuvent pas être invoquées par URL et ne
// tournent que sur les déploiements publiés (pas les previews).
// ─────────────────────────────────────────────────────────────────────────────

export const config = { schedule: "0 * * * *" }; // toutes les heures, à la minute 0 (UTC)

export default async () => {
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    "";

  if (!base) {
    console.error("[geo-scheduler-cron] URL du site introuvable (env URL) — dispatch annulé");
    return new Response("no base url", { status: 500 });
  }

  const bgUrl = `${base}/.netlify/functions/geo-scheduler-background`;

  try {
    // force:false → mode planifié : le background ne traite que les schedules dûs.
    const res = await fetch(bgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false, origin: base }),
    });
    // Le background renvoie 202 immédiatement puis continue en arrière-plan.
    console.log(`[geo-scheduler-cron] dispatched (${res.status}) @ ${new Date().toISOString()}`);
  } catch (e) {
    console.error("[geo-scheduler-cron] dispatch failed:", e.message);
  }

  return new Response("ok", { status: 200 });
};
