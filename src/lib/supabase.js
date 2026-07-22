const PROXY = "/api/supabase";

// ── Lecture du token stocké ───────────────────────────────────────
function _getStoredToken() {
  try {
    const s = sessionStorage.getItem("correl_session") || localStorage.getItem("correl_session");
    const sess = s ? JSON.parse(s) : null;
    return { token: sess?.access_token || null, refreshToken: sess?.refresh_token || null, sess };
  } catch { return { token: null, refreshToken: null, sess: null }; }
}

// ── Rafraîchir le token si expiré ────────────────────────────────
async function _refreshToken() {
  const { refreshToken } = _getStoredToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch("/api/auth?action=refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      // Refresh échoué → effacer la session
      sessionStorage.removeItem("correl_session");
      localStorage.removeItem("correl_session");
      return null;
    }
    const data = await res.json();
    const newSess = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      user:          data.user,
    };
    // Stocker la nouvelle session
    try {
      const stored = sessionStorage.getItem("correl_session") || localStorage.getItem("correl_session");
      const old = stored ? JSON.parse(stored) : {};
      const merged = { ...old, ...newSess };
      sessionStorage.setItem("correl_session", JSON.stringify(merged));
      localStorage.setItem("correl_session", JSON.stringify(merged));
    } catch {}
    return data.access_token;
  } catch { return null; }
}

// ── authHeaders (synchrone, compatibilité ascendante) ────────────
function authHeaders(extra = {}) {
  const { token } = _getStoredToken();
  if (token) return { "Authorization": `Bearer ${token}`, ...extra };
  return extra;
}

// ── fetchSupabase : fetch avec retry automatique sur 401 ──────────
async function fetchSupabase(url, options = {}) {
  let { token } = _getStoredToken();
  const makeHeaders = (t) => {
    const base = { ...(options.headers || {}) };
    if (t) base["Authorization"] = `Bearer ${t}`;
    return base;
  };
  // Tentative 1
  let res = await fetch(url, { ...options, headers: makeHeaders(token) });
  if (res.status !== 401) return res;
  // 401 → tenter un refresh
  const newToken = await _refreshToken();
  if (!newToken) {
    // Pas de refresh possible → déclencher un rechargement pour forcer la reconnexion
    window.dispatchEvent(new CustomEvent("supabase:session-expired"));
    return res; // retourner le 401 original
  }
  // Tentative 2 avec le nouveau token
  res = await fetch(url, { ...options, headers: makeHeaders(newToken) });
  return res;
}


export async function sbUpload(path, csvText) {
  // Upload via proxy Netlify — auth gérée côté serveur
  const token = (() => {
    try {
      const s = sessionStorage.getItem("correl_session") || localStorage.getItem("correl_session");
      return s ? JSON.parse(s).access_token : null;
    } catch { return null; }
  })();

  if (!token) throw new Error("Non authentifié — reconnectez-vous");

  const res = await fetch(`${PROXY}/storage/v1/object/csv-imports/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "text/csv",
      "x-upsert": "true",
    },
    body: csvText,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[sbUpload] failed:", res.status, body);
    throw new Error(`Upload failed: ${res.status} — ${body.slice(0, 120)}`);
  }
  return path;
}


export async function sbInsertImport({ project_id, site_id, source, filename, storage_path, row_count }) {
  // UPSERT: 1 row max per (project_id, site_id, source) — replaces previous
  const res = await fetchSupabase(`${PROXY}/rest/v1/imports`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=representation",
      "on-conflict": "project_id,site_id,source",
    },
    body: JSON.stringify({ project_id, site_id, source, filename, storage_path, row_count, uploaded_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 409 = contrainte unique non configurée en DB → fallback ignore-duplicates
    if (res.status === 409) {
      const res2 = await fetchSupabase(`${PROXY}/rest/v1/imports`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          "Prefer": "resolution=ignore-duplicates,return=representation",
        },
        body: JSON.stringify({ project_id, site_id, source, filename, storage_path, row_count, uploaded_at: new Date().toISOString() }),
      });
      if (!res2.ok) return null; // silencieux si toujours KO
      const data = await res2.json();
      return Array.isArray(data) ? data[0] || null : data;
    }
    throw new Error(`Insert failed: ${res.status} — ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : data;
}

export async function sbDeleteImport(id) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/imports?id=eq.${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Delete import failed: ${res.status}`);
}

export async function sbDeleteFile(storage_path) {
  const res = await fetchSupabase(`${PROXY}/storage/v1/object/csv-imports/${storage_path}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Delete file failed: ${res.status}`);
}

export async function sbGetHistory(projectId, limit = 50) {
  const filter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`${PROXY}/rest/v1/imports?select=*&order=uploaded_at.desc&limit=${limit}${filter}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch history failed: ${res.status}`);
  return res.json();
}

export async function sbGetLatest(projectId) {
  const filter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : "";
  // With fixed path strategy, there's only 1 row per (project, site, source)
  const res = await fetch(`${PROXY}/rest/v1/imports?select=*&order=uploaded_at.desc&limit=50${filter}`, { headers: authHeaders() });
  if (!res.ok) return {};
  const rows = await res.json();
  const latest = {};
  for (const row of rows) {
    if (!row.storage_path) continue;
    const key = `${row.site_id}_${row.source}`;
    if (!latest[key]) latest[key] = row;
  }
  return latest;
}

export async function sbDownload(storage_path) {
  const res = await fetch(`${PROXY}/storage/v1/object/csv-imports/${storage_path}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[sbDownload] failed:", res.status, body);
    throw new Error(`Download failed: ${res.status}`);
  }
  return res.text();
}

export async function sbSaveProject(project) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/projects`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: project.id, name: project.name, owner_email: project.owner_email || null,
      openai_key_enc:      project.openai_key_enc      || null,
      gemini_key_enc:      project.gemini_key_enc      || null,
      perplexity_key_enc:  project.perplexity_key_enc  || null,
      claude_geo_key_enc:  project.claude_geo_key_enc  || null,
      semrush_key_enc:     project.semrush_key_enc     || null,
      sites_json: JSON.stringify(project.sites.map(s => ({ id: s.id, label: s.label, color: s.color, bg: s.bg }))),
      settings_json: project.settings_json || null, geo_axes_json: JSON.stringify(project.geo_axes || ["Meilleur / top / recommandé","Pistes et approches pour utiliser / bénéficier du mot-clé","Avis / fiable / fiabilité","Pour atteindre un objectif lié au mot-clé","Pour résoudre une problématique liée au mot-clé"]), updated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.warn("Save project failed:", res.status);
}

export async function sbLoadProjects() {
  const res = await fetch(`${PROXY}/rest/v1/projects?select=*&order=created_at.asc`, { headers: authHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.map(r => ({ id: r.id, name: r.name, sites: JSON.parse(r.sites_json || "[]"), openai_key_enc: r.openai_key_enc || null, geo_axes: JSON.parse(r.geo_axes_json || "null") || ["Meilleur / top / recommandé","Pistes et approches pour utiliser / bénéficier du mot-clé","Avis / fiable / fiabilité","Pour atteindre un objectif lié au mot-clé","Pour résoudre une problématique liée au mot-clé"], gemini_key_enc: r.gemini_key_enc || null, perplexity_key_enc: r.perplexity_key_enc || null, claude_geo_key_enc: r.claude_geo_key_enc || null, semrush_key_enc: r.semrush_key_enc || null, owner_email: r.owner_email || null, updated_at: r.updated_at || null, settings_json: r.settings_json || null, provider_web_search: r.provider_web_search || {} }));
}

export async function sbDeleteProject(projectId) {
  await fetchSupabase(`${PROXY}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}`, { method: "DELETE", headers: authHeaders() });
}

// ── ANALYSES ─────────────────────────────────────────────────────
export async function sbSaveAnalysis({ id, project_id, content }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/analyses`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id, project_id, content }),
  });
  if (!res.ok) throw new Error(`Save analysis failed: ${res.status}`);
  return res.json();
}

export async function sbGetLatestAnalysis(project_id) {
  const res = await fetch(`${PROXY}/rest/v1/analyses?project_id=eq.${encodeURIComponent(project_id)}&order=created_at.desc&limit=1`, { headers: authHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ── RECOMMENDATIONS ───────────────────────────────────────────────
export async function sbSaveRecommendations(recs) {
  if (!recs.length) return;
  const res = await fetchSupabase(`${PROXY}/rest/v1/recommendations`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(recs),
  });
  if (!res.ok) throw new Error(`Save recommendations failed: ${res.status}`);
  return res.json();
}

export async function sbGetRecommendations(project_id) {
  const res = await fetch(`${PROXY}/rest/v1/recommendations?project_id=eq.${encodeURIComponent(project_id)}&order=created_at.desc&limit=200`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbUpdateRecommendation(id, patch) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/recommendations?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Update recommendation failed: ${res.status}`);
}

// ── PAGE TYPES ───────────────────────────────────────────────────
export async function sbSavePageTypes(rows) {
  if (!rows.length) return;
  const res = await fetchSupabase(`${PROXY}/rest/v1/page_types`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) console.warn("sbSavePageTypes failed:", res.status);
  return res.ok;
}

export async function sbGetPageTypes(project_id, site_id) {
  const params = new URLSearchParams({ project_id: `eq.${project_id}`, site_id: `eq.${site_id}`, select: "url,page_type,confidence" });
  const res = await fetch(`${PROXY}/rest/v1/page_types?${params}`, {
    headers: { ...authHeaders(), "Content-Type": "application/json" },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function sbDeletePageTypes(project_id, site_id) {
  const params = new URLSearchParams({ project_id: `eq.${project_id}`, site_id: `eq.${site_id}` });
  const res = await fetchSupabase(`${PROXY}/rest/v1/page_types?${params}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
  });
  return res.ok;
}

// ── SNAPSHOTS ─────────────────────────────────────────────────────
export async function sbSaveSnapshot(snap) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/snapshots`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(snap),
  });
  if (!res.ok) throw new Error(`Save snapshot failed: ${res.status}`);
  return res.json();
}

export async function sbGetSnapshots(project_id, site_id) {
  const q = `project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=date_end.asc`;
  const res = await fetch(`${PROXY}/rest/v1/snapshots?${q}`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbDeleteSnapshot(id) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/snapshots?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
  });
  return res.ok;
}

// ── MILESTONES ────────────────────────────────────────────────────
export async function sbSaveMilestone(m) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/milestones`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(m),
  });
  if (!res.ok) throw new Error(`Save milestone failed: ${res.status}`);
  return res.json();
}

export async function sbGetMilestones(project_id) {
  const res = await fetch(`${PROXY}/rest/v1/milestones?project_id=eq.${encodeURIComponent(project_id)}&order=milestone_date.asc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbDeleteMilestone(id) {
  const res = await fetch(`${PROXY}/rest/v1/milestones?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
  });
  return res.ok;
}

export async function sbUpdateMilestone(id, patch) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/milestones?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

// ── GEO — BRAND SETTINGS ─────────────────────────────────────────

export async function sbSaveBrand({ project_id, site_id, brand_name, brand_domain, brand_aliases, competitors, context }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/site_brand`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ project_id, site_id, brand_name, brand_domain, brand_aliases, competitors, context, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Save brand failed: ${res.status}`);
  return res.json();
}

export async function sbGetBrand(project_id, site_id) {
  const res = await fetch(`${PROXY}/rest/v1/site_brand?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&limit=1`, { headers: authHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ── GEO — OPENAI KEY (encrypted) on project ──────────────────────

export async function sbSaveGeoAxes(project_id, axes) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ geo_axes_json: JSON.stringify(axes) }),
  });
  return res.ok;
}

// ── GEO — KEYWORDS ───────────────────────────────────────────────

export async function sbSaveKeywords(rows) {
  // rows: [{ project_id, site_id, keyword }]
  // Filtre les lignes vides ou invalides
  const valid = rows.filter(r => r.keyword?.trim());
  if (!valid.length) return [];
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_keywords`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Prefer": "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(valid),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 409 = duplicate unique key — retourner tableau vide plutôt que planter
    if (res.status === 409) return [];
    throw new Error(`Save keywords failed: ${res.status} — ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function sbGetKeywords(project_id, site_id) {
  const res = await fetch(`${PROXY}/rest/v1/geo_keywords?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=created_at.asc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbUpdateKeywordStatus(id, status) {
  const res = await fetch(`${PROXY}/rest/v1/geo_keywords?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

export async function sbUpdateKeywordVolume(id, volume, source = "semrush_api") {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_keywords?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ search_volume: volume, volume_source: source, volume_updated_at: new Date().toISOString() }),
  });
  return res.ok;
}

export async function sbDeleteKeyword(id) {
  await fetch(`${PROXY}/rest/v1/geo_keywords?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
}

// ── GEO — QUESTIONS ──────────────────────────────────────────────

export async function sbSaveQuestions(rows) {
  if (!rows.length) return [];
  // Filtre les questions vides
  const valid = rows.filter(r => r.question?.trim());
  if (!valid.length) return [];
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_questions`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Prefer": "return=representation,resolution=ignore-duplicates",
    },
    body: JSON.stringify(valid),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // 409 = contrainte unique — les questions existent déjà, récupérer depuis la base
    if (res.status === 409) {
      const pid = valid[0].project_id; const sid = valid[0].site_id;
      const res2 = await fetchSupabase(`${PROXY}/rest/v1/geo_questions?project_id=eq.${encodeURIComponent(pid)}&site_id=eq.${encodeURIComponent(sid)}&select=*&order=created_at.asc`, { headers: authHeaders() });
      return res2.ok ? res2.json() : [];
    }
    throw new Error(`Save questions failed: ${res.status} — ${errText.slice(0, 200)}`);
  }
  const saved = await res.json();
  // ignore-duplicates returns [] for existing rows — fetch them back
  if (Array.isArray(saved) && saved.length === 0 && rows.length > 0) {
    const pid = rows[0].project_id;
    const sid = rows[0].site_id;
    const texts = rows.map(r => r.question);
    const qs = encodeURIComponent("(" + texts.map(t => `"${t.replace(/"/g, '\\"')}"`).join(",") + ")");
    const res2 = await fetchSupabase(`${PROXY}/rest/v1/geo_questions?project_id=eq.${encodeURIComponent(pid)}&site_id=eq.${encodeURIComponent(sid)}&question=in.${qs}&select=*`);
    if (res2.ok) return res2.json();
  }
  return saved;
}

export async function sbGetQuestions(project_id, site_id) {
  const res = await fetch(`${PROXY}/rest/v1/geo_questions?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=created_at.asc&select=*`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

// ── GEO Analyses (Fan-out & Roadmap "Et maintenant ?") ───────────
// Table geo_analyses : { id, project_id, site_id, kind, content (jsonb), created_at }
// kind = "fanout" (bouton Analyser) | "roadmap" (bouton Et maintenant ?)
export async function sbSaveGeoAnalysis({ project_id, site_id, kind, content }) {
  const row = {
    project_id, site_id, kind,
    content: typeof content === "string" ? content : JSON.stringify(content),
    created_at: new Date().toISOString(),
  };
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_analyses`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[sbSaveGeoAnalysis] failed:", res.status, err.slice(0, 200));
    throw new Error(`Save geo analysis failed: ${res.status}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// Récupère les analyses GEO d'un site, plus récentes en premier
export async function sbGetGeoAnalyses(project_id, site_id, kind = null) {
  let url = `${PROXY}/rest/v1/geo_analyses?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=created_at.desc&limit=20`;
  if (kind) url += `&kind=eq.${encodeURIComponent(kind)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return [];
  const rows = await res.json();
  // Parser le content JSON si stocké en string
  return (Array.isArray(rows) ? rows : []).map(r => {
    let parsed = r.content;
    try { if (typeof r.content === "string") parsed = JSON.parse(r.content); } catch {}
    return { ...r, content: parsed };
  });
}

export async function sbUpdateQuestion(id, patch) {
  if (!id || id.startsWith("tmp-")) return false; // skip optimistic/temp IDs
  const doPatch = async (body) => fetchSupabase(`${PROXY}/rest/v1/geo_questions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(body),
  });

  let res = await doPatch(patch);

  // Si une colonne du cache n'existe pas (has_result, last_answer, last_date…),
  // PostgREST renvoie 400/PGRST204 → on retire les colonnes "optionnelles"
  // et on ré-essaie avec le sous-ensemble sûr (question, keyword_id, category_id,
  // is_favorite, tags) pour ne pas perdre la mise à jour critique.
  if (!res.ok) {
    const errPeek = await res.clone().text().catch(() => "");
    if (res.status === 400 || /column|PGRST204|schema/i.test(errPeek)) {
      const SAFE = ["question", "keyword_id", "category_id", "is_favorite", "tags"];
      const safePatch = {};
      for (const k of SAFE) if (k in patch) safePatch[k] = patch[k];
      if (Object.keys(safePatch).length > 0) {
        console.warn("[sbUpdateQuestion] retry colonnes sûres:", Object.keys(safePatch).join(","));
        res = await doPatch(safePatch);
      }
    }
  }

  if (!res.ok) {
    console.error("sbUpdateQuestion failed:", res.status, id, patch);
    return false;
  }
  return res.json();
}

export async function sbDeleteQuestion(id) {
  await fetch(`${PROXY}/rest/v1/geo_questions?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
}

// ── GEO — RESULTS ────────────────────────────────────────────────

export async function sbSaveGeoResult(result) {
  // Colonnes de base garanties d'exister dans geo_results
  const baseRow = {
    question_id:          result.question_id,
    project_id:           result.project_id,
    site_id:              result.site_id,
    model:                result.model,
    answer:               result.answer,
    answer_type:          result.answer_type   || null,
    intent_type:          result.intent_type   || null,
    sources:              result.sources       || [],
    source_types:         result.source_types  || [],
    brand_mentioned:      result.brand_mentioned    ?? false,
    brand_position:       result.brand_position     ?? null,
    brand_in_sources:     result.brand_in_sources   ?? false,
    competitors_mentioned: result.competitors_mentioned || [],
    input_tokens:         result.input_tokens  ?? null,
    output_tokens:        result.output_tokens ?? null,
    created_at:           result.created_at    || new Date().toISOString(),
  };
  // Colonnes de présence détaillées — ajoutées seulement si présentes
  // (peuvent ne pas exister en base sur d'anciens schémas)
  const detailCols = {};
  if (result.brand_mention_position   !== undefined) detailCols.brand_mention_position   = result.brand_mention_position   ?? null;
  if (result.brand_evocation_position !== undefined) detailCols.brand_evocation_position = result.brand_evocation_position ?? null;
  if (result.brand_citation_position  !== undefined) detailCols.brand_citation_position  = result.brand_citation_position  ?? null;
  if (result.unknown_entities         !== undefined) detailCols.unknown_entities         = result.unknown_entities         || [];
  if (result.brand_presences          !== undefined) detailCols.brand_presences          = result.brand_presences          || {};

  // ── Dédoublonnage : la contrainte unique est geo_results_question_model_unique
  // sur (question_id, model) — SANS la date. On doit donc supprimer TOUT
  // résultat existant pour ce couple (peu importe sa date) avant d'insérer,
  // sinon l'INSERT viole la contrainte (409 Conflict).
  await fetchSupabase(
    `${PROXY}/rest/v1/geo_results?question_id=eq.${encodeURIComponent(result.question_id)}&model=eq.${encodeURIComponent(result.model)}`,
    { method: "DELETE", headers: { ...authHeaders(), "Prefer": "return=minimal" } }
  ).catch(() => {}); // best-effort — si ça échoue on tente quand même l'insert/upsert

  // Tentative 1 : insert avec colonnes détaillées
  const doInsert = async (row) => fetchSupabase(`${PROXY}/rest/v1/geo_results`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(row),
  });

  // UPSERT : si le DELETE n'a pas suffi (latence, droits), on fusionne sur conflit
  // au lieu d'échouer en 409. Nécessite que (question_id, model) soit la clé de conflit.
  const doUpsert = async (row) => fetchSupabase(`${PROXY}/rest/v1/geo_results`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Prefer": "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });

  let res = await doInsert({ ...baseRow, ...detailCols });

  // Si échec à cause d'une colonne inconnue (400/PGRST204) → retry sans les colonnes détaillées
  if (!res.ok && Object.keys(detailCols).length > 0) {
    const errPeek = await res.clone().text().catch(() => "");
    if (res.status === 400 || /column|PGRST204|schema/i.test(errPeek)) {
      console.warn("[sbSaveGeoResult] retry sans colonnes détaillées:", errPeek.slice(0, 120));
      res = await doInsert(baseRow);
    }
  }

  // Si conflit de clé unique (409) malgré le DELETE → bascule en UPSERT (merge)
  if (!res.ok && res.status === 409) {
    console.warn("[sbSaveGeoResult] 409 conflict → bascule en upsert (merge-duplicates)");
    res = await doUpsert({ ...baseRow, ...detailCols });
    if (!res.ok && Object.keys(detailCols).length > 0) {
      const peek = await res.clone().text().catch(() => "");
      if (res.status === 400 || /column|PGRST204|schema/i.test(peek)) {
        res = await doUpsert(baseRow);
      }
    }
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[sbSaveGeoResult] failed:", res.status, errBody);
    throw new Error(`Save geo result failed: ${res.status} — ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

export async function sbGetGeoResultsAll(project_id) {
  const res = await fetch(`${PROXY}/rest/v1/geo_results?project_id=eq.${encodeURIComponent(project_id)}&select=*&order=created_at.desc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbGetGeoResults(project_id, site_id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_results?select=*&project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=created_at.desc&limit=2000`,
    { headers: authHeaders() }
  );
  if (!res.ok) {
    console.warn("[sbGetGeoResults] failed:", res.status, await res.text().catch(() => ""));
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.warn("[sbGetGeoResults] unexpected response:", data);
    return [];
  }
  return data;
}

export async function sbGetResultsForQuestion(question_id) {
  const res = await fetch(`${PROXY}/rest/v1/geo_results?question_id=eq.${encodeURIComponent(question_id)}&order=created_at.desc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

// ── GEO v2 — CATEGORIES ──────────────────────────────────────────

export async function sbGetCategories(project_id) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_categories?project_id=eq.${encodeURIComponent(project_id)}&order=name.asc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbSaveCategory({ project_id, name, color }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_categories`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ project_id, name, color }),
  });
  if (!res.ok) throw new Error(`Save category failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] || rows;
}

export async function sbDeleteCategory(id) {
  await fetchSupabase(`${PROXY}/rest/v1/geo_categories?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
}

export async function sbSetKeywordCategory(id, category_id) {
  await fetch(`${PROXY}/rest/v1/geo_keywords?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ category_id }),
  });
}

export async function sbSetQuestionCategory(id, category_id) {
  await fetch(`${PROXY}/rest/v1/geo_questions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ category_id }),
  });
}

// Intention manuelle de la question : "transactional" | "informational" | "brand" | null
export async function sbSetQuestionIntent(id, intent) {
  const res = await fetch(`${PROXY}/rest/v1/geo_questions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });
  // Colonne non migrée → ne pas casser l'UI (silencieux, l'état local reste)
  if (!res.ok) throw new Error(`intent PATCH ${res.status}`);
}

// Marques (sites) associées à une question : liste d'IDs de sites du projet.
export async function sbSetQuestionSites(id, associated_sites) {
  const res = await fetch(`${PROXY}/rest/v1/geo_questions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ associated_sites: Array.isArray(associated_sites) ? associated_sites : [] }),
  });
  if (!res.ok) throw new Error(`associated_sites PATCH ${res.status}`);
}

export async function sbSetKeywordTags(id, tags) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_keywords?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ tags: tags || [] }),
  });
  return res.ok;
}

export async function sbBulkSetKeywordTags(ids, tags) {
  if (!ids.length) return;
  const filter = ids.map(id => `"${id}"`).join(",");
  const res = await fetch(`${PROXY}/rest/v1/geo_keywords?id=in.(${filter})`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ tags: tags || [] }),
  });
  return res.ok;
}

export async function sbBulkSetKeywordCategory(ids, category_id) {
  // Supabase REST: PATCH with in() filter
  const filter = ids.map(id => encodeURIComponent(id)).join(",");
  await fetchSupabase(`${PROXY}/rest/v1/geo_keywords?id=in.(${filter})`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ category_id }),
  });
}

export async function sbBulkSetQuestionCategory(ids, category_id) {
  const filter = ids.map(id => encodeURIComponent(id)).join(",");
  await fetchSupabase(`${PROXY}/rest/v1/geo_questions?id=in.(${filter})`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ category_id }),
  });
}

// ── GEO v2 — URL INDEX ───────────────────────────────────────────

export async function sbGetUrlIndex(project_id) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_url_index?project_id=eq.${encodeURIComponent(project_id)}&order=count_as_source.desc`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbUpsertUrl({ project_id, url, domain, count_as_source = 0, count_in_answer = 0 }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_url_index`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ project_id, url, domain, count_as_source, count_in_answer, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || rows;
}

export async function sbIncrementUrlCounts(project_id, url, { as_source = 0, in_answer = 0 }) {
  // Fetch current, then patch
  const existing = await fetch(`${PROXY}/rest/v1/geo_url_index?project_id=eq.${encodeURIComponent(project_id)}&url=eq.${encodeURIComponent(url)}&limit=1`);
  const rows = existing.ok ? await existing.json() : [];
  const cur = rows[0];
  if (!cur) {
    return sbUpsertUrl({ project_id, url, domain: extractDomain(url), count_as_source: as_source, count_in_answer: in_answer });
  }
  await fetch(`${PROXY}/rest/v1/geo_url_index?id=eq.${cur.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ count_as_source: cur.count_as_source + as_source, count_in_answer: cur.count_in_answer + in_answer, updated_at: new Date().toISOString() }),
  });
}

export async function sbUpdateUrlMeta(id, patch) {
  await fetch(`${PROXY}/rest/v1/geo_url_index?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

export async function sbSaveUrlQuestion({ url_id, question_id, result_id, as_source, in_answer }) {
  await fetchSupabase(`${PROXY}/rest/v1/geo_url_question`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ url_id, question_id, result_id, as_source, in_answer }),
  });
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

export async function sbSaveProviderWebSearch(project_id, map) {
  // map: { openai: bool, gemini: bool, perplexity: bool, claude: bool }
  const res = await fetch(`${PROXY}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ provider_web_search: map || {} }),
  });
  return res.ok;
}

export async function sbSaveProviderKeys(project_id, keys) {
  // keys: any of { openai_key_enc, gemini_key_enc, perplexity_key_enc, claude_geo_key_enc, semrush_key_enc }
  const allowed = ["openai_key_enc", "gemini_key_enc", "perplexity_key_enc", "claude_geo_key_enc", "semrush_key_enc"];
  const patch = {};
  allowed.forEach(k => { if (keys[k] !== undefined) patch[k] = keys[k]; });
  const res = await fetch(`${PROXY}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

// ── GEO — PRESENCE HISTORY ───────────────────────────────────────

export async function sbGetPresenceHistory(question_id) {
  const res = await fetch(`${PROXY}/rest/v1/geo_presence_history?question_id=eq.${encodeURIComponent(question_id)}&order=test_date.asc&select=provider_id,test_date,brand_mentioned,brand_position,brand_in_sources`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function sbGetPresenceHistoryBatch(project_id, site_id) {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);
    const res = await fetch(`${PROXY}/rest/v1/geo_presence_history?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&test_date=gte.${sinceStr}&order=test_date.asc&select=question_id,provider_id,test_date,brand_mentioned`, { headers: authHeaders() });
    if (!res.ok) return []; // table may not exist yet
    return res.json();
  } catch { return []; }
}

// ── GEO — CALENDAR ENTRIES ──────────────────────────────────────
// Table : geo_calendar_dates
// Columns: id, question_id, provider_id, brand_present, test_date, created_at

export async function sbAddCalendarEntry(question_id, provider_id, brand_present, presType, mentionPos = null) {
  // presType: "mention" | "citation" | "evocation" | null
  // mentionPos: position numérique si presType === "mention"
  const test_date = new Date().toISOString().slice(0, 10);
  const present = brand_present === true || brand_present === 1;

  // Payload complet (avec ventilation M/É/C + position). Si la table ne possède
  // pas ces colonnes, PostgREST renvoie une 400 → on réessaie avec les colonnes de base.
  const fullBody = {
    question_id,
    provider_id,
    brand_present: present,
    brand_mention:   presType === "mention"   ? 1 : 0,
    brand_citation:  presType === "citation"  ? 1 : 0,
    brand_evocation: presType === "evocation" ? 1 : 0,
    mention_position: presType === "mention" && mentionPos != null ? mentionPos : null,
    test_date,
  };
  const baseBody = { question_id, provider_id, brand_present: present, test_date };

  const post = async (body) => fetchSupabase(`${PROXY}/rest/v1/geo_calendar_dates`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(body),
  });

  try {
    let res = await post(fullBody);
    // Colonnes manquantes ou contrainte → retomber sur le payload minimal
    if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
      const errText = await res.text().catch(() => "");
      console.warn("[sbAddCalendarEntry] full payload rejected (" + res.status + "), retry base columns:", errText.slice(0, 160));
      res = await post(baseBody);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[sbAddCalendarEntry] failed:", res.status, errText.slice(0, 200));
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch(e) {
    console.error("[sbAddCalendarEntry] error:", e.message);
    return null;
  }
}

// Upsert d'une entrée calendrier pour une DATE donnée (utilisé par le recalcul de
// détection, qui doit mettre à jour le carré à la date d'origine du résultat, pas
// à aujourd'hui). DELETE + INSERT pour garantir une seule ligne par (question, provider, date).
export async function sbUpsertCalendarEntry(question_id, provider_id, test_date, brand_present, presType, mentionPos = null) {
  if (!question_id || !provider_id || !test_date) return null;
  const present = brand_present === true || brand_present === 1;
  const fullBody = {
    question_id,
    provider_id,
    brand_present: present,
    brand_mention:   presType === "mention"   ? 1 : 0,
    brand_citation:  presType === "citation"  ? 1 : 0,
    brand_evocation: presType === "evocation" ? 1 : 0,
    mention_position: presType === "mention" && mentionPos != null ? mentionPos : null,
    test_date,
  };
  const baseBody = { question_id, provider_id, brand_present: present, test_date };

  const post = async (body) => fetchSupabase(`${PROXY}/rest/v1/geo_calendar_dates`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(body),
  });

  try {
    // 1) Supprimer l'éventuelle entrée existante pour cette (question, provider, date)
    await fetchSupabase(
      `${PROXY}/rest/v1/geo_calendar_dates?question_id=eq.${encodeURIComponent(question_id)}&provider_id=eq.${encodeURIComponent(provider_id)}&test_date=eq.${encodeURIComponent(test_date)}`,
      { method: "DELETE", headers: authHeaders() }
    );
    // 2) Réinsérer avec la détection à jour (payload complet, fallback colonnes de base)
    let res = await post(fullBody);
    if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
      res = await post(baseBody);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[sbUpsertCalendarEntry] failed:", res.status, errText.slice(0, 200));
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error("[sbUpsertCalendarEntry] error:", e.message);
    return null;
  }
}

// Par question (utilisé par PresenceCalendar)
export async function sbGetCalendarEntries(question_id) {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);
    const res = await fetch(
      `${PROXY}/rest/v1/geo_calendar_dates?question_id=eq.${encodeURIComponent(question_id)}&test_date=gte.${sinceStr}&order=test_date.asc&select=provider_id,test_date,brand_present,brand_mention,brand_citation,brand_evocation,mention_position`,
      { headers: authHeaders() }
    );
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

// ── NOUVEAU : batch pour tout un projet/site (utilisé par QuestionsTab pour lostByQ) ──
// Charge toutes les entrées des 30 derniers jours pour calculer "Positionnée précédemment"
// en utilisant la même source de vérité que PresenceCalendar.
export async function sbGetCalendarEntriesBatch(project_id, site_id) {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    // Étape 1 : récupérer les question_ids du projet/site
    const qRes = await fetch(
      `${PROXY}/rest/v1/geo_questions?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&select=id`,
      { headers: authHeaders() }
    );
    if (!qRes.ok) {
      console.warn("[sbGetCalendarEntriesBatch] geo_questions fetch failed:", qRes.status);
      return [];
    }
    const questions = await qRes.json();
    if (!Array.isArray(questions) || !questions.length) return [];

    // Étape 2 : récupérer les entrées calendar pour ces question_ids
    // PostgREST : in.(uuid1,uuid2,...) — les UUIDs n'ont pas besoin d'être quotés
    const ids = questions.map(q => q.id).join(",");
    const url = `${PROXY}/rest/v1/geo_calendar_dates?question_id=in.(${ids})&test_date=gte.${sinceStr}&order=test_date.asc&select=question_id,provider_id,test_date,brand_present`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[sbGetCalendarEntriesBatch] calendar fetch failed:", res.status, body.slice(0, 120));
      return [];
    }
    const data = await res.json();
    return data;
  } catch(e) {
    console.warn("[sbGetCalendarEntriesBatch] error:", e.message);
    return [];
  }
}

// ── GEO HINTS ────────────────────────────────────────────────────

export async function sbSaveHint(question_id, site_id, project_id, hint_text) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_hints`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ question_id, site_id, project_id, hint_text, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`Save hint failed: ${res.status} — ${body.slice(0, 80)}`);
    return null; // non-blocking
  }
  return res.json();
}

export async function sbGetHints(project_id, site_id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_hints?select=question_id,hint_text,updated_at&project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}`,
    { headers: authHeaders() }
  );
  if (!res.ok) {
    console.warn("[sbGetHints] failed:", res.status);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── PROJECT SETTINGS (UI preferences per project) ────────────────
export async function sbSaveProjectSettings(project_id, settings) {
  const res = await fetch(`${PROXY}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ settings_json: JSON.stringify(settings) }),
  });
  return res.ok;
}

// ── GEO SCHEDULES (automation) ───────────────────────────────────

export async function sbGetSchedule(project_id, site_id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_schedules?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&select=*&limit=1`,
    { headers: authHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

export async function sbSaveSchedule({ project_id, site_id, owner_email, frequency, providers, active, max_questions }) {
  // Compute initial next_run based on frequency
  const now = new Date();
  const nextRun = new Date(now);
  switch (frequency) {
    case "daily":    nextRun.setDate(now.getDate() + 1); break;
    case "weekly":   nextRun.setDate(now.getDate() + 7); break;
    case "biweekly": nextRun.setDate(now.getDate() + 14); break;
    case "monthly":  nextRun.setDate(now.getDate() + 30); break;
    default:         nextRun.setDate(now.getDate() + 7);
  }

  const payload = {
    project_id, site_id, owner_email,
    frequency, providers: providers || ["openai"],
    active: active !== false,
    max_questions: max_questions || 10,
    next_run: nextRun.toISOString(),
  };

  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_schedules?on_conflict=project_id,site_id`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Save schedule failed: ${res.status} — ${body.slice(0, 120)}`);
  }
  return (await res.json())[0];
}

export async function sbUpdateSchedule(id, patch) {
  const res = await fetch(`${PROXY}/rest/v1/geo_schedules?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

export async function sbDeleteSchedule(id) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_schedules?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.ok;
}

export async function sbTriggerScheduler(target = {}) {
  // Le scheduler est désormais asynchrone : l'edge dispatch vers une
  // background function (15 min de timeout) et renvoie 202 immédiatement.
  // `target` = { project_id, site_id } pour ne traiter QUE ce schedule
  // (test manuel sur le projet courant) au lieu de tous les schedules actifs.
  const secret = process.env.REACT_APP_SCHEDULER_SECRET;
  const res = await fetch("/api/geo-scheduler", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Scheduler-Secret": secret } : {}),
    },
    body: JSON.stringify({ force: true, project_id: target.project_id || null, site_id: target.site_id || null }),
  });
  // 202 = accepté et lancé en arrière-plan (pas d'erreur)
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trigger failed: ${res.status} — ${body.slice(0, 120)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { ...data, dispatched: true };
}

// ── Competitors (geo_competitors) ────────────────────────────────

export async function sbGetCompetitors(project_id, site_id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_competitors?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=name.asc`,
    { headers: authHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

export async function sbSaveCompetitor({ project_id, site_id, name, domain = "", category = "other", color = "#64748B", enabled = true }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_competitors`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Prefer": "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify({ project_id, site_id, name, domain, category, color, enabled }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`sbSaveCompetitor: ${res.status} — ${err.slice(0, 120)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function sbUpdateCompetitor(id, patch) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_competitors?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch),
    }
  );
  return res.ok;
}

export async function sbDeleteCompetitor(id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_competitors?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  return res.ok;
}

// ── Lot B1 : réglages de la comparaison concurrentielle (niveau projet) ──
// compare_rows = liste d'IDs de lignes (métriques) incluses dans l'audit.
export async function sbGetCompareSettings(project_id) {
  try {
    const res = await fetch(
      `${PROXY}/rest/v1/geo_compare_settings?project_id=eq.${encodeURIComponent(project_id)}&select=*`,
      { headers: authHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}

export async function sbSetCompareRows(project_id, compare_rows) {
  const res = await fetch(`${PROXY}/rest/v1/geo_compare_settings`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ project_id, compare_rows, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`compare_rows upsert ${res.status}`);
}

// ── Alias de marques (table geo_aliases) ─────────────────────────
// Restaurées : ces fonctions étaient perdues lors d'une reprise de supabase.js.
export async function sbGetAliases(project_id, site_id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_aliases?project_id=eq.${encodeURIComponent(project_id)}&site_id=eq.${encodeURIComponent(site_id)}&order=alias.asc`,
    { headers: authHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

export async function sbSaveAlias({ project_id, site_id, alias, canonical }) {
  const res = await fetchSupabase(`${PROXY}/rest/v1/geo_aliases`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Prefer": "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify({ project_id, site_id, alias, canonical }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`sbSaveAlias: ${res.status} — ${err.slice(0, 120)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function sbDeleteAlias(id) {
  const res = await fetch(
    `${PROXY}/rest/v1/geo_aliases?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  return res.ok;
}
// ── Suivi d'activité (heartbeats) ────────────────────────────────
// Enregistre un battement d'activité (≈ 1 minute d'usage actif).
export async function sbRecordActivity(user_email, project_id = null) {
  if (!user_email) return null;
  try {
    const res = await fetchSupabase(`${PROXY}/rest/v1/user_activity`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", "Prefer": "return=minimal" }),
      body: JSON.stringify({ user_email: user_email.toLowerCase(), project_id: project_id || null }),
    });
    return res.ok;
  } catch (e) { return false; }
}

// Agrégat d'usage par utilisateur (dernier usage + minutes par période).
export async function sbGetActivitySummary() {
  try {
    const res = await fetch(`${PROXY}/rest/v1/rpc/get_activity_summary`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{}",
    });
    if (!res.ok) return [];
    return res.json();
  } catch (e) { return []; }
}

// Agrégat d'usage par utilisateur ET par projet.
export async function sbGetActivityByProject() {
  try {
    const res = await fetch(`${PROXY}/rest/v1/rpc/get_activity_by_project`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{}",
    });
    if (!res.ok) return [];
    return res.json();
  } catch (e) { return []; }
}