import InfoCard from "../components/InfoCard";
import { ProviderConfigPanel, BrandConfigPanel } from "../components/GeoConfig";
import { C, SITE_PALETTE } from "../lib/constants";
import { newProject, parseCSV, parseSemrushCSV } from "../lib/helpers";
import { sbSaveProject, sbDeleteProject, sbDownload } from "../lib/supabase";
import { parseSemrush } from "../lib/parsers";
import UploadCard from "../components/UploadCard";
import PageTypeClassifier from "../components/PageTypeClassifier";

// ── Section wrapper ───────────────────────────────────────────────
function Section({ number, title, sub, desc, children }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 8, background: C.blue, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 800, flexShrink: 0,
        }}>{number}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>{sub}</div>}
        </div>
      </div>
      {desc && <div style={{ fontSize: 12.5, color: C.textLight, lineHeight: 1.6, marginBottom: 16, marginLeft: 36, maxWidth: 760 }}>{desc}</div>}
      {children}
    </div>
  );
}

export default function ImportTab({ projects, currentProjectId, setCurrentProjectId, editingProjectName, setEditingProjectName, setProjects, ownerEmail = null, sites, setSites, sfData, gscData, gaData, bingData, smData, setSfData, setGscData, setGaData, setBingData, setSmData, confirmModal, setConfirmModal, dbHistory, dbLoading, showHistory, setShowHistory, refreshHistory, pageTypes, setPageTypes, onSemrushVolumes }) {

  // ── Last import dates ─────────────────────────────────────────
  const lastBySrc = {};
  for (const row of dbHistory) {
    if (!lastBySrc[row.source] || row.uploaded_at > lastBySrc[row.source].uploaded_at)
      lastBySrc[row.source] = row;
  }
  const fmtDate = (d) => new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });

  // Last import per site+source for "↩ Dernier" buttons
  const lastImports = {};
  for (const row of dbHistory) {
    const key = `${row.site_id}_${row.source}`;
    if (!lastImports[key] && row.storage_path) lastImports[key] = row;
  }

  return (
    <div>

      {/* ── 1. PROJET ACTIF ──────────────── */}
      <Section number="1" title="Projet actif" sub="Gérez vos projets et les sites associés" desc="Un projet regroupe un ou plusieurs sites avec leurs données et leurs réglages. Choisissez ici le projet actif : toute la configuration et tous les imports de cette page s'y rattachent.">
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "20px 24px" }}>

          {/* Project selector */}
          <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${C.borderLight}` }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, color: C.textLight, fontWeight: 600, marginBottom: 10 }}>Projet actif</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Dropdown selector */}
              <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
                <select
                  value={currentProjectId}
                  onChange={e => setCurrentProjectId(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: `2px solid ${C.blue}`, borderRadius: 10, fontSize: 13, fontWeight: 600, color: C.blue, background: C.blueLight, cursor: "pointer", appearance: "none" }}>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.sites.length} site{p.sites.length > 1 ? "s" : ""})</option>
                  ))}
                </select>
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.blue }}>▾</span>
              </div>
              {/* Rename current project */}
              {editingProjectName === currentProjectId ? (
                <input autoFocus
                  value={projects.find(p => p.id === currentProjectId)?.name || ""}
                  onChange={e => setProjects(prev => prev.map(x => x.id === currentProjectId ? {...x, name: e.target.value} : x))}
                  onBlur={() => setEditingProjectName(null)}
                  onKeyDown={e => e.key === "Enter" && setEditingProjectName(null)}
                  style={{ padding: "7px 10px", border: `1px solid ${C.blue}`, borderRadius: 8, fontSize: 13, fontWeight: 600, color: C.blue, width: 160 }}
                />
              ) : (
                <button title="Renommer le projet" onClick={() => setEditingProjectName(currentProjectId)}
                  style={{ padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.white, cursor: "pointer", fontSize: 12, color: C.textMid }}>✏️ Renommer</button>
              )}
              {projects.length > 1 && (
                <button title="Supprimer ce projet" onClick={() => setConfirmModal({ message: `Supprimer le projet "${projects.find(p=>p.id===currentProjectId)?.name}" ?`, onConfirm: () => {
                  sbDeleteProject(currentProjectId).catch(() => {});
                  setProjects(prev => { const next = prev.filter(x => x.id !== currentProjectId); if (next.length) setCurrentProjectId(next[0].id); return next; });
                }})}
                  style={{ padding: "7px 10px", border: "1px solid #FECACA", borderRadius: 8, background: "#FEF2F2", cursor: "pointer", fontSize: 12, color: "#DC2626" }}>🗑 Supprimer</button>
              )}

              {projects.length < 20 && (
                <button onClick={() => {
                  const p = newProject(`Projet ${projects.length + 1}`, [{ id: `site-${Date.now()}`, label: "Nouveau site", ...SITE_PALETTE[0] }], ownerEmail);
                  setProjects(prev => [...prev, p]);
                  setCurrentProjectId(p.id);
                  sbSaveProject(p).catch(() => {});
                }} style={{ padding: "8px 16px", borderRadius: 10, border: `2px dashed ${C.blue}`, background: C.blueLight, color: C.blue, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  + Nouveau projet
                </button>
              )}
            </div>
          </div>

          {/* Sites of current project */}
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, color: C.textLight, fontWeight: 600, marginBottom: 10 }}>Sites du projet</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {sites.map(site => (
                <div key={site.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 10, border: `1px solid ${site.color}33`, background: site.bg }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: site.color, flexShrink: 0 }} />
                  <input
                    value={site.label}
                    onChange={e => setSites(prev => prev.map(s => s.id === site.id ? {...s, label: e.target.value} : s))}
                    style={{ fontWeight: 600, fontSize: 13, color: site.color, border: "none", outline: "none", background: "transparent", width: 120 }}
                    placeholder="Nom du site"
                  />
                  <button title="Vider les imports" onClick={() => setConfirmModal({ message: `Vider tous les imports de "${site.label}" ?`, onConfirm: () => {
                    setSfData(p => ({...p, [site.id]: []}));
                    setGscData(p => ({...p, [site.id]: []}));
                    setGaData(p => ({...p, [site.id]: []}));
                    setBingData(p => ({...p, [site.id]: []}));
                    setSmData(p => ({...p, [site.id]: []}));
                  }})} style={{ padding: "2px 6px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.white, cursor: "pointer", fontSize: 11, color: C.textLight }}>🗑</button>
                  {sites.length > 1 && (
                    <button title="Supprimer" onClick={() => setConfirmModal({ message: `Supprimer le site "${site.label}" ?`, onConfirm: () => {
                      setSites(prev => prev.filter(s => s.id !== site.id));
                      ["sfData","gscData","gaData","bingData","smData"].forEach(k => {
                        const setter = { sfData: setSfData, gscData: setGscData, gaData: setGaData, bingData: setBingData, smData: setSmData }[k];
                        setter(p => { const n = {...p}; delete n[site.id]; return n; });
                      });
                    }})} style={{ padding: "2px 6px", border: "1px solid #FCA5A5", borderRadius: 5, background: "#FFF5F5", cursor: "pointer", fontSize: 11, color: "#DC2626" }}>✕</button>
                  )}
                </div>
              ))}
              {sites.length < 3 && (
                <button onClick={() => {
                  const palette = SITE_PALETTE[sites.length] || SITE_PALETTE[0];
                  const newId = `site-${Date.now()}`;
                  setSites(prev => [...prev, { id: newId, label: `Site ${sites.length + 1}`, ...palette }]);
                  setSfData(p => ({...p, [newId]: []}));
                  setGscData(p => ({...p, [newId]: []}));
                  setGaData(p => ({...p, [newId]: []}));
                  setBingData(p => ({...p, [newId]: []}));
                  setSmData(p => ({...p, [newId]: []}));
                }} style={{ padding: "8px 14px", borderRadius: 10, border: `2px dashed ${C.border}`, background: C.white, color: C.blue, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  + Ajouter un site
                </button>
              )}
            </div>
          </div>

          {/* DB status + history */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: dbLoading ? C.amber : dbHistory.length > 0 ? C.green : C.textLight }} />
              <span style={{ fontSize: 12, color: C.textMid }}>
                {dbLoading ? "Chargement…" : dbHistory.length > 0 ? `${dbHistory.length} import${dbHistory.length > 1 ? "s" : ""} en base` : "Aucun import en base"}
              </span>
            </div>
            <button onClick={() => { setShowHistory(h => !h); refreshHistory(); }} style={{
              padding: "5px 14px", background: showHistory ? C.blue : C.white,
              color: showHistory ? "#fff" : C.textMid,
              border: `1px solid ${showHistory ? C.blue : C.border}`,
              borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 500,
            }}>
              📋 Historique {dbHistory.length > 0 ? `(${dbHistory.length})` : ""}
            </button>
          </div>

          {showHistory && (
            <div style={{ marginTop: 14 }}>
              {dbHistory.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textLight }}>Aucun import enregistré</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 260, overflowY: "auto" }}>
                  {dbHistory.map(row => {
                    const site = sites.find(s => s.id === row.site_id);
                    const srcLabel = { sf: "🐸 SF", gsc: "🔍 GSC", ga: "📊 GA4", bing: "🤖 Bing", sm: "📈 Semrush" }[row.source] || row.source;
                    return (
                      <div key={row.id} draggable onDragStart={e => { e.dataTransfer.setData("historyRow", JSON.stringify(row)); e.dataTransfer.effectAllowed = "copy"; }}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: C.bg, borderRadius: 7, fontSize: 11, cursor: "grab", userSelect: "none" }}
                        title="Glisser vers une case d'import">
                        <span style={{ color: C.textLight, flexShrink: 0 }}>⠿</span>
                        <span style={{ fontWeight: 600, color: site?.color || C.text, minWidth: 80 }}>{site?.label || row.site_id}</span>
                        <span style={{ color: C.textMid, minWidth: 60 }}>{srcLabel}</span>
                        <span style={{ color: C.textLight, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.filename}</span>
                        <span style={{ color: C.textLight }}>{new Date(row.uploaded_at).toLocaleString("fr-FR")}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* ── 2. CONFIGURATION GEO ──────────── */}
      <Section number="2" title="Configuration GEO" sub="Providers d'IA et marques — associés au projet" desc="C'est le cœur du suivi : vos clés API de providers (OpenAI, Gemini, Perplexity, Claude) et la définition de votre marque, ses alias et ses concurrents. Sans cela, aucune interrogation des IA ni analyse de présence n'est possible.">
        {/* ── 5a. Provider keys ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 10 }}>
            Clés API des providers
          </div>
          <ProviderConfigPanel
            project={projects.find(p => p.id === currentProjectId) || null}
            projectId={currentProjectId}
            sites={sites}
            onSaveProviderKeys={(keyPatch) => {
              setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, ...keyPatch } : p));
            }}
          />
        </div>

        {/* ── 5b. Brand setup per site ── */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 10 }}>
            Configuration des marques
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sites.map(site => (
              <BrandConfigPanel
                key={site.id}
                site={site}
                projectId={currentProjectId}
              />
            ))}
            {sites.length === 0 && (
              <div style={{ fontSize: 12, color: C.textLight, fontStyle: "italic" }}>
                Ajoutez un site dans la section Import pour configurer sa marque.
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* ── 3. CLASSIFICATION DES PAGES ────── */}
      <Section number="3" title="Classification des pages" sub="Attribuez un type à chaque page pour filtrer la matrice par template" desc="Attribuez un type (accueil, produit, blog...) à chaque URL issue de votre crawl Screaming Frog. Cela permet de filtrer la matrice et l'audit par template et de voir quels types de pages les IA citent réellement.">
        {sites.filter(site => sfData[site.id]?.length > 0).length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "28px 24px", textAlign: "center", color: C.textLight }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🐸</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>Importez d'abord un fichier Screaming Frog</div>
            <div style={{ fontSize: 12 }}>La classification est basée sur les données SF (URL, title, H1, content-type…)</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {sites.filter(site => sfData[site.id]?.length > 0).map(site => (
              <div key={site.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "20px 24px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.borderLight}` }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: site.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 14, color: site.color }}>{site.label}</span>
                  <span style={{ fontSize: 11, color: C.textLight }}>· {sfData[site.id].length} pages</span>
                </div>
                <PageTypeClassifier
                  siteId={site.id}
                  projectId={currentProjectId}
                  sfRows={sfData[site.id]}
                  pageTypes={pageTypes}
                  setPageTypes={setPageTypes}
                />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 4. IMPORT DES FICHIERS ────────── */}
      <Section number="4" title="Import des fichiers" sub="Glissez-déposez vos exports CSV par site et par source" desc="Chargez vos exports CSV (Screaming Frog, Search Console, GA4, Bing, Semrush) site par site. Ces données SEO alimentent les corrélations entre votre performance organique et votre visibilité dans les réponses des IA.">

        {/* Last import dates summary */}
        {Object.keys(lastBySrc).length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {[
              { src: "sf",  icon: "🐸", label: "SF" },
              { src: "gsc", icon: "🔍", label: "GSC" },
              { src: "ga",  icon: "📊", label: "GA4" },
              { src: "bing",icon: "🤖", label: "Bing" },
              { src: "sm",  icon: "📈", label: "Semrush" },
            ].filter(i => lastBySrc[i.src]).map(({ src, icon, label }) => (
              <div key={src} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 20, fontSize: 11 }}>
                <span>{icon}</span>
                <span style={{ fontWeight: 600, color: C.textMid }}>{label}</span>
                <span style={{ color: C.textLight }}>·</span>
                <span style={{ color: C.text }}>{fmtDate(lastBySrc[src].uploaded_at)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(Math.max(sites.length, 1) + (sites.length < 3 ? 1 : 0), 3)}, 1fr)`, gap: 20 }}>
          {sites.length === 0 && (
            <div style={{ gridColumn: "1 / -1", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "20px 24px", fontSize: 13, color: "#92400E" }}>
              ⚠️ Aucun site configuré — créez un projet avec au moins un site dans la section <strong>Projet actif</strong> ci-dessus pour importer des fichiers.
            </div>
          )}
          {sites.map(site => (
            <div key={site.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
              {/* Site header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.borderLight}` }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: site.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, fontSize: 14, color: site.color }}>{site.label}</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div style={{ flex: 1 }}>
                    <UploadCard label="Screaming Frog" icon="🐸" hint="Export interne SF" color={site.color}
                      loaded={sfData[site.id]?.length > 0} rows={sfData[site.id]}
                      onData={rows => setSfData(p => ({...p, [site.id]: rows}))}
                      onClear={() => setSfData(p => ({...p, [site.id]: []}))}
                      siteId={site.id} source="sf" projectId={currentProjectId}
                      onAfterUpload={refreshHistory}
                      onLoadFromHistory={async row => { try { const text = await sbDownload(row.storage_path); setSfData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn("History load error", e); } }} />
                  </div>
                  {lastImports[`${site.id}_sf`]?.storage_path && !sfData[site.id]?.length && (
                    <button onClick={async () => { try { const text = await sbDownload(lastImports[`${site.id}_sf`].storage_path); setSfData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn(e); } }}
                      title={`Recharger : ${lastImports[`${site.id}_sf`].filename}`}
                      style={{ padding: "0 10px", border: `1px solid ${site.color}`, borderRadius: 9, background: site.bg, color: site.color, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                      ↩ Dernier
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div style={{ flex: 1 }}>
                    <UploadCard label="Google Search Console" icon="🔍" hint="Clics, impressions, CTR, position" color={site.color}
                      loaded={gscData[site.id]?.length > 0} rows={gscData[site.id]}
                      onData={rows => setGscData(p => ({...p, [site.id]: rows}))}
                      onClear={() => setGscData(p => ({...p, [site.id]: []}))}
                      siteId={site.id} source="gsc" projectId={currentProjectId}
                      onAfterUpload={refreshHistory}
                      onLoadFromHistory={async row => { try { const text = await sbDownload(row.storage_path); setGscData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn("History load error", e); } }} />
                  </div>
                  {lastImports[`${site.id}_gsc`]?.storage_path && !gscData[site.id]?.length && (
                    <button onClick={async () => { try { const text = await sbDownload(lastImports[`${site.id}_gsc`].storage_path); setGscData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn(e); } }}
                      title={`Recharger : ${lastImports[`${site.id}_gsc`].filename}`}
                      style={{ padding: "0 10px", border: `1px solid ${site.color}`, borderRadius: 9, background: site.bg, color: site.color, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                      ↩ Dernier
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div style={{ flex: 1 }}>
                    <UploadCard label="Google Analytics 4" icon="📊" hint="Sessions, vues" color={site.color}
                      loaded={gaData[site.id]?.length > 0} rows={gaData[site.id]}
                      onData={rows => setGaData(p => ({...p, [site.id]: rows}))}
                      onClear={() => setGaData(p => ({...p, [site.id]: []}))}
                      siteId={site.id} source="ga" projectId={currentProjectId}
                      onAfterUpload={refreshHistory}
                      onLoadFromHistory={async row => { try { const text = await sbDownload(row.storage_path); setGaData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn("History load error", e); } }} />
                  </div>
                  {lastImports[`${site.id}_ga`]?.storage_path && !gaData[site.id]?.length && (
                    <button onClick={async () => { try { const text = await sbDownload(lastImports[`${site.id}_ga`].storage_path); setGaData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn(e); } }}
                      title={`Recharger : ${lastImports[`${site.id}_ga`].filename}`}
                      style={{ padding: "0 10px", border: `1px solid ${site.color}`, borderRadius: 9, background: site.bg, color: site.color, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                      ↩ Dernier
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div style={{ flex: 1 }}>
                    <UploadCard label="Bing AI Performance" icon="🤖" hint="Citations dans Bing Copilot" color={site.color}
                      loaded={bingData[site.id]?.length > 0} rows={bingData[site.id]}
                      onData={rows => setBingData(p => ({...p, [site.id]: rows}))}
                      onClear={() => setBingData(p => ({...p, [site.id]: []}))}
                      siteId={site.id} source="bing" projectId={currentProjectId}
                      onAfterUpload={refreshHistory}
                      onLoadFromHistory={async row => { try { const text = await sbDownload(row.storage_path); setBingData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn("History load error", e); } }} />
                  </div>
                  {lastImports[`${site.id}_bing`]?.storage_path && !bingData[site.id]?.length && (
                    <button onClick={async () => { try { const text = await sbDownload(lastImports[`${site.id}_bing`].storage_path); setBingData(p => ({...p, [site.id]: parseCSV(text)})); } catch(e) { console.warn(e); } }}
                      title={`Recharger : ${lastImports[`${site.id}_bing`].filename}`}
                      style={{ padding: "0 10px", border: `1px solid ${site.color}`, borderRadius: 9, background: site.bg, color: site.color, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                      ↩ Dernier
                    </button>
                  )}
                </div>
                <UploadCard label="Semrush Organic Pages" icon="📈" hint="Positions, trafic estimé, volumes" color={site.color}
                  loaded={smData[site.id]?.length > 0} rows={smData[site.id]}
                  onData={(_, rawText) => {
                    const rows = parseSemrush(parseSemrushCSV(rawText));
                    setSmData(p => ({...p, [site.id]: rows}));
                    // Auto-match keyword volumes if Keyword Overview format
                    const parsed = parseSemrushCSV(rawText);
                    if (parsed.length > 0 && parsed[0].keyword !== undefined) {
                      onSemrushVolumes?.(site.id, parsed);
                    }
                  }}
                  onClear={() => setSmData(p => ({...p, [site.id]: []}))}
                  rawMode siteId={site.id} source="sm" projectId={currentProjectId}
                  onAfterUpload={refreshHistory}
                  onLoadFromHistory={async row => { try { const text = await sbDownload(row.storage_path); const rows = parseSemrush(parseSemrushCSV(text)); setSmData(p => ({...p, [site.id]: rows})); } catch(e) { console.warn("History load error", e); } }} />
              </div>

              {/* Data status badges */}
              <div style={{ marginTop: 12, display: "flex", gap: 5, flexWrap: "wrap" }}>
                {[["SF", sfData[site.id]?.length || 0], ["GSC", gscData[site.id]?.length || 0], ["GA4", gaData[site.id]?.length || 0], ["Bing", bingData[site.id]?.length || 0], ["SM", smData[site.id]?.length || 0]].map(([src, n]) => (
                  <div key={src} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, fontWeight: 600, background: n > 0 ? site.bg : C.borderLight, color: n > 0 ? site.color : C.textLight }}>
                    {src} {n > 0 ? `· ${n}` : "· vide"}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Add site card */}
          {sites.length < 3 && (
            <div onClick={() => {
              const palette = SITE_PALETTE[sites.length] || SITE_PALETTE[0];
              const newId = `site-${Date.now()}`;
              setSites(prev => [...prev, { id: newId, label: `Site ${sites.length + 1}`, ...palette }]);
              setSfData(p => ({...p, [newId]: []}));
              setGscData(p => ({...p, [newId]: []}));
              setGaData(p => ({...p, [newId]: []}));
              setBingData(p => ({...p, [newId]: []}));
              setSmData(p => ({...p, [newId]: []}));
            }}
              style={{ background: C.white, border: `2px dashed ${C.border}`, borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer", minHeight: 180 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = C.blue}
              onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
            >
              <div style={{ width: 44, height: 44, borderRadius: 11, background: C.blueLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.blue }}>+</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.blue }}>Ajouter un site</div>
              <div style={{ fontSize: 11, color: C.textLight }}>Max 3 sites par projet</div>
            </div>
          )}
        </div>
      </Section>

      {/* ── 5. CONNEXIONS API ────────────── */}
      <Section number="5" title="Connexions API" sub="Récupération automatique des données sans export CSV" desc="Alternative aux imports manuels : branchez directement vos sources (GSC, Semrush...) pour récupérer les données automatiquement. Idéal pour un suivi récurrent une fois le projet en place.">
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "20px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
            {[
              { icon: "🔍", label: "Google Search Console", desc: "Clics, impressions, CTR, position via GSC API", color: "#2563EB", soon: true },
              { icon: "📊", label: "Google Analytics 4",    desc: "Sessions et vues via GA4 Data API",            color: "#EA580C", soon: true },
              { icon: "🤖", label: "Bing Webmaster",        desc: "Citations AI via Bing Webmaster API",          color: "#0891B2", soon: true },
              { icon: "📈", label: "Semrush API",           desc: "Position tracking via Semrush API",            color: "#059669", soon: true },
            ].map(({ icon, label, desc, color, soon }) => (
              <div key={label} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8, opacity: soon ? 0.7 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 12, color: C.text }}>{label}</span>
                  {soon && <span style={{ marginLeft: "auto", fontSize: 9, padding: "2px 7px", borderRadius: 10, background: C.bg, color: C.textLight, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Bientôt</span>}
                </div>
                <div style={{ fontSize: 11, color: C.textLight }}>{desc}</div>
                <button disabled style={{ padding: "6px 0", border: `1px solid ${color}44`, borderRadius: 7, background: `${color}0D`, color: color, fontSize: 11, fontWeight: 600, cursor: "not-allowed", opacity: 0.6 }}>
                  Connecter
                </button>
              </div>
            ))}
          </div>
        </div>
      </Section>
      {confirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: C.white, borderRadius: 14, padding: 32, maxWidth: 400, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 12 }}>Confirmer</div>
            <div style={{ fontSize: 14, color: C.textMid, marginBottom: 24 }}>{confirmModal.message}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmModal(null)} style={{ padding: "8px 20px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.white, cursor: "pointer", fontSize: 13, color: C.textMid }}>Annuler</button>
              <button onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }} style={{ padding: "8px 20px", border: "none", borderRadius: 8, background: "#DC2626", cursor: "pointer", fontSize: 13, color: "#fff", fontWeight: 600 }}>Confirmer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}