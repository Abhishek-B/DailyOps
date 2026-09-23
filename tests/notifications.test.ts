import { strict as assert } from "node:assert";
import { adminClient } from "../supabase/functions/_shared/supabase.ts";
import {
  appendEvidenceSummary,
  checklistEvidenceSummary,
  evidenceAppLink,
} from "../supabase/functions/_shared/notifications.ts";
import { handleNotificationRequest } from "../supabase/functions/notify-manager/index.ts";
import { handleEndOfDayRequest } from "../supabase/functions/end-of-day/index.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const environment = {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "public-test-key",
    SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    DAILYOPS_CRON_SECRET: "test-cron-secret",
    DAILYOPS_APP_URL: "https://dailyops.test/DailyOps/",
  };
  const previousEnv = Object.fromEntries(
    Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
  );
  Object.entries(environment).forEach(([key, value]) =>
    Deno.env.set(key, value)
  );
  const date = new Date().toISOString().slice(0, 10);
  const checklist = {
    id: id(3),
    venue_id: id(2),
    work_date: date,
    list_type: "open" as const,
    submitted: true,
    submitted_by: id(1),
    notification_revision: 2,
    submitted_at: date + "T01:00:00Z",
  };
  const state = {
    checklist,
    deny: false,
    authDenied: false,
    failTable: "",
    sendFail: false,
    requests: [] as Request[],
    claims: [] as Record<string, any>[],
    sent: [] as Record<string, any>[],
    events: new Map<
      string,
      { event_id: string; delivery_status: string; should_send: boolean }
    >(),
    rows: {
      daily_checklists: [checklist],
      daily_tasks: [{
        id: id(4),
        checklist_id: checklist.id,
        title: "Kitchen clean",
        status: "done",
        sort_order: 0,
      }],
      venues: [{
        id: id(2),
        name: "Restaurant",
        timezone: "UTC",
        cutoff_time: "00:00",
        notify_complete: true,
        notify_end_of_day: true,
      }],
      profiles: [{
        id: id(1),
        display_name: "Manager",
        email: "manager@example.test",
        active: true,
      }],
      venue_notification_recipients: [{
        id: id(5),
        venue_id: id(2),
        profile_id: id(1),
        telegram_chat_id: "123",
        enabled: true,
        notify_shift_complete: true,
        notify_incomplete_submission: true,
        notify_shift_reopened: true,
        notify_end_of_day: true,
      }],
      task_evidence_submissions: [{
        checklist_id: checklist.id,
        task_id: id(4),
        venue_id: id(2),
        work_date: date,
        notification_revision: 2,
        evidence: [{ id: id(6), expires_at: "2020-01-01T00:00:00Z" }, {
          id: id(7),
        }],
        exemption_id: null,
      }],
      task_evidence: [],
    } as Record<string, Array<Record<string, any>>>,
  };
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    state.requests.push(req.clone());
    const url = new URL(req.url);
    if (url.hostname === "api.telegram.org") {
      assert.equal(url.pathname, "/bottest-bot-token/sendMessage");
      const body = await req.json();
      state.sent.push(body);
      return state.sendFail
        ? response({ ok: false, description: "Retry later" }, 500)
        : response({ ok: true, result: { message_id: 1 } });
    }
    assert.equal(url.hostname, "supabase.test");
    if (url.pathname === "/auth/v1/user") {
      return state.authDenied
        ? response({ message: "Denied" }, 401)
        : response({ id: id(1) });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.split("/").at(-1);
      const body = await req.json();
      if (name === "claim_telegram_notification_event") {
        state.claims.push(body);
        let event = state.events.get(body.p_idempotency_key);
        if (!event) {
          event = {
            event_id: id(100 + state.events.size),
            delivery_status: "pending",
            should_send: true,
          };
          state.events.set(body.p_idempotency_key, event);
        }
        return response([{
          ...event,
          should_send: event.delivery_status !== "sent",
        }]);
      }
      if (
        name === "complete_notification_event" ||
        name === "fail_notification_event"
      ) {
        const event = [...state.events.values()].find((row) =>
          row.event_id === body.p_event_id
        )!;
        event.delivery_status = name === "complete_notification_event"
          ? "sent"
          : "failed";
        return response(true);
      }
      throw new Error("Unexpected RPC " + name);
    }
    const table = url.pathname.split("/").at(-1)!;
    assert.ok(table in state.rows, "Unexpected table " + table);
    if (state.failTable === table) {
      return response(
        { message: "Simulated query failure", code: "XX000" },
        500,
      );
    }
    let rows = state.rows[table];
    if (
      state.deny &&
      req.headers.get("Authorization") === "Bearer user-test-token"
    ) rows = [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.")) {
        rows = rows.filter((row) => String(row[key]) === value.slice(3));
      }
      if (value.startsWith("gt.")) {
        rows = rows.filter((row) => String(row[key]) > value.slice(3));
      }
      if (value.startsWith("in.(")) {
        rows = rows.filter((row) =>
          value.slice(4, -1).split(",").includes(String(row[key]))
        );
      }
    }
    const offset = Number(url.searchParams.get("offset") || 0),
      limit = Number(url.searchParams.get("limit") || 1000);
    rows = rows.slice(offset, offset + limit);
    return response(
      req.headers.get("Accept")?.includes("vnd.pgrst.object")
        ? rows[0] || null
        : rows,
    );
  };
  return {
    ...state,
    state,
    restore() {
      globalThis.fetch = originalFetch;
      Object.entries(previousEnv).forEach(([key, value]) =>
        value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
      );
    },
  };
}

const notify = (kind = "list-complete") =>
  handleNotificationRequest(
    new Request("https://function.test/", {
      method: "POST",
      headers: {
        Authorization: "Bearer user-test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind,
        checklist_id: id(3),
        photo_count: 999,
        app_url: "https://attacker.test/",
      }),
    }),
  );
const eod = () =>
  handleEndOfDayRequest(
    new Request("https://function.test/", {
      method: "POST",
      headers: { "x-dailyops-cron-secret": "test-cron-secret" },
    }),
  );

Deno.test("submission notifications count immutable evidence and exemptions, retain links, and remain idempotent", async () => {
  const f = fixture();
  try {
    f.rows.task_evidence_submissions.push({
      ...f.rows.task_evidence_submissions[0],
      task_id: id(8),
      evidence: [],
      exemption_id: id(9),
    });
    f.rows.task_evidence_submissions.push({
      ...f.rows.task_evidence_submissions[0],
      notification_revision: 1,
      evidence: Array(10).fill({}),
    });
    const first = await notify();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).sent, 1);
    const body = f.sent[0];
    assert.match(
      body.text,
      /At submission: 2 photo\(s\), 1 manager exemption\(s\)/,
    );
    assert.match(body.text, /https:\/\/dailyops.test\/DailyOps\/#evidence\?/);
    assert.match(body.text, /revision=2/);
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.doesNotMatch(body.text, /attacker|999|token|storage\/|2020-01-01/);
    assert.equal(
      f.claims[0].p_idempotency_key,
      `list-complete:${id(3)}:2:${id(5)}`,
    );
    assert.equal(f.claims[0].p_body_text, body.text);
    await notify();
    assert.equal(f.sent.length, 1);
    f.checklist.notification_revision = 3;
    f.rows.task_evidence_submissions.push({
      ...f.rows.task_evidence_submissions[0],
      notification_revision: 3,
    });
    await notify();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].text, /revision=3/);
  } finally {
    f.restore();
  }
});

Deno.test("incomplete long messages preserve evidence links and recipient preference", async () => {
  const f = fixture();
  try {
    f.rows.daily_tasks[0].status = "blocked";
    f.rows.daily_tasks[0].note = "long note ".repeat(1000);
    f.rows.venue_notification_recipients[0].notify_shift_complete = false;
    await notify();
    assert.equal(f.claims[0].p_kind, "list-incomplete");
    assert.ok(f.sent[0].text.length <= 3900);
    assert.match(f.sent[0].text, /message truncated/);
    assert.ok(f.sent[0].text.endsWith("revision=2"));
    f.rows.venue_notification_recipients[0].notify_incomplete_submission =
      false;
    assert.equal((await (await notify()).json()).skipped, "no-recipients");
  } finally {
    f.restore();
  }
});

Deno.test("reopen uses current unexpired ready photos and not a previous submission revision", async () => {
  const f = fixture();
  try {
    Object.assign(f.checklist, {
      submitted: false,
      reopened_by: id(1),
      reopened_at: new Date().toISOString(),
    });
    for (
      const [n, state, expires] of [
        [10, "ready", "2099"],
        [11, "pending", "2099"],
        [12, "ready", "2020"],
        [13, "deleted", "2099"],
      ]
    ) {
      f.rows.task_evidence.push({
        id: id(Number(n)),
        checklist_id: id(3),
        venue_id: id(2),
        work_date: f.checklist.work_date,
        state,
        expires_at: `${expires}-01-01T00:00:00Z`,
      });
    }
    await notify("list-reopened");
    assert.match(f.sent[0].text, /Currently available: 1 photo\(s\)/);
    assert.doesNotMatch(f.sent[0].text, /revision=/);
    assert.equal(
      f.claims[0].p_idempotency_key,
      `list-reopened:${id(3)}:2:${id(5)}`,
    );
  } finally {
    f.restore();
  }
});

Deno.test("end-of-day distinguishes submitted snapshots from current photos and preserves both links", async () => {
  const f = fixture();
  try {
    f.rows.daily_checklists.push({
      ...f.checklist,
      id: id(20),
      list_type: "close",
      submitted: false,
    });
    f.rows.daily_tasks.push({
      id: id(21),
      checklist_id: id(20),
      title: "Long task ".repeat(900),
      status: "blocked",
    });
    f.rows.task_evidence.push({
      id: id(22),
      checklist_id: id(20),
      venue_id: id(2),
      work_date: f.checklist.work_date,
      state: "ready",
      expires_at: "2099-01-01T00:00:00Z",
    });
    const result = await eod();
    assert.equal(result.status, 200);
    assert.match(f.sent[0].text, /Opening Shift evidence\nAt submission: 2/);
    assert.match(
      f.sent[0].text,
      /Closing Shift evidence\nCurrently available: 1/,
    );
    assert.equal((f.sent[0].text.match(/#evidence\?/g) || []).length, 2);
    assert.ok(f.sent[0].text.length <= 3900);
    await eod();
    assert.equal(f.sent.length, 1);
  } finally {
    f.restore();
  }
});

Deno.test("authentication and caller venue RLS precede privileged evidence reads", async () => {
  const f = fixture();
  try {
    f.state.authDenied = true;
    assert.equal((await notify()).status, 401);
    f.state.authDenied = false;
    f.state.deny = true;
    assert.equal((await notify()).status, 403);
    assert.equal(f.sent.length, 0);
    assert.equal(f.claims.length, 0);
    assert.ok(!f.requests.some((req) => req.url.includes("task_evidence")));
  } finally {
    f.restore();
  }
});

Deno.test("evidence query failures never send false zero counts; end-of-day records retryable failure", async () => {
  const f = fixture();
  try {
    f.state.failTable = "task_evidence_submissions";
    assert.equal((await notify()).status, 500);
    assert.equal(f.claims.length, 0);
    assert.equal((await eod()).status, 500);
    assert.equal(f.sent.length, 0);
    assert.equal([...f.events.values()][0].delivery_status, "failed");
    f.state.failTable = "";
    await eod();
    assert.equal(f.sent.length, 1);
  } finally {
    f.restore();
  }
});

Deno.test("photo summaries paginate and legacy submissions do not claim a zero-photo audit", async () => {
  const f = fixture();
  try {
    f.rows.task_evidence_submissions = Array.from(
      { length: 1001 },
      (_, n) => ({
        ...f.rows.task_evidence_submissions[0],
        task_id: id(1000 + n),
        evidence: [{ id: id(3000 + n) }],
      }),
    );
    assert.match(
      await checklistEvidenceSummary(adminClient(), f.checklist),
      /At submission: 1001 photo/,
    );
    f.rows.task_evidence_submissions = [];
    assert.match(
      await checklistEvidenceSummary(adminClient(), f.checklist),
      /was not recorded/,
    );
    assert.doesNotMatch(
      await checklistEvidenceSummary(adminClient(), f.checklist),
      /At submission: 0/,
    );
  } finally {
    f.restore();
  }
});

Deno.test("app links require a trusted configured HTTPS page URL, never request-controlled redirects", async () => {
  const f = fixture();
  try {
    for (
      const value of [
        "",
        "http://dailyops.test/",
        "javascript:alert(1)",
        "https://user:pass@dailyops.test/",
        "https://dailyops.test/?token=x",
        "https://dailyops.test/#x",
      ]
    ) {
      Deno.env.set("DAILYOPS_APP_URL", value);
      assert.throws(() => evidenceAppLink(f.checklist), /DAILYOPS_APP_URL/);
    }
    assert.equal((await notify()).status, 500);
    assert.equal(f.sent.length, 0);
    Deno.env.set("DAILYOPS_APP_URL", "https://dailyops.test/site/index.html");
    assert.ok(
      evidenceAppLink(f.checklist).startsWith(
        "https://dailyops.test/site/index.html#evidence?",
      ),
    );
    const summary = "Safe footer";
    assert.ok(
      appendEvidenceSummary("text".repeat(2000), [summary]).endsWith(summary),
    );
  } finally {
    f.restore();
  }
});

Deno.test("Telegram failure remains retryable with the same existing event key", async () => {
  const f = fixture();
  try {
    f.state.sendFail = true;
    await notify();
    assert.equal([...f.events.values()][0].delivery_status, "failed");
    f.state.sendFail = false;
    await notify();
    assert.equal(f.events.size, 1);
    assert.equal([...f.events.values()][0].delivery_status, "sent");
  } finally {
    f.restore();
  }
});
