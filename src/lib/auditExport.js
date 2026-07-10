// ════════════════════════════════════════════════════════════════════
// auditExport.js → src/lib/auditExport.js
// Export de l'audit GEO en .pptx (éditable) ET .pdf (présentable),
// à partir d'UN seul modèle de slides → cohérence parfaite entre formats.
//
// pptxgenjs / jsPDF sont chargés À LA VOLÉE depuis un CDN (au clic), pas
// bundlés par webpack — sinon le build CRA échoue sur `node:fs` (build
// Node de pptxgenjs). Aucune dépendance npm requise.
// ════════════════════════════════════════════════════════════════════

const CDN = {
  pptx: "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
  jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const found = document.querySelector(`script[data-lib="${src}"]`);
    if (found) {
      if (found.dataset.loaded === "1") return resolve();
      found.addEventListener("load", () => resolve());
      found.addEventListener("error", () => reject(new Error("Échec chargement " + src)));
      return;
    }
    const s = document.createElement("script");
    s.src = src; s.async = true; s.dataset.lib = src;
    s.addEventListener("load", () => { s.dataset.loaded = "1"; resolve(); });
    s.addEventListener("error", () => reject(new Error("Échec chargement de la librairie d'export. Vérifiez votre connexion.")));
    document.head.appendChild(s);
  });
}

let _Pptx = null, _JsPDF = null;
async function loadPptx() {
  if (_Pptx) return _Pptx;
  if (!window.PptxGenJS) await loadScript(CDN.pptx);
  _Pptx = window.PptxGenJS;
  if (!_Pptx) throw new Error("pptxgenjs indisponible.");
  return _Pptx;
}
async function loadJsPDF() {
  if (_JsPDF) return _JsPDF;
  if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript(CDN.jspdf);
  _JsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!_JsPDF) throw new Error("jsPDF indisponible.");
  return _JsPDF;
}

// ── Palette Sonate (sans #, pour pptxgenjs) ──
const C = {
  green: "1A3C2E", greenMid: "2D5A42", greenLight: "4A8C6A", greenPale: "EAF2ED",
  cream: "F5F0E8", creamDark: "E8E0CE", ink: "1C1C1C", inkMid: "4A4A4A", inkLight: "9A9A9A",
  white: "FFFFFF", accent: "E8541A", accentPale: "FCEBE3",
  ok: "2D6A4F", warn: "C2790F", danger: "9B2335", blue: "1A4A7A",
};

// ── Helpers data ──
const PROVIDER_LABEL = { openai: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity", google: "Google AIO" };
const fmtDate = () => new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
const fileDate = () => new Date().toISOString().slice(0, 10);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmtVol = (v) => v >= 1000 ? (v / 1000).toFixed(1).replace(".0", "") + "k" : String(v);
const catLabel = (c) => c.volume > 0 ? `${c.name} · ${fmtVol(c.volume)} rech./mois` : c.name;
const scoreVerdict = (r) => r >= 70 ? ["Excellente présence", "1A7A4A"] : r >= 50 ? ["Bonne présence", C.green] : r >= 30 ? ["Potentiel à développer", "C97820"] : ["Potentiel à exploiter", "C97820"];

// Construit le modèle commun (liste de slides) depuis l'audit.
export function buildAuditDeck(audit, brand, site, roadmapData, categories = [], sentiment = null) {
  const a = audit || {};
  const brandName = brand?.brand_name || "Marque";
  const catName = {}; (categories || []).forEach(c => { catName[c.id] = c.name; });

  // Providers
  const providers = Object.entries(a.providerStats || {}).map(([pid, s]) => ({
    label: PROVIDER_LABEL[pid] || pid, rate: pct(s.withBrand, s.total), withBrand: s.withBrand, total: s.total,
  })).sort((x, y) => y.rate - x.rate);

  // Catégories (taux de présence)
  const cats = Object.entries(a.byQuestionCategory || {})
    .filter(([cid]) => cid !== "__none__")
    .map(([cid, s]) => ({ name: catName[cid] || "Sans catégorie", rate: pct(s.withBrand, s.total), qCount: s.qCount, total: s.total, withBrand: s.withBrand, volume: s.volume || 0 }))
    .sort((x, y) => y.rate - x.rate);

  // Concurrents (part de citations) — gère le format [name, statsObj] de competitorsRanked
  const comps = (a.competitorsRanked || a.top5Competitors || []).slice(0, 6).map(c => {
    if (Array.isArray(c)) { const st = c[1] || {}; return { name: c[0] || "—", count: (st.mentions || 0) + (st.evocations || 0) + (st.citations || 0) }; }
    return { name: c.name || "—", count: c.count ?? c.mentions ?? 0 };
  });
  const compMax = Math.max(1, ...comps.map(c => c.count), a.withBrand || 0);
  const sovBrandPct = (a.shareOfVoice && a.shareOfVoice[0]) ? a.shareOfVoice[0].pct : null;
  const blindSpotsCount = (a.blindSpots || []).length;

  // Tendance
  const trend = (a.mentionTrend && a.mentionTrend.some(d => d.total > 0))
    ? a.mentionTrend.map(d => ({ date: d.date, present: (d.mentions || 0) + (d.evocations || 0), total: d.total }))
    : (a.trendDays || []).map(d => ({ date: d.date, present: d.present ?? 0, total: d.tested ?? d.total ?? 0 }));

  const [verdictLabel, verdictColor] = scoreVerdict(a.presenceRate || 0);

  const rm = roadmapData || {};
  const roadmap = (rm.roadmap || []).slice().sort((x, y) => {
    const rank = { haute: 0, moyenne: 1, basse: 2 };
    return (rank[x.priority] ?? 1) - (rank[y.priority] ?? 1);
  }).slice(0, 6);

  return {
    brandName, siteName: site?.name || "", date: fmtDate(),
    score: { rate: a.presenceRate || 0, label: verdictLabel, color: verdictColor,
      withBrand: a.withBrand || 0, total: a.total || 0, questions: a.questions || 0 },
    kpis: [
      { v: `${a.mentionCount || 0}`, l: "Mentions classées" },
      { v: `${a.evocationCount || 0}`, l: "Évocations" },
      { v: `${a.citationCount || 0}`, l: "Citations sources" },
      { v: (() => { const p = parseFloat(a.avgMentionPos); return Number.isFinite(p) && p > 0 ? p.toFixed(1) : "—"; })(), l: "Position moyenne" },
    ],
    providers, cats, comps, compMax, sovBrandPct, blindSpotsCount, trend,
    presenceTrend: (a.presenceTrend || []).filter(t => t.tested > 0),
    distinctRuns: a.distinctRuns || 0,
    nProviders: providers.length,
    questionStatus: (a.questionStatus || []).map(q => ({ question: q.question, status: q.status, lost: !!q.lost, presentOn: q.presentOn || 0, providersOn: q.providersOn || 0 })),
    sources: {
      own: (a.brandOwnUrls || []).length,
      optimize: (a.urlsToOptimize || []).length,
      rework: (a.urlsToRework || []).length,
      inspire: (a.urlsToInspire || []).length,
      topOwn: (a.brandOwnUrls || []).slice(0, 6).map(u => ({ url: (u.norm || u.url || "").replace(/^https?:\/\//, ""), n: u.count_as_source ?? 0 })),
    },
    diagnostic: rm.diagnostic || null,
    leads: (a.leads || []).slice(0, 4).map(l => ({
      label: l.label || "", reco: l.reco || l.action || "", why: l.why || "", how: l.how || "", howMuch: l.howMuch || "",
      col: (l.priority || "").includes("🔴") ? "9B2335" : ((l.priority || "").includes("🟠") || (l.priority || "").includes("🟡")) ? "C2790F" : "4A8C6A",
    })),
    sentiment: sentiment ? {
      overall: sentiment.overall || "",
      score: typeof sentiment.score === "number" ? sentiment.score : null,
      summary: sentiment.summary || "",
      themes: Array.isArray(sentiment.themes) ? sentiment.themes : [],
      strengths: Array.isArray(sentiment.strengths) ? sentiment.strengths : [],
      watchouts: Array.isArray(sentiment.watchouts) ? sentiment.watchouts : [],
      quotes: Array.isArray(sentiment.quotes) ? sentiment.quotes : [],
    } : null,
    roadmap,
  };
}

// ════════════════════════ PPTX (éditable) ════════════════════════
export async function exportAuditPptx(audit, brand, site, roadmapData, categories = [], sentiment = null) {
  const PptxGenJS = await loadPptx();
  const d = buildAuditDeck(audit, brand, site, roadmapData, categories, sentiment);
  const p = new PptxGenJS();
  p.defineLayout({ name: "W", width: 13.333, height: 7.5 });
  p.layout = "W";
  p.theme = { headFontFace: "Georgia", bodyFontFace: "Calibri" };

  const slide = (bg) => { const s = p.addSlide(); s.background = { color: bg || C.white }; return s; };
  const kicker = (s, t) => s.addText(t.toUpperCase(), { x: 0.6, y: 0.42, w: 12, h: 0.3, fontSize: 11, color: C.accent, bold: true, charSpacing: 2, fontFace: "Calibri" });
  const title = (s, t) => s.addText(t, { x: 0.6, y: 0.7, w: 12, h: 0.7, fontSize: 30, color: C.green, bold: true, fontFace: "Georgia" });
  const footer = (s, n) => s.addText(`${d.brandName} · Audit GEO · ${d.date}`, { x: 0.6, y: 7.05, w: 10, h: 0.3, fontSize: 9, color: C.inkLight }) || s.addText(`${n}`, { x: 12.4, y: 7.05, w: 0.6, h: 0.3, fontSize: 9, color: C.inkLight, align: "right" });

  // 1 — Couverture
  {
    const s = slide(C.green);
    s.addText("AUDIT DE VISIBILITÉ GEO", { x: 0.8, y: 2.4, w: 11.7, h: 0.4, fontSize: 14, color: C.accent, bold: true, charSpacing: 3 });
    s.addText(d.brandName, { x: 0.8, y: 2.9, w: 11.7, h: 1.1, fontSize: 44, color: C.white, bold: true, fontFace: "Georgia" });
    s.addText("Présence et performance dans les réponses des moteurs génératifs (LLMs)", { x: 0.8, y: 4.0, w: 11, h: 0.5, fontSize: 15, color: "C9D6CE" });
    s.addText(d.date + (d.siteName ? `  ·  ${d.siteName}` : ""), { x: 0.8, y: 6.4, w: 11, h: 0.4, fontSize: 12, color: "9DB3A6" });
    s.addShape(p.ShapeType.rect, { x: 0.8, y: 4.7, w: 1.6, h: 0.06, fill: { color: C.accent } });
  }

  // 2 — Score & synthèse
  {
    const s = slide();
    kicker(s, "Synthèse"); title(s, "Score de présence GEO");
    // Donut score
    s.addChart(p.ChartType.doughnut, [{ name: "Score", labels: ["Présent", "Absent"], values: [d.score.rate, 100 - d.score.rate] }], {
      x: 0.6, y: 1.9, w: 4.2, h: 4.2, holeSize: 70, showLegend: false, showValue: false,
      chartColors: [d.score.color, C.creamDark], dataBorder: { pt: 0, color: C.white },
    });
    s.addText([{ text: `${d.score.rate}`, options: { fontSize: 54, bold: true, color: d.score.color, fontFace: "Georgia" } }, { text: "%", options: { fontSize: 24, color: d.score.color } }], { x: 0.6, y: 3.35, w: 4.2, h: 0.8, align: "center" });
    s.addText(d.score.label, { x: 0.6, y: 5.9, w: 4.2, h: 0.45, align: "center", fontSize: 15, bold: true, color: d.score.color });
    // KPIs (2x3 grid à droite)
    const gx = 5.3, gw = 3.7, gh = 1.55, gap = 0.25;
    d.kpis.slice(0, 4).forEach((k, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = gx + col * (gw + gap), y = 1.95 + row * (gh + gap);
      s.addShape(p.ShapeType.roundRect, { x, y, w: gw, h: gh, rectRadius: 0.08, fill: { color: C.greenPale }, line: { color: C.creamDark, pt: 0.5 } });
      s.addText(k.v, { x, y: y + 0.16, w: gw, h: 0.72, align: "center", fontSize: 30, bold: true, color: C.green, fontFace: "Georgia" });
      s.addText(k.l, { x, y: y + 0.98, w: gw, h: 0.4, align: "center", fontSize: 12, color: C.inkMid });
    });
    s.addText(`${d.score.withBrand} réponses sur ${d.score.total} analysées citent la marque — ${d.score.questions} questions suivies sur ${d.nProviders} moteur${d.nProviders > 1 ? "s" : ""}${d.distinctRuns ? ` (${d.distinctRuns} interrogations distinctes)` : ""}.`, { x: 5.3, y: 5.5, w: 7.6, h: 0.6, fontSize: 13, color: C.inkMid });
    footer(s, 2);
  }

  // 3 — Visibilité par provider (barres)
  if (d.providers.length) {
    const s = slide();
    kicker(s, "Visibilité"); title(s, "Présence par moteur IA");
    s.addChart(p.ChartType.bar, [{ name: "Présence %", labels: d.providers.map(x => x.label), values: d.providers.map(x => x.rate) }], {
      x: 0.6, y: 1.9, w: 12.1, h: 4.6, barDir: "bar", chartColors: [C.green], showValue: true,
      dataLabelColor: C.white, dataLabelFontSize: 12, dataLabelPosition: "inEnd",
      valAxisMaxVal: 100, valAxisMinVal: 0, catAxisLabelColor: C.ink, catAxisLabelFontSize: 13,
      valGridLine: { style: "none" }, showLegend: false,
    });
    s.addText("Les écarts entre moteurs sont normaux : chaque IA s'appuie sur des sources différentes (recherche web pour ChatGPT, Gemini et Perplexity, connaissances internes pour Claude) et sur ses propres critères de sélection.", { x: 0.6, y: 6.55, w: 12.1, h: 0.5, fontSize: 11, color: C.inkMid, italic: true });
    footer(s, 3);
  }

  // 4 — Présence dans le temps (taux par jour de test)
  if (d.presenceTrend.length > 1) {
    const s = slide();
    kicker(s, "Tendance"); title(s, "Présence dans le temps");
    s.addText("Taux de présence de la marque par jour de test (réponses avec marque / réponses analysées).", { x: 0.6, y: 1.42, w: 12, h: 0.35, fontSize: 12, color: C.inkMid });
    s.addChart(p.ChartType.line, [{ name: "Présence %", labels: d.presenceTrend.map(t => t.date?.slice(5)), values: d.presenceTrend.map(t => t.rate) }], {
      x: 0.6, y: 1.9, w: 12.1, h: 4.6, chartColors: [C.accent], lineSize: 3, lineSmooth: false,
      showValue: true, dataLabelColor: C.accent, dataLabelFontSize: 11,
      valAxisMaxVal: 100, valAxisMinVal: 0,
      showLegend: false, catAxisLabelFontSize: 10, catAxisLabelColor: C.inkMid, valGridLine: { color: C.creamDark, style: "solid" },
    });
    footer(s, 4);
  }

  // 5 — Catégories (barres taux)
  if (d.cats.length) {
    const s = slide();
    kicker(s, "Thématiques"); title(s, "Présence par catégorie");
    s.addChart(p.ChartType.bar, [{ name: "Présence %", labels: d.cats.map(catLabel), values: d.cats.map(c => c.rate) }], {
      x: 0.6, y: 1.9, w: 12.1, h: 4.6, barDir: "bar", chartColors: [C.greenMid], showValue: true,
      dataLabelColor: C.white, dataLabelPosition: "inEnd", dataLabelFontSize: 11, valAxisMaxVal: 100,
      catAxisLabelColor: C.ink, catAxisLabelFontSize: 12, valGridLine: { style: "none" }, showLegend: false,
    });
    footer(s, 5);
  }

  // 6 — Concurrents
  if (d.comps.length) {
    const s = slide();
    kicker(s, "Concurrence"); title(s, "Paysage concurrentiel GEO");
    if (d.sovBrandPct != null) s.addText(`Part de voix de ${d.brandName} : ${d.sovBrandPct}% des citations marque + concurrents`, { x: 0.6, y: 1.42, w: 12, h: 0.35, fontSize: 13, color: C.accent, bold: true });
    const rows = [[{ text: "Acteur", options: { bold: true, color: C.white, fill: { color: C.green } } }, { text: "Citations", options: { bold: true, color: C.white, fill: { color: C.green }, align: "center" } }]];
    rows.push([{ text: `${d.brandName} (vous)`, options: { bold: true, color: C.accent } }, { text: `${d.score.withBrand}`, options: { align: "center", bold: true, color: C.accent } }]);
    d.comps.forEach(c => rows.push([{ text: c.name, options: { color: C.ink } }, { text: `${c.count}`, options: { align: "center", color: C.inkMid } }]));
    s.addTable(rows, { x: 0.6, y: 1.9, w: 6.0, colW: [4.4, 1.6], fontSize: 13, border: { type: "solid", pt: 0.5, color: C.creamDark }, rowH: 0.45, valign: "middle" });
    // barres part de voix
    s.addChart(p.ChartType.bar, [{ name: "Citations", labels: [d.brandName, ...d.comps.map(c => c.name)], values: [d.score.withBrand, ...d.comps.map(c => c.count)] }], {
      x: 7.0, y: 1.9, w: 5.7, h: 4.6, barDir: "bar", chartColors: [C.accent], showValue: true,
      dataLabelColor: C.white, dataLabelPosition: "inEnd", dataLabelFontSize: 11,
      catAxisLabelColor: C.ink, catAxisLabelFontSize: 11, valGridLine: { style: "none" }, showLegend: false,
    });
    footer(s, 6);
  }

  // 7 — Perception de la marque (sentiment IA)
  if (d.sentiment) {
    const se = d.sentiment;
    const sCol = { "positif": C.greenLight, "plutôt positif": C.greenLight, "neutre": C.inkMid, "mitigé": C.accent, "négatif": "9B2335" }[se.overall] || C.green;
    const s = slide();
    kicker(s, "Perception"); title(s, "Perception de la marque");
    // Badge tonalité + score
    s.addShape(p.ShapeType.roundRect, { x: 0.6, y: 1.95, w: 3.0, h: 1.55, rectRadius: 0.1, fill: { color: C.greenPale }, line: { color: C.creamDark, pt: 0.5 } });
    s.addText(se.overall ? se.overall.toUpperCase() : "—", { x: 0.6, y: 2.12, w: 3.0, h: 0.4, align: "center", fontSize: 13, bold: true, color: sCol, charSpacing: 1 });
    s.addText([{ text: se.score != null ? `${se.score}` : "—", options: { fontSize: 38, bold: true, color: sCol, fontFace: "Georgia" } }, { text: se.score != null ? " /100" : "", options: { fontSize: 15, color: C.inkMid } }], { x: 0.6, y: 2.52, w: 3.0, h: 0.7, align: "center" });
    s.addText("Tonalité globale", { x: 0.6, y: 3.2, w: 3.0, h: 0.3, align: "center", fontSize: 10, color: C.inkLight });
    // Résumé
    s.addText(se.summary || "", { x: 3.9, y: 1.95, w: 8.8, h: 1.55, fontSize: 13, color: C.inkMid, valign: "top", lineSpacingMultiple: 1.12 });
    // Atouts / Vigilance — 2 colonnes
    s.addText("ATOUTS PERÇUS", { x: 0.6, y: 3.85, w: 6.0, h: 0.3, fontSize: 11, bold: true, color: C.greenLight, charSpacing: 1 });
    s.addText((se.strengths || []).slice(0, 5).map(t => ({ text: t, options: { bullet: { code: "2022" }, color: C.inkMid, fontSize: 12, paraSpaceAfter: 5 } })), { x: 0.6, y: 4.2, w: 6.0, h: 2.5, valign: "top" });
    s.addText("POINTS DE VIGILANCE", { x: 6.9, y: 3.85, w: 5.8, h: 0.3, fontSize: 11, bold: true, color: C.accent, charSpacing: 1 });
    const watch = (se.watchouts || []).slice(0, 5);
    s.addText(watch.length ? watch.map(t => ({ text: t, options: { bullet: { code: "2022" }, color: C.inkMid, fontSize: 12, paraSpaceAfter: 5 } })) : [{ text: "Aucun point de vigilance notable.", options: { color: C.inkLight, fontSize: 12, italic: true } }], { x: 6.9, y: 4.2, w: 5.8, h: 2.5, valign: "top" });
    footer(s, 7);
  }

  // 8 — Sources & URLs
  {
    const s = slide();
    kicker(s, "Sources"); title(s, "URLs de la marque & opportunités");
    const tiles = [
      { v: d.sources.own, l: "URLs propres citées", c: C.green },
      { v: d.sources.optimize, l: "À optimiser", c: C.warn },
      { v: d.sources.rework, l: "À retravailler", c: C.danger },
      { v: d.sources.inspire, l: "Pages de référence", c: C.blue },
    ];
    tiles.forEach((t, i) => {
      const x = 0.6 + i * 3.1;
      s.addShape(p.ShapeType.roundRect, { x, y: 1.95, w: 2.85, h: 1.4, rectRadius: 0.08, fill: { color: C.greenPale }, line: { pt: 0 } });
      s.addText(`${t.v}`, { x, y: 2.05, w: 2.85, h: 0.7, align: "center", fontSize: 30, bold: true, color: t.c, fontFace: "Georgia" });
      s.addText(t.l, { x, y: 2.75, w: 2.85, h: 0.5, align: "center", fontSize: 11, color: C.inkMid });
    });
    if (d.sources.topOwn.length) {
      s.addText("Principales URLs propres citées comme sources", { x: 0.6, y: 3.7, w: 12, h: 0.4, fontSize: 13, bold: true, color: C.green });
      const rows = d.sources.topOwn.map(u => [{ text: u.url, options: { color: C.ink } }, { text: `${u.n} citations`, options: { align: "right", color: C.inkMid } }]);
      s.addTable(rows, { x: 0.6, y: 4.1, w: 12.1, colW: [9.6, 2.5], fontSize: 12, rowH: 0.38, border: { type: "solid", pt: 0.5, color: C.creamDark } });
    }
    footer(s, 8);
  }

  // 9 — Questions par statut (À défendre / À surveiller / Conquête prioritaire)
  if (d.questionStatus.length) {
    const s = slide();
    kicker(s, "Questions"); title(s, "Statut GEO des questions suivies");
    const ST = { defend: { label: "À défendre", col: "1A7A4A" }, watch: { label: "À surveiller", col: C.warn }, conquest: { label: "Conquête prioritaire", col: C.accent } };
    const counts = { defend: 0, watch: 0, conquest: 0, lost: 0 };
    d.questionStatus.forEach(q => { counts[q.status]++; if (q.lost) counts.lost++; });
    s.addText([
      { text: `${counts.defend} à défendre`, options: { color: ST.defend.col, bold: true } }, { text: "   ·   ", options: { color: C.inkLight } },
      { text: `${counts.watch} à surveiller`, options: { color: ST.watch.col, bold: true } }, { text: "   ·   ", options: { color: C.inkLight } },
      { text: `${counts.conquest} en conquête prioritaire`, options: { color: ST.conquest.col, bold: true } },
      { text: counts.lost ? `   (dont ${counts.lost} position${counts.lost > 1 ? "s" : ""} perdue${counts.lost > 1 ? "s" : ""})` : "", options: { color: C.inkMid, italic: true } },
      { text: d.blindSpotsCount > 0 ? `   ·   ${d.blindSpotsCount} angle${d.blindSpotsCount > 1 ? "s" : ""} mort${d.blindSpotsCount > 1 ? "s" : ""} (ni vous ni vos concurrents)` : "", options: { color: C.inkMid, italic: true } },
    ], { x: 0.6, y: 1.42, w: 12.1, h: 0.35, fontSize: 12 });
    const rows = d.questionStatus.slice(0, 13).map(q => ([
      { text: ST[q.status].label + (q.lost ? " ⟳" : ""), options: { color: ST[q.status].col, bold: true, fontSize: 10 } },
      { text: (q.question || "").length > 105 ? q.question.slice(0, 102) + "…" : (q.question || ""), options: { color: C.ink, fontSize: 11 } },
      { text: `${q.presentOn}/${q.providersOn}`, options: { color: C.inkMid, fontSize: 10, align: "center" } },
    ]));
    s.addTable([[
      { text: "Statut", options: { bold: true, color: C.white, fill: { color: C.green }, fontSize: 10 } },
      { text: "Question", options: { bold: true, color: C.white, fill: { color: C.green }, fontSize: 10 } },
      { text: "Moteurs", options: { bold: true, color: C.white, fill: { color: C.green }, fontSize: 10, align: "center" } },
    ], ...rows], { x: 0.6, y: 1.9, w: 12.1, colW: [2.2, 8.7, 1.2], border: { type: "solid", pt: 0.5, color: C.creamDark }, rowH: 0.34, valign: "middle" });
    s.addText("⟳ = position perdue : la marque apparaissait sur cette question mais n'apparaît plus au dernier test.", { x: 0.6, y: 6.95, w: 12.1, h: 0.3, fontSize: 10, color: C.inkLight, italic: true });
    footer(s, 9);
  }

  // 10 — Pistes prioritaires (reco + pourquoi/comment/combien)
  if (d.leads && d.leads.length) {
    const s = slide();
    kicker(s, "Recommandations"); title(s, "Pistes prioritaires");
    let y = 1.7;
    d.leads.slice(0, 4).forEach((l) => {
      s.addShape(p.ShapeType.rect, { x: 0.6, y: y + 0.02, w: 0.08, h: 1.05, fill: { color: l.col } });
      s.addText(l.reco, { x: 0.85, y, w: 11.9, h: 0.32, fontSize: 14, bold: true, color: C.green, fontFace: "Georgia" });
      s.addText([
        { text: "Pourquoi  ", options: { bold: true, color: l.col } }, { text: l.why || "", options: { color: C.inkMid, breakLine: true } },
        { text: "Comment  ", options: { bold: true, color: l.col } }, { text: l.how || "", options: { color: C.inkMid, breakLine: true } },
        { text: "Combien  ", options: { bold: true, color: l.col } }, { text: l.howMuch || "", options: { color: C.inkMid } },
      ], { x: 0.85, y: y + 0.34, w: 11.9, h: 1.0, fontSize: 9.5, valign: "top", lineSpacingMultiple: 1.04 });
      y += 1.32;
    });
    footer(s, 10);
  }

  // 10 — Plan d'action
  {
    const s = slide(C.green);
    s.addText("PLAN D'ACTION", { x: 0.6, y: 0.5, w: 12, h: 0.3, fontSize: 11, color: C.accent, bold: true, charSpacing: 2 });
    s.addText("Et maintenant ?", { x: 0.6, y: 0.8, w: 12, h: 0.7, fontSize: 30, color: C.white, bold: true, fontFace: "Georgia" });
    if (d.diagnostic?.verdict) {
      s.addText([{ text: "Verdict.  ", options: { bold: true, color: C.accent } }, { text: d.diagnostic.verdict, options: { color: "E8EFE9" } }], { x: 0.6, y: 1.7, w: 12.1, h: 0.9, fontSize: 14, valign: "top" });
    }
    const startY = d.diagnostic?.verdict ? 2.7 : 1.8;
    const PR = { haute: C.accent, moyenne: C.warn, basse: C.greenLight };
    (d.roadmap.length ? d.roadmap : [{ action: "Générez le plan d'action depuis l'onglet « Et maintenant ? » pour l'inclure ici.", priority: "moyenne" }]).forEach((r, i) => {
      const y = startY + i * 0.68;
      s.addShape(p.ShapeType.rect, { x: 0.6, y: y + 0.05, w: 0.09, h: 0.5, fill: { color: PR[r.priority] || C.greenLight } });
      s.addText(`${i + 1}`, { x: 0.8, y, w: 0.5, h: 0.6, fontSize: 16, bold: true, color: C.accent, fontFace: "Georgia", valign: "middle" });
      s.addText(r.action || "", { x: 1.35, y, w: 10.0, h: 0.6, fontSize: 13, color: "F0F3F1", valign: "middle" });
      if (r.priority) s.addText((r.priority).toUpperCase(), { x: 11.4, y, w: 1.3, h: 0.6, fontSize: 9, bold: true, color: PR[r.priority] || C.greenLight, align: "right", valign: "middle" });
    });
  }

  p.writeFile({ fileName: `Audit_GEO_${d.brandName.replace(/\s+/g, "_")}_${fileDate()}.pptx` });
}

// ════════════════════════ PDF (présentable) ════════════════════════
export async function exportAuditPdf(audit, brand, site, roadmapData, categories = [], sentiment = null) {
  const jsPDF = await loadJsPDF();
  const d = buildAuditDeck(audit, brand, site, roadmapData, categories, sentiment);
  // jsPDF (police standard WinAnsi) ne gère pas tout l'Unicode → on normalise.
  const sf = (t) => String(t == null ? "" : t)
    .replace(/[\u2012-\u2015]/g, "-").replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, "...").replace(/[\u2022\u2605\u2606]/g, "-")
    .replace(/\u202f|\u00a0/g, " ").replace(/\u2192/g, "->");
  // 16:9 en mm (paysage)
  const W = 338.7, H = 190.5;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [W, H] });
  // Sanitize automatiquement tout texte rendu (accents OK en Latin-1, le reste normalisé).
  const _text = doc.text.bind(doc);
  doc.text = (txt, x, y, opts) => _text(Array.isArray(txt) ? txt.map(sf) : sf(txt), x, y, opts);
  const _split = doc.splitTextToSize.bind(doc);
  doc.splitTextToSize = (txt, w, o) => _split(sf(txt), w, o);
  const rgb = (hexc) => { const n = parseInt(hexc, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const setFill = (c) => doc.setFillColor(...rgb(c));
  const setText = (c) => doc.setTextColor(...rgb(c));
  const setDraw = (c) => doc.setDrawColor(...rgb(c));
  let page = 0;
  const newPage = (bg) => { if (page > 0) doc.addPage([W, H], "landscape"); page++; if (bg) { setFill(bg); doc.rect(0, 0, W, H, "F"); } };
  const foot = () => { doc.setFontSize(8); setText(C.inkLight); doc.text(`${d.brandName} · Audit GEO · ${d.date}`, 16, H - 8); doc.text(`${page}`, W - 14, H - 8, { align: "right" }); };
  const head = (kick, ttl) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); setText(C.accent); doc.text(kick.toUpperCase(), 16, 20);
    doc.setFontSize(26); setText(C.green); doc.text(ttl, 16, 32);
  };
  const hbars = (items, x, y, w, maxBarW, color, suffix = "%") => {
    // En %, la barre pleine représente 100 % ; sinon échelle relative au max.
    const max = suffix === "%" ? 100 : Math.max(1, ...items.map(i => i.val));
    doc.setFontSize(11);
    items.forEach((it, i) => {
      const yy = y + i * 13;
      setText(C.ink); doc.setFont("helvetica", "normal"); doc.text(it.label, x, yy + 4, { maxWidth: w });
      const bx = x + w + 4, bw = (it.val / max) * maxBarW;
      setFill(C.creamDark); doc.roundedRect(bx, yy, maxBarW, 6, 1, 1, "F");
      setFill(color); doc.roundedRect(bx, yy, Math.max(1.5, bw), 6, 1, 1, "F");
      setText(C.inkMid); doc.setFont("helvetica", "bold"); doc.text(`${it.val}${suffix}`, bx + maxBarW + 4, yy + 5);
    });
  };

  // 1 — Couverture
  newPage(C.green);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); setText(C.accent);
  doc.text("AUDIT DE VISIBILITÉ GEO", 24, 70);
  doc.setFontSize(46); setText(C.white); doc.text(d.brandName, 24, 92);
  doc.setFontSize(15); setText("C9D6CE"); doc.setFont("helvetica", "normal");
  doc.text("Présence et performance dans les réponses des moteurs génératifs (LLMs)", 24, 106);
  setFill(C.accent); doc.rect(24, 116, 40, 1.6, "F");
  doc.setFontSize(12); setText("9DB3A6"); doc.text(d.date + (d.siteName ? `   ·   ${d.siteName}` : ""), 24, 168);

  // 2 — Score & KPIs
  newPage(C.white); head("Synthèse", "Score de présence GEO");
  // Anneau proportionnel : la piste crème = 100 %, l'arc coloré = le taux de présence.
  const cx = 56, cy = 110, rMid = 29, ring = 11;
  const arc = (from, to, color) => {
    setDraw(color); doc.setLineWidth(ring); doc.setLineCap("butt");
    const steps = Math.max(2, Math.ceil((to - from) / 4));
    for (let i = 0; i < steps; i++) {
      const a1 = ((from + ((to - from) * i) / steps) - 90) * Math.PI / 180;
      const a2 = ((from + ((to - from) * (i + 1)) / steps) - 90) * Math.PI / 180;
      doc.line(cx + rMid * Math.cos(a1), cy + rMid * Math.sin(a1), cx + rMid * Math.cos(a2), cy + rMid * Math.sin(a2));
    }
  };
  arc(0, 360, C.creamDark);
  if (d.score.rate > 0) arc(0, Math.max(4, (d.score.rate / 100) * 360), d.score.color);
  doc.setLineWidth(0.3);
  setText(d.score.color); doc.setFont("helvetica", "bold"); doc.setFontSize(30);
  doc.text(`${d.score.rate}%`, cx, cy + 4, { align: "center" });
  doc.setFontSize(13); doc.text(d.score.label, cx, cy + rMid + ring / 2 + 14, { align: "center" });
  // Cards KPI empilées verticalement, valeur + libellé sur la même ligne
  const kx = 110, ky = 52, kw = W - 16 - kx, kh = 18, kg = 7;
  d.kpis.slice(0, 4).forEach((k, i) => {
    const y = ky + i * (kh + kg);
    setFill(C.greenPale); doc.roundedRect(kx, y, kw, kh, 2, 2, "F");
    setText(C.green); doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.text(`${k.v}`, kx + 10, y + 12.5);
    setText(C.inkMid); doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.text(k.l, kx + 44, y + 12.5);
  });
  setText(C.inkMid); doc.setFontSize(12);
  doc.text(`${d.score.withBrand} réponses sur ${d.score.total} analysées citent la marque — ${d.score.questions} questions suivies sur ${d.nProviders} moteur${d.nProviders > 1 ? "s" : ""}${d.distinctRuns ? ` (${d.distinctRuns} interrogations distinctes)` : ""}.`, kx, ky + 4 * (kh + kg) + 8, { maxWidth: 212 });
  foot();

  // 3 — Providers
  if (d.providers.length) {
    newPage(C.white); head("Visibilité", "Présence par moteur IA");
    hbars(d.providers.map(p => ({ label: p.label, val: p.rate })), 16, 50, 50, 200, C.green, "%");
    setText(C.inkMid); doc.setFont("helvetica", "italic"); doc.setFontSize(10);
    doc.text(doc.splitTextToSize("Les écarts entre moteurs sont normaux : chaque IA s'appuie sur des sources différentes (recherche web pour ChatGPT, Gemini et Perplexity, connaissances internes pour Claude) et sur ses propres critères de sélection.", W - 40), 16, 58 + d.providers.length * 13 + 8);
    doc.setFont("helvetica", "normal");
    foot();
  }

  // 4 — Présence dans le temps (taux par jour de test)
  if (d.presenceTrend.length > 1) {
    newPage(C.white); head("Tendance", "Présence dans le temps");
    setText(C.inkMid); doc.setFontSize(11); doc.setFont("helvetica", "normal");
    doc.text("Taux de présence de la marque par jour de test (réponses avec marque / réponses analysées).", 16, 42);
    const gx = 24, gy = 158, gw = 290, gh = 100;
    setDraw(C.creamDark); doc.setLineWidth(0.3);
    [0, 50, 100].forEach(v => { const yy = gy - (v / 100) * gh; doc.line(gx, yy, gx + gw, yy); setText(C.inkLight); doc.setFontSize(8); doc.text(`${v}%`, gx - 3, yy + 2, { align: "right" }); });
    const pts = d.presenceTrend, n = pts.length;
    setDraw(C.accent); doc.setLineWidth(1.2);
    pts.forEach((t, i) => {
      const x = gx + (n > 1 ? (i / (n - 1)) * gw : gw / 2), y = gy - (t.rate / 100) * gh;
      if (i > 0) { const px = gx + ((i - 1) / (n - 1)) * gw, py = gy - (pts[i - 1].rate / 100) * gh; doc.line(px, py, x, y); }
      setFill(C.accent); doc.circle(x, y, 1.4, "F");
      setText(C.accent); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text(`${t.rate}%`, x, y - 4, { align: "center" });
      setText(C.inkMid); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.text((t.date || "").slice(5), x, gy + 6, { align: "center" });
    });
    foot();
  }

  // 5 — Catégories
  if (d.cats.length) {
    newPage(C.white); head("Thématiques", "Présence par catégorie");
    hbars(d.cats.slice(0, 8).map(c => ({ label: catLabel(c), val: c.rate })), 16, 50, 60, 190, C.greenMid, "%");
    foot();
  }

  // 6 — Concurrents
  if (d.comps.length) {
    newPage(C.white); head("Concurrence", "Paysage concurrentiel GEO");
    if (d.sovBrandPct != null) { doc.setFontSize(12); setText(C.accent); doc.setFont("helvetica", "bold"); doc.text(`Part de voix de ${d.brandName} : ${d.sovBrandPct}%`, 16, 42); }
    hbars([{ label: `${d.brandName} (vous)`, val: d.score.withBrand }, ...d.comps.map(c => ({ label: c.name, val: c.count }))], 16, 50, 60, 180, C.accent, "");
    foot();
  }

  // 7 — Perception de la marque (sentiment IA)
  if (d.sentiment) {
    const se = d.sentiment;
    const sCol = { "positif": C.greenLight, "plutôt positif": C.greenLight, "neutre": C.inkMid, "mitigé": C.accent, "négatif": "9B2335" }[se.overall] || C.green;
    newPage(C.white); head("Perception", "Perception de la marque");
    // Badge tonalité + score
    setFill(C.greenPale); doc.roundedRect(16, 44, 70, 34, 2, 2, "F");
    setText(sCol); doc.setFont("helvetica", "bold"); doc.setFontSize(12);
    doc.text((se.overall || "—").toUpperCase(), 51, 54, { align: "center" });
    doc.setFontSize(30); doc.text(se.score != null ? `${se.score}` : "—", 51, 70, { align: "center" });
    setText(C.inkLight); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text("Tonalité globale /100", 51, 76, { align: "center" });
    // Résumé
    setText(C.inkMid); doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    doc.text(doc.splitTextToSize(se.summary || "", W - 112), 96, 50);
    // Atouts perçus
    let yA = 92;
    setText(C.greenLight); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("ATOUTS PERÇUS", 16, yA);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); setText(C.inkMid); yA += 7;
    (se.strengths || []).slice(0, 5).forEach(t => { const lines = doc.splitTextToSize("• " + t, 140); doc.text(lines, 16, yA); yA += lines.length * 5 + 1.5; });
    // Points de vigilance
    let yW = 92;
    setText(C.accent); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("POINTS DE VIGILANCE", 180, yW);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); yW += 7;
    const watch = (se.watchouts || []).slice(0, 5);
    if (watch.length) { setText(C.inkMid); watch.forEach(t => { const lines = doc.splitTextToSize("• " + t, 142); doc.text(lines, 180, yW); yW += lines.length * 5 + 1.5; }); }
    else { doc.setFont("helvetica", "italic"); setText(C.inkLight); doc.text("Aucun point de vigilance notable.", 180, yW); }
    foot();
  }

  // 8 — Sources
  newPage(C.white); head("Sources", "URLs de la marque & opportunités");
  const tiles = [
    { v: d.sources.own, l: "URLs propres citées", c: C.green },
    { v: d.sources.optimize, l: "À optimiser", c: C.warn },
    { v: d.sources.rework, l: "À retravailler", c: C.danger },
    { v: d.sources.inspire, l: "Pages de référence", c: C.blue },
  ];
  tiles.forEach((t, i) => {
    const x = 16 + i * 80;
    setFill(C.greenPale); doc.roundedRect(x, 46, 72, 30, 2, 2, "F");
    setText(t.c); doc.setFont("helvetica", "bold"); doc.setFontSize(24); doc.text(`${t.v}`, x + 10, 62);
    setText(C.inkMid); doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text(t.l, x + 10, 70);
  });
  if (d.sources.topOwn.length) {
    setText(C.green); doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text("Principales URLs propres citées comme sources", 16, 92);
    doc.setFontSize(11);
    d.sources.topOwn.forEach((u, i) => {
      const y = 102 + i * 9;
      setText(C.ink); doc.setFont("helvetica", "normal"); doc.text(u.url, 16, y, { maxWidth: 260 });
      setText(C.inkMid); doc.text(`${u.n} citations`, W - 16, y, { align: "right" });
      setDraw(C.creamDark); doc.setLineWidth(0.2); doc.line(16, y + 3, W - 16, y + 3);
    });
  }
  foot();

  // 9 — Questions par statut (À défendre / À surveiller / Conquête prioritaire)
  if (d.questionStatus.length) {
    newPage(C.white); head("Questions", "Statut GEO des questions suivies");
    const STp = { defend: { label: "À défendre", col: "1A7A4A" }, watch: { label: "À surveiller", col: C.warn }, conquest: { label: "Conquête prioritaire", col: C.accent } };
    const cnt = { defend: 0, watch: 0, conquest: 0, lost: 0 };
    d.questionStatus.forEach(q => { cnt[q.status]++; if (q.lost) cnt.lost++; });
    doc.setFontSize(11); doc.setFont("helvetica", "bold");
    setText(STp.defend.col); doc.text(`${cnt.defend} à défendre`, 16, 42);
    setText(STp.watch.col); doc.text(`${cnt.watch} à surveiller`, 70, 42);
    setText(STp.conquest.col); doc.text(`${cnt.conquest} en conquête prioritaire`, 126, 42);
    if (cnt.lost) { setText(C.inkMid); doc.setFont("helvetica", "italic"); doc.setFontSize(10); doc.text(`dont ${cnt.lost} position${cnt.lost > 1 ? "s" : ""} perdue${cnt.lost > 1 ? "s" : ""} (⟳)`, 210, 42); }
    if (d.blindSpotsCount > 0) { setText(C.inkMid); doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.text(`${d.blindSpotsCount} angle${d.blindSpotsCount > 1 ? "s" : ""} mort${d.blindSpotsCount > 1 ? "s" : ""} : questions où ni vous ni vos concurrents n'apparaissez.`, 16, 49); doc.setFont("helvetica", "normal"); }
    let qy = 56;
    d.questionStatus.slice(0, 16).forEach(q => {
      const st = STp[q.status];
      setFill(st.col); doc.rect(16, qy - 3.2, 2.6, 4.4, "F");
      setText(st.col); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5);
      doc.text(st.label.toUpperCase() + (q.lost ? " ⟳" : ""), 21, qy);
      setText(C.ink); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      const qt = (q.question || "").length > 118 ? q.question.slice(0, 115) + "…" : (q.question || "");
      doc.text(qt, 66, qy);
      setText(C.inkMid); doc.setFontSize(9); doc.text(`${q.presentOn}/${q.providersOn}`, W - 16, qy, { align: "right" });
      qy += 7.4;
    });
    setText(C.inkLight); doc.setFont("helvetica", "italic"); doc.setFontSize(9);
    doc.text("⟳ = position perdue : la marque apparaissait sur cette question mais n'apparaît plus au dernier test.", 16, H - 14);
    doc.setFont("helvetica", "normal");
    foot();
  }

  // 10 — Pistes prioritaires (reco + pourquoi/comment/combien)
  if (d.leads && d.leads.length) {
    newPage(C.white); head("Recommandations", "Pistes prioritaires");
    let y = 46;
    d.leads.slice(0, 4).forEach((l) => {
      const startY = y;
      setText(C.green); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
      doc.text(l.reco || "", 22, y); y += 7;
      const row = (lab, txt) => {
        setText(l.col); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.text(lab, 22, y);
        setText(C.inkMid); doc.setFont("helvetica", "normal");
        const lines = doc.splitTextToSize(txt || "", W - 66); doc.text(lines, 46, y);
        y += Math.max(4.5, lines.length * 4.4) + 1.5;
      };
      row("Pourquoi", l.why); row("Comment", l.how); row("Combien", l.howMuch);
      setFill(l.col); doc.rect(16, startY - 4, 1.6, (y - startY) - 1, "F");
      y += 4;
    });
  }

  // 10 — Plan d'action
  newPage(C.green);
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); setText(C.accent); doc.text("PLAN D'ACTION", 16, 22);
  doc.setFontSize(26); setText(C.white); doc.text("Et maintenant ?", 16, 36);
  let y = 50;
  if (d.diagnostic?.verdict) {
    doc.setFontSize(13); setText(C.accent); doc.setFont("helvetica", "bold"); doc.text("Verdict.", 16, y);
    setText("E8EFE9"); doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(d.diagnostic.verdict, 300); doc.text(lines, 34, y); y += lines.length * 6 + 8;
  }
  const PR = { haute: C.accent, moyenne: C.warn, basse: C.greenLight };
  const rmList = d.roadmap.length ? d.roadmap : [{ action: "Générez le plan depuis l'onglet « Et maintenant ? » pour l'inclure ici.", priority: "moyenne" }];
  rmList.forEach((r, i) => {
    setFill(PR[r.priority] || C.greenLight); doc.rect(16, y - 4, 1.6, 9, "F");
    setText(C.accent); doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.text(`${i + 1}`, 22, y + 3);
    setText("F0F3F1"); doc.setFont("helvetica", "normal"); doc.setFontSize(12);
    const lines = doc.splitTextToSize(r.action || "", 270); doc.text(lines, 30, y + 3);
    if (r.priority) { setText(PR[r.priority] || C.greenLight); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.text(r.priority.toUpperCase(), W - 16, y + 3, { align: "right" }); }
    y += Math.max(13, lines.length * 6 + 6);
  });

  // 12 — Roadmap ICE (priorisation Impact / Confiance / Effort)
  if (d.roadmap.length && d.roadmap.some(r => r.impact != null || r.confidence != null || r.ease != null)) {
    newPage(C.white); head("Roadmap", "Priorisation ICE");
    setText(C.inkMid); doc.setFontSize(10.5); doc.setFont("helvetica", "normal");
    doc.text("Chaque action est notée de 1 à 10 sur trois critères : Impact attendu, Confiance dans le résultat, Facilité de mise en œuvre. Score ICE = I + C + E (sur 30).", 16, 42, { maxWidth: W - 32 });
    const col = { act: 16, i: 236, c: 256, e: 276, ice: 296, pr: 314 };
    let ry = 58;
    setFill(C.green); doc.rect(14, ry - 5, W - 28, 8, "F");
    setText(C.white); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text("Action", col.act + 4, ry); doc.text("I", col.i, ry, { align: "center" }); doc.text("C", col.c, ry, { align: "center" }); doc.text("E", col.e, ry, { align: "center" }); doc.text("ICE", col.ice, ry, { align: "center" }); doc.text("Priorité", col.pr, ry);
    ry += 9;
    const PRc = { haute: C.accent, moyenne: C.warn, basse: C.greenLight };
    d.roadmap.forEach((r) => {
      const ice = (r.impact || 0) + (r.confidence || 0) + (r.ease || 0);
      setText(C.ink); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      const lines = doc.splitTextToSize(r.action || "", 208);
      doc.text(lines, col.act + 4, ry);
      setText(C.inkMid); doc.setFontSize(10);
      doc.text(`${r.impact ?? "—"}`, col.i, ry, { align: "center" });
      doc.text(`${r.confidence ?? "—"}`, col.c, ry, { align: "center" });
      doc.text(`${r.ease ?? "—"}`, col.e, ry, { align: "center" });
      setText(C.green); doc.setFont("helvetica", "bold"); doc.text(`${ice || "—"}`, col.ice, ry, { align: "center" });
      setText(PRc[r.priority] || C.greenLight); doc.setFontSize(8); doc.text((r.priority || "").toUpperCase(), col.pr, ry);
      ry += Math.max(9, lines.length * 5 + 4);
      setDraw(C.creamDark); doc.setLineWidth(0.2); doc.line(14, ry - 6, W - 14, ry - 6);
    });
    foot();
  }

  doc.save(`Audit_GEO_${d.brandName.replace(/\s+/g, "_")}_${fileDate()}.pdf`);
}