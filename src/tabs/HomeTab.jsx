import { useState, useEffect } from "react";
import { C } from "../lib/constants";
import { authLogin, authSignup, authForgotPassword, isSuperAdmin } from "../lib/auth";

const GREEN        = "#1A3C2E";
const GREEN_LIGHT  = "#EAF0EC";

// ── Helpers ───────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return "hier";
  if (diff < 7)  return `il y a ${diff} j`;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: diff > 365 ? "numeric" : undefined });
}

// ── Forgot Password Modal ─────────────────────────────────────────
function ForgotPasswordModal({ onClose }) {
  const [email, setEmail]   = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError]   = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("loading"); setError("");
    try { await authForgotPassword(email.trim()); setStatus("sent"); }
    catch (err) { setError(err.message); setStatus("error"); }
  };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.40)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: "32px 36px", width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", position: "relative" }}>
        <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#94A3B8" }}>✕</button>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 6 }}>🔑 Mot de passe oublié</div>
        <div style={{ fontSize: 12, color: C.textLight, lineHeight: 1.6, marginBottom: 22 }}>
          Entrez votre email. Si un compte existe, vous recevrez un lien de réinitialisation.
        </div>
        {status === "sent" ? (
          <div style={{ background: "#ECFDF5", border: "1px solid #BBF7D0", borderRadius: 10, padding: "20px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📧</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#065F46", marginBottom: 6 }}>Email envoyé !</div>
            <div style={{ fontSize: 12, color: "#047857", lineHeight: 1.6, marginBottom: 16 }}>
              Si <strong>{email}</strong> correspond à un compte, vous recevrez le lien sous peu.
            </div>
            <button onClick={onClose} style={{ padding: "9px 22px", background: "#059669", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Fermer</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="votre@email.com" autoFocus required
              style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, color: C.text, outline: "none" }}
              onFocus={e => e.target.style.borderColor = GREEN} onBlur={e => e.target.style.borderColor = C.border} />
            {error && <div style={{ background: "#FEF2F2", border: "1px solid #DC262633", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#DC2626" }}>{error}</div>}
            <button type="submit" disabled={status === "loading" || !email.trim()}
              style={{ padding: "10px", background: status === "loading" ? C.bg : GREEN, color: status === "loading" ? C.textLight : "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              {status === "loading" ? "⏳ Envoi…" : "Envoyer le lien"}
            </button>
            <button type="button" onClick={onClose} style={{ padding: "9px", background: "transparent", color: C.textLight, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 12, cursor: "pointer" }}>Annuler</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Login / Signup form ───────────────────────────────────────────
function LoginForm({ onLogin }) {
  const [mode, setMode]         = useState("login");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [success, setSuccess]   = useState("");
  const [showForgot, setShowForgot] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setError(""); setSuccess("");
    if (mode === "signup" && password !== confirm) { setError("Les mots de passe ne correspondent pas"); return; }
    if (password.length < 8) { setError("Minimum 8 caractères"); return; }
    setLoading(true);
    try {
      if (mode === "login") { const u = await authLogin(email.trim(), password, remember); onLogin(u); }
      else {
        const u = await authSignup(email.trim(), password);
        if (u) { onLogin(u); }
        else { setSuccess("Compte créé ! Connectez-vous."); setMode("login"); setPassword(""); setConfirm(""); }
      }
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const isLogin = mode === "login";
  return (
    <>
      {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", background: C.bg, borderRadius: 10, padding: 3, gap: 3 }}>
          {[{key:"login",label:"Se connecter"},{key:"signup",label:"Créer un compte"}].map(m => (
            <button key={m.key} onClick={() => { setMode(m.key); setError(""); setSuccess(""); }}
              style={{ flex: 1, padding: "8px", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", background: mode === m.key ? "#fff" : "transparent", color: mode === m.key ? GREEN : C.textLight, boxShadow: mode === m.key ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
              {m.label}
            </button>
          ))}
        </div>
        {error   && <div style={{ background: "#FEF2F2", border: "1px solid #DC262633", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#DC2626" }}>{error}</div>}
        {success && <div style={{ background: "#ECFDF5", border: "1px solid #05966633", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#059669" }}>{success}</div>}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="adresse@email.com"
            style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, color: C.text, outline: "none" }} />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Mot de passe (8 caractères min.)"
            style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, color: C.text }} />
          {!isLogin && (
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required placeholder="Confirmer le mot de passe"
              style={{ padding: "10px 14px", border: `1.5px solid ${confirm && confirm !== password ? "#DC2626" : C.border}`, borderRadius: 9, fontSize: 13, color: C.text }} />
          )}
          {isLogin && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textLight, cursor: "pointer" }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Se souvenir de moi
              </label>
              <button type="button" onClick={() => setShowForgot(true)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: GREEN, fontWeight: 600, textDecoration: "underline", padding: 0 }}>
                Mot de passe oublié ?
              </button>
            </div>
          )}
          <button type="submit" disabled={loading || !email || !password || (!isLogin && !confirm)}
            style={{ padding: "11px", background: loading ? C.bg : GREEN, color: loading ? C.textLight : "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", marginTop: 4 }}>
            {loading ? (isLogin ? "Connexion…" : "Création…") : (isLogin ? "Se connecter →" : "Créer mon compte →")}
          </button>
        </form>
      </div>
    </>
  );
}

// ── Benefits list ─────────────────────────────────────────────────
function BenefitsList() {
  const items = [
    { icon: "📡", title: "Monitoring GEO en temps réel", color: GREEN,
      points: ["Présence marque dans OpenAI, Gemini, Perplexity, Claude", "Historique 30 jours et tendances", "Analyse par provider et par question"] },
    { icon: "📋", title: "Audits GEO prêts à livrer", color: "#2563EB",
      points: ["Analyse concurrentielle des sources citées", "URLs à optimiser et pages à créer", "Recommandations actionnables priorisées"] },
    { icon: "🔬", title: "Analyse SEO × GEO", color: "#059669",
      points: ["Corrélations SF × citations LLM", "Croisement Bing AI × Fan-outs", "Roadmaps avec quick wins par site"] },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {items.map(b => (
        <div key={b.title} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: b.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{b.icon}</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 5 }}>{b.title}</div>
            {b.points.map((p, i) => (
              <div key={i} style={{ fontSize: 12, color: C.textMid, display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 3 }}>
                <span style={{ color: b.color, marginTop: 1, flexShrink: 0 }}>·</span>
                <span style={{ lineHeight: 1.4 }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Projects list ─────────────────────────────────────────────────
function ProjectsList({ user, projects, currentProjectId, dbLoading, onSelectProject, onCreateProject, onDeleteProject, onLogout }) {
  const isAdmin = isSuperAdmin(user);
  const displayName = user?.user_metadata?.display_name || user?.email?.split("@")[0] || "";
  const sorted = [...projects].sort((a, b) => {
    const da = a.updated_at ? new Date(a.updated_at) : new Date(0);
    const db = b.updated_at ? new Date(b.updated_at) : new Date(0);
    return db - da;
  });
  const current = sorted.find(p => p.id === currentProjectId) || sorted[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* User header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>
            👋 Bonjour{displayName ? `, ${displayName}` : ""} !
          </div>
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>
            {user?.email}
            {isAdmin && <span style={{ marginLeft: 6, fontSize: 9, background: GREEN_LIGHT, color: GREEN, borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>SUPER ADMIN</span>}
          </div>
        </div>
        <button onClick={onLogout}
          style={{ fontSize: 11, color: C.textLight, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 10px", cursor: "pointer" }}>
          Déconnexion
        </button>
      </div>

      <div style={{ height: 1, background: C.border }} />

      {dbLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textLight, fontSize: 12, padding: "8px 0" }}>
          <span style={{ display: "inline-block", animation: "spin 1s linear infinite", fontSize: 16 }}>⟳</span>
          Projets en chargement…
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <div style={{ fontSize: 12, color: C.textLight, marginBottom: 12 }}>Aucun projet disponible</div>
          <button onClick={onCreateProject}
            style={{ padding: "9px 20px", background: GREEN, color: "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + Créer mon premier projet
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {sorted.map((p) => {
            const isCurrent = p.id === (currentProjectId || current?.id);
            const date = fmtDate(p.updated_at);
            return (
              <div key={p.id} style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
                <button onClick={() => onSelectProject(p.id)}
                  style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: isCurrent ? "12px 16px" : "9px 14px", background: isCurrent ? GREEN_LIGHT : C.bg, border: `${isCurrent ? 2 : 1}px solid ${isCurrent ? GREEN + "44" : C.border}`, borderRadius: 10, cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}
                  onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = GREEN_LIGHT; }}
                  onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = C.bg; }}>
                  <div>
                    <div style={{ fontSize: isCurrent ? 13 : 12, fontWeight: isCurrent ? 700 : 600, color: isCurrent ? GREEN : C.text }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: C.textLight, marginTop: 2, display: "flex", gap: 8 }}>
                      <span>{p.sites?.length || 0} site{p.sites?.length !== 1 ? "s" : ""}</span>
                      {date && <span>· modifié {date}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: isCurrent ? 18 : 14, color: isCurrent ? GREEN : C.textLight }}>→</span>
                </button>
                {onDeleteProject && (
                  <button onClick={() => onDeleteProject(p.id)} title="Supprimer ce projet"
                    style={{ flexShrink: 0, width: 38, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", color: C.textLight, fontSize: 14 }}>
                    🗑
                  </button>
                )}
              </div>
            );
          })}
          <button onClick={onCreateProject}
            style={{ padding: "8px", border: `2px dashed ${C.border}`, borderRadius: 9, background: "transparent", color: C.textLight, fontSize: 12, cursor: "pointer" }}>
            + Nouveau projet
          </button>
        </div>
      )}
    </div>
  );
}

// ── Guide de démarrage inline ─────────────────────────────────────
function GuideSection({ onGoFanoutTour, onGoAuditTour }) {
  const cards = [
    {
      icon: "🔍", label: "Fan-outs", color: "#059669", bg: "#ECFDF5", border: "#BBF7D0",
      desc: "Configurez vos providers, ajoutez vos mots-clés et interrogez les LLMs pour mesurer votre présence.",
      steps: 5,
      action: "Démarrer le guide →",
      onClick: onGoFanoutTour,
    },
    {
      icon: "📋", label: "Audit GEO", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE",
      desc: "Consultez votre score de présence, le paysage concurrentiel et exportez un rapport PDF.",
      steps: 4,
      action: "Démarrer le guide →",
      onClick: onGoAuditTour,
    },
  ];

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ height: 1, flex: 1, background: C.border }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.8 }}>🎓 Guide de démarrage interactif</span>
        <div style={{ height: 1, flex: 1, background: C.border }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {cards.map(p => (
          <div key={p.label} style={{ background: C.white, border: `1px solid ${p.border}`, borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: p.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{p.icon}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{p.label}</div>
                <div style={{ fontSize: 11, color: C.textLight }}>{p.steps} étapes guidées avec spotlight</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>{p.desc}</div>
            <button onClick={p.onClick}
              style={{ marginTop: "auto", padding: "9px", background: p.color, color: "#fff", border: "none", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {p.action}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── HomeTab ───────────────────────────────────────────────────────
export default function HomeTab({ user, projects, currentProjectId, dbLoading, onLogin, onLogout, onSelectProject, onCreateProject, onDeleteProject, onGoSetup, onGoFanout, onGoAudit, onGoFanoutTour, onGoAuditTour }) {
  const [visible, setVisible]         = useState(true);
  const [displayUser, setDisplayUser] = useState(user);

  useEffect(() => {
    if (user === displayUser) return;
    setVisible(false);
    const t = setTimeout(() => { setDisplayUser(user); setVisible(true); }, 280);
    return () => clearTimeout(t);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const isConnected = !!displayUser;
  const transStyle  = { opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(10px)", transition: "opacity 0.28s ease, transform 0.28s ease" };
  const cardStyle   = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: "28px 32px", boxShadow: "0 2px 12px rgba(0,0,0,0.04)", boxSizing: "border-box" };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header non-connecté */}
      {!isConnected && (
        <div style={{ textAlign: "center", marginBottom: 40, ...transStyle }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div style={{ width: 40, height: 40, background: "#1A3C2E", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "#F0EBE0", fontSize: 22, fontWeight: 900, fontStyle: "italic" }}>S</span>
            </div>
            <span style={{ fontSize: 30, fontWeight: 900, color: "#1A3C2E", letterSpacing: -0.5 }}>Echo</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A3C2E", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>Dashboard GEO <span style={{ fontStyle: "italic" }}>par Sonate</span></div>
          <h1 style={{ fontSize: 20, fontWeight: 400, color: "#1A3C2E", margin: "0 0 6px", letterSpacing: 0.5 }}>Votre croissance est clé</h1>
          <div style={{ fontSize: 13, color: C.textLight }}>Plateforme GEO Intelligence</div>
        </div>
      )}

      {/* Header connecté */}
      {isConnected && (
        <div style={{ marginBottom: 28, ...transStyle, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "#1A3C2E", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <span style={{ color: "#F0EBE0", fontSize: 17, fontWeight: 900, fontStyle: "italic" }}>S</span>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#1A3C2E", letterSpacing: 1, textTransform: "uppercase", marginBottom: 1 }}>Echo · Dashboard GEO par Sonate</div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: 0 }}>Tableau de bord</h1>
          </div>
        </div>
      )}

      {/* Contenu */}
      <div style={transStyle}>
        {!isConnected ? (
          /* Non connecté : 2 colonnes */
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 20 }}>Ce que vous obtenez</div>
              <BenefitsList />
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Accéder à la plateforme</div>
              <div style={{ fontSize: 11, color: C.textLight, marginBottom: 20 }}>Connectez-vous ou créez un compte</div>
              <LoginForm onLogin={onLogin} />
            </div>
          </div>
        ) : (
          /* Connecté : projets + guide inline */
          <>
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Mes projets</div>
              <div style={{ fontSize: 11, color: C.textLight, marginBottom: 20 }}>Sélectionnez un projet ou créez-en un nouveau</div>
              <ProjectsList
                user={displayUser}
                projects={projects}
                currentProjectId={currentProjectId}
                dbLoading={dbLoading}
                onSelectProject={onSelectProject}
                onCreateProject={onCreateProject}
                onDeleteProject={onDeleteProject}
                onLogout={onLogout}
              />
            </div>

            {/* Guide inline */}
            <GuideSection onGoFanoutTour={onGoFanoutTour} onGoAuditTour={onGoAuditTour} />
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", paddingTop: 28, marginTop: 36, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 11, color: C.textLight }}>
          Echo · Dashboard GEO par Sonate · par <a href="mailto:guillaume@deux.io" style={{ color: GREEN }}>deux.io</a>
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}