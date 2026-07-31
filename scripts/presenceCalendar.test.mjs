/**
 * Tests unitaires — affichage des carrés du calendrier de présence.
 * Teste les helpers PURS extraits de PresenceCalendar (le vrai code de rendu).
 *
 *   node presenceCalendar.test.mjs
 *
 * Couvre : classification d'une entrée, fusion du jour, groupement par provider,
 * couleur, glyphe, et filtrage par marque (site_id) — les points qui décident
 * de ce que l'utilisateur voit dans chaque carré.
 */
import {
  classifyCalEntry, mergeCalCells, groupCalByProvider,
  cellColor, cellGlyph, filterCalBySite,
} from "../src/lib/calendarDisplay.js";

let ko = 0, total = 0;
const eq = (name, got, exp) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) ko++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `  →  ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`}`);
};

console.log("──── classifyCalEntry : type + position ────");
eq("mention #2 → {present, m, pos 2}",
  classifyCalEntry({ brand_present: 1, brand_mention: 1, mention_position: 2 }),
  { present: true, type: "m", pos: 2 });
eq("évocation → {present, e}",
  classifyCalEntry({ brand_present: 1, brand_evocation: 1 }),
  { present: true, type: "e", pos: null });
eq("citation → {present, c}",
  classifyCalEntry({ brand_present: 1, brand_citation: 1 }),
  { present: true, type: "c", pos: null });
eq("absent → {!present, null}",
  classifyCalEntry({ brand_present: 0 }),
  { present: false, type: null, pos: null });
eq("mention SANS position → pos null",
  classifyCalEntry({ brand_present: 1, brand_mention: 1, mention_position: null }),
  { present: true, type: "m", pos: null });

console.log("\n──── mergeCalCells : type le plus fort l'emporte (m>e>c) ────");
eq("évocation puis mention → mention",
  mergeCalCells({ present: true, type: "e", pos: null }, { present: true, type: "m", pos: 1 }),
  { present: true, type: "m", pos: 1 });
eq("mention puis citation → reste mention",
  mergeCalCells({ present: true, type: "m", pos: 3 }, { present: true, type: "c", pos: null }),
  { present: true, type: "m", pos: 3 });
eq("cellule absente initiale → prend la candidate",
  mergeCalCells(undefined, { present: true, type: "e", pos: null }),
  { present: true, type: "e", pos: null });
eq("absent + présent → présent l'emporte",
  mergeCalCells({ present: false, type: null, pos: null }, { present: true, type: "c", pos: null }),
  { present: true, type: "c", pos: null });

console.log("\n──── groupCalByProvider : regroupement date/provider ────");
{
  const by = groupCalByProvider([
    { provider_id: "openai", test_date: "2026-07-31", brand_present: 1, brand_mention: 1, mention_position: 2 },
    { provider_id: "openai", test_date: "2026-07-31", brand_present: 1, brand_evocation: 1 }, // même jour, plus faible
    { provider_id: "gemini", test_date: "2026-07-30", brand_present: 1, brand_citation: 1 },
  ]);
  eq("openai 31/07 fusionné en mention #2", by.openai["2026-07-31"], { present: true, type: "m", pos: 2 });
  eq("gemini 30/07 en citation", by.gemini["2026-07-30"], { present: true, type: "c", pos: null });
  eq("deux providers distincts", Object.keys(by).sort(), ["gemini", "openai"]);
}

console.log("\n──── cellColor : couleur du carré ────");
eq("non testé (undefined) → gris", cellColor(undefined), "#E5E7EB");
eq("absent → rouge", cellColor({ present: false }), "#DC2626");
eq("mention → vert", cellColor({ present: true, type: "m" }), "#059669");
eq("évocation → orange", cellColor({ present: true, type: "e" }), "#D97706");
eq("citation → vert profond", cellColor({ present: true, type: "c" }), "#1A3C2E");

console.log("\n──── cellGlyph : contenu du carré ────");
eq("mention #4 → '4'", cellGlyph({ present: true, type: "m", pos: 4 }), "4");
eq("mention sans position → 'm'", cellGlyph({ present: true, type: "m", pos: null }), "m");
eq("évocation → 'e'", cellGlyph({ present: true, type: "e" }), "e");
eq("citation → 'c'", cellGlyph({ present: true, type: "c" }), "c");
eq("absent → vide", cellGlyph({ present: false }), "");
eq("undefined → vide", cellGlyph(undefined), "");

console.log("\n──── filterCalBySite : lignes par marque (LE bug de l'image) ────");
{
  const entries = [
    { provider_id: "openai", site_id: "wedig",    test_date: "2026-07-31", brand_present: 1, brand_mention: 1, mention_position: 2 },
    { provider_id: "openai", site_id: "deuxio",   test_date: "2026-07-31", brand_present: 1, brand_evocation: 1 },
    { provider_id: "openai", site_id: null,       test_date: "2026-07-20", brand_present: 1, brand_mention: 1, mention_position: 1 }, // legacy
  ];
  eq("marque Wedig ne voit QUE ses entrées", filterCalBySite(entries, "wedig").map(e => e.site_id), ["wedig"]);
  eq("marque Deux.io idem", filterCalBySite(entries, "deuxio").map(e => e.site_id), ["deuxio"]);
  eq("marque LetsClic (aucune entrée) → vide", filterCalBySite(entries, "letsclic"), []);
  eq("mono-site (siteId null) → TOUT (legacy inclus)", filterCalBySite(entries, null).length, 3);
}

console.log("\n──── chaîne complète : entrée → grille rendue (Wedig) ────");
{
  const entries = [
    { provider_id: "openai", site_id: "wedig",  test_date: "2026-07-31", brand_present: 1, brand_mention: 1, mention_position: 2 },
    { provider_id: "openai", site_id: "deuxio", test_date: "2026-07-31", brand_present: 1, brand_evocation: 1 },
  ];
  const wedig = filterCalBySite(entries, "wedig");
  const by = groupCalByProvider(wedig);
  const cell = by.openai["2026-07-31"];
  eq("Wedig 31/07 : vert + glyphe '2'", [cellColor(cell), cellGlyph(cell)], ["#059669", "2"]);
}

console.log(`\n${ko === 0 ? `✅ ${total}/${total} tests passés — affichage des carrés vérifié` : `❌ ${ko}/${total} tests en échec`}`);
process.exit(ko === 0 ? 0 : 1);
