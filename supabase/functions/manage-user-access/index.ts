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
  "apply_user_access",
]);
const ORGANISATION_ROLES = new Set(["employee", "manager"]);
const PLATFORM_ROLES = new Set(["user", "admin"]);

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

function isProtectedAccountError(error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const message = typeof details.message === "string"
    ? details.message.toLowerCase()
    : "";
  return details.code === "P0001" &&
    message.includes("master administrator");
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

  if (action === "apply_user_access") {
    if (typeof body.active !== "boolean") {
      return validationError("Choose a valid active state");
    }
    if (
      typeof body.platform_role !== "string" ||
      !PLATFORM_ROLES.has(body.platform_role)
    ) {
      return validationError("Choose a valid platform role");
    }
    if (!Array.isArray(body.organisations)) {
      return validationError("Organisation access must be an array");
    }
    for (const organisation of body.organisations) {
      if (
        !organisation || typeof organisation !== "object" ||
        Array.isArray(organisation)
      ) {
        return validationError(
          "Each organisation access entry must be an object",
        );
      }
      const entry = organisation as Record<string, unknown>;
      if (!isUuid(entry.organisation_id)) {
        return validationError("Each organisation must have a valid id");
      }
      if (
        typeof entry.role !== "string" ||
        !ORGANISATION_ROLES.has(entry.role)
      ) {
        return validationError("Each organisation must have a valid role");
      }
      if (!Array.isArray(entry.venue_ids)) {
        return validationError("Each organisation must have a venue id array");
      }
      if (new Set(entry.venue_ids).size !== entry.venue_ids.length) {
        return validationError("A venue may only appear once per organisation");
      }
      if (entry.venue_ids.some((venueId) => !isUuid(venueId))) {
        return validationError("Each venue must have a valid id");
      }
      if (entry.role === "manager" && entry.venue_ids.length) {
        return validationError(
          "Manager access does not require explicit venues",
        );
      }
    }
    if (
      userId === caller.userId &&
      (body.active !== callerProfile.data.active ||
        body.platform_role !== callerProfile.data.platform_role)
    ) {
      return json({
        error:
          "You cannot change your own platform access or active state. Another platform administrator must perform this change.",
      }, 400);
    }
  }

  let organisationId: string | null = null;
  let organisationRole: string | null = null;
  if (action !== "apply_user_access") {
    if (!isUuid(body.organisation_id)) {
      return validationError("Choose a valid organisation");
    }
    organisationId = body.organisation_id;

    const roleValue = body.organisation_role;
    organisationRole = roleValue == null ? null : roleValue as string;
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
  }

  const db = adminClient();
  const result = action === "apply_user_access"
    ? await db.rpc("admin_apply_user_access", {
      p_user_id: userId,
      p_active: body.active,
      p_platform_role: body.platform_role,
      p_organisations: body.organisations,
      p_caller_id: caller.userId,
    })
    : await db.rpc("admin_manage_user_organisation_access", {
      p_action: action,
      p_user_id: userId,
      p_organisation_id: organisationId,
      p_organisation_role: organisationRole,
      p_caller_id: caller.userId,
    });
  if (result.error) {
    logDatabaseError("organisation access mutation failed", result.error);
    if (isProtectedAccountError(result.error)) {
      return json({
        error: "The protected master administrator account cannot be changed",
      }, 403);
    }
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
