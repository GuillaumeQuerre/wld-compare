import { useState, useEffect, useRef } from "react";
import { C, PAGE_TYPES } from "../lib/constants";
import { sbSavePageTypes, sbGetPageTypes, sbDeletePageTypes } from "../lib/supabase";

const TYPE_KEYS = PAGE_TYPES.map(t => t.key);

// ── Signal detection ─────────────────────────────────────────────

function findCol(row, fragments) {
  const key = Object.keys(row).find(k =>
    fragments.some(f => k.toLowerCase().includes(f.toLowerCase()))
  );
  return key ? (row[key] || "").trim() : "";
}

function detectSignals(sfRows) {
  if (!sfRows?.length) return { jsonLd: false, breadcrumb: false, bodyClass: false, mainContent: false };
  const keys = Object.keys(sfRows[0]).map(k => k.toLowerCase());
  return {
    jsonLd:      keys.some(k => k.includes("json_ld")      || k.includes("json-ld")     || k.includes("ld+json")),
    breadcrumb:  keys.some(k => k.includes("breadcrumb")   || k.includes("fil d'ariane") || k.includes("miette")),
    bodyClass:   keys.some(k => k.includes("body_class")   || k.includes("body class")  || k.includes("body/@class")),
    mainContent: keys.some(k => k.includes("custom extraction") || k.includes("extraction personnalisée") || k.includes("main_content") || k.includes("custom_extract")),
  };
}

function extractSignals(row) {
  return {
    jsonLd:      findCol(row, ["json_ld", "json-ld", "ld+json", "schema"]).slice(0, 800),
    breadcrumb:  findCol(row, ["breadcrumb", "fil d'ariane", "fil ariane", "miette"]).slice(0, 200),
    bodyClass:   findCol(row, ["body_class", "body class", "classe body", "body/@class"]).slice(0, 200),
    mainContent: findCol(row, ["custom extraction", "extraction personnalisée", "main_content", "custom_extract"]).slice(0, 500),
  };
}

// ── Deterministic classification ─────────────────────────────────

const JSONLD_TYPE_MAP = {
  "article": "article", "newsarticle": "article", "blogposting": "article", "techarticle": "article",
  "product": "fiche", "itempage": "fiche", "productgroup": "fiche",
  "collectionpage": "categorie", "categorypage": "categorie", "searchresultspage": "categorie",
  "contactpage": "contact", "aboutpage": "about", "website": "home", "webpage": null,
};

function tryJsonLdClassify(jsonLdRaw) {
  if (!jsonLdRaw) return null;
  const types = [...jsonLdRaw.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1].toLowerCase());
  for (const t of types) {
    const mapped = JSONLD_TYPE_MAP[t];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

function tryBodyClassClassify(bodyClass) {
  if (!bodyClass) return null;
  const c = bodyClass.toLowerCase();
  if (c.includes("single-post") || c.includes("post-type-post") || c.includes("blog-post") || c.includes("article")) return "article";
  if (c.includes("single-product") || c.includes("product-page") || (c.includes("woocommerce-page") && c.includes("product"))) return "fiche";
  if (c.includes("category") || c.includes("archive") || c.includes("tax-") || c.includes("listing")) return "categorie";
  if (c.includes("home") || c.includes("front-page") || c.includes("page-home")) return "home";
  if (c.includes("contact")) return "contact";
  if (c.includes("about") || c.includes("a-propos")) return "about";
  return null;
}

function tryBreadcrumbClassify(breadcrumb) {
  if (!breadcrumb) return null;
  const b = breadcrumb.toLowerCase();
  if (b.includes("blog") || b.includes("article") || b.includes("news") || b.includes("actualit")) return "article";
  if (b.includes("produit") || b.includes("product") || b.includes("shop") || b.includes("boutique")) return "fiche";
  if (b.includes("catégorie") || b.includes("category") || b.includes("collection")) return "categorie";
  if (b.includes("contact")) return "contact";
  if (b.includes("à propos") || b.includes("about") || b.includes("équipe")) return "about";
  return null;
}

function tryDeterministicClassify(url, signals, sfRow) {
  const path    = url.toLowerCase().replace(/https?:\/\/[^/]+/, "").replace(/\/$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const depth   = segments.length;
  const slug    = segments[segments.length - 1] || "";

  // ── 1. Accueil ────────────────────────────────────────────────
  if (path === "/" || path === "/index" || path === "/accueil" || path === "/home") return "home";

  // ── 2. JSON-LD @type (signal le plus fiable) ──────────────────
  const fromJsonLd = tryJsonLdClassify(signals.jsonLd);
  if (fromJsonLd) return fromJsonLd;

  // ── 3. Body class CSS ─────────────────────────────────────────
  const fromBody = tryBodyClassClassify(signals.bodyClass);
  if (fromBody) return fromBody;

  // ── 4. Breadcrumb ─────────────────────────────────────────────
  const fromBreadcrumb = tryBreadcrumbClassify(signals.breadcrumb);
  if (fromBreadcrumb) return fromBreadcrumb;

  // ── 5. Patterns URL — segments ────────────────────────────────
  const anySegment = (rx) => segments.some(s => rx.test(s));

  if (anySegment(/^(blog|articles?|news|actu|actualit[eé]s?|dossiers?|chroniques?|edito|editorial|insights?|ressources?|guides?|tutos?|tutoriels?|howto|posts?)$/))
    return "article";

  if (anySegment(/^(cat[eé]gorie?s?|categories|collection|collections|tag|tags|archive|archives|listing|listings|rayon|rayons|univers|thème|themes?)$/))
    return "categorie";

  if (anySegment(/^(produits?|products?|shop|boutique|fiches?|items?|p|ref|sku|catalogue)$/) && depth >= 2)
    return "fiche";

  if (anySegment(/^(lp|landing|campagnes?|promo|offre|deals?)$/) || slug.startsWith("lp-") || slug.startsWith("landing-"))
    return "landing";

  if (anySegment(/^(contact|contacts|devis|quote|rdv|rendez-vous|rappel|callback|nous-contacter|contactez)$/))
    return "contact";

  if (anySegment(/^(about|a-propos|qui-sommes-nous|notre-equipe|equipe|team|histoire|story|cgv|cgu|mentions|legal|privacy|politique|cookies|faq|aide)$/))
    return "about";

  if (anySegment(/^(comparatif|comparaison|vs|versus|top|meilleur|alternative|meilleures?|classement|avis|reviews?|benchmark)$/))
    return "comparatif";

  // ── 6. Patterns sur le slug terminal ─────────────────────────
  // Dates dans le slug → article  (ex: mon-article-2024-03)
  if (/\b(20[12][0-9])\b/.test(slug) && slug.split("-").length >= 4) return "article";

  // Slug très long (≥7 mots séparés par tirets) → article probable
  if (slug.split("-").length >= 7) return "article";

  // Slug court à profondeur 1 avec ID/ref numérique → fiche
  if (depth === 1 && /[0-9]{3,}/.test(slug)) return "fiche";

  // Comparatifs : "X-vs-Y" ou "meilleur-X" dans le slug
  if (/\bvs\b/.test(slug) || slug.startsWith("meilleur") || slug.startsWith("top-[0-9]") || slug.includes("-vs-")) return "comparatif";

  // Contact / légal via slug terminal seul
  if (/^(contact|devis|quote|rgpd|legal|cgu|cgv|mentions|privacy|faq|aide)$/.test(slug)) return "contact";
  if (/^(about|equipe|team|histoire|a-propos)$/.test(slug)) return "about";

  // ── 7. Signaux SF quantitatifs (si disponibles) ───────────────
  if (sfRow) {
    const words   = parseFloat(sfRow["nombre de mots"] || sfRow["word count"] || 0) || 0;
    const inlinks = parseFloat(sfRow["liens entrants"] || sfRow["inlinks"] || 0) || 0;
    const inlkUniq= parseFloat(sfRow["liens entrants uniques"] || 0) || 0;
    const title   = (sfRow["title 1"] || sfRow["title"] || "").toLowerCase();
    const h1      = (sfRow["h1-1"]    || sfRow["h1"]   || "").toLowerCase();
    const combined = title + " " + h1;

    // Comparatif signals dans title/H1
    if (/\bvs\b|versus|comparatif|meilleur|top [0-9]|alternative|benchmark|classement/.test(combined)) return "comparatif";

    // Contact via H1
    if (/contact|devis|rappel|formulaire|nous [eé]crire|nous appeler/.test(h1)) return "contact";

    // Article : contenu long + peu d'inlinks internes
    if (words >= 700 && inlinks <= 8) return "article";

    // Catégorie : beaucoup d'inlinks, peu de mots (hub de navigation)
    if (inlkUniq >= 15 && words <= 350) return "categorie";

    // Landing : 1 segment URL, contenu modéré
    if (depth === 1 && words >= 150 && inlinks <= 5) return "landing";

    // Fiche : depth ≥ 2, peu de mots, peu d'inlinks (fiche isolée)
    if (depth >= 2 && words <= 250 && inlinks <= 5) return "fiche";
  }

  return null;
}

// ── AI prompt ────────────────────────────────────────────────────

function buildClassifyPrompt(pages) {
  const typeList = PAGE_TYPES.map(t => `"${t.key}" — ${t.label}`).join("\n");
  const pagesStr = pages.map((p, i) => {
    const lines = [`[${i}] URL: ${p.url}`, `Title: ${p.title}`, `H1: ${p.h1}`];
    if (p.signals.breadcrumb)  lines.push(`Breadcrumb: ${p.signals.breadcrumb}`);
    if (p.signals.bodyClass)   lines.push(`Body class: ${p.signals.bodyClass}`);
    if (p.signals.mainContent) lines.push(`Contenu main: ${p.signals.mainContent}`);
    return lines.join("\n");
  }).join("\n\n");
  return `Tu es un expert SEO. Classe chaque page dans UN seul type parmi cette liste :\n${typeList}\n\nRéponds UNIQUEMENT avec un JSON strict, tableau d'objets :\n[{"i":0,"type":"landing"},{"i":1,"type":"article"},...]\n\nPages à classifier :\n${pagesStr}`;
}

// ── Component ────────────────────────────────────────────────────

export default function PageTypeClassifier({ siteId, projectId, sfRows, pageTypes, setPageTypes }) {
  const [status, setStatus]         = useState("idle"); // idle | running_det | running_ai | done | partial
  const [progress, setProgress]     = useState({ det: 0, ai: 0, aiTotal: 0, total: 0 });
  const [pendingAI, setPendingAI]   = useState([]); // pages that still need AI (after 429 exhaustion)
  const [warnings, setWarnings]     = useState([]); // e.g. "3 pages non classifiées (429)"
  const autoTriggeredRef            = useRef(false);
  // Keep partial results across retries
  const resultsRef                  = useRef({});
  const dbRowsRef                   = useRef([]);

  const signals    = sfRows?.length ? detectSignals(sfRows) : {};
  const hasSignal  = Object.values(signals).some(Boolean);
  const BATCH      = 10;

  // ── Load from DB on mount, auto-run deterministic if nothing saved ──
  useEffect(() => {
    if (!projectId || !siteId || !sfRows?.length) return;
    sbGetPageTypes(projectId, siteId).then(rows => {
      if (rows.length) {
        const map = {};
        rows.forEach(r => { map[r.url] = r.page_type; });
        setPageTypes(prev => ({ ...prev, [siteId]: map }));
      } else if (!autoTriggeredRef.current) {
        autoTriggeredRef.current = true;
        runDeterministic();
      }
    });
  }, [projectId, siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pass 1: deterministic only ───────────────────────────────────
  const runDeterministic = async () => {
    setStatus("running_det");
    setWarnings([]);
    resultsRef.current  = {};
    dbRowsRef.current   = [];

    const html = sfRows.filter(r => {
      const ct = (r["type de contenu"] || r["content type"] || r["type"] || "").toLowerCase();
      const sc = parseInt(r["code http"] || r["status code"] || 200);
      if (sc >= 400) return false;
      if (ct.includes("html")) return true;
      if (ct === "") {
        return (r["title 1"] || r["title"] || "").trim() !== "" ||
               (r["h1-1"]   || r["h1"]    || "").trim() !== "";
      }
      return false;
    });

    const allPages = html.map(r => ({
      url:     (r["adresse"] || r["address"] || r["url"] || "").trim(),
      title:   (r["title 1"] || r["title"] || "").slice(0, 80),
      h1:      (r["h1-1"] || r["h1"] || "").slice(0, 80),
      signals: extractSignals(r),
      sfRow:   r,
    })).filter(p => p.url);

    const needsAI = [];
    let detCount = 0;

    allPages.forEach(p => {
      const type = tryDeterministicClassify(p.url, p.signals, p.sfRow);
      if (type) {
        resultsRef.current[p.url] = type;
        dbRowsRef.current.push({ project_id: projectId, site_id: siteId, url: p.url, page_type: type, confidence: "auto" });
        detCount++;
      } else {
        needsAI.push(p);
      }
    });

    setProgress({ det: detCount, ai: 0, aiTotal: needsAI.length, total: allPages.length });
    setPendingAI(needsAI);

    // Save deterministic results immediately
    if (dbRowsRef.current.length) {
      await sbSavePageTypes(dbRowsRef.current);
      setPageTypes(prev => ({ ...prev, [siteId]: { ...resultsRef.current } }));
    }

    setStatus("done");
  };

  // ── Pass 2: AI for pending pages ─────────────────────────────────
  const runAI = async (pages) => {
    if (!pages?.length) return;
    setStatus("running_ai");
    setWarnings([]);

    const newDbRows = [];
    const stillPending = [];

    for (let i = 0; i < pages.length; i += BATCH) {
      const batch = pages.slice(i, i + BATCH);
      const prompt = buildClassifyPrompt(batch);

      let res, retries = 0, hit429 = false;
      while (retries <= 4) {
        res = await fetch("/api/anthropic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1000,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (res.status === 429) {
          const wait = 2000 * Math.pow(2, retries);
          retries++;
          await new Promise(r => setTimeout(r, wait));
        } else {
          break;
        }
      }

      // After max retries, still 429 → keep pages pending, continue
      if (res.status === 429) {
        hit429 = true;
        batch.forEach(p => stillPending.push(p));
      } else if (res.ok) {
        const data = await res.json();
        const text = data.content?.find(b => b.type === "text")?.text || "[]";
        let parsed = [];
        try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); }
        catch { console.warn("Parse error", text.slice(0, 200)); }

        parsed.forEach(({ i: idx, type }) => {
          const page = batch[idx];
          if (!page) return;
          const validType = TYPE_KEYS.includes(type) ? type : "autre";
          resultsRef.current[page.url] = validType;
          newDbRows.push({ project_id: projectId, site_id: siteId, url: page.url, page_type: validType, confidence: "auto" });
        });
        // Pages not returned by Claude → mark as "autre"
        batch.forEach((page, idx) => {
          if (!parsed.find(p => p.i === idx)) {
            resultsRef.current[page.url] = "autre";
            newDbRows.push({ project_id: projectId, site_id: siteId, url: page.url, page_type: "autre", confidence: "auto" });
          }
        });
      } else {
        // Other error — keep pending
        batch.forEach(p => stillPending.push(p));
      }

      setProgress(prev => ({
        ...prev,
        ai: Math.min(i + BATCH, pages.length) - stillPending.length,
      }));

      if (!hit429 && i + BATCH < pages.length) await new Promise(r => setTimeout(r, 1500));
    }

    // Save new AI results
    if (newDbRows.length) {
      await sbSavePageTypes(newDbRows);
      setPageTypes(prev => ({ ...prev, [siteId]: { ...resultsRef.current } }));
    }

    if (stillPending.length) {
      setPendingAI(stillPending);
      setWarnings([`${stillPending.length} page${stillPending.length > 1 ? "s" : ""} non classifiée${stillPending.length > 1 ? "s" : ""} (limite API 429) — cliquez "Relancer" pour réessayer`]);
      setStatus("partial");
    } else {
      setPendingAI([]);
      setStatus("done");
    }
  };

  const reset = async () => {
    await sbDeletePageTypes(projectId, siteId);
    setPageTypes(prev => ({ ...prev, [siteId]: {} }));
    resultsRef.current  = {};
    dbRowsRef.current   = [];
    setPendingAI([]);
    setWarnings([]);
    setStatus("idle");
    setProgress({ det: 0, ai: 0, aiTotal: 0, total: 0 });
    autoTriggeredRef.current = false;
  };

  const typeCount = pageTypes[siteId] ? Object.keys(pageTypes[siteId]).length : 0;
  const typeDist  = pageTypes[siteId]
    ? PAGE_TYPES.map(t => ({ ...t, count: Object.values(pageTypes[siteId]).filter(v => v === t.key).length })).filter(t => t.count > 0)
    : [];

  const isRunning = status === "running_det" || status === "running_ai";
  const pct = progress.total
    ? Math.round((progress.det + progress.ai) / progress.total * 100)
    : 0;

  const signalBadges = [
    { key: "jsonLd",      label: "JSON-LD",    active: signals.jsonLd,      tip: "Meilleur signal — @type détecté directement" },
    { key: "breadcrumb",  label: "Breadcrumb", active: signals.breadcrumb,  tip: "Chemin de navigation" },
    { key: "bodyClass",   label: "Body class", active: signals.bodyClass,   tip: "Classes CSS du <body>" },
    { key: "mainContent", label: "<main>",     active: signals.mainContent, tip: "Contenu textuel du <main>" },
  ];

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>🏷️ Classification des templates</div>
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>
            {hasSignal
              ? "Signaux SF détectés — classification déterministe + Claude pour les cas ambigus"
              : "Aucun signal custom — classification par URL + Title + H1 uniquement"}
          </div>
        </div>
        {typeCount > 0 && !isRunning && (
          <button onClick={reset} style={{ padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 7, background: C.white, color: C.textLight, fontSize: 11, cursor: "pointer" }}>
            Réinitialiser
          </button>
        )}
      </div>

      {/* Signal badges */}
      <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
        {signalBadges.map(b => (
          <span key={b.key} title={b.tip} style={{
            fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
            background: b.active ? "#ECFDF5" : C.bg,
            color: b.active ? "#059669" : "#94A3B8",
            border: `1px solid ${b.active ? "#6EE7B7" : C.border}`,
          }}>
            {b.active ? "✓" : "·"} {b.label}
          </span>
        ))}
      </div>

      {/* Progress bar (while running) */}
      {isRunning && (
        <>
          <div style={{ height: 4, background: C.bg, borderRadius: 2, marginBottom: 6, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: C.blue, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 10, color: C.textLight, marginBottom: 10 }}>
            {status === "running_det" && "Classification déterministe en cours…"}
            {status === "running_ai" && (
              <>
                <span style={{ color: "#059669" }}>{progress.det} sans IA</span>
                {" · "}
                <span style={{ color: C.blue }}>{progress.ai}/{progress.aiTotal} via Claude…</span>
              </>
            )}
          </div>
        </>
      )}

      {/* Done summary */}
      {(status === "done" || status === "partial") && progress.total > 0 && (
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span>
            <span style={{ fontWeight: 700, color: C.text }}>{typeCount}</span> pages classifiées
            <span style={{ color: "#94A3B8" }}> / {progress.total}</span>
          </span>
          <span style={{ color: "#059669" }}>✓ {progress.det} par règles</span>
          {progress.ai > 0 && <span style={{ color: C.blue }}>✦ {progress.ai} via Claude</span>}
        </div>
      )}

      {/* 429 warning + retry */}
      {warnings.map((w, i) => (
        <div key={i} style={{ fontSize: 11, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 7, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span>⚠️ {w}</span>
          <button
            onClick={() => runAI(pendingAI)}
            style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 6, background: "#F59E0B", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            Relancer ({pendingAI.length})
          </button>
        </div>
      ))}

      {/* Type distribution */}
      {typeDist.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
          {typeDist.sort((a, b) => b.count - a.count).map(t => (
            <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 4, background: t.bg, border: `1px solid ${t.color}33`, borderRadius: 20, padding: "3px 10px" }}>
              <span style={{ fontSize: 11 }}>{t.icon}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: t.color }}>{t.label}</span>
              <span style={{ fontSize: 11, color: t.color, opacity: 0.7 }}>{t.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* SF config hint when no signals */}
      {!hasSignal && status !== "running_det" && status !== "running_ai" && typeCount === 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: C.textLight, background: C.bg, borderRadius: 7, padding: "10px 12px", borderLeft: `3px solid ${C.border}`, marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>💡 Ajouter des extracts SF pour une meilleure précision</div>
          {[
            ["JSON-LD", "//script[@type='application/ld+json']", "Inner HTML"],
            ["Breadcrumb", "//nav[contains(@class,'bread')]//text()", "Text"],
            ["Body class", "//body/@class", "Text"],
          ].map(([name, selector, type]) => (
            <div key={name} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: C.text }}>{name}</span>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: C.blue, marginLeft: 8 }}>{selector}</span>
              <span style={{ fontSize: 10, color: C.textLight, marginLeft: 6 }}>· {type}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI button — discreet, at the bottom */}
      {!isRunning && (
        <div style={{ borderTop: `1px solid ${C.borderLight}`, paddingTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: C.textLight }}>
            {pendingAI.length > 0
              ? `${pendingAI.length} page${pendingAI.length > 1 ? "s" : ""} à affiner avec Claude`
              : typeCount > 0
                ? `${progress.total - progress.det > 0 ? progress.total - progress.det + " pages via Claude · " : ""}Classification complète`
                : sfRows?.length
                  ? `${sfRows.length} pages à classifier`
                  : "Importez un CSV SF"}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {status === "idle" && sfRows?.length > 0 && (
              <button
                onClick={runDeterministic}
                disabled={!sfRows?.length}
                style={{ padding: "4px 12px", border: `1px solid ${C.border}`, borderRadius: 6, background: C.white, color: C.textMid, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
              >
                Classifier (sans IA)
              </button>
            )}
            {(status === "done" || status === "partial" || status === "idle") && sfRows?.length > 0 && (
              <button
                onClick={() => {
                  // Collect all unclassified pages for AI pass
                  const html = sfRows.filter(r => {
                    const ct = (r["type de contenu"] || r["content type"] || r["type"] || "").toLowerCase();
                    const sc = parseInt(r["code http"] || r["status code"] || 200);
                    if (sc >= 400) return false;
                    if (ct.includes("html")) return true;
                    if (ct === "") return (r["title 1"] || r["title"] || "").trim() !== "" || (r["h1-1"] || r["h1"] || "").trim() !== "";
                    return false;
                  });
                  const allPages = html.map(r => ({
                    url:     (r["adresse"] || r["address"] || r["url"] || "").trim(),
                    title:   (r["title 1"] || r["title"] || "").slice(0, 80),
                    h1:      (r["h1-1"] || r["h1"] || "").slice(0, 80),
                    signals: extractSignals(r),
                  })).filter(p => p.url);
                  // Only send pages not yet classified or classified as "autre"
                  const toReclassify = allPages.filter(p =>
                    !resultsRef.current[p.url] || resultsRef.current[p.url] === "autre"
                  );
                  // If no pending from 429, use those pending pages or all unclassified
                  const target = pendingAI.length > 0 ? pendingAI : toReclassify;
                  setProgress(prev => ({ ...prev, aiTotal: target.length, ai: 0 }));
                  runAI(target);
                }}
                style={{
                  padding: "4px 12px", border: `1px solid ${C.blue}33`, borderRadius: 6,
                  background: "transparent", color: C.blue,
                  fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: 0.8,
                }}
              >
                {pendingAI.length > 0 ? `Relancer Claude (${pendingAI.length})` : "✦ Affiner avec Claude"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}