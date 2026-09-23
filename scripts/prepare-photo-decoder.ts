import "npm:@imagemagick/magick-wasm@0.0.43";

const source = new URL(
  import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.43"),
);
const destination = new URL(
  "../supabase/functions/_shared/photo-decoder/",
  import.meta.url,
);
await Deno.mkdir(destination, { recursive: true });

// Supabase bundles whole npm packages; exclude the unused second WASM binary.
for (
  const [from, to] of [
    ["index.js", "index.js"],
    ["index.d.ts", "index.d.ts"],
    ["../NOTICE", "NOTICE"],
    ["../LICENSE", "LICENSE"],
  ]
) {
  await Deno.copyFile(new URL(from, source), new URL(to, destination));
}
const declarations = new URL("index.d.ts", destination);
await Deno.writeTextFile(
  declarations,
  '/// <reference lib="dom" />\n' + await Deno.readTextFile(declarations),
);
const wasm = await Deno.readFile(new URL("x86/magick.wasm", source));
const compressed = new Blob([wasm]).stream().pipeThrough(
  new CompressionStream("gzip"),
);
await Deno.writeFile(
  new URL("magick.wasm.gz", destination),
  new Uint8Array(await new Response(compressed).arrayBuffer()),
);
console.log("Prepared magick-wasm 0.0.43 (x86 only) for upload-task-evidence.");
