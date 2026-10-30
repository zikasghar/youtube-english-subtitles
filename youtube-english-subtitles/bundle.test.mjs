import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ONNX_RUNTIME_FILES } from "./runtime-config.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const ortRequire = createRequire(require.resolve("@huggingface/transformers"));
const ortDist = dirname(ortRequire.resolve("onnxruntime-web"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("packaged ONNX factory and WASM exactly match Transformers' installed runtime", () => {
  for (const filename of Object.values(ONNX_RUNTIME_FILES)) {
    assert.equal(hash(join(root, "dist/onnx", filename)), hash(join(ortDist, filename)), filename);
  }
});

test("extension remains self-only and all runtime entrypoints are packaged", () => {
  const manifest = JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8"));
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, metadata.version);
  assert.deepEqual(manifest.content_scripts[0].js, ["playback-recovery.js", "sync-playback.js", "rolling-playback.js", "content.js"]);
  assert.ok(
    manifest.permissions.includes("unlimitedStorage"),
    "large local speech models need extension Cache Storage quota exemption",
  );
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  );
  for (const filename of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    "offscreen.html",
    "offscreen.js",
    "audio-worklet.js",
    "rolling-session.js",
    ...manifest.content_scripts.flatMap(({ js }) => js),
  ]) {
    assert.ok(existsSync(join(root, "dist", filename)), filename);
  }
  const offscreen = readFileSync(join(root, "dist/offscreen.js"), "utf8");
  assert.ok(offscreen.includes("onnx/"), "compiled runtime uses packaged paths");
  assert.ok(!offscreen.includes("@huggingface/transformers"), "no bare package imports");
});
