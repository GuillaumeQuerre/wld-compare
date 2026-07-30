import React, { useState, useMemo, useEffect } from "react";

// ════════════════════════════════════════════════════════════════════════
//  Chronologie Mentions / Évocations / Citations — source UNIQUE
//  Utilisé par : Suivi GEO, onglet Audit, exports PPTX/PDF.
//
//  SÉMANTIQUE (alignée sur le tableau comparatif) :
//   • Mention   = la marque est CLASSÉE dans un top de la réponse (position)
//   • Évocation = la marque est citée dans le texte SANS être classée
//   • Citation  = la marque est présente dans les SOURCES — indépendant des deux
//     autres (une réponse peut être à la fois « mention » et « citation »).
//
//  L'ancienne série chaînait les trois en else/if : une réponse classée ET citée
//  ne comptait que comme mention, ce qui sous-évaluait structurellement les citations.
// ════════════════════════════════════════════════════════════════════════

export const MEC_COLORS = { mentions: "#1A7A4A", evocations: "#C97820", citations: "#2563EB" };
export const MEC_LABELS = { mentions: "Mentions", evocations: "Évocations", citations: "Citations" };

// Courbe lissée passant par TOUS les points, sans dépassement (interpolation
// cubique monotone de Fritsch-Carlson) : idéal pour des comptes en dents de scie
// — la courbe ne descend jamais sous 0 ni ne dépasse un pic entre deux points.
// coords : [[x,y], …] déjà à l'échelle écran. Retourne l'attribut `d` d'un <path>.
function smoothPathD(coords) {
  const p = coords.filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const nP = p.length;
  if (nP === 0) return "";
  if (nP === 1) return `M ${p[0][0]} ${p[0][1]}`;
  if (nP === 2) return `M ${p[0][0]} ${p[0][1]} L ${p[1][0]} ${p[1][1]}`;

  // Pentes des sécantes (x régulièrement espacés, mais on reste général)
  const dx = [], dy = [], m = [];
  for (let i = 0; i < nP - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; dy[i] = p[i + 1][1] - p[i][1]; m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0; }

  // Tangentes aux points
  const t = new Array(nP);
  t[0] = m[0]; t[nP - 1] = m[nP - 2];
  for (let i = 1; i < nP - 1; i++) {
    // À un extremum local (les sécantes changent de signe, ou l'une est nulle),
    // la tangente est forcée à 0 : c'est ce qui empêche la courbe de dépasser.
    t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
  }

  // Correction monotone : empêche les oscillations / dépassements
  for (let i = 0; i < nP - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
  }

  // Segments cubiques Hermite → Bézier
  let d = `M ${p[0][0]} ${p[0][1]}`;
  for (let i = 0; i < nP - 1; i++) {
    const h = dx[i];
    const c1x = p[i][0] + h / 3,     c1y = p[i][1] + (t[i] * h) / 3;
    const c2x = p[i + 1][0] - h / 3, c2y = p[i + 1][1] - (t[i + 1] * h) / 3;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p[i + 1][0]} ${p[i + 1][1]}`;
  }
  return d;
}

export function dayKeyOf(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return dayKeyOf(d);
}

// Liste continue de jours entre from et to inclus (axe régulier, sans trou).
export function daysBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 2000) { out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}

// Ventilation canonique d'UN résultat — DÉFINITION DE RÉFÉRENCE de l'application.
// Réutilisée telle quelle par les compteurs de l'audit et des exports, pour qu'un
// même mot ("Citation") désigne toujours le même nombre partout.
export function classifyResult(r) {
  const isMention = r.brand_mention_position != null || (r.brand_position != null && r.brand_position > 0);
  const isPresent = isMention || r.brand_mentioned === true || r.brand_mentioned === 1;
  return {
    mention: isMention,
    evocation: !isMention && isPresent,
    citation: r.brand_in_sources === true || r.brand_in_sources === 1,
  };
}

/**
 * Construit la série quotidienne sur un axe de jours CONTINU.
 * results         : geo_results (champs indépendants → source prioritaire)
 * calendarEntries : geo_calendar_dates (repli pour les jours sans résultat en mémoire ;
 *                   ce format ne stocke qu'un type de présence exclusif par test,
 *                   les citations y sont donc approchées par défaut)
 * from / to       : "YYYY-MM-DD"
 * → [{ date, tested, mentions, evocations, citations, source }]
 */
/**
 * A) Construit les 3 sets à partir des dates où une DÉTECTION a eu lieu.
 * On ne garde QUE les dates testées (≥1 réponse) dans [from, to], triées.
 * Chaque entrée porte les 3 comptes du jour : { date, mentions, evocations, citations, tested }.
 * (Les jours sans détection ne sont PAS des points — l'axe est fait des dates de détection.)
 */
export function buildPresenceSeries({ results = [], calendarEntries = [], dailyRows = null, mode = "response", from, to }) {
  // Source PRIORITAIRE : la table d'agrégats quotidiens (geo_presence_daily),
  // si fournie. Elle porte les deux modes et couvre tout l'historique (au-delà
  // de la fenêtre des résultats récents). Le mode choisit le triplet à tracer.
  if (Array.isArray(dailyRows) && dailyRows.length) {
    const suf = mode === "question" ? "_q" : "_resp";
    return dailyRows
      .filter(r => r.date && (!from || r.date >= from) && (!to || r.date <= to))
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => {
        const tested = mode === "question" ? (r.questions_count || 0) : (r.responses_count || 0);
        const mentions = r["mentions" + suf] || 0, evocations = r["evocations" + suf] || 0, citations = r["citations" + suf] || 0;
        const present = mentions + evocations; // exclusifs
        return { date: r.date, tested, mentions, evocations, citations,
          present, rate: tested > 0 ? Math.round((present / tested) * 100) : null, source: "daily" };
      });
  }

  const byDayResults = {};
  (results || []).forEach(r => {
    const d = (r.created_at || "").slice(0, 10);
    if (!d) return;
    if (!byDayResults[d]) byDayResults[d] = { tested: 0, present: 0, mentions: 0, evocations: 0, citations: 0 };
    const c = classifyResult(r);
    byDayResults[d].tested++;
    if (c.mention) byDayResults[d].mentions++;
    if (c.evocation) byDayResults[d].evocations++;
    if (c.citation) byDayResults[d].citations++;
    if (c.mention || c.evocation || c.citation) byDayResults[d].present++;
  });

  const byDayCal = {};
  (calendarEntries || []).forEach(e => {
    const d = e.test_date || (e.created_at || "").slice(0, 10);
    if (!d) return;
    if (!byDayCal[d]) byDayCal[d] = { tested: 0, present: 0, mentions: 0, evocations: 0, citations: 0 };
    byDayCal[d].tested++;
    const isMention = e.brand_mention === 1 || e.brand_mention === true || e.mention_position != null;
    const isCitation = e.brand_citation === 1 || e.brand_citation === true;
    const isEvocation = e.brand_evocation === 1 || e.brand_evocation === true;
    if (isMention) byDayCal[d].mentions++;
    else if (isEvocation || (!isCitation && (e.brand_present === true || e.brand_present === 1))) byDayCal[d].evocations++;
    if (isCitation) byDayCal[d].citations++;
    if (e.brand_present === true || e.brand_present === 1 || isMention || isCitation || isEvocation) byDayCal[d].present++;
  });

  // Union des dates de détection (résultats prioritaires), filtrées sur [from, to], triées.
  const dates = [...new Set([...Object.keys(byDayResults), ...Object.keys(byDayCal)])]
    .filter(d => (!from || d >= from) && (!to || d <= to))
    .sort();

  return dates.map(date => {
    const src = byDayResults[date] ? "results" : "calendar";
    const v = byDayResults[date] || byDayCal[date];
    return { date, tested: v.tested, present: v.present || 0, mentions: v.mentions, evocations: v.evocations, citations: v.citations,
      rate: v.tested > 0 ? Math.round(((v.present || 0) / v.tested) * 100) : null, source: src };
  });
}

// Totaux canoniques sur un jeu de résultats — MÊME définition que la chronologie.
// À utiliser pour tout compteur libellé « Mentions / Évocations / Citations ».
export function mecTotalsOf(results = []) {
  return (results || []).reduce((a, r) => {
    const c = classifyResult(r);
    if (c.mention) a.mentions++;
    if (c.evocation) a.evocations++;
    if (c.citation) a.citations++;
    if (c.mention || c.evocation || c.citation) a.present++;
    return a;
  }, { mentions: 0, evocations: 0, citations: 0, present: 0, tested: (results || []).length });
}

// ── Agrégats quotidiens par marque — les DEUX modes de comptage ──────────
// Produit, par date, ce que stocke geo_presence_daily. Une seule classification
// canonique (classifyResult) alimente les deux modes.
//   • par RÉPONSE  : chaque geo_results compte
//   • par QUESTION : une question compte si ≥1 de ses réponses la classe ainsi
//                    (mention/évocation exclusives ; citation indépendante)
export function computeMecDaily(results = []) {
  const byDay = {};
  for (const r of (results || [])) {
    const date = (r.created_at || "").slice(0, 10);
    if (!date) continue;
    if (!byDay[date]) byDay[date] = {
      date, responses: 0, questions: new Set(),
      mentions_resp: 0, evocations_resp: 0, citations_resp: 0,
      q: {}, // question_id -> { mention, evocation, citation }
    };
    const d = byDay[date];
    const c = classifyResult(r);
    d.responses++;
    const qid = r.question_id != null ? r.question_id : `_${d.responses}`;
    d.questions.add(qid);
    if (c.mention) d.mentions_resp++;
    if (c.evocation) d.evocations_resp++;
    if (c.citation) d.citations_resp++;
    if (!d.q[qid]) d.q[qid] = { mention: false, evocation: false, citation: false };
    if (c.mention) d.q[qid].mention = true;
    if (c.evocation) d.q[qid].evocation = true;
    if (c.citation) d.q[qid].citation = true;
  }
  return Object.values(byDay).map(d => {
    let mq = 0, eq = 0, cq = 0;
    for (const v of Object.values(d.q)) {
      if (v.mention) mq++;                       // mention prioritaire
      else if (v.evocation) eq++;                // évocation = pas de mention
      if (v.citation) cq++;                      // citation indépendante
    }
    return {
      date: d.date, questions_count: d.questions.size, responses_count: d.responses,
      mentions_resp: d.mentions_resp, evocations_resp: d.evocations_resp, citations_resp: d.citations_resp,
      mentions_q: mq, evocations_q: eq, citations_q: cq,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// Date de départ minimale sélectionnable : création du projet, sinon plus ancienne donnée.
export function earliestSelectableDate(project, results = [], calendarEntries = []) {
  const fromProject = (project?.created_at || project?.createdAt || "").slice(0, 10);
  if (fromProject) return fromProject;
  const dates = [];
  (results || []).forEach(r => { const d = (r.created_at || "").slice(0, 10); if (d) dates.push(d); });
  (calendarEntries || []).forEach(e => { const d = e.test_date || (e.created_at || "").slice(0, 10); if (d) dates.push(d); });
  return dates.length ? dates.sort()[0] : addDays(dayKeyOf(new Date()), -365);
}

// ── Rendu SVG : 3 courbes sur un axe fait des DATES DE DÉTECTION ──────────
function Curves({ series, width = 900, height = 240 }) {
  const padL = 34, padR = 12, padT = 12, padB = 26;
  const w = Math.max(width, 240), h = height;
  const innerW = w - padL - padR, innerH = h - padT - padB;

  // Valeur numérique SÛRE : une info manquante/partielle vaut 0 (jamais undefined),
  // sinon un NaN casserait la polyline SVG et couperait la courbe.
  const val = (d, key) => { const v = Number(d[key]); return Number.isFinite(v) ? v : 0; };

  // Points valides uniquement (date présente) — l'axe est fait des dates de détection.
  const pts = (series || []).filter(d => d && d.date);
  const n = pts.length;

  // B) Axe vertical : borne max = 120% du plus élevé parmi MENTIONS ou ÉVOCATIONS.
  const peak = Math.max(0, ...pts.map(d => Math.max(val(d, "mentions"), val(d, "evocations"))));
  const maxVal = Math.max(1, Math.ceil(peak * 1.2));

  // Points régulièrement espacés (une position par date de détection).
  const x = (i) => n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW;
  const y = (v) => { const vv = Number.isFinite(Number(v)) ? Number(v) : 0; return padT + innerH - (vv / maxVal) * innerH; };

  const ticks = [...new Set([0, Math.round(maxVal / 2), maxVal])];
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Chronologie mentions, évocations, citations">
      {ticks.map(t => (
        <g key={t}>
          <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#1A3C2E14" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9" fill="#94A3B8">{t}</text>
        </g>
      ))}
      {pts.map((d, i) => (i % labelEvery === 0 || i === n - 1) && (
        <text key={d.date} x={x(i)} y={h - 8} textAnchor="middle" fontSize="9" fill="#94A3B8">{d.date.slice(8, 10)}/{d.date.slice(5, 7)}</text>
      ))}
      {/* C) Une courbe LISSÉE fine par set reliant tous les points, points par-dessus. */}
      {["citations", "evocations", "mentions"].map(key => (
        <g key={key}>
          {n > 1 && (
            <path
              d={smoothPathD(pts.map((d, i) => [x(i), y(val(d, key))]))}
              fill="none" stroke={MEC_COLORS[key]} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round"
            />
          )}
          {pts.map((d, i) => (
            <circle key={d.date} cx={x(i)} cy={y(val(d, key))} r={n === 1 ? 2.6 : 1.8} fill={MEC_COLORS[key]}>
              <title>{`${d.date} — ${MEC_LABELS[key]} : ${val(d, key)} (sur ${d.tested} réponses)`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  );
}

/**
 * Graphique complet : 3 courbes + sélecteur d'intervalle.
 * La date de début ne peut pas remonter avant la création du projet (minDate).
 */
export function PresenceTrendChart({
  results = [], calendarEntries = [], dailyRows = null, minDate, title = "Chronologie de la présence",
  defaultDays = 30, compact = false, onRangeChange = null, defaultMode = "response",
}) {
  const today = dayKeyOf(new Date());
  const floor = minDate || addDays(today, -365);
  const defaultFrom = (() => { const f = addDays(today, -(defaultDays - 1)); return f < floor ? floor : f; })();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [mode, setMode] = useState(defaultMode); // "response" | "question"

  const series = useMemo(() => {
    const f = from < floor ? floor : from;
    return buildPresenceSeries({ results, calendarEntries, dailyRows, mode, from: f, to });
  }, [results, calendarEntries, dailyRows, mode, from, to, floor]);

  // Remontee au parent APRES le rendu (jamais pendant) : evite un setState
  // sur le parent au milieu du rendu de l'enfant.
  useEffect(() => {
    if (onRangeChange) onRangeChange({ from: from < floor ? floor : from, to, mode, series });
  }, [series]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = series.reduce((a, d) => ({
    mentions: a.mentions + d.mentions, evocations: a.evocations + d.evocations,
    citations: a.citations + d.citations, tested: a.tested + d.tested,
  }), { mentions: 0, evocations: 0, citations: 0, tested: 0 });

  const preset = (days) => { const f = addDays(today, -(days - 1)); setFrom(f < floor ? floor : f); setTo(today); };
  const btn = (active) => ({
    padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
    border: `0.5px solid ${active ? "#1A7A4A44" : "#1A3C2E18"}`,
    background: active ? "#1A7A4A10" : "transparent", color: active ? "#1A7A4A" : "#94A3B8",
  });
  const dateInput = { padding: "3px 7px", border: "0.5px solid #1A3C2E18", borderRadius: 7, fontSize: 11, color: "#1A3C2E", background: "transparent" };
  const spanDays = daysBetween(from, to).length;

  return (
    <div style={{ background: "#fff", border: "0.5px solid #1A3C2E14", borderRadius: 12, padding: compact ? 14 : 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E" }}>{title}</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
            {totals.tested > 0
              ? `${totals.mentions} mentions · ${totals.evocations} évocations · ${totals.citations} citations sur ${totals.tested} ${mode === "question" ? "questions" : "réponses"}`
              : "Aucune interrogation sur la période"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {/* Switch mode de comptage : par réponse / par question */}
          <span style={{ display: "inline-flex", border: "0.5px solid #1A3C2E18", borderRadius: 20, overflow: "hidden", marginRight: 4 }}>
            {[["response", "par réponse"], ["question", "par question"]].map(([m, lbl]) => (
              <button key={m} onClick={() => setMode(m)}
                style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
                  background: mode === m ? "#1A7A4A10" : "transparent", color: mode === m ? "#1A7A4A" : "#94A3B8" }}
                title={m === "response" ? "Chaque interrogation d'un modèle compte" : "Une question compte si ≥1 réponse la classe ainsi"}>
                {lbl}
              </button>
            ))}
          </span>
          {[7, 30, 90].map(d => <button key={d} onClick={() => preset(d)} style={btn(spanDays === d && to === today)}>{d} j</button>)}
          <button onClick={() => { setFrom(floor); setTo(today); }} style={btn(from === floor && to === today)}>Tout</button>
          <input type="date" value={from} min={floor} max={to} onChange={e => setFrom(e.target.value < floor ? floor : e.target.value)} style={dateInput} title={`Début (au plus tôt : ${floor})`} />
          <span style={{ fontSize: 11, color: "#94A3B8" }}>→</span>
          <input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value > today ? today : e.target.value)} style={dateInput} title="Fin" />
        </div>
      </div>

      <Curves series={series} height={compact ? 190 : 240} />

      <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
        {["mentions", "evocations", "citations"].map(k => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748B" }}>
            <span style={{ width: 14, height: 2.5, borderRadius: 2, background: MEC_COLORS[k] }} />
            {MEC_LABELS[k]} <b style={{ color: MEC_COLORS[k] }}>{totals[k]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}