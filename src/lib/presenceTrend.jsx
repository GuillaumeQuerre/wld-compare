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
export function buildPresenceSeries({ results = [], calendarEntries = [], from, to }) {
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
    // Présence = au moins un des trois, comptée UNE fois (pas de double comptage)
    if (c.mention || c.evocation || c.citation) byDayResults[d].present++;
  });

  const byDayCal = {};
  (calendarEntries || []).forEach(e => {
    const d = e.test_date || (e.created_at || "").slice(0, 10);
    if (!d) return;
    if (!byDayCal[d]) byDayCal[d] = { tested: 0, present: 0, mentions: 0, evocations: 0, citations: 0 };
    byDayCal[d].tested++;
    if (e.brand_present === true || e.brand_present === 1 || e.brand_mention === 1 || e.brand_citation === 1 || e.brand_evocation === 1) byDayCal[d].present++;
    const isMention = e.brand_mention === 1 || e.brand_mention === true || e.mention_position != null;
    const isCitation = e.brand_citation === 1 || e.brand_citation === true;
    const isEvocation = e.brand_evocation === 1 || e.brand_evocation === true;
    if (isMention) byDayCal[d].mentions++;
    else if (isEvocation || (!isCitation && (e.brand_present === true || e.brand_present === 1))) byDayCal[d].evocations++;
    if (isCitation) byDayCal[d].citations++;
  });

  return daysBetween(from, to).map(date => {
    // Un jour couvert par les résultats est TOUJOURS servi par eux (ventilation exacte).
    const src = byDayResults[date] ? "results" : (byDayCal[date] ? "calendar" : null);
    const v = byDayResults[date] || byDayCal[date] || { tested: 0, present: 0, mentions: 0, evocations: 0, citations: 0 };
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

// Date de départ minimale sélectionnable : création du projet, sinon plus ancienne donnée.
export function earliestSelectableDate(project, results = [], calendarEntries = []) {
  const fromProject = (project?.created_at || project?.createdAt || "").slice(0, 10);
  if (fromProject) return fromProject;
  const dates = [];
  (results || []).forEach(r => { const d = (r.created_at || "").slice(0, 10); if (d) dates.push(d); });
  (calendarEntries || []).forEach(e => { const d = e.test_date || (e.created_at || "").slice(0, 10); if (d) dates.push(d); });
  return dates.length ? dates.sort()[0] : addDays(dayKeyOf(new Date()), -365);
}

// ── Rendu SVG : 3 courbes sur un axe de jours continu ────────────────────
function Curves({ series, width = 900, height = 240 }) {
  const padL = 34, padR = 12, padT = 12, padB = 26;
  const w = Math.max(width, 240), h = height;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const maxVal = Math.max(1, ...series.flatMap(d => [d.mentions, d.evocations, d.citations]));
  const n = series.length;
  const x = (i) => n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW;
  const y = (v) => padT + innerH - (v / maxVal) * innerH;

  // Une réponse nulle un jour NON testé n'est pas un zéro mesuré → on coupe la courbe.
  const segments = (key) => {
    const segs = []; let cur = [];
    series.forEach((d, i) => {
      if (d.tested > 0) cur.push([x(i), y(d[key])]);
      else { if (cur.length) segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    return segs;
  };

  const ticks = [0, 0.5, 1].map(f => Math.round(maxVal * f));
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Chronologie mentions, évocations, citations">
      {[...new Set(ticks)].map(t => (
        <g key={t}>
          <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#1A3C2E14" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9" fill="#94A3B8">{t}</text>
        </g>
      ))}
      {series.map((d, i) => (i % labelEvery === 0 || i === n - 1) && (
        <text key={d.date} x={x(i)} y={h - 8} textAnchor="middle" fontSize="9" fill="#94A3B8">{d.date.slice(8, 10)}/{d.date.slice(5, 7)}</text>
      ))}
      {["citations", "evocations", "mentions"].map(key => (
        <g key={key}>
          {segments(key).map((seg, si) => (
            seg.length === 1
              ? <circle key={si} cx={seg[0][0]} cy={seg[0][1]} r="3" fill={MEC_COLORS[key]} />
              : <polyline key={si} points={seg.map(p => p.join(",")).join(" ")} fill="none" stroke={MEC_COLORS[key]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((d, i) => d.tested > 0 ? <circle key={d.date} cx={x(i)} cy={y(d[key])} r="2" fill={MEC_COLORS[key]}><title>{`${d.date} — ${MEC_LABELS[key]} : ${d[key]} / ${d.tested} réponses`}</title></circle> : null)}
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
  results = [], calendarEntries = [], minDate, title = "Chronologie de la présence",
  defaultDays = 30, compact = false, onRangeChange = null,
}) {
  const today = dayKeyOf(new Date());
  const floor = minDate || addDays(today, -365);
  const defaultFrom = (() => { const f = addDays(today, -(defaultDays - 1)); return f < floor ? floor : f; })();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);

  const series = useMemo(() => {
    const f = from < floor ? floor : from;
    return buildPresenceSeries({ results, calendarEntries, from: f, to });
  }, [results, calendarEntries, from, to, floor]);

  // Remontee au parent APRES le rendu (jamais pendant) : evite un setState
  // sur le parent au milieu du rendu de l'enfant.
  useEffect(() => {
    if (onRangeChange) onRangeChange({ from: from < floor ? floor : from, to, series });
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
              ? `${totals.mentions} mentions · ${totals.evocations} évocations · ${totals.citations} citations sur ${totals.tested} réponses`
              : "Aucune interrogation sur la période"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
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