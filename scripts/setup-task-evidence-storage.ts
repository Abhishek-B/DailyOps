import { adminClient } from "../supabase/functions/_shared/supabase.ts";
import { configureEvidenceBucket } from "../supabase/functions/_shared/task-evidence.ts";

if (import.meta.main) {
  if (!Deno.args.includes("--apply")) {
    console.log(
      "No changes made. Set SUPABASE_URL and a server-only service key, then pass --apply to provision the private task-evidence bucket.",
    );
  } else {
    console.log(
      `task-evidence: ${await configureEvidenceBucket(adminClient())}`,
    );
  }
}
