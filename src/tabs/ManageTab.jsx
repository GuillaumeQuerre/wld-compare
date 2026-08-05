import { useState, useEffect, useMemo } from "react";
import { C } from "../lib/constants";
import { sbGetGeoResultsAll } from "../lib/supabase";
import { getModelPricing, WEB_SEARCH_FEE } from "../components/GeoConfig";
import { authLogin, authSignup, isSuperAdmin, sbGetProjectMembers, sbRemoveProjectMember, sbInviteMember, sbSetMemberRole } from "../lib/auth";

function Section({ title, children }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden", marginBottom: 20 }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, background: C.bg }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{title}</div>
      </div>
      <div style={{ padding: "18px 20px" }}>{children}</div>
    </div>
  );
}

// ── Login card (when not connected) ──────────────────────────────
function LoginCard({ onLogin }) {
  const [mode, setMode]         = useState("login");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [success, setSuccess]   = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setSuccess("");
    if (mode === "signup" && password !== confirm) { setError("Mots de passe différents"); return; }
    if (password.length < 8) { setError("8 caractères minimum"); return; }
    setLoading(true);
    try {
      if (mode === "login") {
        const u = await authLogin(email.trim(), password);
        onLogin(u);
      } else {
        const u = await authSignup(email.trim(), password);
        if (u) { onLogin(u); }
        else { setSuccess("Compte créé ! Vérifiez votre email puis connectez-vous."); setMode("login"); setPassword(""); setConfirm(""); }
      }
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <Section title="🔐 Connexion / Inscription">
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[{key:"login",label:"Connexion"},{key:"signup",label:"Créer un compte"}].map(m => (
          <button key={m.key} onClick={() => { setMode(m.key); setError(""); setSuccess(""); }}
            style={{ flex: 1, padding: "7px", border: `2px solid ${mode===m.key ? "#7C3AED" : C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", background: mode===m.key ? "#F5F3FF" : "#fff", color: mode===m.key ? "#7C3AED" : C.textMid }}>
            {m.label}
          </button>
        ))}
      </div>
      {error && <div style={{ background: "#FEF2F2", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#DC2626", marginBottom: 12 }}>{error}</div>}
      {success && <div style={{ background: "#ECFDF5", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#059669", marginBottom: 12 }}>{success}</div>}
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 360 }}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="Email" style={{ padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13 }} />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Mot de passe (8 min.)" style={{ padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13 }} />
        {mode === "signup" && (
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required placeholder="Confirmer" style={{ padding: "8px 12px", border: `1px solid ${confirm && confirm !== password ? "#DC2626" : C.border}`, borderRadius: 8, fontSize: 13 }} />
        )}
        <button type="submit" disabled={loading} style={{ padding: "9px", background: "#7C3AED", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          {loading ? "…" : mode === "login" ? "Se connecter" : "Créer mon compte"}
        </button>
      </form>
    </Section>
  );
}

// ── Project members manager ───────────────────────────────────────
// ── ProjectCosts — suivi des coûts RÉELS du projet (tokens × tarifs) ──
// Agrège les tokens réellement consommés (input/output) stockés sur geo_results,
// par provider, avec un sélecteur de période. Tarifs : MODEL_CATALOG (USD/1M tokens).
function ProjectCosts({ project }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [periodDays, setPeriodDays] = useState(30); // 0 = tout

  useEffect(() => {
    if (!project?.id) { setRows([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    sbGetGeoResultsAll(project.id).then(r => { if (!cancelled) { setRows(r || []); setLoading(false); } })
      .catch(() => { if (!cancelled) { setRows([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [project?.id]);

  // Extraire providerId + modelId depuis le champ model "OpenAI (gpt-4o-mini)"
  const parseModel = (modelStr) => {
    const s = String(modelStr || "");
    const m = s.match(/\(([^)]+)\)\s*$/);
    const modelId = m ? m[1].trim() : "";
    const low = s.toLowerCase();
    let providerId = "openai";
    if (low.includes("gemini")) providerId = "gemini";
    else if (low.includes("perplex") || low.includes("sonar")) providerId = "perplexity";
    else if (low.includes("claude")) providerId = "claude";
    else if (low.includes("openai") || low.includes("gpt")) providerId = "openai";
    return { providerId, modelId };
  };

  const PROVIDER_LABEL = { openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude" };

  const stats = useMemo(() => {
    const since = periodDays ? Date.now() - periodDays * 86400000 : 0;
    const byProvider = {};
    let totalCost = 0, totalIn = 0, totalOut = 0, totalCalls = 0, withTokens = 0, totalSearchCost = 0;
    rows.forEach(r => {
      const t = r.created_at ? new Date(r.created_at).getTime() : null;
      if (since && t != null && t < since) return;
      const { providerId, modelId } = parseModel(r.model);
      const inTok = r.input_tokens || 0;
      const outTok = r.output_tokens || 0;
      const pricing = getModelPricing(providerId, modelId);
      const tokenCost = (inTok * pricing.in + outTok * pricing.out) / 1e6;
      // Frais de recherche web (par appel) — oubliés dans l'ancien calcul.
      // Nb de recherches réel si enregistré, sinon 1 par appel pour les providers qui cherchent.
      const fee = WEB_SEARCH_FEE[providerId] || 0;
      const searches = r.web_searches != null ? r.web_searches : (fee > 0 ? 1 : 0);
      const searchCost = searches * fee;
      const cost = tokenCost + searchCost;
      if (!byProvider[providerId]) byProvider[providerId] = { provider: providerId, calls: 0, inTok: 0, outTok: 0, cost: 0, searchCost: 0, models: {} };
      const b = byProvider[providerId];
      b.calls++; b.inTok += inTok; b.outTok += outTok; b.cost += cost; b.searchCost += searchCost;
      const mk = modelId || "—";
      if (!b.models[mk]) b.models[mk] = { calls: 0, cost: 0 };
      b.models[mk].calls++; b.models[mk].cost += cost;
      totalCost += cost; totalIn += inTok; totalOut += outTok; totalCalls++; totalSearchCost += searchCost;
      if (inTok || outTok) withTokens++;
    });
    return { list: Object.values(byProvider).sort((a, b) => b.cost - a.cost), totalCost, totalIn, totalOut, totalCalls, withTokens, totalSearchCost };
  }, [rows, periodDays]);

  const fmt$ = (n) => n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
  const fmtTok = (n) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.textLight }}>
          Coûts = tokens réellement consommés + frais de recherche web par appel (OpenAI / Gemini / Perplexity). Les analyses reco/audit ne sont pas incluses.
        </div>
        <select value={periodDays} onChange={e => setPeriodDays(parseInt(e.target.value, 10))}
          style={{ padding: "6px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, background: "#fff", cursor: "pointer" }}>
          <option value={7}>7 derniers jours</option>
          <option value={30}>30 derniers jours</option>
          <option value={90}>3 mois</option>
          <option value={180}>6 mois</option>
          <option value={365}>12 mois</option>
          <option value={0}>Tout l'historique</option>
        </select>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: C.textLight }}>Chargement des coûts…</div>
      ) : stats.totalCalls === 0 ? (
        <div style={{ fontSize: 12, color: C.textLight, fontStyle: "italic" }}>Aucune interrogation sur cette période.</div>
      ) : (
        <>
          {/* Total */}
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", padding: "14px 16px", background: "#1A3C2E08", borderRadius: 10, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Coût total</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#1A3C2E" }}>{fmt$(stats.totalCost)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Interrogations</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#1A3C2E" }}>{stats.totalCalls}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Tokens (in / out)</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A3C2E", marginTop: 4 }}>{fmtTok(stats.totalIn)} / {fmtTok(stats.totalOut)}</div>
            </div>
            {stats.totalSearchCost > 0 && (
              <div>
                <div style={{ fontSize: 10, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>dont recherche web</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#C97820", marginTop: 4 }}>{fmt$(stats.totalSearchCost)}</div>
              </div>
            )}
          </div>

          {stats.withTokens < stats.totalCalls && (
            <div style={{ fontSize: 11, color: "#C97820", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>
              ⚠ {stats.totalCalls - stats.withTokens} interrogation(s) sans tokens enregistrés (antérieures au suivi des coûts) — non comptées dans le total.
            </div>
          )}

          {/* Par provider */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {stats.list.map(b => (
              <div key={b.provider} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A3C2E" }}>{PROVIDER_LABEL[b.provider] || b.provider}</span>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#1A3C2E" }}>{fmt$(b.cost)}</span>
                </div>
                <div style={{ fontSize: 11, color: C.textLight, display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <span>{b.calls} interrogation{b.calls > 1 ? "s" : ""}</span>
                  <span>{fmtTok(b.inTok)} in · {fmtTok(b.outTok)} out</span>
                  {b.searchCost > 0 && <span style={{ color: "#C97820" }}>recherche web {fmt$(b.searchCost)}</span>}
                  <span>{Object.entries(b.models).map(([m, mv]) => `${m} (${fmt$(mv.cost)})`).join(" · ")}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProjectMembers({ project, ownerEmail, myRole = "owner", isSuper = false }) {
  const [members, setMembers] = useState([]);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole]   = useState("member"); // "member" | "admin" | "reader"
  const [loading, setLoading]   = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState("");
  // Seuls le propriétaire, les administrateurs et les super admins peuvent inviter/retirer.
  const canManage   = isSuper || myRole === "owner" || myRole === "admin";
  // Les coûts en tokens ne sont visibles que par owner / admin / superadmin.
  const canSeeCosts = isSuper || myRole === "owner" || myRole === "admin";

  useEffect(() => {
    if (!project?.id) return;
    setLoading(true);
    sbGetProjectMembers(project.id).then(m => { setMembers(m); setLoading(false); }).catch(() => setLoading(false));
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [inviteMsg, setInviteMsg]       = useState(""); // message de succès
  const [emailPayload, setEmailPayload] = useState(null); // { to, subject, body } pour mailto: compte existant

  const add = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    setSaving(true); setError(""); setInviteMsg("");
    const result = await sbInviteMember(project.id, email, ownerEmail, newRole, project.name || "");
    if (result.ok) {
      setMembers(prev => {
        const exists = prev.findIndex(m => m.user_email === email);
        const entry = { user_email: email, role: newRole };
        if (exists >= 0) { const n = [...prev]; n[exists] = entry; return n; }
        return [...prev, entry];
      });
      setNewEmail(""); setNewRole("member");

      // Le compte n'est jamais pré-créé : l'invité s'inscrit lui-même.
      // Un email (mailto) est préparé dans tous les cas pour que l'inviteur l'envoie.
      if (result.emailPayload) setEmailPayload(result.emailPayload);
      if (result.existed) {
        setInviteMsg(`✓ ${email} a été ajouté au projet (compte existant). Un email de notification est prêt à envoyer.`);
      } else {
        setInviteMsg(`✓ ${email} a été ajouté au projet. Un email d'invitation à créer un compte est prêt à envoyer — il accédera au projet dès sa connexion.`);
      }
    } else {
      setError(result.error || "Erreur lors de l'invitation");
    }
    setSaving(false);
  };

  const remove = async (email) => {
    await sbRemoveProjectMember(project.id, email);
    setMembers(prev => prev.filter(m => m.user_email !== email));
  };

  // Modifie le rôle d'un membre — réservé aux admins (canManage). Mise à jour
  // optimiste + persistance ; rollback si la requête échoue.
  const [roleSaving, setRoleSaving] = useState(null); // email en cours de MAJ
  const changeRole = async (email, nextRole) => {
    const prevRole = members.find(m => m.user_email === email)?.role;
    if (!nextRole || nextRole === prevRole) return;
    setRoleSaving(email);
    setMembers(prev => prev.map(m => m.user_email === email ? { ...m, role: nextRole } : m));
    const ok = await sbSetMemberRole(project.id, email, nextRole);
    if (!ok) {
      setMembers(prev => prev.map(m => m.user_email === email ? { ...m, role: prevRole } : m)); // rollback
      setError("La modification du rôle a échoué.");
    }
    setRoleSaving(null);
  };

  const roleBadge = (role) => {
    if (role === "reader") return { label: "👁 Lecture", color: "#D97706", bg: "#FFFBEB" };
    if (role === "admin")  return { label: "🛡 Admin",  color: "#1A3C2E", bg: "#EAF0EC" };
    if (role === "owner")  return { label: "★ Propriétaire", color: "#059669", bg: "#ECFDF5" };
    return { label: "✏️ Membre", color: "#7C3AED", bg: "#F5F3FF" };
  };

  if (!project) return <div style={{ fontSize: 12, color: C.textLight }}>Sélectionnez un projet</div>;

  return (
    <div>
      {/* Owner */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8 }}>Propriétaire</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#F0FDF4", borderRadius: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "#059669", fontWeight: 600 }}>{project.owner_email || ownerEmail || "—"}</span>
        <span style={{ fontSize: 10, background: "#ECFDF5", color: "#059669", borderRadius: 4, padding: "1px 6px" }}>propriétaire</span>
      </div>

      {/* Members list */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8 }}>Accès ({members.length})</div>
      {loading ? <div style={{ fontSize: 12, color: C.textLight }}>Chargement…</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {members.length === 0 && <div style={{ fontSize: 12, color: C.textLight, fontStyle: "italic" }}>Aucun accès invité</div>}
          {members.map(m => {
            const badge = roleBadge(m.role);
            return (
              <div key={m.user_email} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: C.bg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 12, color: C.text, flex: 1 }}>{m.user_email}</span>
                {canManage ? (
                  <select
                    value={m.role === "reader" || m.role === "admin" ? m.role : "member"}
                    disabled={roleSaving === m.user_email}
                    onChange={e => changeRole(m.user_email, e.target.value)}
                    title="Modifier le niveau d'accès"
                    style={{ fontSize: 10, fontWeight: 700, color: badge.color, background: badge.bg, border: `1px solid ${badge.color}22`, borderRadius: 5, padding: "2px 6px", cursor: "pointer", opacity: roleSaving === m.user_email ? 0.5 : 1 }}>
                    <option value="member">✏️ Membre</option>
                    <option value="admin">🛡 Admin</option>
                    <option value="reader">👁 Lecture</option>
                  </select>
                ) : (
                  <span style={{ fontSize: 10, fontWeight: 700, color: badge.color, background: badge.bg, borderRadius: 5, padding: "2px 8px" }}>{badge.label}</span>
                )}
                {canManage && (
                  <button onClick={() => remove(m.user_email)} style={{ fontSize: 11, color: "#DC2626", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Invite — visible only to owners/members */}
      {canManage && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8 }}>Inviter un utilisateur</div>
          {error && <div style={{ fontSize: 12, color: "#DC2626", marginBottom: 8 }}>{error}</div>}
          {inviteMsg && (
            <div style={{ fontSize: 12, color: "#059669", background: "#ECFDF5", border: "1px solid #BBF7D0", borderRadius: 7, padding: "8px 12px", marginBottom: 8, display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span style={{ flex: 1 }}>{inviteMsg}</span>
              {emailPayload && (
                <a
                  href={`mailto:${emailPayload.to}?subject=${encodeURIComponent(emailPayload.subject)}&body=${encodeURIComponent(emailPayload.body)}`}
                  style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: "#fff", background: "#1A3C2E", borderRadius: 6, padding: "4px 10px", textDecoration: "none", whiteSpace: "nowrap" }}
                  onClick={() => setTimeout(() => setEmailPayload(null), 500)}
                >
                  ✉ Envoyer le mail
                </a>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && add()}
              placeholder="email@exemple.com"
              style={{ flex: "1 1 200px", padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
            <select value={newRole} onChange={e => setNewRole(e.target.value)}
              style={{ padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer" }}>
              <option value="member">✏️ Membre — accès complet</option>
              <option value="admin">🛡 Administrateur — accès complet + invitations + coûts</option>
              <option value="reader">👁 Lecture seule — Fan-outs & Audit uniquement</option>
            </select>
            <button onClick={add} disabled={saving || !newEmail.includes("@")}
              style={{ padding: "8px 20px", background: saving ? C.bg : "#7C3AED", color: saving ? C.textLight : "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: !newEmail.includes("@") ? 0.5 : 1 }}>
              {saving ? "…" : "Inviter"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 6 }}>
            <strong>Administrateur</strong> : accès complet + peut inviter et gérer les accès + voit les coûts en tokens. <strong>Membre</strong> : accès complet (Setup, Fan-outs, Audit). <strong>Lecture seule</strong> : Fan-outs et Audit GEO uniquement, aucun appel LLM.
            Si l'adresse n'a pas de compte, un email d'invitation à créer un compte est préparé.
          </div>
        </>
      )}
      {!canManage && (
        <div style={{ fontSize: 12, color: C.textLight, fontStyle: "italic" }}>Vous avez un accès lecture seule sur ce projet.</div>
      )}

      {/* ── Coûts du projet (tokens réels × tarifs) — owner / admin / superadmin uniquement ── */}
      {canSeeCosts && (
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 10 }}>💸 Coûts du projet</div>
          <ProjectCosts project={project} />
        </div>
      )}
    </div>
  );
}

// ── ManageTab ─────────────────────────────────────────────────────
function AccountForm({ user, onLogout, isAdmin }) {
  const [name, setName] = useState(user?.user_metadata?.display_name || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveName = async () => {
    setSaving(true);
    try {
      const { getToken } = await import("../lib/auth");
      const token = getToken();
      await fetch("/api/auth?action=update_name", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ display_name: name.trim() }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch(e) { console.warn(e); }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{user.email}</div>
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 3 }}>
            Connecté
            {isAdmin && <span style={{ marginLeft: 8, fontSize: 10, background: "#F5F3FF", color: "#7C3AED", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>SUPER ADMIN</span>}
          </div>
        </div>
        <button onClick={onLogout} style={{ padding: "7px 16px", border: `1px solid ${C.border}`, borderRadius: 8, background: "#fff", color: "#DC2626", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Déconnexion
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textLight, marginBottom: 5 }}>Prénom / nom affiché</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex : Guillaume"
            style={{ width: "100%", padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, color: C.text, boxSizing: "border-box" }} />
        </div>
        <button onClick={saveName} disabled={saving}
          style={{ marginTop: 20, padding: "8px 16px", background: saved ? "#059669" : "#7C3AED", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
          {saved ? "✓ Enregistré" : saving ? "…" : "Enregistrer"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: C.textLight, marginTop: 6 }}>Affiché sur l'accueil : "Bonjour, {name || "…"} !"</div>
    </div>
  );
}

export default function ManageTab({ user, projects, currentProjectId, setCurrentProjectId, onLogin, onLogout }) {
  const [selectedProjectId, setSelectedProjectId] = useState(currentProjectId);
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0];
  const isAdmin = user && isSuperAdmin(user);
  // Rôle effectif de l'utilisateur courant sur le projet sélectionné
  const myProjectRole = isAdmin
    ? "owner"
    : (selectedProject?.owner_email?.toLowerCase() === user?.email?.toLowerCase()
        ? "owner"
        : (selectedProject?._myRole || "member"));

  if (!user) return (
    <div style={{ maxWidth: 480, margin: "0 auto", paddingTop: 40 }}>
      <LoginCard onLogin={onLogin} />
    </div>
  );

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>👤 Compte & projets</div>
        <div style={{ fontSize: 12, color: C.textLight }}>Gérez votre compte et les accès à vos projets</div>
      </div>

      {/* Account info */}
      <Section title="Votre compte">
        <AccountForm user={user} onLogout={onLogout} isAdmin={isAdmin} />
      </Section>

      {/* Project access */}
      <Section title="Accès aux projets">
        {/* Project selector */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8 }}>Projet</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {projects.map(p => (
              <button key={p.id} onClick={() => { setSelectedProjectId(p.id); setCurrentProjectId(p.id); }}
                style={{ padding: "6px 14px", border: `2px solid ${p.id === selectedProjectId ? "#7C3AED" : C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: p.id === selectedProjectId ? "#F5F3FF" : "#fff", color: p.id === selectedProjectId ? "#7C3AED" : C.text }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <ProjectMembers project={selectedProject} ownerEmail={user.email} myRole={myProjectRole} isSuper={isAdmin} />
      </Section>

      {/* Superadmin info */}
      {isAdmin && (
        <Section title="⚡ Super admin">
          <div style={{ fontSize: 12, color: C.textLight }}>
            Vous avez accès à tous les projets de la plateforme.
            Les super admins sont définis dans la configuration serveur.
          </div>
        </Section>
      )}
    </div>
  );
}