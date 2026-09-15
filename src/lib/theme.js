// ════════════════════════════════════════════════════════════════════════
//  Charte graphique Sonate — source unique de vérité (Echo)
//  Alignée sur le Simulateur SEO : crème + vert forêt sombre + orange vif.
//
//  RÈGLE : aucune couleur en dur dans les composants. On importe T depuis ici.
//  Aligner Echo sur une évolution de la charte = modifier CE fichier seulement.
// ════════════════════════════════════════════════════════════════════════

// ── Palette brute (ne pas utiliser directement : passer par les rôles) ──
const PALETTE = {
  green900: "#142E24", // bandeau / en-tête de panneau sombre
  green800: "#17352A",
  green700: "#1A3C2E", // vert forêt Sonate — fond des panneaux sombres
  green600: "#2E5E3A",
  green100: "#EAF0EC", // vert très clair (fonds de badge sur clair)

  cream:    "#F5F1E7", // fond de page / colonne latérale
  cream200: "#EDE7D9", // séparateurs sur crème
  white:    "#FFFFFF",

  orange:   "#E8541A", // accent Sonate — chiffres clés, CTA, marqueurs ◆
  orange600:"#C94512", // survol / bordure appuyée
  orange100:"#FBE9E0", // fond de badge orange sur clair

  // Gris TEINTÉS VERT (dérivés du vert forêt) — remplacent les gris bleutés
  // hors charte (#94A3B8, #64748B) qui échouaient au contraste.
  sage700:  "#4A5A52", // texte tertiaire sur clair — contraste 6.47 sur crème
  sage600:  "#5B6B63", // texte secondaire sur clair — contraste 4.99 sur crème
  sage300:  "#A8B5AC", // texte secondaire SUR FOND SOMBRE — 5.71 sur vert
  sage200:  "#CFD8CF", // texte lisible sur fond sombre — 8.31 sur vert

  red:      "#C0352A", // erreur / perte
  redLight: "#FBE9E7",
};

// ── Rôles sémantiques : c'est CE QUE les composants utilisent ──
export const T = {
  // Fonds
  bg:            PALETTE.cream,     // fond de page
  bgPanel:       PALETTE.white,     // carte sur fond clair
  bgDark:        PALETTE.green700,  // panneau sombre (zone de résultats)
  bgDarkHeader:  PALETTE.green900,  // bandeau en tête de panneau sombre
  bgSubtle:      PALETTE.green100,

  // Textes SUR FOND CLAIR
  text:          PALETTE.green700,  // texte principal — 10.76 sur crème
  textMuted:     PALETTE.sage600,   // secondaire (remplace #94A3B8 ❌)
  textSubtle:    PALETTE.sage700,   // labels, légendes

  // Textes SUR FOND SOMBRE
  textOnDark:      PALETTE.cream,
  textMutedOnDark: PALETTE.sage300, // libellés en capitales des cartes sombres

  // Accent
  accent:        PALETTE.orange,    // chiffres clés, CTA, marqueur ◆
  accentHover:   "#C94512",
  accentSoft:    PALETTE.orange100,

  // États
  danger:        PALETTE.red,
  dangerSoft:    PALETTE.redLight,
  success:       PALETTE.green600,

  // Bordures
  border:        PALETTE.cream200,          // sur clair
  borderDark:    "rgba(245,241,231,0.14)",  // sur sombre (cartes vert/vert)
  borderAccent:  PALETTE.orange,            // carte mise en avant

  // Rayons & ombres — le simulateur reste sobre, arrondis discrets
  radius:    6,
  radiusLg:  10,
  shadow:    "0 1px 2px rgba(20,46,36,0.06)",
  shadowLg:  "0 4px 16px rgba(20,46,36,0.10)",
};

// ── Typographie Sonate ──
export const FONT = {
  // Titres : serif Playfair Display (le logo « Sonate »)
  heading: "'Playfair Display', Georgia, 'Times New Roman', serif",
  // Corps & interface : Inter
  body:    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono:    "ui-monospace, SFMono-Regular, Menlo, monospace",
};

// Le marqueur ◆ qui précède les titres de section dans le simulateur
export const DIAMOND = "◆";
