import {
  adminClient,
  corsHeaders,
  hasCronSecret,
  json,
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
  statusLabel,
} from "../_shared/notifications.ts";

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

function eodEmail(
  venue: any,
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
    const rows = tasks.map((task) => {
      const completedBy = profiles[task.completed_by]?.display_name ||
        profiles[task.completed_by]?.email || "—";
      const detail = task.status === "done"
        ? `completed by ${completedBy} at ${
          formatDateTime(task.completed_at, venue.timezone)
        }`
        : `${statusLabel(task.status)}${
          task.reason ? ` — ${task.reason}` : ""
        }`;
      return `<li><b>${escapeHtml(task.title)}</b> — ${escapeHtml(detail)}${
        task.note ? `<br><span>Note: ${escapeHtml(task.note)}</span>` : ""
      }</li>`;
    }).join("");
    const submitted = checklist?.submitted
      ? `Submitted at ${formatDateTime(checklist.submitted_at, venue.timezone)}`
      : "Not submitted";
    return {
      label: listLabel(listType as "open" | "close"),
      done,
      total: tasks.length,
      outstanding: outstanding.length,
      critical: critical.length,
      submitted,
      html: `<h3>${
        escapeHtml(listLabel(listType as "open" | "close"))
      } · ${done}/${tasks.length}</h3><p>${
        escapeHtml(submitted)
      } · ${outstanding.length} outstanding${
        critical.length ? ` · ${critical.length} critical` : ""
      }</p><ul>${rows || "<li>No tasks recorded.</li>"}</ul>`,
      text: `${
        listLabel(listType as "open" | "close")
      }: ${done}/${tasks.length} done; ${submitted}; ${outstanding.length} outstanding${
        critical.length ? `; ${critical.length} critical` : ""
      }.\n${
        tasks.map((task) => {
          const completedBy = profiles[task.completed_by]?.display_name ||
            profiles[task.completed_by]?.email || "—";
          const detail = task.status === "done"
            ? `completed by ${completedBy} at ${
              formatDateTime(task.completed_at, venue.timezone)
            }`
            : `${statusLabel(task.status)}${
              task.reason ? ` — ${task.reason}` : ""
            }`;
          return `- ${task.title}: ${detail}${
            task.note ? `; Note: ${task.note}` : ""
          }`;
        }).join("\n")
      }`,
    };
  });
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  const done = sections.reduce((sum, section) => sum + section.done, 0);
  const outstanding = sections.reduce(
    (sum, section) => sum + section.outstanding,
    0,
  );
  const critical = sections.reduce((sum, section) => sum + section.critical, 0);
  const subject =
    `DailyOps · ${venue.name} · end-of-day · ${workDate} (${done}/${total} done)`;
  const text = `${venue.name} end-of-day summary for ${
    formatDate(workDate)
  }\n\n${done} of ${total} tasks completed; ${outstanding} outstanding${
    critical ? `; ${critical} critical` : ""
  }.\n\n${sections.map((section) => section.text).join("\n\n")}`;
  const html = `<h2>End-of-day summary</h2><p>${escapeHtml(venue.name)} · ${
    escapeHtml(formatDate(workDate))
  }</p><p><b>${done} of ${total}</b> tasks completed; ${outstanding} outstanding${
    critical ? `; ${critical} critical` : ""
  }.</p>${sections.map((section) => section.html).join("")}`;
  return { subject, text, html };
}

async function recordFailure(
  db: ReturnType<typeof adminClient>,
  venue: any,
  workDate: string,
  message: string,
) {
  const claim = await claimNotification(db, {
    idempotencyKey: `end-of-day:${venue.id}:${workDate}`,
    venueId: venue.id,
    venueName: venue.name,
    workDate,
    listType: null,
    kind: "end-of-day",
    recipient: venue.manager_email || null,
    subject: `DailyOps · ${venue.name} · end-of-day · ${workDate}`,
    bodyText: message,
  });
  if (claim.shouldSend) await failNotification(db, claim.eventId, message);
}

async function processVenue(
  db: ReturnType<typeof adminClient>,
  venue: Record<string, any>,
) {
  if (!venue.notify_end_of_day || !venue.email_enabled) {
    return { status: "disabled" };
  }
  let local;
  try {
    local = localTimeParts(venue.timezone);
  } catch (error) {
    const message = `Invalid venue timezone: ${venue.timezone}`;
    console.error("[end-of-day] invalid timezone", {
      venueId: venue.id,
      error,
    });
    await recordFailure(
      db,
      venue,
      new Date().toISOString().slice(0, 10),
      message,
    );
    return { status: "failed", error: message };
  }
  const [hours, minutes] = String(venue.cutoff_time || "23:30").slice(0, 5)
    .split(":").map(Number);
  if (local.minutes < hours * 60 + minutes) {
    return { status: "not-due", workDate: local.date };
  }

  const { data: checklists, error: checklistError } = await db
    .from("daily_checklists")
    .select(
      "id,venue_id,work_date,list_type,submitted,submitted_by,submitted_at",
    )
    .eq("venue_id", venue.id)
    .eq("work_date", local.date)
    .in("list_type", ["open", "close"]);
  if (checklistError) throw checklistError;
  if (!checklists?.length) {
    return { status: "no-operation", workDate: local.date };
  }

  const checklistIds = checklists.map((row) => row.id);
  const { data: tasks, error: taskError } = await db
    .from("daily_tasks")
    .select(
      "id,checklist_id,title,status,critical,completed_by,completed_at,note,reason,sort_order",
    )
    .in("checklist_id", checklistIds)
    .order("sort_order")
    .order("id");
  if (taskError) throw taskError;
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
  if (profileResult.error) throw profileResult.error;
  const profiles = Object.fromEntries(
    (profileResult.data || []).map((profile) => [profile.id, profile]),
  );
  const built = eodEmail(
    venue,
    local.date,
    checklists,
    tasksByChecklist,
    profiles,
  );
  const claim = await claimNotification(db, {
    idempotencyKey: `end-of-day:${venue.id}:${local.date}`,
    venueId: venue.id,
    venueName: venue.name,
    workDate: local.date,
    listType: null,
    kind: "end-of-day",
    recipient: venue.manager_email || null,
    subject: built.subject,
    bodyText: built.text,
  });
  if (!claim.shouldSend) {
    return {
      status: claim.deliveryStatus,
      workDate: local.date,
      eventId: claim.eventId,
    };
  }
  if (!venue.manager_email) {
    const message = "No manager_email is configured for this venue.";
    await failNotification(db, claim.eventId, message);
    return {
      status: "failed",
      workDate: local.date,
      eventId: claim.eventId,
      error: message,
    };
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
    return { status: "sent", workDate: local.date, eventId: claim.eventId };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Email provider request failed";
    console.error("[end-of-day] email delivery failed", {
      venueId: venue.id,
      eventId: claim.eventId,
      message,
    });
    await failNotification(db, claim.eventId, message);
    return {
      status: "failed",
      workDate: local.date,
      eventId: claim.eventId,
      error: message,
    };
  }
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
    .select(
      "id,name,timezone,cutoff_time,notify_end_of_day,email_enabled,manager_email",
    )
    .order("id");
  if (error) {
    console.error("[end-of-day] venue load failed", error);
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
      const message = error instanceof Error
        ? error.message
        : "End-of-day processing failed";
      console.error("[end-of-day] venue processing failed", {
        venueId: venue.id,
        message,
      });
      try {
        const workDate = new Date().toISOString().slice(0, 10);
        await recordFailure(db, venue, workDate, message);
      } catch (auditError) {
        console.error("[end-of-day] failure audit failed", {
          venueId: venue.id,
          auditError,
        });
      }
      results.push({
        venue_id: venue.id,
        venue: venue.name,
        status: "failed",
        error: message,
      });
    }
  }
  return json({ ok: true, processed_at: new Date().toISOString(), results });
});
