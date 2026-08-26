// components/TutorialModal.jsx
import { useState } from "react";

const GREEN       = "#1A3C2E";
const GREEN_LITE  = "#EAF0EC";
const GREEN_MED   = "#B2CCBC";
const CREAM       = "#F7F4EF";

const TRACKS = [
  {
    id: "audit",
    icon: "📋",
    label: "Audit GEO",
    tagline: "Importer vos données et générer un rapport",
    color: GREEN,
    steps: [
      {
        num: 1, icon: "📁", title: "Créez votre projet",
        desc: "Dans 📋 Audit GEO → onglet ⚙️ Setup, section « Projet actif », cliquez « + Nouveau ».",
        detail: "Un projet regroupe tous vos sites, marques et données. Donnez-lui un nom parlant (ex : « Acme — 2026 »).",
        action: "Ouvrir Audit GEO →", tab: "geo_audit",
        tip: "Partagez le projet et gérez les accès (Admin / Membre / Lecture) depuis ☰ → Compte & projets.",
      },
      {
        num: 2, icon: "🌐", title: "Ajoutez vos sites",
        desc: "Dans ⚙️ Setup, cliquez « + Site » pour ajouter les domaines à analyser.",
        detail: "Chaque site reçoit ses propres imports et devient une « marque » suivie. Un projet peut suivre plusieurs marques côte à côte.",
        action: null,
        tip: "Renommez les sites avec des noms courts (ex : « Acme FR »).",
      },
      {
        num: 3, icon: "📥", title: "Importez vos données",
        desc: "Dans ⚙️ Setup → « Imports CSV », glissez-déposez vos exports : Screaming Frog, GSC, GA4, Bing.",
        detail: "Screaming Frog est indispensable pour l'audit. GSC et GA4 enrichissent l'analyse croisée SEO × GEO.",
        action: null,
        tip: "SF : export complet UTF-8 · GSC : 3 mois de données · Le bouton ↩ recharge le dernier import.",
        links: [{ label: "Screaming Frog", url: "https://www.screamingfrog.co.uk/seo-spider/" }],
      },
      {
        num: 4, icon: "🚀", title: "Générez l'audit",
        desc: "Passez sur 📋 Génération Audit GEO. Si vous avez déjà des interrogations Fan-outs, l'audit est immédiat.",
        detail: "L'audit croise présence marque, concurrents, URLs à optimiser et pistes d'action. Cliquez « ✦ Générer l'analyse IA » pour le rapport complet.",
        action: "Voir Audit GEO →", tab: "geo_audit",
        tip: "L'analyse IA nécessite une clé Claude — configurez-la dans 🔍 Fan-outs → ⚙️ Setup → Clés API.",
      },
    ],
  },
  {
    id: "fanout",
    icon: "🔍",
    label: "Fan-outs & Suivi",
    tagline: "Suivre votre marque dans les IA, jour après jour",
    color: "#059669",
    steps: [
      {
        num: 1, icon: "🔑", title: "Configurez les providers",
        desc: "Dans 🔍 Fan-outs → ⚙️ Setup → « Gestion des Providers », collez vos clés OpenAI, Claude, Gemini et/ou Perplexity.",
        detail: "Chaque provider interrogé donne une vision différente. Choisissez le modèle et activez ou non la recherche web par provider. L'estimateur affiche le coût avant de lancer.",
        action: "Ouvrir Fan-outs →", tab: "geo",
        tip: "Claude → platform.claude.com/settings/keys · OpenAI → platform.openai.com/api-keys",
        links: [
          { label: "Claude API", url: "https://platform.claude.com/settings/keys" },
          { label: "OpenAI API", url: "https://platform.openai.com/api-keys" },
        ],
      },
      {
        num: 2, icon: "🏷️", title: "Configurez votre marque",
        desc: "Dans ⚙️ Setup → « Configuration des marques », renseignez le nom, le domaine, les alias et vos concurrents.",
        detail: "Ces infos permettent de détecter automatiquement votre marque — et chacune de vos marques suivies — dans les réponses des IA.",
        action: null,
        tip: "Ajoutez tous les alias : « Acme », « acme.fr », « Acme Technologies ». Plus les alias sont complets, meilleure est la détection.",
      },
      {
        num: 3, icon: "💬", title: "Mots-clés & questions",
        desc: "Dans 🔑 Mots-clés, saisissez vos requêtes cibles, puis cliquez « 💬 Générer toutes les questions ».",
        detail: "L'IA crée plusieurs questions par mot-clé, selon différentes intentions (recommandation, comparaison, avis, résolution de problème). Ce sont ces questions qui seront posées aux IA.",
        action: null,
        tip: "Commencez par 5–10 mots-clés stratégiques. Personnalisez les angles dans ⚙️ Setup si votre secteur a des intentions spécifiques.",
      },
      {
        num: 4, icon: "🤖", title: "Lancez les interrogations",
        desc: "Dans l'onglet 💬 Questions, cliquez « ▶ Lancer (N) » pour interroger tous les providers configurés.",
        detail: "Chaque question part vers les IA sélectionnées. La réponse est analysée automatiquement : présence de votre marque, position, type de présence (mention / évocation / citation) et concurrents.",
        action: "Voir Fan-outs →", tab: "geo",
        tip: "Vous pouvez aussi lancer une seule question ou un seul provider via les boutons ▶ de chaque ligne.",
      },
      {
        num: 5, icon: "📊", title: "Suivez vos questions dans le temps",
        desc: "C'est le cœur de l'outil : sous chaque question, le « Suivi Chronologique » montre l'évolution de votre présence, jour après jour.",
        detail: "Pour chaque provider, une ligne de petits carrés retrace chaque interrogation : 🟩 mention · 🟦 évocation · citation, avec la position (#N). En multi-marques, chaque marque a sa propre ligne. Au-dessus, la courbe et les KPI résument mention / évocation / citation ; le sélecteur Cumulé / Comparaison passe d'une vue globale à une comparaison marque par marque.",
        action: null,
        tip: "Réordonnez vos questions par glisser-déposer (⠿) · Favoris en tête · Filtres 📍 Positionnée / 📉 Perdue pour prioriser. Sur un ancien projet, « ↻ Recalculer la détection » remplit l'historique de toutes les marques sans réinterroger (sans coût).",
      },
      {
        num: 6, icon: "✦", title: "Analysez & automatisez",
        desc: "Sous chaque question, « 🏆 Générer une recommandation » propose des actions concrètes ; l'audit consolide le tout.",
        detail: "Programmez des interrogations récurrentes dans ⚙️ Setup → planification (quotidien, hebdo…) pour alimenter le suivi automatiquement. Le bouton 📤 Exporter génère CSV et PDF (rapport « Echo GEO »).",
        action: null,
        tip: "Les rôles Lecture ne peuvent pas lancer d'interrogations ni écrire — pratique pour partager le suivi avec un client en lecture seule.",
      },
    ],
  },
];

export default function TutorialModal({ onClose, onNavigate }) {
  const [track, setTrack] = useState(null);
  const [step, setStep]   = useState(0);

  const currentTrack = track ? TRACKS.find(t => t.id === track) : null;
  const currentStep  = currentTrack ? currentTrack.steps[step] : null;
  const totalSteps   = currentTrack?.steps.length || 0;
  const isLast       = step === totalSteps - 1;

  const reset = () => { setTrack(null); setStep(0); };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, backdropFilter: "blur(2px)" }}>
      <div style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 520, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ background: GREEN, padding: "16px 22px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {track && <button onClick={reset} style={{ background: "none", border: "none", cursor: "pointer", color: "#F0EBE0", fontSize: 16, opacity: 0.7, padding: 0, marginRight: 4 }}>←</button>}
            <div style={{ width: 28, height: 28, background: "#F0EBE0", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: GREEN, fontSize: 13, fontWeight: 900, fontStyle: "italic" }}>S</span>
            </div>
            <div>
              <div style={{ color: "#F0EBE0", fontSize: 9, fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.7 }}>
                {track ? `${currentTrack.icon} ${currentTrack.label}` : "Echo — Dashboard GEO par Sonate"}
              </div>
              <div style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>
                {track ? `Étape ${step + 1} / ${totalSteps}` : "Guide de démarrage"}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#fff", fontSize: 18, opacity: 0.7 }}>✕</button>
        </div>

        {/* Progress bar */}
        {track && (
          <div style={{ height: 3, background: GREEN_LITE }}>
            <div style={{ height: "100%", width: `${((step + 1) / totalSteps) * 100}%`, background: currentTrack.color, transition: "width 0.3s" }} />
          </div>
        )}

        {/* Content */}
        <div style={{ padding: "22px 24px" }}>

          {/* Track selection */}
          {!track && (
            <div>
              <p style={{ fontSize: 13, color: "#64748B", marginBottom: 18, lineHeight: 1.5 }}>
                Choisissez votre parcours selon votre objectif.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {TRACKS.map(t => (
                  <button key={t.id} onClick={() => { setTrack(t.id); setStep(0); }}
                    style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", border: `1.5px solid ${GREEN_MED}`, borderRadius: 12, background: CREAM, cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = t.color; e.currentTarget.style.background = GREEN_LITE; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = GREEN_MED; e.currentTarget.style.background = CREAM; }}>
                    <div style={{ width: 44, height: 44, flexShrink: 0, background: t.color + "18", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{t.icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#0F172A", marginBottom: 2 }}>{t.label}</div>
                      <div style={{ fontSize: 12, color: "#64748B" }}>{t.tagline}</div>
                      <div style={{ display: "flex", gap: 3, marginTop: 5, flexWrap: "wrap" }}>
                        {t.steps.map((s, i) => (
                          <span key={i} style={{ fontSize: 9, background: t.color + "18", color: t.color, borderRadius: 8, padding: "1px 6px", fontWeight: 600 }}>{s.num}. {s.title}</span>
                        ))}
                      </div>
                    </div>
                    <span style={{ color: GREEN_MED, fontSize: 18 }}>→</span>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 16, padding: "10px 14px", background: GREEN_LITE, borderRadius: 8, fontSize: 11, color: GREEN, display: "flex", gap: 7 }}>
                <span>💡</span>
                <span>Nouveau ? Commencez par <strong>Fan-outs</strong> pour un résultat rapide, ou <strong>Audit GEO</strong> si vous avez déjà des exports SF.</span>
              </div>
            </div>
          )}

          {/* Step content */}
          {track && currentStep && (
            <div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16 }}>
                <div style={{ width: 46, height: 46, flexShrink: 0, background: currentTrack.color + "18", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{currentStep.icon}</div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: currentTrack.color, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>Étape {currentStep.num}</div>
                  <h2 style={{ fontSize: 17, fontWeight: 800, color: "#0F172A", margin: 0, lineHeight: 1.2 }}>{currentStep.title}</h2>
                </div>
              </div>
              <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 10 }}>{currentStep.desc}</p>
              <p style={{ fontSize: 12, color: "#64748B", lineHeight: 1.6, marginBottom: 12 }}>{currentStep.detail}</p>
              <div style={{ background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#92400E", display: "flex", gap: 7 }}>
                <span style={{ flexShrink: 0 }}>💡</span><span>{currentStep.tip}</span>
              </div>
              {currentStep.links?.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                  {currentStep.links.map((l, i) => (
                    <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11, fontWeight: 600, color: currentTrack.color, background: currentTrack.color + "12", border: `1px solid ${currentTrack.color}33`, borderRadius: 6, padding: "3px 9px", textDecoration: "none" }}>
                      🔗 {l.label} ↗
                    </a>
                  ))}
                </div>
              )}
              {/* Step dots */}
              <div style={{ display: "flex", gap: 5, justifyContent: "center", marginTop: 20 }}>
                {currentTrack.steps.map((_, i) => (
                  <button key={i} onClick={() => setStep(i)} style={{ width: i === step ? 20 : 7, height: 7, borderRadius: 4, border: "none", background: i === step ? currentTrack.color : i < step ? currentTrack.color + "55" : "#E2E8F0", cursor: "pointer", transition: "all 0.2s", padding: 0 }} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer navigation */}
        {track && (
          <div style={{ padding: "12px 24px 18px", borderTop: "1px solid #F1F5F9", display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setStep(s => s - 1)} disabled={step === 0}
              style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "1px solid #E2E8F0", background: "transparent", color: step === 0 ? "#CBD5E1" : "#64748B", cursor: step === 0 ? "not-allowed" : "pointer" }}>
              ← Précédent
            </button>
            {currentStep?.action && onNavigate && (
              <button onClick={() => { onNavigate(currentStep.tab); onClose(); }}
                style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: `1px solid ${currentTrack.color}44`, background: currentTrack.color + "12", color: currentTrack.color, cursor: "pointer" }}>
                {currentStep.action}
              </button>
            )}
            <button onClick={() => { if (isLast) onClose(); else setStep(s => s + 1); }}
              style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 700, border: "none", background: isLast ? "#059669" : currentTrack.color, color: "#fff", cursor: "pointer", marginLeft: "auto" }}>
              {isLast ? "✓ Terminer" : "Suivant →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}