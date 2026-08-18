import {
  adminClient,
  corsHeaders,
  isUuid,
  json,
  requireUser,
} from "../_shared/supabase.ts";

const ACTIONS = new Set([
  "upsert_organisation_membership",
  "remove_organisation_membership",
]);
const ORGANISATION_ROLES = new Set(["employee", "manager"]);

function logDatabaseError(context: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  console.error(`[manage-user-access] ${context}`, {
    code: typeof details.code === "string" ? details.code : undefined,
    message: typeof details.message === "string"
      ? details.message
      : "Database request failed",
  });
}

function validationError(message: string) {
  return json({ error: message }, 400);
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
      { error: "Only an active platform admin can manage organisation access" },
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

  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return validationError("Choose a valid organisation access action");
  }

  const userId = body.user_id;
  if (!isUuid(userId)) return validationError("Choose a valid user");

  const organisationId = body.organisation_id;
  if (!isUuid(organisationId)) {
    return validationError("Choose a valid organisation");
  }

  const roleValue = body.organisation_role;
  const organisationRole = roleValue == null ? null : roleValue;
  if (
    action === "upsert_organisation_membership" &&
    (typeof organisationRole !== "string" ||
      !ORGANISATION_ROLES.has(organisationRole))
  ) {
    return validationError("Choose a valid organisation role");
  }
  if (action === "remove_organisation_membership" && roleValue != null) {
    return validationError(
      "Organisation role is not used when removing access",
    );
  }

  const result = await adminClient().rpc(
    "admin_manage_user_organisation_access",
    {
      p_action: action,
      p_user_id: userId,
      p_organisation_id: organisationId,
      p_organisation_role: organisationRole,
    },
  );
  if (result.error) {
    logDatabaseError("organisation access mutation failed", result.error);
    return json({ error: "Could not update organisation access" }, 500);
  }

  console.info("[manage-user-access] organisation access updated", {
    callerId: caller.userId,
    targetUserId: userId,
    organisationId,
    action,
    organisationRole,
  });
  return json({ ok: true, membership: result.data });
});
