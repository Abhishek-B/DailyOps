import type { AdminDb } from "./supabase.ts";

export type EvidenceChecklist = {
  id: string;
  venue_id: string;
  work_date: string;
  list_type: "open" | "close";
  submitted: boolean;
  notification_revision: number;
};

export function evidenceAppLink(checklist: EvidenceChecklist) {
  const configured = Deno.env.get("DAILYOPS_APP_URL") || "";
  let url: URL;
  try {
    url = new URL(configured);
  } catch (_) {
    throw new Error("DAILYOPS_APP_URL must be the HTTPS DailyOps page URL");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.href.length > 500
  ) {
    throw new Error(
      "DAILYOPS_APP_URL must be an HTTPS page URL without credentials, query or fragment",
    );
  }
  const params = new URLSearchParams({
    venue: checklist.venue_id,
    date: checklist.work_date,
    shift: checklist.list_type,
    checklist: checklist.id,
  });
  if (checklist.submitted) {
    params.set("revision", String(checklist.notification_revision || 0));
  }
  url.hash = "evidence?" + params;
  return url.href;
}

export async function checklistEvidenceSummary(
  db: AdminDb,
  checklist: EvidenceChecklist,
) {
  const link = evidenceAppLink(checklist);
  let photos = 0, exemptions = 0, records = 0;
  const now = new Date().toISOString();
  for (let offset = 0;; offset += 500) {
    let query = checklist.submitted
      ? db.from("task_evidence_submissions").select(
        "task_id,evidence,exemption_id",
      )
        .eq("notification_revision", checklist.notification_revision || 0)
        .order("task_id")
      : db.from("task_evidence").select("id").eq("state", "ready").gt(
        "expires_at",
        now,
      ).order("id");
    query = query.eq("checklist_id", checklist.id).eq(
      "venue_id",
      checklist.venue_id,
    )
      .eq("work_date", checklist.work_date).range(offset, offset + 499);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    records += rows.length;
    for (const row of rows) {
      photos += "evidence" in row
        ? (Array.isArray(row.evidence) ? row.evidence.length : 0)
        : 1;
      if ("exemption_id" in row && row.exemption_id) exemptions++;
    }
    if (rows.length < 500) break;
  }
  const summary = checklist.submitted
    ? records
      ? `At submission: ${photos} photo(s), ${exemptions} manager exemption(s).`
      : "Photo evidence was not recorded for this submission."
    : `Currently available: ${photos} photo(s). Shift not submitted.`;
  return `${
    listLabel(checklist.list_type)
  } evidence\n${summary}\nView in DailyOps (sign-in required):\n${link}`;
}

export function appendEvidenceSummary(text: string, summaries: string[]) {
  const footer = "\n\n" + summaries.join("\n\n");
  const budget = 3900 - footer.length;
  const body = text.length > budget
    ? text.slice(0, budget - 22) + "\n… message truncated"
    : text;
  return body + footer;
}

export type NotificationClaim = {
  idempotencyKey: string;
  venueId: string | null;
  venueName: string | null;
  workDate: string | null;
  listType: "open" | "close" | null;
  kind:
    | "list-complete"
    | "list-incomplete"
    | "list-reopened"
    | "shift-cover"
    | "end-of-day"
    | "test";
  recipientProfileId: string | null;
  recipient: string | null;
  subject: string;
  bodyText: string;
};

export async function claimNotification(db: AdminDb, input: NotificationClaim) {
  const { data, error } = await db.rpc("claim_telegram_notification_event", {
    p_idempotency_key: input.idempotencyKey,
    p_venue_id: input.venueId,
    p_venue_name: input.venueName,
    p_work_date: input.workDate,
    p_list_type: input.listType,
    p_kind: input.kind,
    p_recipient_profile_id: input.recipientProfileId,
    p_recipient: input.recipient,
    p_subject: input.subject,
    p_body_text: input.bodyText,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.event_id) {
    throw new Error("Notification event claim returned no event");
  }
  return {
    eventId: row.event_id as string,
    shouldSend: row.should_send === true,
    deliveryStatus: String(row.delivery_status || "pending"),
  };
}

export async function completeNotification(
  db: AdminDb,
  eventId: string,
  providerMessageId: string | null,
) {
  const { data, error } = await db.rpc("complete_notification_event", {
    p_event_id: eventId,
    p_provider_message_id: providerMessageId,
  });
  if (error) throw error;
  if (data !== true) {
    throw new Error("Notification event could not be marked sent");
  }
}

export async function failNotification(
  db: AdminDb,
  eventId: string,
  message: string,
) {
  const { error } = await db.rpc("fail_notification_event", {
    p_event_id: eventId,
    p_error_message: message.slice(0, 2000),
  });
  if (error) throw error;
}

export async function sendTelegramMessage(input: {
  chatId: string;
  text: string;
}) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) throw new Error("Telegram is not configured");
  const text = input.text.length > 3900
    ? `${input.text.slice(0, 3880)}\n… message truncated`
    : input.text;
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        text,
        link_preview_options: { is_disabled: true },
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    const detail = typeof payload?.description === "string"
      ? payload.description
      : typeof payload?.message === "string"
      ? payload.message
      : `Telegram returned HTTP ${response.status}`;
    const safeDetail = String(detail).replaceAll(botToken, "[redacted]");
    throw new Error(`Telegram delivery failed: ${safeDetail}`);
  }
  const messageId = payload?.result?.message_id;
  return messageId === undefined || messageId === null
    ? null
    : String(messageId);
}

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function formatDateTime(value: string | null, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

export function statusLabel(status: string) {
  return ({
    pending: "Pending",
    done: "Done",
    blocked: "Blocked",
    na: "Not applicable",
    skipped: "Ran out of time",
  } as Record<string, string>)[status] || status;
}

export function listLabel(listType: "open" | "close") {
  return listType === "open" ? "Opening Shift" : "Closing Shift";
}
