import { useState, useEffect } from "react";
import { authResetPassword, authAdoptSession } from "../lib/auth";

// onDone : callback optionnel appelé après succès (retour à l'accueil dans App.jsx)
export default function ResetPasswordPage({ onDone }) {
  const [token, setToken]       = useState("");
  const [refresh, setRefresh]   = useState("");   // refresh_token (invitation → connexion auto)
  const [projectId, setProjectId] = useState(""); // ?project=<id> (invitation → ouverture du projet)
  const [isInvite, setIsInvite] = useState(false); // true si type=invite (nouveau compte)
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [status, setStatus]     = useState("idle");
  const [error, setError]       = useState("");
  const [showPwd, setShowPwd]   = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const t    = params.get("access_token");
    const type = params.get("type");
    const pid  = new URLSearchParams(window.location.search).get("project") || "";
    if (t && (type === "recovery" || type === "invite")) {
      setToken(t);
      setRefresh(params.get("refresh_token") || "");
      setProjectId(pid);
      setIsInvite(type === "invite");
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setStatus("invalid");
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Le mot de passe doit faire au moins 8 caractères."); return; }
    if (password !== confirm)  { setError("Les mots de passe ne correspondent pas."); return; }
    setStatus("loading");
    try {
      await authResetPassword(token, password);
      if (isInvite) {
        // Nouveau compte : connexion automatique puis ouverture du projet partagé
        const u = await authAdoptSession(token, refresh).catch(() => null);
        if (u) {
          window.location.replace(projectId ? `/?project=${encodeURIComponent(projectId)}` : "/");
          return;
        }
      }
      setStatus("success");
    } catch (err) {
      setError(err.message || "Erreur lors de la réinitialisation");
      setStatus("error");
    }
  };

  const goHome = () => {
    // On repasse par une URL propre (sans /reset-password ni hash)
    const target = projectId ? `/?project=${encodeURIComponent(projectId)}` : "/";
    if (onDone && !projectId && window.location.pathname === "/") onDone();
    else window.location.replace(target);
  };

  const strength = (pwd) => {
    if (!pwd) return { score: 0, label: "", color: "#E2E8F0" };
    let s = 0;
    if (pwd.length >= 8) s++;
    if (pwd.length >= 12) s++;
    if (/[A-Z]/.test(pwd)) s++;
    if (/[0-9]/.test(pwd)) s++;
    if (/[^A-Za-z0-9]/.test(pwd)) s++;
    return [
      { score: 0, label: "",            color: "#E2E8F0" },
      { score: 1, label: "Très faible", color: "#DC2626" },
      { score: 2, label: "Faible",      color: "#F59E0B" },
      { score: 3, label: "Correct",     color: "#3B82F6" },
      { score: 4, label: "Fort",        color: "#059669" },
      { score: 5, label: "Très fort",   color: "#059669" },
    ][Math.min(s, 5)];
  };
  const pwdStr = strength(password);

  const inputStyle = {
    width: "100%", padding: "11px 14px", boxSizing: "border-box",
    border: "1.5px solid #E2E8F0", borderRadius: 9,
    fontSize: 13, color: "#0F172A", outline: "none", fontFamily: "inherit",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 44px", width: "100%", maxWidth: 440, boxShadow: "0 8px 40px rgba(0,0,0,0.10)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>{isInvite ? "👋" : "🔐"}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#0F172A", marginBottom: 4 }}>
            {isInvite ? "Créer votre mot de passe" : "Nouveau mot de passe"}
          </div>
          <div style={{ fontSize: 12, color: "#64748B" }}>
            {isInvite ? "Bienvenue ! Choisissez un mot de passe pour accéder à votre espace." : "Choisissez un mot de passe sécurisé"}
          </div>
        </div>

        {status === "invalid" && (
          <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 30, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#DC2626", marginBottom: 8 }}>Lien invalide ou expiré</div>
            <div style={{ fontSize: 12, color: "#B91C1C", lineHeight: 1.6, marginBottom: 16 }}>
              Ce lien a expiré (valable 1h) ou a déjà été utilisé. Faites une nouvelle demande.
            </div>
            <button onClick={goHome} style={{ padding: "9px 20px", background: "#7C3AED", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Retour à la connexion
            </button>
          </div>
        )}

        {status === "success" && (
          <div style={{ background: "#ECFDF5", border: "1px solid #BBF7D0", borderRadius: 12, padding: 24, textAlign: "center" }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#065F46", marginBottom: 8 }}>
              {isInvite ? "Compte créé avec succès !" : "Mot de passe mis à jour !"}
            </div>
            <div style={{ fontSize: 12, color: "#047857", lineHeight: 1.6, marginBottom: 20 }}>
              {isInvite
                ? "Votre compte est prêt. Vous pouvez maintenant vous connecter et accéder au projet partagé."
                : "Vous pouvez maintenant vous connecter avec votre nouveau mot de passe."}
            </div>
            <button onClick={goHome} style={{ padding: "11px 28px", background: "#059669", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Se connecter →
            </button>
          </div>
        )}

        {(status === "idle" || status === "loading" || status === "error") && (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Nouveau mot de passe</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPwd ? "text" : "password"}
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="8 caractères minimum" autoFocus required
                  style={{ ...inputStyle, paddingRight: 44 }}
                  onFocus={e => e.target.style.borderColor = "#7C3AED"}
                  onBlur={e => e.target.style.borderColor = "#E2E8F0"}
                />
                <button type="button" onClick={() => setShowPwd(v => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#94A3B8" }}>
                  {showPwd ? "🙈" : "👁️"}
                </button>
              </div>
              {password && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ height: 4, borderRadius: 2, background: "#F1F5F9", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(pwdStr.score/5)*100}%`, background: pwdStr.color, borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  {pwdStr.label && <div style={{ fontSize: 11, color: pwdStr.color, marginTop: 3, fontWeight: 600 }}>{pwdStr.label}</div>}
                </div>
              )}
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Confirmer le mot de passe</label>
              <input
                type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                placeholder="Répétez le mot de passe" required
                style={{ ...inputStyle, borderColor: confirm && confirm !== password ? "#FCA5A5" : "#E2E8F0" }}
                onFocus={e => e.target.style.borderColor = confirm && confirm !== password ? "#FCA5A5" : "#7C3AED"}
                onBlur={e => e.target.style.borderColor = confirm && confirm !== password ? "#FCA5A5" : "#E2E8F0"}
              />
              {confirm && confirm !== password && (
                <div style={{ fontSize: 11, color: "#DC2626", marginTop: 4 }}>Les mots de passe ne correspondent pas</div>
              )}
            </div>

            {error && (
              <div style={{ background: "#FEF2F2", border: "1px solid #DC262633", borderRadius: 8, padding: "9px 12px", fontSize: 12, color: "#DC2626" }}>{error}</div>
            )}

            <button type="submit" disabled={status === "loading" || !password || !confirm}
              style={{ padding: "12px", background: (status === "loading" || !password || !confirm) ? "#E2E8F0" : "#7C3AED", color: (status === "loading" || !password || !confirm) ? "#94A3B8" : "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: (status === "loading" || !password || !confirm) ? "not-allowed" : "pointer", boxShadow: "0 2px 8px #7C3AED44" }}>
              {status === "loading" ? "⏳ Mise à jour…" : "Valider le nouveau mot de passe"}
            </button>

            <button type="button" onClick={goHome} style={{ padding: "10px", background: "transparent", color: "#64748B", border: "1px solid #E2E8F0", borderRadius: 9, fontSize: 12, cursor: "pointer" }}>
              ← Retour à la connexion
            </button>
          </form>
        )}
      </div>
    </div>
  );
}