import {
  adminClient,
  corsHeaders,
  isUuid,
  json,
  requireUser,
} from "../_shared/supabase.ts";
import { normalizeUsername, usernameToAuthEmail } from "../_shared/username.ts";

const ORGANISATION_ROLES = new Set(["employee", "manager"]);
const PLATFORM_ROLES = new Set(["user", "admin"]);

function logDatabaseError(context: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  console.error(`[create-user] ${context}`, {
    code: typeof details.code === "string" ? details.code : undefined,
    message: typeof details.message === "string"
      ? details.message
      : "Database query failed",
  });
}

function logAuthError(context: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  console.error(`[create-user] ${context}`, {
    code: typeof details.code === "string" ? details.code : undefined,
    status: typeof details.status === "number" ? details.status : undefined,
  });
}

function validationError(message: string) {
  return json({ error: message }, 400);
}

function authCreateError(error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const code = typeof details.code === "string" ? details.code : "";
  const status = typeof details.status === "number" ? details.status : 0;
  const message = typeof details.message === "string" ? details.message : "";

  if (
    code === "email_exists" ||
    /already registered|already exists|duplicate/i.test(message)
  ) {
    return json({ error: "That username is already in use." }, 409);
  }
  if ((status === 400 || status === 422) && /password/i.test(message)) {
    return json({
      error:
        "The password was rejected. Use a stronger password and try again.",
    }, 400);
  }
  return json(
    { error: "The user could not be created." },
    status >= 400 && status < 500 ? 400 : 500,
  );
}

async function compensateCreatedUser(
  db: ReturnType<typeof adminClient>,
  userId: string,
) {
  const profileCleanup = await db.rpc(
    "cleanup_failed_created_user_profile",
    { p_user_id: userId },
  );
  if (profileCleanup.error || profileCleanup.data !== true) {
    logDatabaseError(
      "failed-created-user profile cleanup failed",
      profileCleanup.error ??
        { message: "Cleanup did not confirm profile removal" },
    );
    console.error(
      "[create-user] provisioning failure requires manual recovery",
      { userId },
    );
    return false;
  }

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) {
    logAuthError(
      "Auth-user compensation failed; manual cleanup is required",
      error,
    );
    console.error("[create-user] orphan Auth user requires cleanup", {
      userId,
    });
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const caller = await requireUser(req);
  if (!caller) return json({ error: "Authentication required" }, 401);

  const callerProfile = await caller.client
    .from("profiles")
    .select("id,active,platform_role")
    .eq("id", caller.userId)
    .maybeSingle();
  if (callerProfile.error) {
    logDatabaseError("caller profile query failed", callerProfile.error);
    return json({ error: "Could not verify account permissions" }, 500);
  }
  if (
    !callerProfile.data?.active ||
    callerProfile.data.platform_role !== "admin"
  ) {
    return json(
      { error: "Only an active platform admin can create users" },
      403,
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return validationError("Invalid request body");
    }
    body = parsed as Record<string, unknown>;
  } catch (_) {
    return validationError("Invalid request body");
  }

  let username: string;
  try {
    username = normalizeUsername(body.username);
  } catch (error) {
    return validationError(
      error instanceof Error ? error.message : "Invalid username",
    );
  }

  const password = body.password;
  if (
    typeof password !== "string" || password.length < 6 || password.length > 256
  ) {
    return validationError("Password must be between 6 and 256 characters");
  }

  const displayName = typeof body.display_name === "string"
    ? body.display_name.trim()
    : "";
  if (!displayName || displayName.length > 120) {
    return validationError("Display name must be between 1 and 120 characters");
  }

  const organisationId = body.organisation_id;
  if (!isUuid(organisationId)) {
    return validationError("Choose a valid organisation");
  }

  const organisationRole = body.organisation_role;
  if (
    typeof organisationRole !== "string" ||
    !ORGANISATION_ROLES.has(organisationRole)
  ) {
    return validationError("Choose a valid organisation role");
  }

  const platformRole = body.platform_role;
  if (typeof platformRole !== "string" || !PLATFORM_ROLES.has(platformRole)) {
    return validationError("Choose a valid platform role");
  }

  const organisationResult = await caller.client
    .from("organisations")
    .select("id")
    .eq("id", organisationId)
    .maybeSingle();
  if (organisationResult.error) {
    logDatabaseError(
      "organisation visibility query failed",
      organisationResult.error,
    );
    return json({ error: "Could not verify the selected organisation" }, 500);
  }
  if (!organisationResult.data) {
    return json({ error: "That organisation is no longer available" }, 400);
  }

  const email = usernameToAuthEmail(username);
  const db = adminClient();
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName, username },
  });
  if (created.error) {
    logAuthError("Auth-user creation failed", created.error);
    return authCreateError(created.error);
  }

  const userId = created.data.user?.id;
  if (!userId) {
    console.error("[create-user] Auth creation returned no user id");
    return json({ error: "The user could not be created" }, 500);
  }

  const provisioning = await db.rpc("provision_created_user", {
    p_user_id: userId,
    p_email: email,
    p_display_name: displayName,
    p_organisation_id: organisationId,
    p_organisation_role: organisationRole,
    p_platform_role: platformRole,
  });
  if (provisioning.error) {
    logDatabaseError("post-Auth provisioning failed", provisioning.error);
    const cleaned = await compensateCreatedUser(db, userId);
    return json({
      error: cleaned
        ? "The user could not be provisioned. No account was created."
        : "The user could not be provisioned. An administrator must clean up the incomplete account before retrying.",
    }, 500);
  }

  console.info("[create-user] user created", {
    creatorId: caller.userId,
    createdUserId: userId,
    organisationId,
    organisationRole,
    platformRole,
  });
  return json({
    ok: true,
    username,
    organisation_id: organisationId,
    organisation_role: organisationRole,
    platform_role: platformRole,
  });
});
