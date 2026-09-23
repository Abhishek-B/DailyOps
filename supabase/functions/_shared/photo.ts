// @deno-types="./photo-decoder/index.d.ts"
import {
  AlphaAction,
  ImageMagick,
  initializeImageMagick,
  MagickColors,
  MagickFormat,
  MagickImageInfo,
  MagickReadSettings,
  ResourceLimits,
} from "./photo-decoder/index.js";
import { MAX_PHOTO_BYTES, photoDigest, PhotoError } from "./task-evidence.ts";

const MAX_PIXELS = 4_000_000;
let decoderReady: Promise<void> | undefined;

export function initializePhotoDecoder() {
  decoderReady ??= (async () => {
    const compressed = await Deno.readFile(
      new URL("./photo-decoder/magick.wasm.gz", import.meta.url),
    );
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    );
    const wasm = new Uint8Array(await new Response(stream).arrayBuffer());
    await initializeImageMagick(wasm);
    ResourceLimits.width = 4096n;
    ResourceLimits.height = 4096n;
    ResourceLimits.listLength = 4n;
    ResourceLimits.memory = 96n * 1024n * 1024n;
    ResourceLimits.disk = 0n;
    ResourceLimits.maxProfileSize = 1024n * 1024n;
  })();
  return decoderReady;
}

function photoFormat(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return MagickFormat.Jpeg;
  }
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        ...bytes.subarray(offset + 4, offset + 8),
      );
      if (type === "acTL") {
        throw new PhotoError("Animated images are not supported.");
      }
      if (offset + size + 12 > bytes.length) {
        throw new PhotoError("The photo is incomplete or damaged.");
      }
      offset += size + 12;
    }
    return MagickFormat.Png;
  }
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = text(offset, offset + 4);
      const size = view.getUint32(offset + 4, true);
      if (
        type === "ANIM" || type === "ANMF" ||
        (type === "VP8X" && (bytes[offset + 8] & 2))
      ) {
        throw new PhotoError("Animated images are not supported.");
      }
      if (offset + size + 8 > bytes.length) {
        throw new PhotoError("The photo is incomplete or damaged.");
      }
      offset += 8 + size + (size % 2);
    }
    return MagickFormat.WebP;
  }
  throw new PhotoError(
    "Use a JPEG, PNG or WebP photo. Convert HEIC photos before uploading.",
  );
}

export async function normalizePhoto(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) {
    throw new PhotoError("Photos must be between 1 byte and 5 MiB.");
  }
  const format = photoFormat(bytes);
  await initializePhotoDecoder();
  let output: Uint8Array;
  try {
    const settings = new MagickReadSettings({ format });
    const info = MagickImageInfo.create(bytes, settings);
    if (info.width * info.height > MAX_PIXELS) {
      throw new PhotoError(
        "Resize the photo to at most 4 megapixels before uploading.",
      );
    }
    output = ImageMagick.read(bytes, settings, (image) => {
      image.autoOrient();
      if (Math.max(image.width, image.height) > 1600) image.resize(1600, 1600);
      image.backgroundColor = MagickColors.White;
      image.alpha(AlphaAction.Remove);
      image.strip();
      image.quality = 82;
      return image.write(MagickFormat.Jpeg, (data) => Uint8Array.from(data));
    });
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError(
      "The photo could not be decoded safely. Choose another photo or resize it.",
    );
  }
  if (!output.length || output.length > MAX_PHOTO_BYTES) {
    throw new PhotoError("The processed photo is too large.");
  }
  return {
    bytes: output,
    sha256: await photoDigest(output),
    mimeType: "image/jpeg",
  };
}
