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
  listLabel,
  sendTelegramMessage,
} from "../_shared/notifications.ts";

type Recipient = {
  id: string;
  profile_id: string;
  telegram_chat_id: string;
  profile: { display_name: string; email: string; active: boolean };
};

async function loadRecipients(
  db: ReturnType<typeof adminClient>,
  venueId: string,
  preference: "notify_shift_complete" | "notify_end_of_day",
) {
  const { data, error } = await db
    .from("venue_notification_recipients")
    .select("id,profile_id,telegram_chat_id,enabled," + preference)
    .eq("venue_id", venueId)
    .eq("enabled", true)
    .eq(preference, true)
    .order("created_at");
  if (error) throw error;

  const rows = (data || []) as Array<Record<string, any>>;
  const profileIds = [...new Set(rows.map((row) => row.profile_id))];
  if (!profileIds.length) return [] as Recipient[];
  const profiles = await db
    .from("profiles")
    .select("id,display_name,email,active")
    .in("id", profileIds);
  if (profiles.error) throw profiles.error;
  const profilesById = Object.fromEntries(
    (profiles.data || []).map((profile) => [profile.id, profile]),
  );
  return rows
    .map((row) => ({ ...row, profile: profilesById[row.profile_id] }))
    .filter((row): row is Recipient => !!row.profile?.active);
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
    kind: "list-complete" | "test";
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

function completionMessage(
  venue: { name: string },
  checklist: { list_type: "open" | "close"; work_date: string },
  tasks: Array<Record<string, any>>,
  profiles: Record<string, { display_name: string; email: string }>,
) {
  const label = listLabel(checklist.list_type);
  const completers = [
    ...new Set(tasks.map((task) => {
      const profile = profiles[task.completed_by];
      return profile?.display_name || profile?.email || "Team member";
    })),
  ];
  const subject =
    `DailyOps · ${venue.name} · ${label} complete · ${checklist.work_date}`;
  const text = [
    `✅ ${label} complete`,
    "",
    venue.name,
    formatDate(checklist.work_date),
    "",
    `${tasks.length} / ${tasks.length} tasks completed.`,
    "",
    `Completed by: ${completers.join(", ") || "Team member"}`,
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
  if (visible.error || !visible.data) {
    return json({ error: "Venue is not available to this user" }, 403);
  }
  const manageCheck = await caller.client.rpc("can_manage_venue", {
    p_venue_id: body.venue_id,
  });
  if (manageCheck.error || manageCheck.data !== true) {
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
  if (recipientResult.error || !recipientResult.data) {
    return json({ error: "Configured Telegram recipient was not found" }, 404);
  }
  const profileResult = await db
    .from("profiles")
    .select("id,display_name,email,active")
    .eq("id", recipientResult.data.profile_id)
    .single();
  if (
    profileResult.error || !profileResult.data?.active ||
    !recipientResult.data.enabled
  ) {
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
  if (body?.kind !== "list-complete" || !isUuid(body?.checklist_id)) {
    return json({
      error:
        "Only a valid list-complete checklist_id or test recipient request is accepted",
    }, 400);
  }

  const visible = await caller.client
    .from("daily_checklists")
    .select("id,venue_id,work_date,list_type")
    .eq("id", body.checklist_id)
    .maybeSingle();
  if (visible.error) {
    console.error(
      "[notify-manager] caller visibility check failed",
      visible.error,
    );
    return json({ error: "Could not verify checklist access" }, 403);
  }
  if (!visible.data) {
    return json({ error: "Checklist is not available to this user" }, 403);
  }

  const db = adminClient();
  const { data: checklist, error: checklistError } = await db
    .from("daily_checklists")
    .select("id,venue_id,work_date,list_type")
    .eq("id", body.checklist_id)
    .single();
  if (checklistError || !checklist) {
    console.error("[notify-manager] checklist load failed", checklistError);
    return json({ error: "Could not load the checklist" }, 500);
  }

  const { data: tasks, error: taskError } = await db
    .from("daily_tasks")
    .select("id,title,status,critical,completed_by,completed_at,note,reason")
    .eq("checklist_id", checklist.id)
    .order("sort_order")
    .order("id");
  if (taskError) {
    console.error("[notify-manager] task load failed", taskError);
    return json({ error: "Could not load checklist tasks" }, 500);
  }
  if (!tasks?.length || tasks.some((task) => task.status !== "done")) {
    return json({ ok: true, sent: 0, skipped: "not-complete" });
  }

  const { data: venue, error: venueError } = await db
    .from("venues")
    .select("id,name,notify_complete")
    .eq("id", checklist.venue_id)
    .single();
  if (venueError || !venue) {
    console.error("[notify-manager] venue load failed", venueError);
    return json({ error: "Could not load venue notification settings" }, 500);
  }
  if (!venue.notify_complete) {
    return json({ ok: true, sent: 0, skipped: "venue-disabled" });
  }

  const recipients = await loadRecipients(
    db,
    venue.id,
    "notify_shift_complete",
  );
  if (!recipients.length) {
    return json({ ok: true, sent: 0, skipped: "no-recipients" });
  }

  const profileIds = [
    ...new Set(tasks.map((task) => task.completed_by).filter(Boolean)),
  ];
  const profileResult = profileIds.length
    ? await db.from("profiles").select("id,display_name,email").in(
      "id",
      profileIds,
    )
    : { data: [], error: null };
  if (profileResult.error) {
    console.error("[notify-manager] profile load failed", profileResult.error);
    return json({ error: "Could not load task attribution" }, 500);
  }
  const profiles = Object.fromEntries(
    (profileResult.data || []).map((profile) => [profile.id, profile]),
  );
  const built = completionMessage(venue, checklist, tasks, profiles);
  const results = [];
  for (const recipient of recipients) {
    results.push(
      await deliverToRecipient(db, recipient, {
        idempotencyKey: `list-complete:${checklist.id}:${recipient.id}`,
        venueId: venue.id,
        venueName: venue.name,
        workDate: checklist.work_date,
        listType: checklist.list_type,
        kind: "list-complete",
        subject: built.subject,
        bodyText: built.text,
      }),
    );
  }
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.status === "failed").length;
  return json({ ok: failed === 0, sent, failed, results });
});
