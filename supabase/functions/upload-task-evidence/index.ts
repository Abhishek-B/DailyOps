import { createEvidenceUploadHandler } from "../_shared/task-evidence.ts";
import { normalizePhoto } from "../_shared/photo.ts";

Deno.serve(createEvidenceUploadHandler(normalizePhoto));
