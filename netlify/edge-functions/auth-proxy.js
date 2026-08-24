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
      const data = await res.json();
      if (!res.ok) return json({ error: data.error_description || data.msg || "Identifiants incorrects" }, 401);
      return json({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    }

    // ── SIGNUP ─────────────────────────────────────────────────────
    if (action === "signup") {
      if (!SUPABASE_SERVICE_KEY) {
        return json({ error: "Configuration serveur manquante (SUPABASE_SERVICE_KEY)" }, 500);
      }

      // 1. Créer le compte via Admin API (sans email de confirmation)
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          email: body.email,
          password: body.password,
          email_confirm: true,
        }),
      });
      const createData = await createRes.json();

      if (!createRes.ok) {
        const msg = createData.message || createData.msg || createData.error_description || "Erreur lors de la création du compte";
        const status = createRes.status === 422 ? 409 : 400;
        return json({ error: msg }, status);
      }

      // 2. Connecter immédiatement
      const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON },
        body: JSON.stringify({ email: body.email, password: body.password }),
      });
      const loginData = await loginRes.json();

      if (!loginRes.ok) {
        return json({ error: "Compte créé mais connexion automatique échouée. Connectez-vous manuellement.", user: createData }, 200);
      }

      return json({
        access_token: loginData.access_token,
        refresh_token: loginData.refresh_token,
        user: loginData.user,
      });
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
    // Crée ou retrouve le compte + ajoute à project_members + envoie un email
    if (action === "invite_member") {
      const { projectId, email, invitedBy, role: memberRole, projectName } = body;
      if (!email || !projectId) return json({ error: "email et projectId requis" }, 400);
      if (!SUPABASE_SERVICE_KEY) return json({ error: "SUPABASE_SERVICE_KEY manquante" }, 500);

      const emailClean   = email.toLowerCase().trim();
      const roleClean    = memberRole || "member";
      const projectLabel = projectName || "le projet";
      const inviterEmail = invitedBy || "";
      const appUrl       = "https://correledash.netlify.app";

      // ── Étape 1 : l'email correspond-il déjà à un compte ? ──────────────
      // On NE crée PAS le compte. On vérifie seulement son existence pour
      // adapter le message d'invitation (créer un compte vs se connecter).
      // L'accès au projet passe par project_members (clé = email) : dès que la
      // personne s'inscrit avec cet email et se connecte, le projet apparaît.
      let existed = false;
      try {
        const lookupRes = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&email=${encodeURIComponent(emailClean)}`,
          { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
        );
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          const users = Array.isArray(lookupData) ? lookupData : (lookupData.users || []);
          existed = users.some(u => (u.email || "").toLowerCase() === emailClean);
        }
      } catch (e) {
        console.warn("[invite_member] lookup warn:", e.message);
      }

      // ── Étape 2 : insérer dans project_members (bypass RLS via SERVICE_KEY) ──
      // Idempotent (ignore-duplicates) : l'appartenance est portée par l'email.
      const memberRes = await fetch(`${SUPABASE_URL}/rest/v1/project_members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Prefer": "return=representation,resolution=ignore-duplicates",
        },
        body: JSON.stringify({
          project_id:  projectId,
          user_email:  emailClean,
          role:        roleClean,
          invited_by:  inviterEmail,
        }),
      });

      if (!memberRes.ok) {
        const err = await memberRes.text().catch(() => "");
        console.error("[invite_member] project_members insert failed:", memberRes.status, err.slice(0, 200));
        return json({ error: "Erreur d'ajout au projet", detail: err.slice(0, 200), status: memberRes.status }, 500);
      }

      // ── Étape 3 : composer l'email (mailto) — adapté selon compte existant ou non ──
      const roleLabel = roleClean === "reader" ? "Lecture seule" : "Membre";
      const emailPayload = existed
        ? {
            to:      emailClean,
            subject: `[Echo] Accès ajouté — ${projectLabel}`,
            body: `Bonjour,

${inviterEmail || "Un administrateur"} vous a donné accès à « ${projectLabel} » sur Echo · Dashboard GEO par Sonate.

Votre rôle : ${roleLabel}

Connectez-vous avec votre compte pour accéder au projet :
${appUrl}

Bonne analyse,
${inviterEmail || "L'équipe Echo"}`,
          }
        : {
            to:      emailClean,
            subject: `[Echo] Invitation — ${projectLabel}`,
            body: `Bonjour,

${inviterEmail || "Un administrateur"} vous invite à rejoindre « ${projectLabel} » sur Echo · Dashboard GEO par Sonate.

Votre rôle : ${roleLabel}

Pour accéder au projet, créez votre compte (avec CETTE adresse email) ici :
${appUrl}

Une fois votre compte créé et connecté, le projet « ${projectLabel} » apparaîtra automatiquement dans vos projets.

À bientôt,
${inviterEmail || "L'équipe Echo"}`,
          };

      return json({
        ok:            true,
        accountCreated: false,      // on ne crée jamais le compte : l'utilisateur s'inscrit lui-même
        existed,                    // true = un compte existe déjà pour cet email
        email:         emailClean,
        emailSent:     false,       // l'email part via le client (mailto)
        emailPayload,               // toujours non-null → le frontend ouvre le mailto
        role:          roleClean,
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
      }));
      return json({ users });
    }

        return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
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