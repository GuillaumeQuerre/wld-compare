// lib/auth.js
// Auth helpers — talk to /api/auth edge function
// Session stored in sessionStorage (clears on tab close) + localStorage for remember-me

const SUPERADMINS = ["guillaume@deux.io"];

export function getStoredSession() {
  try {
    const s = sessionStorage.getItem("correl_session") || localStorage.getItem("correl_session");
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function storeSession(session, remember = true) {
  const s = JSON.stringify(session);
  sessionStorage.setItem("correl_session", s);
  if (remember) localStorage.setItem("correl_session", s);
}

export function clearSession() {
  sessionStorage.removeItem("correl_session");
  localStorage.removeItem("correl_session");
}

export function getToken() {
  return getStoredSession()?.access_token || null;
}

export function getCurrentUser() {
  return getStoredSession()?.user || null;
}

export function isSuperAdmin(user) {
  return user && SUPERADMINS.includes(user.email);
}

export async function authLogin(email, password, remember = true) {
  const res = await fetch("/api/auth?action=login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Identifiants incorrects");
  storeSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }, remember);
  return data.user;
}

export async function authSignup(email, password) {
  const res = await fetch("/api/auth?action=signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409) throw new Error("Un compte existe déjà avec cet email.");
    throw new Error(data.error || "Erreur lors de la création du compte");
  }

  if (data.access_token) {
    storeSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }, true);
    return data.user;
  }

  return null;
}

// ── Mot de passe oublié ───────────────────────────────────────────
// Envoie un email de réinitialisation. Retourne toujours true
// (Supabase ne divulgue pas si le compte existe).
export async function authForgotPassword(email) {
  const res = await fetch("/api/auth?action=forgot_password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email.toLowerCase().trim(),
      redirect_url: `${window.location.origin}/reset-password`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur lors de l'envoi de l'email");
  return data;
}

// ── Réinitialisation du mot de passe ──────────────────────────────
// Appelée depuis la page /reset-password.
// Le token vient du hash de l'URL (#access_token=xxx&type=recovery).
export async function authResetPassword(accessToken, newPassword) {
  const res = await fetch("/api/auth?action=reset_password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, new_password: newPassword }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur lors de la réinitialisation");
  return data;
}

export async function authLogout() {
  clearSession();
}

export async function authRefresh() {
  const session = getStoredSession();
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch("/api/auth?action=refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) { clearSession(); return null; }
    const data = await res.json();
    storeSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    return data.user;
  } catch { clearSession(); return null; }
}

// ── Project access control ────────────────────────────────────────

export async function sbGetProjectMembers(projectId) {
  const token = getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`/api/supabase/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&select=*`, { headers });
  if (!res.ok) return [];
  return res.json();
}

export async function sbAddProjectMember(projectId, email, invitedBy) {
  const token = getToken(); // token de l'admin connecté — requis pour bypasser les RLS
  const headers = {
    "Content-Type": "application/json",
    "Prefer": "return=representation,resolution=ignore-duplicates",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api/supabase/rest/v1/project_members`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_id:   projectId,
      user_email:   email.toLowerCase().trim(),
      role:         "member",
      invited_by:   invitedBy,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[sbAddProjectMember] failed:", res.status, err.slice(0, 200));
  }
  return res.ok;
}

export async function sbRemoveProjectMember(projectId, email) {
  const token = getToken();
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(
    `/api/supabase/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&user_email=eq.${encodeURIComponent(email)}`,
    { method: "DELETE", headers }
  );
  return res.ok;
}

// Met à jour le rôle d'un membre (owner/admin uniquement, garanti côté UI + RLS).
export async function sbSetMemberRole(projectId, email, role) {
  const token = getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(
    `/api/supabase/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&user_email=eq.${encodeURIComponent(email)}`,
    { method: "PATCH", headers, body: JSON.stringify({ role }) }
  );
  return res.ok;
}

export async function sbSetProjectOwner(projectId, ownerEmail) {
  await fetch(`/api/supabase/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner_email: ownerEmail }),
  });
}

export async function sbLoadAccessibleProjects(userEmail) {
  const token = getToken();
  if (!token || !userEmail) return [];

  try {
    const email = userEmail.toLowerCase();
    const admin = isSuperAdmin({ email });
    const authH = { "Authorization": `Bearer ${token}` };

    if (admin) {
      const res = await fetch(`/api/supabase/rest/v1/projects?select=*&order=updated_at.desc`, { headers: authH });
      if (!res.ok) return [];
      return (await res.json()).map(p => { const proj = parseProject(p); proj._myRole = "owner"; return proj; });
    }

    const [ownedRes, memberRes] = await Promise.all([
      fetch(`/api/supabase/rest/v1/projects?owner_email=eq.${encodeURIComponent(email)}&select=*&order=updated_at.desc`, { headers: authH }),
      fetch(`/api/supabase/rest/v1/project_members?user_email=eq.${encodeURIComponent(email)}&select=project_id,role`, { headers: authH }),
    ]);
    const owned = ownedRes.ok ? await ownedRes.json() : [];
    const memberships = memberRes.ok ? await memberRes.json() : [];
    const roleByProject = {};
    memberships.forEach(m => { if (m.project_id) roleByProject[m.project_id] = m.role || "member"; });
    const memberIds = Object.keys(roleByProject);

    let memberProjects = [];
    if (memberIds.length > 0) {
      const ids = memberIds.map(id => `"${id}"`).join(",");
      const res = await fetch(`/api/supabase/rest/v1/projects?id=in.(${ids})&select=*&order=updated_at.desc`, { headers: authH });
      if (res.ok) memberProjects = await res.json();
    }

    const ownedIds = new Set(owned.map(p => p.id));
    const seen = new Set();
    return [...owned, ...memberProjects]
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .map(p => {
        const proj = parseProject(p);
        // Rôle de l'utilisateur courant sur ce projet (pour les permissions UI)
        proj._myRole = ownedIds.has(p.id) ? "owner" : (roleByProject[p.id] || "member");
        return proj;
      });
  } catch(e) {
    console.error("sbLoadAccessibleProjects error:", e);
    return [];
  }
}

function parseProject(r) {
  return {
    id: r.id, name: r.name,
    sites: JSON.parse(r.sites_json || "[]"),
    openai_key_enc: r.openai_key_enc || null,
    geo_axes: JSON.parse(r.geo_axes_json || "null") || ["Meilleur / top / recommandé","Pistes et approches pour utiliser / bénéficier du mot-clé","Avis / fiable / fiabilité","Pour atteindre un objectif lié au mot-clé","Pour résoudre une problématique liée au mot-clé"],
    gemini_key_enc: r.gemini_key_enc || null,
    perplexity_key_enc: r.perplexity_key_enc || null,
    claude_geo_key_enc: r.claude_geo_key_enc || null,
    semrush_key_enc: r.semrush_key_enc || null,
    owner_email: r.owner_email || null,
    updated_at: r.updated_at || null,
    settings_json: r.settings_json || null,
  };
}

// ── Invite member — passe par auth-proxy avec SERVICE_KEY ────────
// Utilise /api/auth?action=invite_member qui bypass les RLS avec la clé service
export async function sbInviteMember(projectId, email, invitedBy, role = "member", projectName = "") {
  const res = await fetch("/api/auth?action=invite_member", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      email:       email.toLowerCase().trim(),
      invitedBy:   invitedBy || "",
      role:        role || "member",
      projectName: projectName || "",
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Erreur invitation: ${res.status}`);
  }

  // data : { ok, accountCreated, existed, email, emailSent, emailPayload, role }
  return data;
}

// ── Token expiry check ────────────────────────────────────────────
function isTokenExpired(token) {
  if (!token) return true;
  try {
    // Décoder le payload JWT (base64url) sans librairie
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    // exp est en secondes Unix — marge de 60s pour anticiper l'expiration
    return !payload.exp || (payload.exp - 60) < Math.floor(Date.now() / 1000);
  } catch { return true; }
}

// Vérifie si la session stockée est valide, et tente un refresh si le token est expiré
// Retourne le user si connecté, null sinon
export async function getOrRefreshSession() {
  const session = getStoredSession();
  if (!session?.user) return null;

  if (!isTokenExpired(session.access_token)) {
    // Token encore valide
    return session.user;
  }

  // Token expiré — tenter un refresh
  if (!session.refresh_token) { clearSession(); return null; }

  try {
    const res = await fetch("/api/auth?action=refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) { clearSession(); return null; }
    const data = await res.json();
    storeSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    return data.user;
  } catch { clearSession(); return null; }
}
// Liste des utilisateurs avec dernière connexion (super admin uniquement).
export async function authAdminListUsers() {
  const token = getToken();
  if (!token) return [];
  try {
    const res = await fetch(`/api/auth?action=admin_list_users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.users || [];
  } catch (e) { return []; }
}