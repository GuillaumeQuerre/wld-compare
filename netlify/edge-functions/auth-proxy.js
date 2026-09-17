// netlify/edge-functions/auth-proxy.js
// Handles Supabase Auth API calls (signup, login, logout, session, password reset)

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON       = Deno.env.get("SUPABASE_ANON");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY"); // clé service_role (admin)
const SUPERADMINS         = ["guillaume@deux.io"];

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  const url    = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    const body = req.method !== "GET" ? await req.json() : {};

    // ── LOGIN ──────────────────────────────────────────────────────
    if (action === "login") {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON },
        body: JSON.stringify({ email: body.email, password: body.password }),
      });
      const data = await res.json().catch(() => ({}));
      const notConfirmed = { error: "Adresse email non confirmée. Cliquez sur le lien reçu par email pour activer votre compte.", code: "email_not_confirmed" };
      if (!res.ok) {
        if (data.error_code === "email_not_confirmed" || /not confirmed/i.test(data.msg || data.error_description || "")) {
          return json(notConfirmed, 403);
        }
        return json({ error: "Identifiants incorrects" }, 401);
      }
      // Garde-fou indépendant du réglage Supabase « Confirm email »
      if (!isActivated(data.user || {})) return json(notConfirmed, 403);
      return json({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    }

    // ── SIGNUP ─────────────────────────────────────────────────────
    // Crée le compte NON confirmé et envoie l'email de confirmation.
    // Aucune session n'est ouverte avant le clic sur le lien.
    if (action === "signup") {
      if (!SUPABASE_SERVICE_KEY) {
        return json({ error: "Configuration serveur manquante (SUPABASE_SERVICE_KEY)" }, 500);
      }
      const emailClean = String(body.email || "").toLowerCase().trim();
      const password   = String(body.password || "");
      if (!EMAIL_RE.test(emailClean)) return json({ error: "Adresse email invalide" }, 400);
      if (password.length < 8) return json({ error: "Le mot de passe doit faire au moins 8 caractères" }, 400);

      let existing;
      try { existing = await findAuthUser(emailClean); }
      catch (e) { return json({ error: "Impossible de vérifier l'adresse, réessayez." }, 502); }

      if (existing && isActivated(existing)) {
        return json({ error: "Un compte existe déjà avec cet email." }, 409);
      }

      if (existing) {
        // Compte jamais confirmé (inscription ou invitation non finalisée) :
        // le mot de passe devient celui de cette demande, activé seulement
        // par le clic dans la boîte mail.
        const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, {
          method: "PUT", headers: adminHeaders(), body: JSON.stringify({ password }),
        });
        if (!upd.ok) return json({ error: "Erreur lors de la création du compte" }, 400);
      } else {
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: "POST", headers: adminHeaders(),
          body: JSON.stringify({ email: emailClean, password, email_confirm: false }),
        });
        if (!createRes.ok) {
          const d = await createRes.json().catch(() => ({}));
          if (createRes.status === 422) return json({ error: "Un compte existe déjà avec cet email." }, 409);
          return json({ error: d.msg || d.message || "Erreur lors de la création du compte" }, 400);
        }
      }

      const sent = await sendSignupConfirmation(emailClean, url.origin);
      if (!sent.ok) return json({ error: sent.error }, 502);
      return json({ pendingConfirmation: true, email: emailClean });
    }

    // ── RESEND CONFIRMATION ────────────────────────────────────────
    // Réponse identique que le compte existe ou non (anti-énumération).
    if (action === "resend_confirmation") {
      const emailClean = String(body.email || "").toLowerCase().trim();
      if (!EMAIL_RE.test(emailClean)) return json({ error: "Adresse email invalide" }, 400);
      const generic = { success: true, message: "Si un compte non confirmé existe pour cette adresse, un nouvel email a été envoyé." };
      try {
        const u = SUPABASE_SERVICE_KEY ? await findAuthUser(emailClean) : null;
        if (u && !isActivated(u)) {
          const sent = await sendSignupConfirmation(emailClean, url.origin);
          if (!sent.ok && sent.rateLimited) return json({ error: sent.error }, 429);
        }
      } catch (e) {
        console.warn("[resend_confirmation]", e.message);
      }
      return json(generic);
    }

    // ── FORGOT PASSWORD ────────────────────────────────────────────
    // Envoie un email de réinitialisation via l'API Supabase.
    // L'email doit exister dans auth.users, sinon Supabase renvoie 200 quand même
    // (pour ne pas divulguer l'existence du compte).
    if (action === "forgot_password") {
      if (!body.email) return json({ error: "Email requis" }, 400);

      const redirectTo = body.redirect_url || `${url.origin}/reset-password`;

      const res = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON,
        },
        body: JSON.stringify({
          email: body.email.toLowerCase().trim(),
          gotrue_meta_security: {},
        }),
      });

      // Lire la réponse Supabase pour distinguer un vrai échec d'un succès silencieux.
      const recoverData = await res.json().catch(() => ({}));

      // Un email INEXISTANT renvoie tout de même 200 (anti-enumeration) → succès silencieux, OK.
      // Mais une vraie erreur SYSTÈME (SMTP non configuré, rate limit, URL de redirection
      // non autorisée…) renvoie un statut non-2xx : on la fait remonter pour diagnostic,
      // car cela ne divulgue PAS l'existence du compte.
      if (!res.ok) {
        const msg = recoverData.msg || recoverData.error_description || recoverData.message || recoverData.error || `Échec de l'envoi (HTTP ${res.status})`;
        console.error("[forgot_password] recover failed:", res.status, JSON.stringify(recoverData).slice(0, 300));
        return json({ error: `Envoi du mail impossible : ${msg}`, status: res.status }, 502);
      }

      return json({ success: true, message: "Si ce compte existe, un email de réinitialisation a été envoyé." });
    }

    // ── RESET PASSWORD ─────────────────────────────────────────────
    // Appelé depuis la page /reset-password avec le token de l'email.
    // Le token est dans le hash de l'URL (#access_token=...) — le client
    // l'extrait et l'envoie ici pour changer le mot de passe.
    if (action === "reset_password") {
      if (!body.access_token || !body.new_password) {
        return json({ error: "Token et nouveau mot de passe requis" }, 400);
      }
      if (body.new_password.length < 8) {
        return json({ error: "Le mot de passe doit faire au moins 8 caractères" }, 400);
      }

      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON,
          "Authorization": `Bearer ${body.access_token}`,
        },
        body: JSON.stringify({ password: body.new_password }),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.message || data.error_description || "Erreur lors de la réinitialisation" }, 400);
      return json({ success: true, user: data });
    }

    // ── REFRESH ────────────────────────────────────────────────────
    if (action === "refresh") {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON },
        body: JSON.stringify({ refresh_token: body.refresh_token }),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: "Session expirée" }, 401);
      return json({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    }

    // ── ME ─────────────────────────────────────────────────────────
    if (action === "me") {
      const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      if (!token) return json({ user: null });
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) return json({ user: null });
      return json({ user: data, isSuperAdmin: SUPERADMINS.includes(data.email) });
    }

    // ── UPDATE NAME ────────────────────────────────────────────────
    if (action === "update_name") {
      const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      if (!token) return json({ error: "Non authentifié" }, 401);
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ data: { display_name: body.display_name || "" } }),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.message || "Erreur mise à jour" }, 400);
      return json({ user: data });
    }

    // ── INVITE MEMBER ───────────────────────────────────────────────
    // Ajoute un email à un projet puis :
    //  • compte INEXISTANT (ou invité jamais activé) → Supabase envoie l'invitation,
    //    lien → /reset-password?project=<id> (création du mot de passe) ;
    //  • compte EXISTANT → aucun envoi ici : le front PROPOSE d'envoyer le lien
    //    du projet (action notify_member).
    // Réservé au super admin, au propriétaire du projet et à ses administrateurs.
    if (action === "invite_member") {
      if (!SUPABASE_SERVICE_KEY) return json({ error: "SUPABASE_SERVICE_KEY manquante" }, 500);
      const { projectId, email, role: memberRole, projectName } = body;
      const emailClean = String(email || "").toLowerCase().trim();
      if (!projectId || !EMAIL_RE.test(emailClean)) return json({ error: "Email valide et projectId requis" }, 400);
      const roleClean = memberRole || "member";
      if (!ROLES.includes(roleClean)) return json({ error: "Rôle invalide" }, 400);

      const authz = await authorizeProjectAdmin(req, projectId);
      if (authz.error) return json({ error: authz.error }, authz.status);
      const inviterEmail = authz.email;
      const projectLabel = projectName || authz.projectName || "le projet";
      const origin       = appOrigin(req, url);

      // 1. Statut du compte : new | pending (invité, jamais activé) | active
      let accountStatus = "new", authUser = null;
      try {
        authUser = await findAuthUser(emailClean);
        if (authUser) accountStatus = isActivated(authUser) ? "active" : "pending";
      } catch (e) {
        console.error("[invite_member] lookup failed:", e.message);
        return json({ error: "Impossible de vérifier l'existence du compte" }, 502);
      }

      // 2. Accès au projet (création ou mise à jour du rôle)
      const up = await upsertMember(projectId, emailClean, roleClean, inviterEmail);
      if (!up.ok) return json({ error: "Erreur d'ajout au projet", detail: up.detail }, 500);

      const roleLabel = ROLE_LABELS[roleClean];

      // 3a. Compte existant → le front propose l'envoi du lien projet
      if (accountStatus === "active") {
        return json({
          ok: true, status: "active", existed: true, email: emailClean, role: roleClean,
          emailSent: false,
          emailPayload: projectMailPayload(emailClean, projectLabel, roleLabel, inviterEmail, `${origin}/?project=${encodeURIComponent(projectId)}`),
        });
      }

      // 3b. Nouveau compte (ou invitation en attente) → invitation Supabase
      const meta = { project_id: projectId, project_name: projectLabel, invited_by: inviterEmail, role: roleClean };
      if (accountStatus === "pending" && authUser?.id) {
        // Met à jour les métadonnées pour que le mail affiche le bon projet
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUser.id}`, {
          method: "PUT",
          headers: adminHeaders(),
          body: JSON.stringify({ user_metadata: { ...(authUser.user_metadata || {}), ...meta } }),
        }).catch(() => {});
      }
      const redirectTo = `${origin}/reset-password?project=${encodeURIComponent(projectId)}`;
      let emailSent = false, emailError = null;
      try {
        const invRes = await fetch(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ email: emailClean, data: meta }),
        });
        if (invRes.ok) emailSent = true;
        else {
          const t = await invRes.json().catch(() => ({}));
          // Course possible : le compte a été activé entre-temps
          if (invRes.status === 422 && (t.error_code === "email_exists" || /already been registered/i.test(t.msg || ""))) {
            return json({
              ok: true, status: "active", existed: true, email: emailClean, role: roleClean, emailSent: false,
              emailPayload: projectMailPayload(emailClean, projectLabel, roleLabel, inviterEmail, `${origin}/?project=${encodeURIComponent(projectId)}`),
            });
          }
          emailError = t.msg || t.message || t.error_description || `HTTP ${invRes.status}`;
          console.warn("[invite_member] invite failed:", invRes.status, JSON.stringify(t).slice(0, 200));
        }
      } catch (e) {
        emailError = e.message;
      }

      return json({
        ok: true, status: accountStatus, existed: false, email: emailClean, role: roleClean,
        emailSent, emailError,
        // Repli manuel si l'envoi automatique a échoué
        emailPayload: emailSent ? null : inviteMailPayload(emailClean, projectLabel, roleLabel, inviterEmail, origin),
      });
    }

    // ── NOTIFY MEMBER ───────────────────────────────────────────────
    // Compte existant : envoie (après confirmation dans l'UI) un lien de connexion
    // qui ouvre directement le projet. Utilise le modèle « Magic Link » Supabase.
    if (action === "notify_member") {
      const { projectId, email, projectName } = body;
      const emailClean = String(email || "").toLowerCase().trim();
      if (!projectId || !EMAIL_RE.test(emailClean)) return json({ error: "Email valide et projectId requis" }, 400);

      const authz = await authorizeProjectAdmin(req, projectId);
      if (authz.error) return json({ error: authz.error }, authz.status);

      // Le destinataire doit bien avoir accès au projet
      const m = await getMember(projectId, emailClean);
      if (!m) return json({ error: "Cet email n'a pas accès au projet" }, 404);

      const origin     = appOrigin(req, url);
      const projectUrl = `${origin}/?project=${encodeURIComponent(projectId)}`;
      const otpRes = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(projectUrl)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON },
        body: JSON.stringify({ email: emailClean, create_user: false }),
      });
      if (otpRes.ok) return json({ ok: true, emailSent: true });

      const t = await otpRes.json().catch(() => ({}));
      const emailError = t.msg || t.message || t.error_description || `HTTP ${otpRes.status}`;
      console.warn("[notify_member] otp failed:", otpRes.status, JSON.stringify(t).slice(0, 200));
      return json({
        ok: true, emailSent: false, emailError,
        emailPayload: projectMailPayload(emailClean, projectName || authz.projectName || "le projet", ROLE_LABELS[m.role] || ROLE_LABELS.member, authz.email, projectUrl),
      });
    }

    if (action === "admin_list_users") {
      // Réservé au super admin : on vérifie le token appelant.
      const token = body.access_token;
      if (!token) return json({ error: "Non autorisé" }, 401);
      if (!SUPABASE_SERVICE_KEY) return json({ error: "SUPABASE_SERVICE_KEY manquante" }, 500);
      const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${token}` },
      });
      const me = await meRes.json().catch(() => ({}));
      if (!meRes.ok || !SUPERADMINS.includes((me.email || "").toLowerCase())) {
        return json({ error: "Réservé au super admin" }, 403);
      }
      // Liste des utilisateurs (Admin API) → email + dernière connexion + création
      const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
        headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      const data = await usersRes.json().catch(() => ({}));
      if (!usersRes.ok) return json({ error: "Erreur Admin API", detail: data }, 502);
      const list = Array.isArray(data) ? data : (data.users || []);
      const users = list.map(u => ({
        email:          u.email || "",
        last_sign_in_at: u.last_sign_in_at || null,
        created_at:     u.created_at || null,
        email_confirmed_at: u.email_confirmed_at || null,
      }));
      return json({ users });
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── Helpers invitation ─────────────────────────────────────────────
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES       = ["member", "admin", "reader"];
const ROLE_LABELS = { member: "Membre", admin: "Administrateur", reader: "Lecture seule" };

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

// Origine publique de l'app (domaine Netlify courant), jamais une URL en dur.
function appOrigin(req, url) {
  return url.origin;
}

// Compte activé = adresse email confirmée (lien de confirmation, d'invitation,
// de connexion ou de réinitialisation cliqué). Une connexion passée ne suffit pas.
function isActivated(u) {
  return !!(u.email_confirmed_at || u.confirmed_at);
}

// Envoie (ou renvoie) l'email « Confirm signup » de Supabase.
async function sendSignupConfirmation(email, origin) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/resend?redirect_to=${encodeURIComponent(`${origin}/`)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON },
    body: JSON.stringify({ type: "signup", email }),
  });
  if (res.ok) return { ok: true };
  const d = await res.json().catch(() => ({}));
  console.warn("[signup] confirmation email failed:", res.status, JSON.stringify(d).slice(0, 200));
  if (res.status === 429 || d.error_code === "over_email_send_rate_limit") {
    return { ok: false, rateLimited: true, error: "Trop de demandes : patientez une minute avant de renvoyer l'email." };
  }
  return { ok: false, error: `Envoi de l'email de confirmation impossible : ${d.msg || d.message || `HTTP ${res.status}`}` };
}

// Recherche exacte d'un compte Auth par email (paginée).
async function findAuthUser(email) {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&page=${page}&per_page=${perPage}`,
      { headers: adminHeaders() }
    );
    if (!res.ok) throw new Error(`Admin API ${res.status}`);
    const data = await res.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const hit = users.find(u => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

async function getMember(projectId, email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&user_email=eq.${encodeURIComponent(email)}&select=role`,
    { headers: adminHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

// Crée l'accès ou met à jour le rôle (sans dépendre d'une contrainte unique).
async function upsertMember(projectId, email, role, invitedBy) {
  const existing = await getMember(projectId, email);
  const res = existing
    ? await fetch(
        `${SUPABASE_URL}/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&user_email=eq.${encodeURIComponent(email)}`,
        { method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ role }) }
      )
    : await fetch(`${SUPABASE_URL}/rest/v1/project_members`, {
        method: "POST",
        headers: { ...adminHeaders(), "Prefer": "return=minimal" },
        body: JSON.stringify({ project_id: projectId, user_email: email, role, invited_by: invitedBy }),
      });
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  console.error("[invite_member] project_members write failed:", res.status, detail);
  return { ok: false, detail };
}

// Vérifie le JWT de l'appelant : super admin, propriétaire ou admin du projet.
async function authorizeProjectAdmin(req, projectId) {
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!token) return { error: "Non authentifié", status: 401 };
  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${token}` },
  });
  const me = await meRes.json().catch(() => ({}));
  const email = (me.email || "").toLowerCase();
  if (!meRes.ok || !email) return { error: "Session invalide", status: 401 };

  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=owner_email,name`,
    { headers: adminHeaders() }
  );
  const project = pRes.ok ? (await pRes.json().catch(() => []))[0] : null;
  if (!project) return { error: "Projet introuvable", status: 404 };

  const ok = SUPERADMINS.includes(email)
    || (project.owner_email || "").toLowerCase() === email
    || (await getMember(projectId, email))?.role === "admin";
  if (!ok) return { error: "Vous n'avez pas le droit d'inviter sur ce projet", status: 403 };
  return { email, projectName: project.name || "" };
}

function inviteMailPayload(to, projectLabel, roleLabel, inviter, origin) {
  return {
    to,
    subject: `[Echo] Invitation — ${projectLabel}`,
    body: `Bonjour,

${inviter || "Un administrateur"} vous invite à rejoindre « ${projectLabel} » sur Echo · Dashboard GEO par Sonate.

Votre rôle : ${roleLabel}

Créez votre compte avec CETTE adresse sur ${origin} (ou utilisez « Mot de passe oublié » si un compte existe déjà). Le projet apparaîtra ensuite automatiquement dans vos projets.

À bientôt,
${inviter || "L'équipe Echo"}`,
  };
}

function projectMailPayload(to, projectLabel, roleLabel, inviter, projectUrl) {
  return {
    to,
    subject: `[Echo] Accès ajouté — ${projectLabel}`,
    body: `Bonjour,

${inviter || "Un administrateur"} vous a donné accès à « ${projectLabel} » sur Echo · Dashboard GEO par Sonate.

Votre rôle : ${roleLabel}

Ouvrir le projet (connexion avec votre compte habituel) :
${projectUrl}

Bonne analyse,
${inviter || "L'équipe Echo"}`,
  };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

export const config = { path: "/api/auth" };