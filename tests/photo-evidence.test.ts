import { strict as assert } from "node:assert";
import { createClient } from "npm:@supabase/supabase-js@2";
// @deno-types="../supabase/functions/_shared/photo-decoder/index.d.ts"
import {
  ImageMagick,
  MagickColors,
  MagickFormat,
  MagickImage,
  Orientation,
} from "../supabase/functions/_shared/photo-decoder/index.js";
import {
  initializePhotoDecoder,
  normalizePhoto,
} from "../supabase/functions/_shared/photo.ts";
import {
  configureEvidenceBucket,
  createEvidenceCleanupHandler,
  createEvidenceUploadHandler,
  MAX_PHOTO_BYTES,
  photoDigest,
  PhotoError,
} from "../supabase/functions/_shared/task-evidence.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytesOf = (text: string) => new TextEncoder().encode(text);

async function fixtureImage(
  format: MagickFormat = MagickFormat.Png,
  width = 100,
  height = 50,
  metadata = false,
) {
  await initializePhotoDecoder();
  const image = MagickImage.create(MagickColors.Red, width, height);
  try {
    if (metadata) {
      image.setAttribute("comment", "private kitchen GPS note");
      image.setProfile(
        "xmp",
        bytesOf(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/">private GPS location</x:xmpmeta>',
        ),
      );
    }
    return image.write(format, (data) => Uint8Array.from(data));
  } finally {
    image.dispose();
  }
}

Deno.test("JPEG, PNG and WebP decode to metadata-free JPEGs with stable digests", async () => {
  for (
    const format of [MagickFormat.Jpeg, MagickFormat.Png, MagickFormat.WebP]
  ) {
    const input = await fixtureImage(format, 100, 50, true);
    const first = await normalizePhoto(input);
    const retry = await normalizePhoto(input);
    assert.equal(first.mimeType, "image/jpeg");
    assert.equal(first.sha256, await photoDigest(first.bytes));
    assert.equal(first.sha256, retry.sha256);
    assert.deepEqual([...first.bytes.subarray(0, 2)], [255, 216]);
    ImageMagick.read(first.bytes, (image) => {
      assert.equal(image.width, 100);
      assert.equal(image.height, 50);
      assert.equal(image.profileNames.length, 0);
      assert.equal(image.attributeNames.includes("comment"), false);
    });
    assert.equal(
      new TextDecoder().decode(first.bytes).includes("private GPS"),
      false,
    );
  }
});

Deno.test("photo resizing preserves aspect ratio and handles EXIF orientation before stripping", async () => {
  const large = await normalizePhoto(
    await fixtureImage(MagickFormat.Jpeg, 2000, 1000),
  );
  ImageMagick.read(
    large.bytes,
    (image) => assert.deepEqual([image.width, image.height], [1600, 800]),
  );
  const image = MagickImage.create(MagickColors.Red, 100, 50);
  let bytes;
  try {
    // Little-endian EXIF IFD containing Orientation=6 (rotate 90 degrees).
    image.setProfile(
      "exif",
      new Uint8Array([
        69,
        120,
        105,
        102,
        0,
        0,
        73,
        73,
        42,
        0,
        8,
        0,
        0,
        0,
        1,
        0,
        18,
        1,
        3,
        0,
        1,
        0,
        0,
        0,
        6,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]),
    );
    image.orientation = Orientation.RightTop;
    bytes = image.write(MagickFormat.Jpeg, (data) => Uint8Array.from(data));
  } finally {
    image.dispose();
  }
  const rotated = await normalizePhoto(bytes);
  ImageMagick.read(rotated.bytes, (photo) => {
    assert.deepEqual([photo.width, photo.height], [50, 100]);
    assert.equal(photo.profileNames.length, 0);
  });
});

Deno.test("invalid formats, damaged files, animation and excessive dimensions fail closed", async () => {
  for (
    const bytes of [
      new Uint8Array(),
      bytesOf("<svg><script/></svg>"),
      bytesOf("%PDF-not-a-photo"),
      bytesOf("GIF89a"),
      new Uint8Array([255, 216, 255, 0, 0]),
      new Uint8Array(MAX_PHOTO_BYTES + 1),
    ]
  ) {
    await assert.rejects(normalizePhoto(bytes), PhotoError);
  }
  const huge = await fixtureImage(MagickFormat.Jpeg, 2100, 2000);
  await assert.rejects(normalizePhoto(huge), /4 megapixels/);
  const png = await fixtureImage();
  const animated = new Uint8Array(png.length + 12);
  animated.set(png.subarray(0, 8));
  animated.set(bytesOf("acTL"), 12);
  animated.set(png.subarray(8), 20);
  await assert.rejects(normalizePhoto(animated), /Animated/);
  const animatedWebp = new Uint8Array(32);
  animatedWebp.set(bytesOf("RIFF"));
  animatedWebp.set(bytesOf("WEBPVP8X"), 8);
  animatedWebp[16] = 10;
  animatedWebp[20] = 2;
  await assert.rejects(normalizePhoto(animatedWebp), /Animated/);
});

function backend() {
  const evidence = {
    id: id(3),
    task_id: id(2),
    uploaded_by: id(1),
    state: "pending",
    object_path: `${id(9)}/${id(8)}/${id(7)}/${id(2)}/${id(3)}`,
    upload_deadline: new Date(Date.now() + 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const state = {
    evidence,
    requests: [] as Request[],
    calls: [] as { name: string; args: Record<string, unknown> }[],
    files: new Map<string, Uint8Array>(),
    bucket: {
      id: "task-evidence",
      name: "task-evidence",
      public: false,
      file_size_limit: MAX_PHOTO_BYTES,
      allowed_mime_types: ["image/jpeg"],
    },
    missingBucket: false,
    bucketError: false,
    reservationError: false,
    finalizeError: false,
    uploadError: false,
    removeError: false,
    confirmError: false,
    queueError: false,
    cleanupRows: [] as { id: string; object_path: string }[],
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const mockFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    state.requests.push(req.clone());
    const path = new URL(req.url).pathname;
    if (path.includes("/rest/v1/rpc/")) {
      const name = path.split("/").at(-1)!;
      const args = await req.json();
      state.calls.push({ name, args });
      if (name === "reserve_task_evidence") {
        return state.reservationError
          ? response({ message: "Denied" }, 403)
          : response(state.evidence);
      }
      if (name === "finalize_task_evidence") {
        if (state.finalizeError) {
          return response({ message: "Shift changed" }, 400);
        }
        state.evidence.state = "ready";
        return response({
          ...state.evidence,
          byte_size: args.p_byte_size,
          sha256: args.p_sha256,
          mime_type: args.p_mime_type,
        });
      }
      if (name === "reject_task_evidence_upload") {
        state.evidence.state = "delete_pending";
        return response(null);
      }
      if (
        name === "queue_expired_task_evidence" ||
        name === "requeue_late_task_evidence_objects"
      ) {
        return state.queueError
          ? response({ message: "Database unavailable" }, 500)
          : response(0);
      }
      if (name === "confirm_task_evidence_deleted") {
        return state.confirmError
          ? response({ message: "Still present" }, 400)
          : response(null);
      }
      if (name === "record_task_evidence_cleanup_failure") {
        return response(null);
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
    if (path === "/rest/v1/task_evidence") return response(state.cleanupRows);
    if (path === "/storage/v1/bucket/task-evidence" && req.method === "GET") {
      if (state.bucketError) {
        return response({ message: "Unavailable", statusCode: 503 }, 503);
      }
      return state.missingBucket
        ? response({ message: "Not found", statusCode: 404 }, 404)
        : response(state.bucket);
    }
    if (path === "/storage/v1/bucket" && req.method === "POST") {
      state.missingBucket = false;
      return response({ name: "task-evidence" });
    }
    if (path === "/storage/v1/bucket/task-evidence" && req.method === "PUT") {
      return response({ message: "Updated" });
    }
    if (
      path === "/storage/v1/object/task-evidence" && req.method === "DELETE"
    ) {
      if (state.removeError) {
        return response(
          { message: "Provider unavailable", statusCode: 503 },
          503,
        );
      }
      const { prefixes } = await req.json();
      for (const key of prefixes) state.files.delete(key);
      return response(prefixes.map((name: string) => ({ name })));
    }
    const match = path.match(
      /\/object\/(?:authenticated\/)?task-evidence\/(.+)$/,
    );
    if (match && req.method === "HEAD") {
      return new Response(null, {
        status: state.files.has(match[1]) ? 200 : 404,
      });
    }
    if (match && req.method === "POST") {
      if (state.uploadError) {
        return response({ message: "Unavailable", statusCode: 503 }, 503);
      }
      if (state.files.has(match[1])) {
        return response({
          message: "The resource already exists",
          statusCode: 409,
        }, 409);
      }
      state.files.set(match[1], new Uint8Array(await req.arrayBuffer()));
      return response({ Key: match[1], Id: id(4) });
    }
    if (match && req.method === "GET") {
      const bytes = state.files.get(match[1]);
      return bytes
        ? new Response(Uint8Array.from(bytes), {
          headers: { "Content-Type": "image/jpeg" },
        })
        : response({ message: "Missing", statusCode: 404 }, 404);
    }
    throw new Error(`Unexpected request ${req.method} ${path}`);
  };
  const client = (key: string) =>
    createClient("https://supabase.test", key, {
      accessToken: async () => key,
      global: { fetch: mockFetch },
    });
  const user = client("user-token");
  const admin = client("service-token");
  return {
    state,
    user,
    admin,
    dependencies: {
      requireUser: async () => ({ client: user, userId: id(1) }),
      adminClient: () => admin,
    },
  };
}

function uploadRequest(
  bytes: Uint8Array,
  query = `task_id=${id(2)}&evidence_id=${id(3)}`,
) {
  return new Request(`https://functions.test/upload-task-evidence?${query}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: Uint8Array.from(bytes),
  });
}

Deno.test("upload authenticates and authorises before image processing or privileged writes", async () => {
  const f = backend();
  const noAuth = createEvidenceUploadHandler(normalizePhoto, {
    ...f.dependencies,
    requireUser: async () => null,
  });
  assert.equal((await noAuth(uploadRequest(bytesOf("bad")))).status, 401);
  assert.equal(f.state.requests.length, 0);
  const handler = createEvidenceUploadHandler(normalizePhoto, f.dependencies);
  assert.equal(
    (await handler(uploadRequest(bytesOf("bad"), "task_id=bad"))).status,
    400,
  );
  f.state.reservationError = true;
  assert.equal((await handler(uploadRequest(bytesOf("bad")))).status, 409);
  assert.deepEqual(f.state.calls.map((call) => call.name), [
    "reserve_task_evidence",
  ]);
  assert.equal(
    f.state.requests.some((req) => req.url.includes("/storage/")),
    false,
  );
});

Deno.test("upload stores only normalized bytes using caller JWT, then finalizes with verified owner", async () => {
  const f = backend();
  const input = await fixtureImage(MagickFormat.Png, 100, 50, true);
  const handler = createEvidenceUploadHandler(normalizePhoto, f.dependencies);
  const result = await handler(uploadRequest(input));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).evidence.state, "ready");
  const stored = f.state.files.get(f.state.evidence.object_path)!;
  assert.deepEqual([...stored.subarray(0, 2)], [255, 216]);
  const request = f.state.requests.find((req) =>
    req.method === "POST" && req.url.includes("/object/")
  )!;
  assert.equal(request.headers.get("authorization"), "Bearer user-token");
  assert.equal(request.headers.get("x-upsert"), "false");
  assert.equal(request.headers.get("content-type"), "image/jpeg");
  const finalize = f.state.calls.find((call) =>
    call.name === "finalize_task_evidence"
  )!;
  assert.equal(finalize.args.p_uploaded_by, id(1));
  assert.equal(finalize.args.p_sha256, await photoDigest(stored));
  assert.equal(finalize.args.p_byte_size, stored.length);
  const before = f.state.requests.length;
  assert.equal((await handler(uploadRequest(input))).status, 200);
  assert.equal(f.state.requests.length, before + 3);
  f.state.files.clear();
  assert.equal((await handler(uploadRequest(input))).status, 409);
});

Deno.test("lost upload responses retry safely without overwrite, and mismatching bytes conflict", async () => {
  const f = backend();
  const input = await fixtureImage();
  const photo = await normalizePhoto(input);
  f.state.files.set(f.state.evidence.object_path, photo.bytes);
  assert.equal(
    (await createEvidenceUploadHandler(normalizePhoto, f.dependencies)(
      uploadRequest(input),
    )).status,
    200,
  );
  const other = backend();
  other.state.files.set(
    other.state.evidence.object_path,
    bytesOf("some other file"),
  );
  const conflict = await createEvidenceUploadHandler(
    normalizePhoto,
    other.dependencies,
  )(uploadRequest(input));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "evidence_conflict");
  assert.equal(
    other.state.calls.some((call) => call.name === "finalize_task_evidence"),
    false,
  );
  assert.equal(
    new TextDecoder().decode(
      other.state.files.get(other.state.evidence.object_path),
    ),
    "some other file",
  );
});

Deno.test("invalid and oversized bodies do not upload or finalize, and release pending reservations", async () => {
  for (
    const input of [
      bytesOf("not an image"),
      new Uint8Array(MAX_PHOTO_BYTES + 1),
    ]
  ) {
    const f = backend();
    const result = await createEvidenceUploadHandler(
      normalizePhoto,
      f.dependencies,
    )(uploadRequest(input));
    assert.equal(result.status, 422);
    assert.equal(f.state.files.size, 0);
    assert.equal(f.state.evidence.state, "delete_pending");
    assert.equal(
      f.state.calls.some((call) => call.name === "finalize_task_evidence"),
      false,
    );
  }
});

Deno.test("unsafe bucket, expired reservation, Storage failure and rejected finalization never report success", async () => {
  const input = await fixtureImage();
  for (const scenario of ["public", "expired", "storage", "finalize"]) {
    const f = backend();
    if (scenario === "public") f.state.bucket.public = true;
    if (scenario === "expired") {
      f.state.evidence.upload_deadline = new Date(0).toISOString();
    }
    if (scenario === "storage") f.state.uploadError = true;
    if (scenario === "finalize") f.state.finalizeError = true;
    const response = await createEvidenceUploadHandler(
      normalizePhoto,
      f.dependencies,
    )(uploadRequest(input));
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).ok, false);
    assert.notEqual(f.state.evidence.state, "ready");
    if (scenario === "public" || scenario === "expired") {
      assert.equal(f.state.files.size, 0);
    }
  }
});

Deno.test("bucket setup is scoped, idempotent and refuses an unexpectedly public bucket", async () => {
  const f = backend();
  assert.equal(await configureEvidenceBucket(f.admin), "unchanged");
  f.state.missingBucket = true;
  assert.equal(await configureEvidenceBucket(f.admin), "created");
  const create = f.state.requests.find((req) => req.method === "POST")!;
  const body = await create.json();
  assert.equal(body.public, false);
  assert.equal(body.file_size_limit, MAX_PHOTO_BYTES);
  assert.deepEqual(body.allowed_mime_types, ["image/jpeg"]);
  f.state.bucket.public = true;
  await assert.rejects(
    configureEvidenceBucket(f.admin),
    /public evidence bucket/,
  );
  f.state.bucket.public = false;
  f.state.bucket.file_size_limit = 0;
  assert.equal(await configureEvidenceBucket(f.admin), "updated");
  f.state.bucketError = true;
  await assert.rejects(configureEvidenceBucket(f.admin), /inspect/);
});

Deno.test("cleanup requires the scheduler secret and deletes only database-queued paths", async () => {
  const f = backend();
  const req = () =>
    new Request("https://functions.test/cleanup-task-evidence", {
      method: "POST",
      body: JSON.stringify({ paths: ["unrelated/photo"] }),
    });
  const denied = createEvidenceCleanupHandler({
    hasCronSecret: () => false,
    adminClient: () => f.admin,
  });
  assert.equal((await denied(req())).status, 401);
  assert.equal(f.state.requests.length, 0);
  f.state.cleanupRows = [{
    id: id(3),
    object_path: f.state.evidence.object_path,
  }];
  f.state.files.set(f.state.evidence.object_path, bytesOf("photo"));
  f.state.files.set("unrelated/photo", bytesOf("keep"));
  const handler = createEvidenceCleanupHandler({
    hasCronSecret: () => true,
    adminClient: () => f.admin,
  });
  const result = await handler(req());
  assert.equal(result.status, 200);
  assert.equal((await result.json()).confirmed, 1);
  assert.equal(f.state.files.has(f.state.evidence.object_path), false);
  assert.equal(f.state.files.has("unrelated/photo"), true);
  assert.equal(f.state.calls.at(-1)?.name, "confirm_task_evidence_deleted");
  assert.equal((await handler(req())).status, 200);
});

Deno.test("cleanup failures remain retryable and do not claim successful deletion", async () => {
  for (const scenario of ["remove", "confirm", "queue"]) {
    const f = backend();
    f.state.cleanupRows = [{
      id: id(3),
      object_path: f.state.evidence.object_path,
    }];
    f.state.removeError = scenario === "remove";
    f.state.confirmError = scenario === "confirm";
    f.state.queueError = scenario === "queue";
    const handler = createEvidenceCleanupHandler({
      hasCronSecret: () => true,
      adminClient: () => f.admin,
    });
    const result = await handler(
      new Request("https://functions.test/cleanup-task-evidence", {
        method: "POST",
      }),
    );
    assert.equal(result.status, 503);
    if (scenario !== "queue") {
      assert.equal((await result.json()).confirmed, 0);
      assert.equal(
        f.state.calls.at(-1)?.name,
        "record_task_evidence_cleanup_failure",
      );
    }
    if (scenario === "remove") {
      assert.equal(
        f.state.calls.some((call) =>
          call.name === "confirm_task_evidence_deleted"
        ),
        false,
      );
    }
  }
});
