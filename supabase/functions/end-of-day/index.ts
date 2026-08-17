import {
  adminClient,
  corsHeaders,
  hasCronSecret,
  json,
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

type RecipientLoadResult =
  | { recipients: Recipient[]; databaseError: false }
  | { recipients: null; databaseError: true };

function logDatabaseError(context: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  console.error("[end-of-day] " + context, {
    code: typeof details.code === "string" ? details.code : undefined,
    message: typeof details.message === "string"
      ? details.message
      : "Database query failed",
  });
}

async function loadRecipients(
  db: ReturnType<typeof adminClient>,
  venueId: string,
): Promise<RecipientLoadResult> {
  const { data, error } = await db
    .from("venue_notification_recipients")
    .select("id,profile_id,telegram_chat_id,enabled,notify_end_of_day")
    .eq("venue_id", venueId)
    .eq("enabled", true)
    .eq("notify_end_of_day", true)
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
    console.error("[end-of-day] Telegram recipient profile row missing", {
      profileId: missingProfile.profile_id,
    });
    return { recipients: null, databaseError: true };
  }
  const recipients = rows
    .map((row) => ({ ...row, profile: profilesById[row.profile_id] }))
    .filter((row): row is Recipient => !!row.profile?.active);
  return { recipients, databaseError: false };
}

function localTimeParts(timeZone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

async function recordFailure(
  db: ReturnType<typeof adminClient>,
  venue: Record<string, any>,
  workDate: string,
  recipient: Recipient,
  message: string,
) {
  const recipientLabel = recipient.profile.display_name ||
    recipient.profile.email || recipient.profile_id;
  const claim = await claimNotification(db, {
    idempotencyKey: `end-of-day:${venue.id}:${workDate}:${recipient.id}`,
    venueId: venue.id,
    venueName: venue.name,
    workDate,
    listType: null,
    kind: "end-of-day",
    recipientProfileId: recipient.profile_id,
    recipient: recipientLabel,
    subject: `DailyOps · ${venue.name} · end-of-day · ${workDate}`,
    bodyText: message,
  });
  if (claim.shouldSend) await failNotification(db, claim.eventId, message);
}

async function deliverToRecipient(
  db: ReturnType<typeof adminClient>,
  recipient: Recipient,
  input: {
    venue: Record<string, any>;
    workDate: string;
    subject: string;
    bodyText: string;
  },
) {
  const recipientLabel = recipient.profile.display_name ||
    recipient.profile.email || recipient.profile_id;
  const claim = await claimNotification(db, {
    idempotencyKey:
      `end-of-day:${input.venue.id}:${input.workDate}:${recipient.id}`,
    venueId: input.venue.id,
    venueName: input.venue.name,
    workDate: input.workDate,
    listType: null,
    kind: "end-of-day",
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
    console.error("[end-of-day] Telegram delivery failed", {
      venueId: input.venue.id,
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

function eodMessage(
  venue: Record<string, any>,
  workDate: string,
  checklists: Array<Record<string, any>>,
  tasksByChecklist: Record<string, Array<Record<string, any>>>,
  profiles: Record<string, { display_name: string; email: string }>,
) {
  const sections = ["open", "close"].map((listType) => {
    const checklist = checklists.find((row) => row.list_type === listType);
    const tasks = checklist ? (tasksByChecklist[checklist.id] || []) : [];
    const done = tasks.filter((task) => task.status === "done").length;
    const outstanding = tasks.filter((task) => task.status !== "done");
    const critical = outstanding.filter((task) => task.critical);
    const submitted = checklist?.submitted
      ? `Yes${
        checklist.submitted_at
          ? ` · ${formatDateTime(checklist.submitted_at, venue.timezone)}`
          : ""
      }`
      : "No";
    const lines = [
      `${done === tasks.length ? "✅" : "⚠️"} ${
        listLabel(listType as "open" | "close")
      }`,
      `${done} / ${tasks.length} complete`,
      `Submitted: ${submitted}`,
    ];
    if (critical.length) {
      lines.push("Critical incomplete:");
      critical.slice(0, 5).forEach((task) => {
        lines.push(`• ${task.title}${task.reason ? ` — ${task.reason}` : ""}`);
      });
      if (critical.length > 5) {
        lines.push(`• +${critical.length - 5} more critical`);
      }
    }
    const other = outstanding.filter((task) => !task.critical);
    if (other.length) {
      lines.push("Other incomplete:");
      other.slice(0, 5).forEach((task) => {
        lines.push(
          `• ${task.title} — ${statusLabel(task.status)}${
            task.reason ? `: ${task.reason}` : ""
          }`,
        );
      });
      if (other.length > 5) lines.push(`• +${other.length - 5} more`);
    }
    const notes = tasks
      .filter((task) => task.note)
      .slice(0, 3)
      .map((task) => `• ${task.title}: ${task.note}`);
    if (notes.length) lines.push("Notes:", ...notes);
    return {
      lines,
      done,
      total: tasks.length,
      outstanding: outstanding.length,
      critical: critical.length,
    };
  });
  const done = sections.reduce((sum, section) => sum + section.done, 0);
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  const outstanding = sections.reduce(
    (sum, section) => sum + section.outstanding,
    0,
  );
  const subject = `DailyOps · ${venue.name} · end-of-day · ${workDate}`;
  const text = [
    "🌙 DailyOps — End of Day",
    "",
    venue.name,
    formatDate(workDate),
    "",
    `Overall: ${done} / ${total} (${
      total ? Math.round(done / total * 100) : 0
    }%)`,
    "",
    ...sections.flatMap((section) => [...section.lines, ""]),
    `${outstanding} task${outstanding === 1 ? "" : "s"} incomplete.`,
  ].join("\n");
  return { subject, text };
}

async function processVenue(
  db: ReturnType<typeof adminClient>,
  venue: Record<string, any>,
) {
  if (!venue.notify_end_of_day) return { status: "disabled" };

  const recipientResult = await loadRecipients(db, venue.id);
  if (recipientResult.databaseError) {
    return {
      status: "failed",
      error: "Could not load Telegram notification recipients",
      database_error: true,
    };
  }
  const recipients = recipientResult.recipients;
  if (!recipients.length) return { status: "no-recipients" };

  let local;
  try {
    local = localTimeParts(venue.timezone);
  } catch (error) {
    const message = `Invalid venue timezone: ${venue.timezone}`;
    console.error("[end-of-day] invalid timezone", {
      venueId: venue.id,
      error,
    });
    const workDate = new Date().toISOString().slice(0, 10);
    for (const recipient of recipients) {
      await recordFailure(db, venue, workDate, recipient, message);
    }
    return { status: "failed", error: message };
  }

  const [hours, minutes] = String(venue.cutoff_time || "23:30").slice(0, 5)
    .split(":").map(Number);
  if (local.minutes < hours * 60 + minutes) {
    return { status: "not-due", workDate: local.date };
  }

  let checklists: Array<Record<string, any>> | null;
  let tasks: Array<Record<string, any>> | null;
  try {
    const checklistResult = await db
      .from("daily_checklists")
      .select(
        "id,venue_id,work_date,list_type,submitted,submitted_by,submitted_at",
      )
      .eq("venue_id", venue.id)
      .eq("work_date", local.date)
      .in("list_type", ["open", "close"]);
    if (checklistResult.error) throw checklistResult.error;
    checklists = checklistResult.data || [];
    if (!checklists.length) {
      return { status: "no-operation", workDate: local.date };
    }

    const checklistIds = checklists.map((row) => row.id);
    const taskResult = await db
      .from("daily_tasks")
      .select(
        "id,checklist_id,title,status,critical,completed_by,completed_at,note,reason,sort_order",
      )
      .in("checklist_id", checklistIds)
      .order("sort_order")
      .order("id");
    if (taskResult.error) throw taskResult.error;
    tasks = taskResult.data || [];
  } catch (error) {
    const message = "Could not load operation data";
    logDatabaseError("operation load failed for venue " + venue.id, error);
    for (const recipient of recipients) {
      await recordFailure(db, venue, local.date, recipient, message);
    }
    return {
      status: "failed",
      workDate: local.date,
      error: message,
      database_error: true,
    };
  }

  const tasksByChecklist: Record<string, Array<Record<string, any>>> = {};
  (tasks || []).forEach((task) => {
    tasksByChecklist[task.checklist_id] = tasksByChecklist[task.checklist_id] ||
      [];
    tasksByChecklist[task.checklist_id].push(task);
  });
  const profileIds = [
    ...new Set((tasks || []).map((task) => task.completed_by).filter(Boolean)),
  ];
  const profileResult = profileIds.length
    ? await db.from("profiles").select("id,display_name,email").in(
      "id",
      profileIds,
    )
    : { data: [], error: null };
  if (profileResult.error) {
    const message = "Could not load task attribution";
    logDatabaseError(
      "profile load failed for venue " + venue.id,
      profileResult.error,
    );
    for (const recipient of recipients) {
      await recordFailure(db, venue, local.date, recipient, message);
    }
    return {
      status: "failed",
      workDate: local.date,
      error: message,
      database_error: true,
    };
  }
  const profiles = Object.fromEntries(
    (profileResult.data || []).map((profile) => [profile.id, profile]),
  );
  const built = eodMessage(
    venue,
    local.date,
    checklists,
    tasksByChecklist,
    profiles,
  );
  const results = [];
  for (const recipient of recipients) {
    results.push(
      await deliverToRecipient(db, recipient, {
        venue,
        workDate: local.date,
        subject: built.subject,
        bodyText: built.text,
      }),
    );
  }
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.status === "failed").length;
  return {
    status: failed ? "partial-failed" : "sent",
    workDate: local.date,
    sent,
    failed,
    results,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "POST is required" }, 405);
  if (!hasCronSecret(req)) {
    return json({ error: "Valid scheduler credentials are required" }, 401);
  }

  const db = adminClient();
  const { data: venues, error } = await db
    .from("venues")
    .select("id,name,timezone,cutoff_time,notify_end_of_day")
    .order("id");
  if (error) {
    logDatabaseError("venue load failed", error);
    return json({ ok: false, error: "Could not load venues" }, 500);
  }

  const results: Record<string, unknown>[] = [];
  for (const venue of venues || []) {
    try {
      results.push({
        venue_id: venue.id,
        venue: venue.name,
        ...(await processVenue(db, venue)),
      });
    } catch (error) {
      const message = "End-of-day processing failed";
      logDatabaseError("venue processing failed for " + venue.id, error);
      results.push({
        venue_id: venue.id,
        venue: venue.name,
        status: "failed",
        error: message,
      });
    }
  }
  const hasDatabaseFailure = results.some((result) =>
    result.database_error === true
  );
  return json(
    {
      ok: !hasDatabaseFailure,
      processed_at: new Date().toISOString(),
      results,
    },
    hasDatabaseFailure ? 500 : 200,
  );
});
