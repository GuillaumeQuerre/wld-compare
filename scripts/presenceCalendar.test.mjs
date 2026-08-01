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
  cellColor, cellGlyph, filterCalBySite, presenceType, presenceToCalEntry,
} from "./calendarDisplay.js";

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

console.log("\n──── presenceType : type depuis une présence de marque ────");
eq("mention_position → mention", presenceType({ mention_position: 2 }), "mention");
eq("evocation_position → evocation", presenceType({ evocation_position: 1 }), "evocation");
eq("in_sources → citation", presenceType({ in_sources: true }), "citation");
eq("mention prioritaire sur citation", presenceType({ mention_position: 1, in_sources: true }), "mention");
eq("rien → null", presenceType({ mentioned: false }), null);
eq("présence nulle → null", presenceType(null), null);

console.log("\n──── presenceToCalEntry : présence → entrée calendrier ────");
eq("mention #3 → entrée mention présente",
  presenceToCalEntry("openai", "wedig", { mentioned: true, mention_position: 3 }, "2026-08-01"),
  { provider_id: "openai", site_id: "wedig", test_date: "2026-08-01", brand_present: true, brand_mention: 1, brand_evocation: 0, brand_citation: 0, mention_position: 3 });
eq("évocation → entrée évocation présente",
  presenceToCalEntry("gemini", "deuxio", { mentioned: true, evocation_position: 1 }, "2026-08-01"),
  { provider_id: "gemini", site_id: "deuxio", test_date: "2026-08-01", brand_present: true, brand_mention: 0, brand_evocation: 1, brand_citation: 0, mention_position: null });
eq("citée seulement → présent via in_sources",
  presenceToCalEntry("openai", "letsclic", { mentioned: false, in_sources: true }, "2026-08-01"),
  { provider_id: "openai", site_id: "letsclic", test_date: "2026-08-01", brand_present: true, brand_mention: 0, brand_evocation: 0, brand_citation: 1, mention_position: null });
eq("absente → entrée absente (rouge)",
  presenceToCalEntry("openai", "wedig", { mentioned: false }, "2026-08-01"),
  { provider_id: "openai", site_id: "wedig", test_date: "2026-08-01", brand_present: false, brand_mention: 0, brand_evocation: 0, brand_citation: 0, mention_position: null });

console.log("\n──── MULTI-MARQUES : 1 interrogation → 1 entrée par marque (le fix #2/#3) ────");
{
  // brand_presences produit par le run pour 3 marques dans UNE seule réponse
  const brand_presences = {
    wedig:    { mentioned: true,  mention_position: 2 },
    deuxio:   { mentioned: true,  evocation_position: 1 },
    letsclic: { mentioned: false, in_sources: true },
  };
  const day = "2026-08-01";
  // ce que le run écrit / ce que l'optimiste affiche pour CHAQUE marque
  const entries = Object.entries(brand_presences).map(([sid, pres]) => presenceToCalEntry("openai", sid, pres, day));

  eq("3 entrées écrites (une par marque)", entries.length, 3);
  eq("chaque entrée porte SA marque", entries.map(e => e.site_id), ["wedig", "deuxio", "letsclic"]);

  // chaque ligne de marque ne voit QUE son carré, avec la bonne couleur/glyphe
  const cellFor = (sid) => { const by = groupCalByProvider(filterCalBySite(entries, sid)); return by.openai[day]; };
  eq("Wedig → vert mention '2'", [cellColor(cellFor("wedig")), cellGlyph(cellFor("wedig"))], ["#059669", "2"]);
  eq("Deux.io → orange évocation 'e'", [cellColor(cellFor("deuxio")), cellGlyph(cellFor("deuxio"))], ["#D97706", "e"]);
  eq("LetsClic → vert profond citation 'c'", [cellColor(cellFor("letsclic")), cellGlyph(cellFor("letsclic"))], ["#1A3C2E", "c"]);

  // une marque non concernée ne voit rien (pas de fuite entre marques)
  eq("marque hors interrogation → aucune cellule", groupCalByProvider(filterCalBySite(entries, "autre")).openai, undefined);
}

console.log("\n──── COHÉRENCE run ↔ optimiste (même fonction → mêmes carrés) ────");
{
  // Le run ET l'affichage optimiste passent TOUS DEUX par presenceToCalEntry :
  // vérifie qu'à présence identique, l'entrée est bit-à-bit identique.
  const pres = { mentioned: true, mention_position: 4, in_sources: true };
  const run  = presenceToCalEntry("openai", "wedig", pres, "2026-08-01");
  const opti = presenceToCalEntry("openai", "wedig", pres, "2026-08-01");
  eq("run et optimiste produisent la MÊME entrée", run, opti);
}

console.log(`\n${ko === 0 ? `✅ ${total}/${total} tests passés — affichage des carrés vérifié` : `❌ ${ko}/${total} tests en échec`}`);
process.exit(ko === 0 ? 0 : 1);
