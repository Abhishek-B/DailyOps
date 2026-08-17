import type { AdminDb } from "./supabase.ts";

export type NotificationClaim = {
  idempotencyKey: string;
  venueId: string | null;
  venueName: string | null;
  workDate: string | null;
  listType: "open" | "close" | null;
  kind: "list-complete" | "end-of-day";
  recipient: string | null;
  subject: string;
  bodyText: string;
};

export async function claimNotification(db: AdminDb, input: NotificationClaim) {
  const { data, error } = await db.rpc("claim_notification_event", {
    p_idempotency_key: input.idempotencyKey,
    p_venue_id: input.venueId,
    p_venue_name: input.venueName,
    p_work_date: input.workDate,
    p_list_type: input.listType,
    p_kind: input.kind,
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

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  if (!apiKey || !fromEmail) throw new Error("Resend is not configured");
  const fromName = Deno.env.get("RESEND_FROM_NAME");
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.message === "string"
      ? payload.message
      : `provider returned HTTP ${response.status}`;
    throw new Error(`Resend delivery failed: ${detail}`);
  }
  return typeof payload?.id === "string" ? payload.id : null;
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
