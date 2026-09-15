import { SCHEMA_TYPES } from "./constants";
import { safeNum, avg, toUrlPath } from "./helpers";

// ── GSC value helper ─────────────────────────────────────────────
export function gscVal(r, ...keys) {
  return keys.map(k => r[k]).find(v => v !== undefined && v !== null && v !== "") ?? null;
}

// ── FILTER ROWS BY PAGE MODE ─────────────────────────────────────
export function filterByMode(rows, mode, bingRows, gscRows = []) {
  if (mode === "all") return rows;

  if (mode === "geo") {
    const bingPaths = new Set(
      bingRows
        .filter(r => safeNum(r["citations"] || r["mentions"] || 0) >= 1)
        .map(r => toUrlPath(r["page"] || r["url"] || r["adresse"] || ""))
    );
    if (bingPaths.size === 0) return rows;
    return rows.filter(r => bingPaths.has(toUrlPath(r["adresse"] || r["address"] || r["url"] || "")));
  }

  if (mode === "seo") {
    if (gscRows.length > 0) {
      const col = (r) => r["pages les plus populaires"] || r["page"] || r["adresse"] || r["url"] || "";
      const gscWithClics = gscRows.filter(r => safeNum(r["clics"] || r["clicks"] || 0) > 0);
      const src = gscWithClics.length > 0 ? gscWithClics : gscRows;
      const pathDedup = {};
      src.forEach(r => {
        const p = toUrlPath(col(r));
        if (!pathDedup[p] || safeNum(r["clics"] || r["clicks"]) > safeNum(pathDedup[p]["clics"] || pathDedup[p]["clicks"])) pathDedup[p] = r;
      });
      const sorted = Object.values(pathDedup).sort((a, b) => safeNum(b["clics"] || b["clicks"]) - safeNum(a["clics"] || a["clicks"]));
      const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.3)));
      const topPaths = new Set(top.map(r => toUrlPath(col(r))));
      return rows.filter(r => topPaths.has(toUrlPath(r["adresse"] || r["address"] || r["url"] || "")));
    }
    return [];
  }

  return rows;
}

// ── DETECT SCHEMA TYPES ─────────────────────────────────────────
function detectSchemas(jsonStr) {
  if (!jsonStr) return [];
  const lower = jsonStr.toLowerCase();
  return SCHEMA_TYPES.filter(type =>
    lower.includes(`"@type":"${type.toLowerCase()}`) ||
    lower.includes(`"@type": "${type.toLowerCase()}`)
  );
}

// ── EXTRACT SF ──────────────────────────────────────────────────
export function extractSF(rows, mode = "all", bingRows = [], gscRows = []) {
  if (!rows.length) return null;

  const filtered = filterByMode(rows, mode, bingRows, gscRows);

  const html = filtered.filter(r => {
    const ct = (r["type de contenu"] || r["content type"] || r["type"] || "").toLowerCase();
    const sc = safeNum(r["code http"] || r["status code"] || r["statuscode"] || 200);
    const isHtml = ct.includes("html") || (ct === "" && (r["title 1"] || r["h1-1"] || r["h1"] || "").trim() !== "");
    return isHtml && sc < 400;
  });
  const total    = html.length || 1;
  const allTotal = filtered.length || 1;

  const titleLens  = html.map(r => safeNum(r["longueur du title 1"] || r["title 1 length"] || 0) || (r["title 1"] || "").length).filter(l => l > 0);
  const metaLens   = html.map(r => safeNum(r["longueur de la meta description 1"] || r["meta description 1 length"] || 0) || (r["meta description 1"] || "").length).filter(l => l > 0);
  const h1Lens     = html.map(r => safeNum(r["longueur du h1-1"] || r["h1-1 length"] || 0) || (r["h1-1"] || r["h1"] || "").trim().length).filter(l => l > 0);
  const pageSizes  = html.map(r => safeNum(r["taille (octets)"] || r["size"] || 0));
  const imgRows    = filtered.filter(r => (r["type de contenu"] || r["content type"] || r["type"] || "").toLowerCase().includes("image"));
  const imgSizes   = imgRows.map(r => safeNum(r["taille (octets)"] || r["size"] || 0));
  const words      = html.map(r => safeNum(r["nombre de mots"] || r["word count"] || 0)).filter(x => x > 0);
  const inlk       = html.map(r => safeNum(r["liens entrants"]                    || r["inlinks"]  || 0));
  const outlk      = html.map(r => safeNum(r["liens sortants"]                    || r["outlinks"] || 0));
  const inlkUniq   = html.map(r => safeNum(r["liens entrants uniques"]            || 0));
  const outlkUniq  = html.map(r => safeNum(r["liens sortants uniques"]            || 0));
  const extlkUniq  = html.map(r => safeNum(r["liens sortants externes uniques"]   || 0));
  const depth      = html.map(r => safeNum(r["crawl profondeur"] || r["crawl depth"] || 0)).filter(x => x >= 0);
  const flesch     = html.map(r => safeNum(r["score de lisibilité de flesch"] || r["flesch reading ease"] || 0)).filter(x => x > 0);

  const indexable = html.filter(r => {
    const idx = (r["indexabilité"] || r["indexability"] || r["indexable"] || "").toLowerCase();
    return idx === "indexable" || idx === "" || idx === "true";
  }).length;

  const withTable = html.filter(r => {
    for (let i = 1; i <= 18; i++) {
      const val = r[`présence table ${i}`] || r[`presence table ${i}`] || r[`table ${i}`] || "";
      if (val && val.trim() !== "" && val.trim() !== "0") return true;
    }
    return false;
  }).length;

  const schemaTypes = {};
  const withSchema = html.filter(r => {
    const jsons = [r["json 1"], r["json 2"], r["json 3"], r["json 4"], r["json 5"]].filter(Boolean).join(" ");
    if (!jsons) return false;
    detectSchemas(jsons).forEach(t => { schemaTypes[t] = (schemaTypes[t] || 0) + 1; });
    return detectSchemas(jsons).length > 0;
  }).length;

  const redirects = filtered.filter(r => { const sc = safeNum(r["code http"] || r["status code"] || 200); return sc >= 300 && sc < 400; }).length;
  const errors    = filtered.filter(r => { const sc = safeNum(r["code http"] || r["status code"] || 200); return sc >= 400; }).length;

  const llmsRow     = rows.find(r => /\/llms\.txt$/i.test((r["adresse"] || r["address"] || r["url"] || "").trim()));
  const llmsFullRow = rows.find(r => /\/llms-full\.txt$/i.test((r["adresse"] || r["address"] || r["url"] || "").trim()));
  const llmsStatus     = llmsRow     ? safeNum(llmsRow["code http"]     || llmsRow["status code"]     || 0) : null;
  const llmsFullStatus = llmsFullRow ? safeNum(llmsFullRow["code http"] || llmsFullRow["status code"] || 0) : null;

  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const mean = (arr) => arr.length ? sum(arr) / arr.length : 0;

  return {
    totalPages:      total,
    totalImg:        imgRows.length,
    indexableRate:   Math.round((indexable / total) * 100),
    avgTitleLen:     Math.round(mean(titleLens)),
    avgMetaLen:      Math.round(mean(metaLens)),
    avgH1Len:        Math.round(mean(h1Lens)),
    avgWords:        Math.round(mean(words)),
    avgPageSizeKB:   Math.round(avg(pageSizes) / 1024),
    avgImgSizeKB:    imgSizes.length ? Math.round(avg(imgSizes) / 1024) : 0,
    avgInlinks:      Math.round(avg(inlk)     * 10) / 10,
    avgOutlinks:     Math.round(avg(outlk)    * 10) / 10,
    avgInlinksUniq:  Math.round(avg(inlkUniq) * 10) / 10,
    avgOutlinksUniq: Math.round(avg(outlkUniq)* 10) / 10,
    avgExtLinksUniq: Math.round(avg(extlkUniq)* 10) / 10,
    avgDepth:        Math.round(mean(depth)   * 10) / 10,
    avgFlesch:       Math.round(mean(flesch)  * 10) / 10,
    tableRate:       Math.round((withTable / total) * 100),
    schemaRate:      Math.round((withSchema / total) * 100),
    schemaTypes,
    errorRate:       Math.round((errors    / allTotal) * 100),
    redirectRate:    Math.round((redirects / allTotal) * 100),
    llms:     llmsRow     ? { present: true,  status: llmsStatus,     url: llmsRow["adresse"]     || llmsRow["url"]     || "" } : { present: false },
    llmsFull: llmsFullRow ? { present: true,  status: llmsFullStatus, url: llmsFullRow["adresse"] || llmsFullRow["url"] || "" } : { present: false },
  };
}

// ── EXTRACT GSC ─────────────────────────────────────────────────
export function extractGSC(rows) {
  if (!rows.length) return null;
  const validRows = rows.filter(r => safeNum(gscVal(r, "clics", "clicks") || 0) > 0 || safeNum(gscVal(r, "impressions") || 0) > 0);
  const src = validRows.length > 0 ? validRows : rows;
  return {
    clicks:      src.map(r => safeNum(gscVal(r, "clics", "clicks") || 0)).reduce((a, b) => a + b, 0),
    impressions: src.map(r => safeNum(gscVal(r, "impressions") || 0)).reduce((a, b) => a + b, 0),
    ctr:         Math.round(avg(src.map(r => safeNum(String(gscVal(r, "ctr") || "0").replace("%", ""))).filter(x => x > 0)) * 100) / 100,
    position:    Math.round(avg(src.map(r => safeNum(gscVal(r, "position") || 0)).filter(x => x > 0)) * 10) / 10,
  };
}

// ── EXTRACT GA ──────────────────────────────────────────────────
export function extractGA(rows) {
  if (!rows.length) return null;
  return {
    sessions: rows.map(r => safeNum(r["ga4 sessions"] || r["sessions"] || r["séances"] || 0)).reduce((a, b) => a + b, 0),
    views:    rows.map(r => safeNum(r["ga4 views"]    || r["views"]    || r["pages vues"] || 0)).reduce((a, b) => a + b, 0),
  };
}

// ── EXTRACT BING ─────────────────────────────────────────────────
export function extractBing(rows) {
  if (!rows.length) return null;
  return {
    geoMentions: rows.map(r => safeNum(r["citations"] || r["mentions"] || r["impressions"] || r["appearancecount"] || 0)).reduce((a, b) => a + b, 0),
    pageCount:   rows.filter(r => safeNum(r["citations"] || r["mentions"] || 0) >= 1).length,
  };
}

// ── PARSE SEMRUSH (position tracking - landing pages) ────────────
// Format : 5 lignes header + 1 vide, puis colonnes avec dates préfixées
// Une ligne par (URL × mot-clé) → agrégation par URL
export function parseSemrush(rows) {
  if (!rows.length) return [];

  const key = (row, ...candidates) => {
    for (const c of candidates) {
      const found = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
      if (found !== undefined && row[found] !== undefined && row[found] !== "") return row[found];
    }
    return null;
  };

  const cols = Object.keys(rows[0]).map(k => k.toLowerCase());

  // ── Détection du format ────────────────────────────────────────
  // Keyword Overview: Keyword,Position,Previous position,Search Volume,...
  const isKeywordOverview = cols.includes("keyword") && cols.includes("position") && cols.includes("search volume");
  if (isKeywordOverview) {
    // Retourne les données brutes pour usage dans les volumes de mots-clés
    return rows.map(row => {
      const keyword  = (key(row, "keyword") || "").trim().toLowerCase();
      const position = safeNum(key(row, "position") || 0);
      const volume   = safeNum(key(row, "search volume") || 0);
      const url      = (key(row, "url") || "").trim();
      const traffic  = safeNum(key(row, "traffic") || 0);
      const kd       = safeNum(key(row, "keyword difficulty") || 0);
      if (!keyword) return null;
      return { keyword, position, volume, url, traffic, kd, _format: "keyword_overview" };
    }).filter(Boolean);
  }

  const isOrganicPages = cols.includes("number of keywords") || cols.includes("traffic (%)");
  const datePattern = /^(\d{8})_/;
  const dates = [...new Set(
    cols.map(c => { const m = c.match(datePattern); return m ? m[1] : null; }).filter(Boolean)
  )].sort();
  const latest = dates[dates.length - 1];

  if (isOrganicPages) {
    // ── Format Organic Research Pages ─────────────────────────────
    // Colonnes : URL, Traffic (%), Number of Keywords, Traffic, Traffic Change,
    //   Positions with {intent} intents in top 20, Traffic with {intent} intents in top 20
    return rows.map(row => {
      const url     = (key(row, "url") || "").trim();
      if (!url) return null;
      const kwCount  = safeNum(key(row, "number of keywords") || 0);
      // Explicit: match "traffic" but NOT "traffic (%)" or "traffic with ..."
      const trafficRaw = (() => {
        const k = Object.keys(row).find(k => {
          const kl = k.toLowerCase().trim();
          return kl === "traffic" || kl === "traffic ";
        });
        return k ? row[k] : null;
      })();
      const traffic  = safeNum(trafficRaw || 0);
      const delta    = safeNum(key(row, "traffic change") || 0);
      // Positions par intent (top 20)
      const posComm  = safeNum(key(row, "positions with commercial intents in top 20") || 0);
      const posInfo  = safeNum(key(row, "positions with informational intents in top 20") || 0);
      const posNav   = safeNum(key(row, "positions with navigational intents in top 20") || 0);
      const posTrans = safeNum(key(row, "positions with transactional intents in top 20") || 0);
      const posTotal = posComm + posInfo + posNav + posTrans
        + safeNum(key(row, "positions with unknown intents in top 20") || 0);
      const trafficPct = safeNum(key(row, "traffic (%)") || 0);
      const trafficComm  = safeNum(key(row, "traffic with commercial intents in top 20")  || 0);
      const trafficInfo  = safeNum(key(row, "traffic with informational intents in top 20") || 0);
      const trafficNav   = safeNum(key(row, "traffic with navigational intents in top 20")  || 0);
      const trafficTrans = safeNum(key(row, "traffic with transactional intents in top 20") || 0);
      return {
        url,
        kwCount,
        traffic,
        trafficPct,
        trafficDelta: delta,
        top20: posTotal,
        // Intent — positions
        intentCommercial:    posComm,
        intentInformational: posInfo,
        intentNavigational:  posNav,
        intentTransactional: posTrans,
        // Intent — traffic
        trafficCommercial:    trafficComm,
        trafficInformational: trafficInfo,
        trafficNavigational:  trafficNav,
        trafficTransactional: trafficTrans,
        format: "organic_pages",
      };
    }).filter(Boolean);
  }

  // ── Format Position Tracking ───────────────────────────────────
  // Deux sous-formats :
  // • Page-level  : 1 ligne par URL — colonnes YYYYMMDD_average, _keywords_count, _estimated_traffic
  // • Keyword-level : 1 ligne par (URL × mot-clé) — colonnes YYYYMMDD_position, volume
  if (!latest) return [];

  // Détecte si page-level (colonne _average présente, _position absente)
  const sampleRow = rows[0] || {};
  const hasPositionCol = Object.keys(sampleRow).some(k => k.toLowerCase() === `${latest}_position`);
  const hasAverageCol  = Object.keys(sampleRow).some(k => k.toLowerCase() === `${latest}_average`);
  const isPageLevel = !hasPositionCol && hasAverageCol;

  const byUrl = {};
  for (const row of rows) {
    const url = (key(row, "url") || "").trim();
    if (!url) continue;

    if (isPageLevel) {
      // Page-level : 1 ligne = 1 URL, toutes les métriques sont directes
      const kwCount  = safeNum(key(row, `${latest}_keywords_count`) || key(row, "keywords_count_difference") || 0);
      const traffic  = safeNum(key(row, `${latest}_estimated_traffic`) || key(row, "estimated_traffic_difference") || 0);
      const avgPos   = safeNum(key(row, `${latest}_average`) || key(row, "average_difference") || 0);
      const totalVol = safeNum(key(row, `${latest}_volume`) || key(row, "volume") || 0);
      // top3/top10/opps estimés via avgPos (pas de détail par mot-clé)
      const estTop3  = avgPos > 0 && avgPos <= 3  ? Math.max(1, Math.round(kwCount * 0.3)) : 0;
      const estTop10 = avgPos > 0 && avgPos <= 10 ? Math.max(1, Math.round(kwCount * 0.6)) : 0;
      const estOpps  = avgPos > 10 && avgPos <= 20 ? Math.max(1, Math.round(kwCount * 0.4)) : 0;
      byUrl[url] = { url, kwCount, traffic, totalVol, avgPos, top3: estTop3, top10: estTop10, opps: estOpps };
    } else {
      // Keyword-level : 1 ligne par (URL × mot-clé)
      const position = safeNum(key(row, `${latest}_position`) || key(row, "position_difference") || 0);
      const volume   = safeNum(key(row, "volume") || 0);
      if (!byUrl[url]) {
        byUrl[url] = {
          url,
          kwCount:   safeNum(key(row, `${latest}_keywords_count`) || key(row, "keywords_count_difference") || 0),
          traffic:   safeNum(key(row, `${latest}_estimated_traffic`) || key(row, "estimated_traffic_difference") || 0),
          totalVol:  safeNum(key(row, `${latest}_volume`) || key(row, "volume") || 0),
          avgPosRaw: safeNum(key(row, `${latest}_average`) || key(row, "average_difference") || 0),
          keywords:  [],
        };
      }
      if (position > 0) byUrl[url].keywords.push({ position, volume });
    }
  }

  return Object.values(byUrl).map(u => {
    if (isPageLevel) {
      return { url: u.url, kwCount: u.kwCount, top3: u.top3, top10: u.top10, opps: u.opps, avgPos: u.avgPos, traffic: u.traffic, totalVol: u.totalVol, trafficDelta: 0, format: "position_tracking" };
    }
    const kws   = u.keywords;
    const top3  = kws.filter(k => k.position <= 3).length;
    const top10 = kws.filter(k => k.position <= 10).length;
    const opps  = kws.filter(k => k.position >= 11 && k.position <= 20).length;
    const avgPos = kws.length
      ? Math.round(kws.reduce((s, k) => s + k.position, 0) / kws.length * 10) / 10
      : u.avgPosRaw;
    return { url: u.url, kwCount: u.kwCount || kws.length, top3, top10, opps, avgPos, traffic: u.traffic, totalVol: u.totalVol, trafficDelta: 0, format: "position_tracking" };
  });
}

// ── EXTRACT SEMRUSH (agrégats site-level) ───────────────────────
export function extractSemrush(rows) {
  if (!rows.length) return null;
  const sum  = (fn) => rows.reduce((a, r) => a + (fn(r) || 0), 0);
  const mean = (fn) => { const v = rows.map(fn).filter(x => x > 0); return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length*10)/10 : 0; };
  const fmt = rows[0]?.format || "position_tracking";
  const isOrganic = fmt === "organic_pages";
  return {
    format:       fmt,
    pageCount:    rows.length,
    // Traffic
    totalTraffic: Math.round(sum(r => r.traffic)),
    trafficDelta: Math.round(sum(r => r.trafficDelta || 0)),
    pagesWithTraffic: rows.filter(r => (r.traffic || 0) > 0).length,
    pagesGrowing:     rows.filter(r => (r.trafficDelta || 0) > 0).length,
    pagesDeclining:   rows.filter(r => (r.trafficDelta || 0) < 0).length,
    // Keywords
    totalKw:      sum(r => r.kwCount),
    // Top 20 positions (organic) / Top 10 (position tracking)
    totalTop20:   isOrganic ? sum(r => r.top20 || 0) : sum(r => r.top10 || 0),
    totalTop3:    sum(r => r.top3 || 0),
    totalOpps:    sum(r => r.opps || 0),
    avgPos:       mean(r => r.avgPos),
    top3Rate:     rows.length ? Math.round(rows.filter(r => (r.top3||0) > 0).length / rows.length * 100) : 0,
    // Intent — positions (organic only)
    intentCommercial:    sum(r => r.intentCommercial    || 0),
    intentInformational: sum(r => r.intentInformational || 0),
    intentNavigational:  sum(r => r.intentNavigational  || 0),
    intentTransactional: sum(r => r.intentTransactional || 0),
    // Intent — traffic (organic only)
    trafficCommercial:    Math.round(sum(r => r.trafficCommercial    || 0)),
    trafficInformational: Math.round(sum(r => r.trafficInformational || 0)),
    trafficNavigational:  Math.round(sum(r => r.trafficNavigational  || 0)),
    trafficTransactional: Math.round(sum(r => r.trafficTransactional || 0)),
  };
}