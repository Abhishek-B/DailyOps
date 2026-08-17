import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-dailyops-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function firstKeyFromJson(name: string) {
  const raw = Deno.env.get(name);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const values = Object.values(parsed).filter((value) =>
        typeof value === "string"
      );
      return String(values[0] || "");
    }
  } catch (_) {
    return "";
  }
  return "";
}

export function projectUrl() {
  const value = Deno.env.get("SUPABASE_URL");
  if (!value) throw new Error("SUPABASE_URL is not configured");
  return value;
}

export function publishableKey() {
  const value = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    firstKeyFromJson("SUPABASE_PUBLISHABLE_KEYS");
  if (!value) throw new Error("A Supabase publishable key is not configured");
  return value;
}

export function serviceRoleKey() {
  const value = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    firstKeyFromJson("SUPABASE_SECRET_KEYS");
  if (!value) {
    throw new Error("A Supabase service key is not available to the function");
  }
  return value;
}

export function adminClient() {
  return createClient(projectUrl(), serviceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function userClient(accessToken: string) {
  return createClient(projectUrl(), publishableKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function requireUser(req: Request) {
  const header = req.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  const client = userClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { client, userId: data.user.id };
}

export function hasCronSecret(req: Request) {
  const configured = Deno.env.get("DAILYOPS_CRON_SECRET");
  return !!configured &&
    req.headers.get("x-dailyops-cron-secret") === configured;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

export type AdminDb = SupabaseClient;
