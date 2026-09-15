// constants import removed — DEFAULT_SITES no longer used here

export function safeNum(v) {
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}

export function avg(arr) {
  const valid = arr.filter(x => x !== null && x !== undefined && !isNaN(x));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : Math.round((num / denom) * 1000) / 1000;
}

export function toUrlPath(raw) {
  const s = (raw || "").trim().toLowerCase();
  try { return new URL(s).pathname.replace(/\/+$/, "") || "/"; }
  catch { return s.replace(/\/+$/, "") || "/"; }
}

function splitCSVLine(line, sep) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === sep && !inQ) {
      fields.push(cur); cur = "";
    } else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const raw = lines[0];
  const sep = raw.includes("\t") ? "\t" : ",";
  const headers = splitCSVLine(raw, sep).map(h => h.trim().toLowerCase());
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCSVLine(lines[i], sep);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] ?? "").trim(); });
    result.push(obj);
  }
  return result;
}

export function emptyDataMap(sites) {
  return Object.fromEntries(sites.map(s => [s.id, []]));
}

export function newProject(name, sites, ownerEmail = null) {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    sites,
    owner_email: ownerEmail,
    sfData:   emptyDataMap(sites),
    gscData:  emptyDataMap(sites),
    gaData:   emptyDataMap(sites),
    bingData: emptyDataMap(sites),
    smData:   emptyDataMap(sites),
  };
}

export function makeInitialProject(ownerEmail = null) {
  const p = newProject("Mon projet", [], ownerEmail);
  p.id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return p;
}

export function corrColor(v) {
  if (v === null) return { bg: "#F5F5F7", text: "#C0C0CC", border: "#E8E8ED" };
  if (v <= -0.25) return { bg: "#FEE2E2", text: "#B91C1C", border: "#FCA5A5" };
  if (v <  -0.05) return { bg: "#FEF2F2", text: "#DC2626", border: "#FECACA" };
  if (v <   0.05) return { bg: "#F1F5F9", text: "#64748B", border: "#CBD5E1" };
  if (v <   0.25) return { bg: "#F0FDF4", text: "#16A34A", border: "#BBF7D0" };
  return              { bg: "#DCFCE7", text: "#15803D", border: "#86EFAC" };
}



// Détecte si un CSV est un export Semrush (header propriétaire sur 5 lignes)
export function isSemrushCSV(text) {
  const t = text.trimStart();
  // Format Position Tracking (header propriétaire avec tirets)
  if (t.startsWith("-----")) return true;
  const firstLine = t.split(/\r?\n/)[0].toLowerCase().replace(/"/g, "").trim();
  // Format Keyword Overview: Keyword,Position,Search Volume,...
  if (firstLine.startsWith("keyword,position,")) return true;
  if (firstLine.startsWith("keyword,") && firstLine.includes("search volume")) return true;
  // Format Organic Research Pages — cherche les colonnes clés (EN et FR)
  if (firstLine.startsWith("url,") || firstLine.startsWith("url,")) {
    const hasTraffic = firstLine.includes("traffic");
    const hasKeyword = firstLine.includes("keyword") || firstLine.includes("mot") || firstLine.includes("nombre");
    if (hasTraffic && hasKeyword) return true;
    if (hasTraffic && firstLine.split(",").length >= 4) return true;
  }
  return false;
}

// Détecte le sous-format Semrush
function semrushFormat(text) {
  const t = text.trimStart();
  if (t.startsWith("-----")) return "position_tracking";
  const firstLine = t.split(/\r?\n/)[0].toLowerCase().replace(/"/g, "").trim();
  if (firstLine.startsWith("keyword,position,") || (firstLine.startsWith("keyword,") && firstLine.includes("search volume"))) {
    return "keyword_overview";
  }
  return "organic_pages";
}

// Parse un CSV Semrush — gère les deux formats
export function parseSemrushCSV(text) {
  const lines = text.split(/\r?\n/);
  const fmt = semrushFormat(text);
  if (fmt === "position_tracking") {
    // Trouver la vraie ligne d'en-tête : celle qui commence par "Url,"
    let headerIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase().trim();
      if (lower.startsWith("url,") || lower.startsWith('"url",')) {
        headerIdx = i;
        break;
      }
    }
    return parseCSV(lines.slice(headerIdx).join("\n"));
  }
  // keyword_overview et organic_pages : header standard
  return parseCSV(text);
}