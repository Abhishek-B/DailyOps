import { createEvidenceCleanupHandler } from "../_shared/task-evidence.ts";

Deno.serve(createEvidenceCleanupHandler());
