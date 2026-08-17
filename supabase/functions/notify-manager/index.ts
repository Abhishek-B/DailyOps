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
  escapeHtml,
  failNotification,
  formatDate,
  formatDateTime,
  listLabel,
  sendEmail,
} from "../_shared/notifications.ts";

function completionEmail(
  venue: { name: string; timezone: string },
  checklist: { list_type: "open" | "close"; work_date: string },
  tasks: Array<Record<string, any>>,
  profiles: Record<string, { display_name: string; email: string }>,
) {
  const label = listLabel(checklist.list_type);
  const taskLines = tasks.map((task) => {
    const completedBy = profiles[task.completed_by]?.display_name ||
      profiles[task.completed_by]?.email || "Team member";
    return `<li><b>${escapeHtml(task.title)}</b> — ${
      escapeHtml(completedBy)
    } at ${escapeHtml(formatDateTime(task.completed_at, venue.timezone))}${
      task.note ? `<br><span>${escapeHtml(task.note)}</span>` : ""
    }</li>`;
  }).join("");
  const subject =
    `DailyOps · ${venue.name} · ${label} complete · ${checklist.work_date}`;
  const text = `${venue.name}: ${label} is complete for ${
    formatDate(checklist.work_date)
  }.\n\n${
    tasks.map((task) => {
      const completedBy = profiles[task.completed_by]?.display_name ||
        profiles[task.completed_by]?.email || "Team member";
      return `- ${task.title} — ${completedBy} at ${
        formatDateTime(task.completed_at, venue.timezone)
      }${task.note ? ` — ${task.note}` : ""}`;
    }).join("\n")
  }`;
  const html = `<h2>${escapeHtml(label)} complete</h2><p>${
    escapeHtml(venue.name)
  } · ${
    escapeHtml(formatDate(checklist.work_date))
  }</p><p><b>${tasks.length} of ${tasks.length}</b> tasks completed.</p><ul>${taskLines}</ul>`;
  return { subject, text, html };
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
  if (body?.kind !== "list-complete" || !isUuid(body?.checklist_id)) {
    return json({
      error: "Only a valid list-complete checklist_id is accepted",
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
    .select("id,venue_id,work_date,list_type,complete_notified")
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
    return json({ ok: true, sent: false, skipped: "not-complete" });
  }
  if (checklist.complete_notified) {
    return json({ ok: true, sent: false, skipped: "already-notified" });
  }

  const { data: venue, error: venueError } = await db
    .from("venues")
    .select("id,name,timezone,notify_complete,email_enabled,manager_email")
    .eq("id", checklist.venue_id)
    .single();
  if (venueError || !venue) {
    console.error("[notify-manager] venue load failed", venueError);
    return json(
      { error: "Could not load the venue notification settings" },
      500,
    );
  }
  if (!venue.notify_complete || !venue.email_enabled) {
    return json({ ok: true, sent: false, skipped: "email-disabled" });
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
  const built = completionEmail(venue, checklist, tasks, profiles);
  const claim = await claimNotification(db, {
    idempotencyKey: `list-complete:${checklist.id}`,
    venueId: venue.id,
    venueName: venue.name,
    workDate: checklist.work_date,
    listType: checklist.list_type,
    kind: "list-complete",
    recipient: venue.manager_email || null,
    subject: built.subject,
    bodyText: built.text,
  });
  if (!claim.shouldSend) {
    return json({
      ok: true,
      sent: claim.deliveryStatus === "sent",
      skipped: claim.deliveryStatus,
    });
  }

  if (!venue.manager_email) {
    await failNotification(
      db,
      claim.eventId,
      "No manager_email is configured for this venue.",
    );
    return json({
      ok: false,
      sent: false,
      error: "No manager email is configured for this venue.",
    }, 422);
  }

  try {
    const providerId = await sendEmail({
      to: venue.manager_email,
      subject: built.subject,
      text: built.text,
      html: built.html,
      idempotencyKey: claim.eventId,
    });
    await completeNotification(db, claim.eventId, providerId);
    return json({
      ok: true,
      sent: true,
      event_id: claim.eventId,
      provider_message_id: providerId,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Email provider request failed";
    console.error("[notify-manager] email delivery failed", {
      eventId: claim.eventId,
      message,
    });
    await failNotification(db, claim.eventId, message);
    return json({
      ok: false,
      sent: false,
      event_id: claim.eventId,
      error: message,
    }, 502);
  }
});
