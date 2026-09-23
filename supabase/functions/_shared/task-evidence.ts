import {
  adminClient,
  corsHeaders,
  hasCronSecret,
  isUuid,
  json,
  requireUser,
} from "./supabase.ts";

export const EVIDENCE_BUCKET = "task-evidence";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export class PhotoError extends Error {}

export async function photoDigest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(
    new Uint8Array(hash),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

export async function configureEvidenceBucket(
  db: ReturnType<typeof adminClient>,
) {
  const existing = await db.storage.getBucket(EVIDENCE_BUCKET);
  const options = {
    public: false,
    fileSizeLimit: MAX_PHOTO_BYTES,
    allowedMimeTypes: ["image/jpeg"],
  };
  if (existing.error) {
    if (String(existing.error.statusCode) !== "404") {
      throw new Error("Could not inspect the evidence bucket.");
    }
    const created = await db.storage.createBucket(EVIDENCE_BUCKET, options);
    if (created.error) {
      throw new Error("Could not create the private evidence bucket.");
    }
    return "created";
  }
  if (existing.data.public) {
    throw new Error(
      "Refusing to use a public evidence bucket. Make it private before continuing.",
    );
  }
  if (
    existing.data.file_size_limit === MAX_PHOTO_BYTES &&
    existing.data.allowed_mime_types?.join(",") === "image/jpeg"
  ) return "unchanged";
  const updated = await db.storage.updateBucket(EVIDENCE_BUCKET, options);
  if (updated.error) throw new Error("Could not restrict the evidence bucket.");
  return "updated";
}

async function privateEvidenceBucket(db: ReturnType<typeof adminClient>) {
  const { data, error } = await db.storage.getBucket(EVIDENCE_BUCKET);
  if (
    error || !data || data.public || data.file_size_limit !== MAX_PHOTO_BYTES ||
    data.allowed_mime_types?.join(",") !== "image/jpeg"
  ) {
    throw new Error("Evidence bucket is not configured safely.");
  }
}

async function readPhotoBytes(req: Request) {
  if (!req.body) throw new PhotoError("A photo is required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PHOTO_BYTES) {
        await reader.cancel();
        throw new PhotoError("The photo exceeds 5 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function failure(error: string, code: string, status: number) {
  return json({ ok: false, error, code }, status);
}

export function createEvidenceUploadHandler(
  normalize: (
    bytes: Uint8Array,
  ) => Promise<{ bytes: Uint8Array; sha256: string; mimeType: string }>,
  dependencies = { requireUser, adminClient },
) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return failure("POST is required.", "method_not_allowed", 405);
    }
    try {
      const caller = await dependencies.requireUser(req);
      if (!caller) {
        return failure(
          "Sign in to upload evidence.",
          "authentication_required",
          401,
        );
      }
      const url = new URL(req.url);
      const taskId = url.searchParams.get("task_id");
      const evidenceId = url.searchParams.get("evidence_id");
      if (!isUuid(taskId) || !isUuid(evidenceId)) {
        return failure(
          "Valid task_id and evidence_id are required.",
          "invalid_ids",
          400,
        );
      }
      const contentType = (req.headers.get("content-type") || "").split(";")[0]
        .trim().toLowerCase();
      if (
        !["image/jpeg", "image/png", "image/webp", "application/octet-stream"]
          .includes(contentType)
      ) {
        return failure(
          "Send JPEG, PNG or WebP image bytes as the request body.",
          "unsupported_type",
          415,
        );
      }
      const length = req.headers.get("content-length");
      if (
        length !== null &&
        (!Number.isInteger(Number(length)) || Number(length) < 1 ||
          Number(length) > MAX_PHOTO_BYTES)
      ) {
        return failure(
          "The photo must be between 1 byte and 5 MiB.",
          "invalid_size",
          413,
        );
      }
      const reserved = await caller.client.rpc("reserve_task_evidence", {
        p_task_id: taskId,
        p_evidence_id: evidenceId,
      });
      if (reserved.error || !reserved.data) {
        return failure(
          "Could not reserve this photo. Check venue access, the three-photo limit and whether the shift is open.",
          "reservation_unavailable",
          409,
        );
      }
      const evidence = Array.isArray(reserved.data)
        ? reserved.data[0]
        : reserved.data;
      const db = dependencies.adminClient();
      await privateEvidenceBucket(db);
      if (
        evidence.state === "ready" &&
        Date.parse(evidence.expires_at) > Date.now()
      ) {
        const present = await db.storage.from(EVIDENCE_BUCKET).exists(
          evidence.object_path,
        );
        if (present.error || !present.data) {
          return failure(
            "The saved photo is unavailable. Refresh the shift before replacing it.",
            "evidence_unavailable",
            409,
          );
        }
        return json({ ok: true, evidence, reused: true });
      }
      if (
        evidence.state !== "pending" ||
        Date.parse(evidence.upload_deadline) <= Date.now()
      ) {
        return failure(
          "This reservation has ended. Choose a new evidence ID.",
          "reservation_expired",
          409,
        );
      }
      let photo;
      try {
        photo = await normalize(await readPhotoBytes(req));
      } catch (error) {
        if (!(error instanceof PhotoError)) throw error;
        const rejected = await db.rpc("reject_task_evidence_upload", {
          p_evidence_id: evidenceId,
          p_uploaded_by: caller.userId,
        });
        if (rejected.error) {
          console.error(
            "[photo-evidence] rejected reservation cleanup failed",
            { evidenceId },
          );
        }
        return failure(error.message, "invalid_photo", 422);
      }
      // Use the caller's JWT so Storage also rechecks the live reservation.
      const stored = await caller.client.storage.from(EVIDENCE_BUCKET).upload(
        evidence.object_path,
        photo.bytes,
        {
          contentType: photo.mimeType,
          cacheControl: "0",
          upsert: false,
        },
      );
      if (stored.error) {
        const duplicate = String(stored.error.statusCode) === "409" ||
          /already exists|duplicate/i.test(stored.error.message);
        if (!duplicate) {
          return failure(
            "Upload was not confirmed. Retry with the same photo and evidence ID.",
            "upload_unconfirmed",
            503,
          );
        }
        const existing = await db.storage.from(EVIDENCE_BUCKET).download(
          evidence.object_path,
        );
        if (existing.error || !existing.data) {
          return failure(
            "Could not verify the earlier upload. Retry shortly.",
            "upload_unconfirmed",
            503,
          );
        }
        if (
          existing.data.size > MAX_PHOTO_BYTES ||
          await photoDigest(
              new Uint8Array(await existing.data.arrayBuffer()),
            ) !== photo.sha256
        ) {
          return failure(
            "This evidence ID already contains a different photo. Use a new ID.",
            "evidence_conflict",
            409,
          );
        }
      }
      const finalized = await db.rpc("finalize_task_evidence", {
        p_evidence_id: evidenceId,
        p_uploaded_by: caller.userId,
        p_byte_size: photo.bytes.length,
        p_mime_type: photo.mimeType,
        p_sha256: photo.sha256,
      });
      if (finalized.error || !finalized.data) {
        return failure(
          "The photo was stored but not confirmed as evidence. Refresh the shift, then retry if it is still open.",
          "finalization_unconfirmed",
          409,
        );
      }
      return json({
        ok: true,
        evidence: Array.isArray(finalized.data)
          ? finalized.data[0]
          : finalized.data,
        reused: false,
      });
    } catch (_) {
      console.error(
        "[photo-evidence] upload failed; no completion was confirmed",
      );
      return failure(
        "Photo upload is temporarily unavailable. Retry with the same evidence ID.",
        "upload_unavailable",
        503,
      );
    }
  };
}

export function createEvidenceCleanupHandler(
  dependencies = { hasCronSecret, adminClient },
) {
  return async (req: Request) => {
    if (req.method !== "POST") {
      return failure("POST is required.", "method_not_allowed", 405);
    }
    if (!dependencies.hasCronSecret(req)) {
      return failure(
        "Valid scheduler credentials are required.",
        "authentication_required",
        401,
      );
    }
    const started = Date.now();
    try {
      const db = dependencies.adminClient();
      const expired = await db.rpc("queue_expired_task_evidence", {
        p_limit: 500,
      });
      const late = await db.rpc("requeue_late_task_evidence_objects", {
        p_limit: 100,
      });
      if (expired.error || late.error) {
        throw new Error("Could not queue expired evidence.");
      }
      const queued = await db.from("task_evidence").select("id,object_path")
        .eq("state", "delete_pending").lte(
          "cleanup_next_attempt_at",
          new Date().toISOString(),
        )
        .order("cleanup_next_attempt_at").order("id").limit(50);
      if (queued.error) throw new Error("Could not load cleanup queue.");
      let confirmed = 0;
      let failed = 0;
      let attempted = 0;
      for (const evidence of queued.data || []) {
        if (Date.now() - started > 50_000) break;
        attempted++;
        let errorCode = "storage_remove_failed";
        try {
          const removed = await db.storage.from(EVIDENCE_BUCKET).remove([
            evidence.object_path,
          ]);
          if (removed.error) throw new Error(errorCode);
          errorCode = "deletion_confirmation_failed";
          const result = await db.rpc("confirm_task_evidence_deleted", {
            p_evidence_id: evidence.id,
          });
          if (result.error) throw new Error(errorCode);
          confirmed++;
        } catch (_) {
          failed++;
          const result = await db.rpc("record_task_evidence_cleanup_failure", {
            p_evidence_id: evidence.id,
            p_error: errorCode,
          });
          if (result.error) {
            console.error("[photo-evidence] could not record cleanup failure", {
              evidenceId: evidence.id,
            });
          }
        }
      }
      const result = {
        ok: failed === 0,
        expired: expired.data,
        late: late.data,
        attempted,
        confirmed,
        failed,
        deferred: (queued.data?.length || 0) - attempted,
        batch_full: queued.data?.length === 50,
      };
      console.info("[photo-evidence] cleanup", result);
      return json(result, failed ? 503 : 200);
    } catch (_) {
      console.error(
        "[photo-evidence] cleanup failed; queued objects retained for retry",
      );
      return failure(
        "Evidence cleanup failed. Check function logs and retry.",
        "cleanup_failed",
        503,
      );
    }
  };
}
