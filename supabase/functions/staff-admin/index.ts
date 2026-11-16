// staff-admin: create a staff sign-in, or set a new password for one.
// Runs on the server because it needs the service-role key (never sent to a browser).
// Who may do what (checked here, again, from the caller's own staff row):
//   owner (admin)  any role, any branch
//   manager        kitchen / cashier / waiter, own branch only
// Staff without an email sign in with a short login name (e.g. "ravi.k"); it is stored as
// <login>@staff.pandias.invalid, a reserved domain that can never receive mail.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOGIN_DOMAIN = "staff.pandias.invalid";
const ROLES = ["admin", "manager", "kitchen", "cashier", "waiter"];
const MANAGER_MAY = ["kitchen", "cashier", "waiter"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: string, status = 400) => reply({ error }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("method", 405);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  if (!who?.user) return fail("forbidden", 401);
  const { data: me } = await admin.from("staff").select("user_id, role, branch_id, active").eq("user_id", who.user.id).maybeSingle();
  if (!me?.active || !["admin", "manager"].includes(me.role)) return fail("forbidden", 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request");
  }
  const password = String(body.password || "");
  const goodPassword = password.length >= 8 && password.length <= 72;

  if (body.action === "create") {
    const name = String(body.name || "").trim();
    const role = String(body.role || "");
    const branch = role === "admin" ? null : String(body.branch || "");
    const login = String(body.login || "").trim().toLowerCase();
    const emailIn = String(body.email || "").trim().toLowerCase();
    if (name.length < 2 || name.length > 60) return fail("bad_name");
    if (!ROLES.includes(role)) return fail("bad_role");
    if (me.role === "manager" && (!MANAGER_MAY.includes(role) || branch !== me.branch_id)) return fail("forbidden", 403);
    if (role !== "admin") {
      const { data: b } = await admin.from("branches").select("id").eq("id", branch).maybeSingle();
      if (!b) return fail("branch_required");
    }
    if (!goodPassword) return fail("weak_password");
    let email = emailIn;
    if (!email) {
      if (!/^[a-z0-9._-]{3,40}$/.test(login)) return fail("bad_login");
      email = `${login}@${LOGIN_DOMAIN}`;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("bad_email");

    const { data: made, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error || !made?.user) return fail(/already/i.test(error?.message || "") ? "login_taken" : "create_failed");
    // the staff row (the activity log records who added whom)
    const phoneDigits = String(body.phone || "").replace(/\D/g, "");
    const phone = /^(91|0)?[6-9]\d{9}$/.test(phoneDigits) ? "+91" + phoneDigits.slice(-10) : null;
    const { error: e2 } = await admin.from("staff").insert({
      user_id: made.user.id, name, email: emailIn || null, login: emailIn ? null : login, role, branch_id: branch, active: true, phone,
    });
    if (e2) {
      await admin.auth.admin.deleteUser(made.user.id); // never leave a sign-in without a staff row
      return fail(/login/.test(e2.message) ? "login_taken" : "create_failed");
    }
    await admin.rpc("_activity_as", { p_actor: me.user_id, p_action: "staff_account_created", p_branch: branch, p_target: name, p_detail: { role } }).then(() => {}, () => {});
    return reply({ ok: true, userId: made.user.id, signIn: emailIn || login });
  }

  if (body.action === "set_password") {
    const userId = String(body.userId || "");
    if (!goodPassword) return fail("weak_password");
    const { data: t } = await admin.from("staff").select("user_id, role, branch_id, name").eq("user_id", userId).maybeSingle();
    if (!t) return fail("unknown_staff");
    if (me.role === "manager" && (t.branch_id !== me.branch_id || !MANAGER_MAY.includes(t.role))) return fail("forbidden", 403);
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return fail("update_failed");
    await admin.rpc("_activity_as", { p_actor: me.user_id, p_action: "password_reset", p_branch: t.branch_id, p_target: t.name, p_detail: {} }).then(() => {}, () => {});
    return reply({ ok: true });
  }

  return fail("bad_action");
});
