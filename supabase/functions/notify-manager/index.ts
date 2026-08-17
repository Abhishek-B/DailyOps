import {
  adminClient,
  corsHeaders,
  isUuid,
  json,
  requireUser,
} from "../_shared/supabase.ts";
import {
  claimNotification,
  completeNotification,
  failNotification,
  formatDate,
  formatDateTime,
  listLabel,
  sendTelegramMessage,
  statusLabel,
} from "../_shared/notifications.ts";

type Recipient = {
  id: string;
  profile_id: string;
  telegram_chat_id: string;
  profile: { display_name: string; email: string; active: boolean };
};

type NotificationKind =
  | "list-complete"
  | "list-incomplete"
  | "list-reopened"
  | "shift-cover"
  | "test";
type RecipientPreference =
  | "notify_shift_complete"
  | "notify_incomplete_submission"
  | "notify_shift_reopened"
  | "notify_shift_cover";

type RecipientLoadResult =
  | { recipients: Recipient[]; databaseError: false }
  | { recipients: null; databaseError: true };

function logDatabaseError(context: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  console.error(`[notify-manager] ${context}`, {
    code: typeof details.code === "string" ? details.code : undefined,
    message: typeof details.message === "string"
      ? details.message
      : "Database query failed",
  });
}

async function loadRecipients(
  db: ReturnType<typeof adminClient>,
  venueId: string,
  preference: RecipientPreference,
): Promise<RecipientLoadResult> {
  const { data, error } = await db
    .from("venue_notification_recipients")
    .select("id,profile_id,telegram_chat_id,enabled," + preference)
    .eq("venue_id", venueId)
    .eq("enabled", true)
    .eq(preference, true)
    .order("created_at");
  if (error) {
    logDatabaseError("Telegram recipient query failed", error);
    return { recipients: null, databaseError: true };
  }

  const rows = (data || []) as Array<Record<string, any>>;
  const profileIds = [...new Set(rows.map((row) => row.profile_id))];
  if (!profileIds.length) return { recipients: [], databaseError: false };
  const profiles = await db
    .from("profiles")
    .select("id,display_name,email,active")
    .in("id", profileIds);
  if (profiles.error) {
    logDatabaseError("Telegram recipient profile query failed", profiles.error);
    return { recipients: null, databaseError: true };
  }
  const profilesById = Object.fromEntries(
    (profiles.data || []).map((profile) => [profile.id, profile]),
  );
  const missingProfile = rows.find((row) => !profilesById[row.profile_id]);
  if (missingProfile) {
    console.error("[notify-manager] Telegram recipient profile row missing", {
      profileId: missingProfile.profile_id,
    });
    return { recipients: null, databaseError: true };
  }
  const recipients = rows
    .map((row) => ({ ...row, profile: profilesById[row.profile_id] }))
    .filter((row): row is Recipient => !!row.profile?.active);
  return { recipients, databaseError: false };
}

async function deliverToRecipient(
  db: ReturnType<typeof adminClient>,
  recipient: Recipient,
  input: {
    idempotencyKey: string;
    venueId: string;
    venueName: string;
    workDate: string;
    listType: "open" | "close" | null;
    kind: NotificationKind;
    subject: string;
    bodyText: string;
  },
) {
  const recipientLabel = recipient.profile.display_name ||
    recipient.profile.email || recipient.profile_id;
  const claim = await claimNotification(db, {
    idempotencyKey: input.idempotencyKey,
    venueId: input.venueId,
    venueName: input.venueName,
    workDate: input.workDate,
    listType: input.listType,
    kind: input.kind,
    recipientProfileId: recipient.profile_id,
    recipient: recipientLabel,
    subject: input.subject,
    bodyText: input.bodyText,
  });
  if (!claim.shouldSend) {
    return {
      recipientId: recipient.id,
      eventId: claim.eventId,
      status: claim.deliveryStatus,
      sent: claim.deliveryStatus === "sent",
    };
  }

  try {
    const providerId = await sendTelegramMessage({
      chatId: recipient.telegram_chat_id,
      text: input.bodyText,
    });
    await completeNotification(db, claim.eventId, providerId);
    return {
      recipientId: recipient.id,
      eventId: claim.eventId,
      status: "sent",
      sent: true,
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Telegram delivery failed";
    console.error("[notify-manager] Telegram delivery failed", {
      recipientId: recipient.id,
      eventId: claim.eventId,
      message,
    });
    await failNotification(db, claim.eventId, message);
    return {
      recipientId: recipient.id,
      eventId: claim.eventId,
      status: "failed",
      sent: false,
      error: message,
    };
  }
}

function profileLabel(
  profile: { display_name?: string; email?: string } | null,
) {
  return profile?.display_name || profile?.email || "Team member";
}

function completionMessage(
  venue: { name: string },
  checklist: {
    list_type: "open" | "close";
    work_date: string;
    submitted_by?: string | null;
  },
  submittedBy: { display_name: string; email: string } | null,
  taskCount: number,
  revision: number,
) {
  const label = listLabel(checklist.list_type);
  const resubmitted = revision > 0;
  const subject = "DailyOps · " + venue.name + " · " + label + " " +
    (resubmitted ? "resubmitted" : "complete") + " · " + checklist.work_date;
  const text = [
    "✅ " + label + " " + (resubmitted ? "resubmitted" : "submitted"),
    "",
    venue.name,
    formatDate(checklist.work_date),
    "",
    `${
      profileLabel(submittedBy)
    } submitted the shift with ${taskCount} / ${taskCount} tasks completed.`,
    ...(resubmitted
      ? ["This shift was submitted again after being reopened."]
      : []),
  ].join("\n");
  return { subject, text };
}

function incompleteSubmissionMessage(
  venue: { name: string },
  checklist: {
    list_type: "open" | "close";
    work_date: string;
  },
  submittedBy: { display_name: string; email: string } | null,
  tasks: Array<Record<string, any>>,
  revision: number,
) {
  const label = listLabel(checklist.list_type);
  const incomplete = tasks.filter((task) => task.status !== "done");
  const visibleTasks = incomplete.slice(0, 10).map((task) => {
    const details = [
      `${statusLabel(String(task.status || "pending"))}`,
      task.reason ? `Reason: ${String(task.reason).trim()}` : "",
      task.note ? `Note: ${String(task.note).trim()}` : "",
    ].filter(Boolean).join(" · ");
    return `• ${String(task.title || "Untitled task")} — ${details}`;
  });
  if (incomplete.length > visibleTasks.length) {
    visibleTasks.push(
      `• +${incomplete.length - visibleTasks.length} more incomplete task(s)`,
    );
  }
  const resubmitted = revision > 0;
  const subject = "DailyOps · " + venue.name + " · " + label +
    (resubmitted ? " resubmitted incomplete" : " submitted incomplete") +
    " · " + checklist.work_date;
  const text = [
    "⚠️ " + label + " " +
    (resubmitted ? "resubmitted incomplete" : "submitted incomplete"),
    "",
    venue.name,
    formatDate(checklist.work_date),
    "",
    `Submitted by: ${profileLabel(submittedBy)}`,
    "",
    "Incomplete tasks:",
    ...visibleTasks,
    "",
    `${incomplete.length} task(s) remain incomplete. Review these items to see whether the team can be unblocked.`,
  ].join("\n");
  return { subject, text };
}

function reopenedMessage(
  venue: { name: string; timezone?: string },
  checklist: {
    list_type: "open" | "close";
    work_date: string;
    reopened_at: string;
  },
  profile: { display_name: string; email: string },
) {
  const label = listLabel(checklist.list_type);
  const subject = "DailyOps · " + venue.name + " · " + label + " reopened · " +
    checklist.work_date;
  const text = [
    "↩️ " + label + " reopened",
    "",
    venue.name,
    formatDate(checklist.work_date),
    "",
    "Reopened by: " + profileLabel(profile),
    "At: " + formatDateTime(checklist.reopened_at, venue.timezone || "UTC"),
    "",
    "The shift is editable again and will need to be submitted again when complete.",
  ].join("\n");
  return { subject, text };
}

function coverMessage(
  venue: { name: string },
  request: { work_date: string; shift_type: "open" | "close" },
  covering: { display_name: string; email: string },
  coveredFor: { display_name: string; email: string } | null,
) {
  const label = listLabel(request.shift_type);
  const subject = "DailyOps · " + venue.name + " · shift cover · " +
    request.work_date;
  const text = [
    "👥 Shift cover · " + label,
    "",
    venue.name,
    formatDate(request.work_date),
    "",
    profileLabel(covering) + " is covering for " +
    (coveredFor ? profileLabel(coveredFor) : "the shift") + ".",
  ].join("\n");
  return { subject, text };
}

async function handleTest(
  caller: NonNullable<Awaited<ReturnType<typeof requireUser>>>,
  body: any,
) {
  if (
    !isUuid(body?.venue_id) || !isUuid(body?.recipient_id) ||
    !isUuid(body?.request_id)
  ) {
    return json({
      error: "venue_id, recipient_id, and request_id must be valid UUIDs",
    }, 400);
  }
  const visible = await caller.client
    .from("venues")
    .select("id,name")
    .eq("id", body.venue_id)
    .maybeSingle();
  if (visible.error) {
    logDatabaseError("caller venue visibility query failed", visible.error);
    return json({ error: "Could not verify venue access" }, 500);
  }
  if (!visible.data) {
    return json({ error: "Venue is not available to this user" }, 403);
  }
  const manageCheck = await caller.client.rpc("can_manage_venue", {
    p_venue_id: body.venue_id,
  });
  if (manageCheck.error) {
    logDatabaseError("caller venue management check failed", manageCheck.error);
    return json({ error: "Could not verify venue management access" }, 500);
  }
  if (manageCheck.data !== true) {
    return json({
      error: "Only an authorised venue manager can send a test notification",
    }, 403);
  }

  const db = adminClient();
  const recipientResult = await db
    .from("venue_notification_recipients")
    .select("id,venue_id,profile_id,telegram_chat_id,enabled")
    .eq("id", body.recipient_id)
    .eq("venue_id", body.venue_id)
    .maybeSingle();
  if (recipientResult.error) {
    logDatabaseError("Telegram recipient lookup failed", recipientResult.error);
    return json({ error: "Could not load the Telegram recipient" }, 500);
  }
  if (!recipientResult.data) {
    return json({ error: "Configured Telegram recipient was not found" }, 404);
  }
  const profileResult = await db
    .from("profiles")
    .select("id,display_name,email,active")
    .eq("id", recipientResult.data.profile_id)
    .single();
  if (profileResult.error) {
    logDatabaseError(
      "Telegram recipient profile lookup failed",
      profileResult.error,
    );
    return json(
      { error: "Could not load the Telegram recipient profile" },
      500,
    );
  }
  if (!profileResult.data.active || !recipientResult.data.enabled) {
    return json(
      { error: "The Telegram recipient is inactive or disabled" },
      422,
    );
  }

  const recipient: Recipient = {
    ...recipientResult.data,
    profile: profileResult.data,
  };
  const bodyText = [
    "✅ DailyOps test notification",
    "",
    `Telegram notifications are configured correctly for ${visible.data.name}.`,
  ].join("\n");
  const result = await deliverToRecipient(db, recipient, {
    idempotencyKey: `test:${recipient.id}:${body.request_id}`,
    venueId: visible.data.id,
    venueName: visible.data.name,
    workDate: new Date().toISOString().slice(0, 10),
    listType: null,
    kind: "test",
    subject: "DailyOps Telegram test notification",
    bodyText,
  });
  return json(
    { ok: result.sent, sent: result.sent, result },
    result.sent ? 200 : 502,
  );
}

async function handleListNotification(
  caller: NonNullable<Awaited<ReturnType<typeof requireUser>>>,
  body: any,
  kind: "list-complete" | "list-reopened",
) {
  const visible = await caller.client
    .from("daily_checklists")
    .select("id,venue_id,work_date,list_type")
    .eq("id", body.checklist_id)
    .maybeSingle();
  if (visible.error) {
    logDatabaseError("caller checklist visibility query failed", visible.error);
    return json({ error: "Could not verify checklist access" }, 500);
  }
  if (!visible.data) {
    return json({ error: "Checklist is not available to this user" }, 403);
  }

  const db = adminClient();
  const checklistResult = await db
    .from("daily_checklists")
    .select(
      "id,venue_id,work_date,list_type,submitted,submitted_by,submitted_at,notification_revision,reopened_by,reopened_at",
    )
    .eq("id", body.checklist_id)
    .maybeSingle();
  if (checklistResult.error) {
    logDatabaseError(
      "checklist notification query failed",
      checklistResult.error,
    );
    return json({ error: "Could not load the checklist" }, 500);
  }
  if (!checklistResult.data) {
    return json({ error: "Checklist was not found" }, 404);
  }
  const checklist = checklistResult.data;
  const revision = Number(checklist.notification_revision || 0);

  if (kind === "list-complete" && !checklist.submitted) {
    return json({ ok: true, sent: 0, skipped: "not-submitted" });
  }
  if (
    kind === "list-reopened" &&
    (checklist.submitted || revision < 1 || !checklist.reopened_by ||
      !checklist.reopened_at)
  ) {
    return json({ ok: true, sent: 0, skipped: "not-reopened" });
  }

  let tasks: Array<Record<string, any>> = [];
  let notificationKind: NotificationKind = kind;
  let recipientPreference: RecipientPreference = "notify_shift_reopened";
  if (kind === "list-complete") {
    const taskResult = await db
      .from("daily_tasks")
      .select("id,title,status,critical,completed_by,completed_at,note,reason")
      .eq("checklist_id", checklist.id)
      .order("sort_order")
      .order("id");
    if (taskResult.error) {
      logDatabaseError("checklist task query failed", taskResult.error);
      return json({ error: "Could not load checklist tasks" }, 500);
    }
    tasks = taskResult.data || [];
    if (!tasks.length) return json({ ok: true, sent: 0, skipped: "no-tasks" });
    const complete = tasks.every((task) => task.status === "done");
    notificationKind = complete ? "list-complete" : "list-incomplete";
    recipientPreference = complete
      ? "notify_shift_complete"
      : "notify_incomplete_submission";
  } else {
    recipientPreference = "notify_shift_reopened";
  }

  const venueResult = await db
    .from("venues")
    .select("id,name,timezone,notify_complete")
    .eq("id", checklist.venue_id)
    .maybeSingle();
  if (venueResult.error) {
    logDatabaseError(
      "venue notification settings query failed",
      venueResult.error,
    );
    return json({ error: "Could not load venue notification settings" }, 500);
  }
  if (!venueResult.data) return json({ error: "Venue was not found" }, 404);
  const venue = venueResult.data;
  if (notificationKind === "list-complete" && !venue.notify_complete) {
    return json({ ok: true, sent: 0, skipped: "venue-disabled" });
  }

  const recipientResult = await loadRecipients(
    db,
    venue.id,
    recipientPreference,
  );
  if (recipientResult.databaseError) {
    return json(
      { error: "Could not load Telegram notification recipients" },
      500,
    );
  }
  const recipients = recipientResult.recipients;
  if (!recipients.length) {
    return json({ ok: true, sent: 0, skipped: "no-recipients" });
  }

  let built: { subject: string; text: string };
  if (
    notificationKind === "list-complete" ||
    notificationKind === "list-incomplete"
  ) {
    const profileResult = checklist.submitted_by
      ? await db
        .from("profiles")
        .select("id,display_name,email")
        .eq("id", checklist.submitted_by)
        .maybeSingle()
      : { data: null, error: null };
    if (profileResult.error) {
      logDatabaseError(
        "submission attribution query failed",
        profileResult.error,
      );
      return json({ error: "Could not load submission attribution" }, 500);
    }
    if (checklist.submitted_by && !profileResult.data) {
      return json({ error: "Submission attribution was not found" }, 500);
    }
    const submittedBy = profileResult.data;
    built = notificationKind === "list-complete"
      ? completionMessage(venue, checklist, submittedBy, tasks.length, revision)
      : incompleteSubmissionMessage(
        venue,
        checklist,
        submittedBy,
        tasks,
        revision,
      );
  } else {
    const profileResult = await db
      .from("profiles")
      .select("id,display_name,email")
      .eq("id", checklist.reopened_by)
      .maybeSingle();
    if (profileResult.error) {
      logDatabaseError("reopen attribution query failed", profileResult.error);
      return json({ error: "Could not load reopen attribution" }, 500);
    }
    if (!profileResult.data) {
      return json({ error: "Reopen attribution was not found" }, 500);
    }
    built = reopenedMessage(venue, checklist, profileResult.data);
  }

  const results = [];
  const eventName = notificationKind === "list-complete"
    ? "complete"
    : notificationKind === "list-incomplete"
    ? "incomplete"
    : "reopened";
  for (const recipient of recipients) {
    results.push(
      await deliverToRecipient(db, recipient, {
        idempotencyKey: "list-" + eventName + ":" + checklist.id + ":" +
          revision + ":" + recipient.id,
        venueId: venue.id,
        venueName: venue.name,
        workDate: checklist.work_date,
        listType: checklist.list_type,
        kind: notificationKind,
        subject: built.subject,
        bodyText: built.text,
      }),
    );
  }
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.status === "failed").length;
  return json({
    ok: failed === 0,
    kind: notificationKind,
    sent,
    failed,
    results,
  });
}

async function handleShiftCover(
  caller: NonNullable<Awaited<ReturnType<typeof requireUser>>>,
  body: any,
) {
  if (!isUuid(body?.cover_request_id)) {
    return json({ error: "cover_request_id must be a valid UUID" }, 400);
  }
  const visible = await caller.client
    .from("shift_cover_requests")
    .select("id")
    .eq("id", body.cover_request_id)
    .maybeSingle();
  if (visible.error) {
    logDatabaseError(
      "caller shift-cover visibility query failed",
      visible.error,
    );
    return json({ error: "Could not verify shift-cover access" }, 500);
  }
  if (!visible.data) {
    return json(
      { error: "Shift-cover request is not available to this user" },
      403,
    );
  }

  const db = adminClient();
  const coverResult = await db
    .from("shift_cover_requests")
    .select(
      "id,venue_id,user_id,covered_for_user_id,work_date,shift_type,created_at",
    )
    .eq("id", body.cover_request_id)
    .maybeSingle();
  if (coverResult.error) {
    logDatabaseError("shift-cover request query failed", coverResult.error);
    return json({ error: "Could not load the shift-cover request" }, 500);
  }
  if (!coverResult.data) {
    return json({ error: "Shift-cover request was not found" }, 404);
  }
  const request = coverResult.data;

  const venueResult = await db
    .from("venues")
    .select("id,name")
    .eq("id", request.venue_id)
    .maybeSingle();
  if (venueResult.error) {
    logDatabaseError("shift-cover venue query failed", venueResult.error);
    return json({ error: "Could not load the shift-cover venue" }, 500);
  }
  if (!venueResult.data) {
    return json({ error: "Shift-cover venue was not found" }, 404);
  }

  const participantIds = [request.user_id, request.covered_for_user_id].filter(
    Boolean,
  );
  const rosterResult = await db
    .from("roster_assignments")
    .select("user_id")
    .eq("venue_id", request.venue_id)
    .eq("work_date", request.work_date)
    .eq("shift_type", request.shift_type)
    .in("user_id", participantIds);
  if (rosterResult.error) {
    logDatabaseError(
      "shift-cover roster validation query failed",
      rosterResult.error,
    );
    return json({ error: "Could not validate the shift-cover roster" }, 500);
  }
  const rosteredIds = new Set(
    (rosterResult.data || []).map((row) => row.user_id),
  );
  if (
    !rosteredIds.has(request.user_id) ||
    (request.covered_for_user_id &&
      !rosteredIds.has(request.covered_for_user_id))
  ) {
    return json({ error: "The shift-cover request is no longer valid" }, 422);
  }

  const profileResult = await db
    .from("profiles")
    .select("id,display_name,email,active")
    .in("id", participantIds);
  if (profileResult.error) {
    logDatabaseError(
      "shift-cover participant query failed",
      profileResult.error,
    );
    return json({ error: "Could not load shift-cover participants" }, 500);
  }
  const profilesById = Object.fromEntries(
    (profileResult.data || []).map((profile) => [profile.id, profile]),
  );
  const covering = profilesById[request.user_id];
  const coveredFor = request.covered_for_user_id
    ? profilesById[request.covered_for_user_id]
    : null;
  if (!covering || (request.covered_for_user_id && !coveredFor)) {
    return json(
      { error: "Shift-cover participant attribution was not found" },
      500,
    );
  }

  const recipientResult = await loadRecipients(
    db,
    request.venue_id,
    "notify_shift_cover",
  );
  if (recipientResult.databaseError) {
    return json(
      { error: "Could not load Telegram notification recipients" },
      500,
    );
  }
  const recipients = recipientResult.recipients;
  if (!recipients.length) {
    return json({ ok: true, sent: 0, skipped: "no-recipients" });
  }

  const built = coverMessage(venueResult.data, request, covering, coveredFor);
  const results = [];
  for (const recipient of recipients) {
    results.push(
      await deliverToRecipient(db, recipient, {
        idempotencyKey: "shift-cover:" + request.id + ":" + recipient.id,
        venueId: request.venue_id,
        venueName: venueResult.data.name,
        workDate: request.work_date,
        listType: request.shift_type,
        kind: "shift-cover",
        subject: built.subject,
        bodyText: built.text,
      }),
    );
  }
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.status === "failed").length;
  return json({ ok: failed === 0, sent, failed, results });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "POST is required" }, 405);

  const caller = await requireUser(req).catch(() => null);
  if (!caller) {
    return json({ error: "A valid signed-in user is required" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "A JSON request body is required" }, 400);
  }

  if (body?.kind === "test") {
    return handleTest(caller, body);
  }
  if (
    (body?.kind === "list-complete" || body?.kind === "list-reopened") &&
    isUuid(body?.checklist_id)
  ) {
    return handleListNotification(caller, body, body.kind);
  }
  if (body?.kind === "shift-cover") {
    return handleShiftCover(caller, body);
  }
  return json({
    error:
      "A valid list-complete, list-reopened, shift-cover, or test request is required",
  }, 400);
});
