// ── DESIGN TOKENS ───────────────────────────────────────────────
export const C = {
  // ── Fonds ────────────────────────────────────────────────────────────
  bg:          "#F5F1E7", // crème Sonate (était un gris/blanc froid)
  white:       "#FFFFFF",
 
  // ── Textes ───────────────────────────────────────────────────────────
  text:        "#1A3C2E", // vert forêt — contraste 10.76 sur crème
  textMid:     "#4A5A52", // gris-vert — contraste 6.47 (était #64748B, bleuté)
  textLight:   "#5B6B63", // gris-vert — contraste 4.99 (était #94A3B8 ❌ 2.27)
 
  // ── Accent (ex-bleu, hors charte → orange Sonate) ────────────────────
  blue:        "#E8541A", // onglet actif, CTA, sélection
  blueLight:   "#FBE9E0", // fond d'onglet survolé / actif clair
 
  // ── Bordures ─────────────────────────────────────────────────────────
  border:      "#EDE7D9", // séparateur sur crème
  borderLight: "#F3EEE3",
};

export const SITE_PALETTE = [
  { color: "#2563EB", bg: "#EFF6FF" },
  { color: "#059669", bg: "#ECFDF5" },
  { color: "#7C3AED", bg: "#F5F3FF" },
];

export const DEFAULT_SITES = [
  { id: "site-1", label: "wedig.fr",      color: "#2563EB", bg: "#EFF6FF" },
  { id: "site-2", label: "deux.io",       color: "#059669", bg: "#ECFDF5" },
  { id: "site-3", label: "lets-clic.com", color: "#7C3AED", bg: "#F5F3FF" },
];

export const SF_DIMS = [
  { key: "avgTitleLen",     label: "Longueur moy. title (car.)", higher: true  },
  { key: "avgMetaLen",      label: "Longueur moy. meta (car.)",  higher: true  },
  { key: "avgH1Len",        label: "Longueur moy. H1 (car.)",    higher: true  },
  { key: "avgWords",        label: "Mots moyens / page",         higher: true  },
  { key: "avgPageSizeKB",   label: "Poids pages contenu (KB)",   higher: false },
  { key: "avgImgSizeKB",    label: "Poids moyen images (KB)",    higher: false },
  { key: "avgInlinksUniq",  label: "Liens entrants uniques moy.", higher: true  },
  { key: "avgOutlinksUniq", label: "Liens sortants uniques moy.", higher: true  },
  { key: "avgExtLinksUniq", label: "Liens ext. uniques moy.",    higher: false },
  { key: "avgDepth",        label: "Profondeur crawl moy.",      higher: false },
  { key: "avgFlesch",       label: "Score Flesch moy.",          higher: true  },
  { key: "tableRate",       label: "Pages avec tableau (%)",     higher: true  },
  { key: "schemaRate",      label: "Pages avec Schema (%)",      higher: true  },
  { key: "errorRate",       label: "Taux d'erreurs (%)",         higher: false },
  { key: "redirectRate",    label: "Taux redirections (%)",      higher: false },
  { key: "totalPages",      label: "Nb pages crawlées",          higher: true  },
];

export const RES_KPIS = [
  { key: "clicks",      label: "Clics GSC",       src: "gsc"  },
  { key: "impressions", label: "Impressions GSC",  src: "gsc"  },
  { key: "ctr",         label: "CTR (%)",          src: "gsc"  },
  { key: "position",    label: "Position moy.",    src: "gsc"  },
  { key: "sessions",    label: "Sessions GA4",     src: "ga"   },
  { key: "views",       label: "Vues GA4",         src: "ga"   },
  { key: "geoMentions", label: "Citations Bing AI", src: "bing" },
];

export const PAGE_MODES = [
  { key: "all",  label: "Toutes les pages",      icon: "📄" },
  { key: "geo",  label: "Top succès GEO (Bing)", icon: "🤖" },
  { key: "seo",  label: "Top succès SEO (GSC)",  icon: "🔍" },
];

export const SCHEMA_TYPES = [
  "Article", "BlogPosting", "Product", "Offer", "FAQPage",
  "BreadcrumbList", "Organization", "LocalBusiness", "WebPage",
  "Service", "Event", "Person", "Review", "HowTo",
];

export const RADAR_DIMS = [
  { key: "totalPages",      label: "Pages",          max: 5000 },
  { key: "totalImg",        label: "Images",         max: 2000 },
  { key: "avgInlinksUniq",  label: "Inlinks uniq.",  max: 100  },
  { key: "avgOutlinksUniq", label: "Outlinks uniq.", max: 100  },
  { key: "avgExtLinksUniq", label: "Liens ext.",     max: 50   },
  { key: "indexableRate",   label: "Indexables %",   max: 100  },
  { key: "avgWords",        label: "Mots moy.",      max: 1000 },
];

export const SF_DIM_TOOLTIPS = {
  avgTitleLen:    "Longueur moyenne des balises <title> (car.).",
  avgMetaLen:     "Longueur moyenne des meta descriptions (car.).",
  avgH1Len:       "Longueur moyenne des H1 (car.).",
  avgWords:       "Nombre moyen de mots par page.",
  avgPageSizeKB:  "Poids moyen des pages HTML (KB).",
  avgImgSizeKB:   "Poids moyen des images (KB).",
  avgInlinks:     "Liens internes entrants moyens par page.",
  avgOutlinks:    "Liens sortants moyens par page.",
  avgInlinksUniq: "Liens internes entrants uniques moyens.",
  avgOutlinksUniq:"Liens sortants uniques moyens.",
  avgExtLinksUniq:"Liens externes uniques moyens.",
  avgDepth:       "Profondeur de crawl moyenne (niveaux depuis la home).",
  avgFlesch:      "Score de lisibilité Flesch moyen (0–100).",
  tableRate:      "% de pages contenant un tableau HTML.",
  schemaRate:     "% de pages avec un schema JSON-LD.",
  errorRate:      "% de pages en erreur HTTP 4xx.",
  redirectRate:   "% d'URLs en redirection 3xx.",
  totalPages:     "Nombre total de pages HTML crawlées.",
};

export const KPI_TOOLTIPS = {
  "Clics GSC":         "Clics organiques Google Search.",
  "Impressions GSC":   "Apparitions dans les résultats Google.",
  "CTR (%)":           "Taux de clic (Clics ÷ Impressions).",
  "Position moy.":     "Position moyenne dans Google Search.",
  "Sessions GA4":      "Sessions Google Analytics 4.",
  "Vues GA4":          "Pages vues GA4.",
  "Citations Bing AI": "Citations dans les réponses Bing AI (Copilot).",
};


export const SEMRUSH_DIMS = [
  { key: "smKwCount",    label: "Mots-clés trackés",       higher: true  },
  { key: "smTop3",       label: "Mots-clés Top 3",          higher: true  },
  { key: "smTop10",      label: "Mots-clés Top 10",         higher: true  },
  { key: "smOpps",       label: "Opportunités (pos. 11-20)", higher: true  },
  { key: "smTraffic",    label: "Trafic estimé Semrush",    higher: true  },
  { key: "smAvgPos",     label: "Position moy. Semrush",    higher: false },
];


// ── PAGE TYPES ───────────────────────────────────────────────────
export const PAGE_TYPES = [
  { key: "article",     label: "Article",         icon: "📝", color: "#7C3AED", bg: "#F5F3FF" },
  { key: "landing",     label: "Landing",         icon: "🎯", color: "#DC2626", bg: "#FEF2F2" },
  { key: "categorie",   label: "Catégorie",       icon: "📂", color: "#D97706", bg: "#FFFBEB" },
  { key: "home",        label: "Accueil",         icon: "🏠", color: "#059669", bg: "#ECFDF5" },
  { key: "fiche",       label: "Fiche produit",   icon: "🛍️", color: "#2563EB", bg: "#EFF6FF" },
  { key: "contact",     label: "Contact",         icon: "📬", color: "#0891B2", bg: "#ECFEFF" },
  { key: "about",       label: "À propos",        icon: "ℹ️",  color: "#64748B", bg: "#F1F5F9" },
  { key: "comparatif",  label: "Comparatif",      icon: "⚖️",  color: "#EA580C", bg: "#FFF7ED" },
  { key: "autre",       label: "Autre",           icon: "❓", color: "#94A3B8", bg: "#F8FAFC" },
];

export const PAGE_TYPE_MAP = Object.fromEntries(PAGE_TYPES.map(t => [t.key, t]));