import assert from "node:assert/strict";
import { test } from "node:test";
import { configureLocalRuntime, ONNX_RUNTIME_FILES } from "./runtime-config.js";

test("overrides CDN paths with packaged extension runtime URLs", () => {
  const env = {
    useWasmCache: true,
    backends: {
      onnx: { wasm: { wasmPaths: "https://cdn.jsdelivr.net/", proxy: true, numThreads: 8 } },
    },
  };
  configureLocalRuntime(env, { getURL: (path) => `chrome-extension://test/${path}` });
  for (const [kind, filename] of Object.entries(ONNX_RUNTIME_FILES)) {
    assert.equal(env.backends.onnx.wasm.wasmPaths[kind], `chrome-extension://test/onnx/${filename}`);
  }
  assert.equal(env.useWasmCache, false, "no blob factory imports");
  assert.equal(env.backends.onnx.wasm.proxy, false);
  assert.equal(env.backends.onnx.wasm.numThreads, 1);
  assert.equal(env.useBrowserCache, true, "model downloads still cached");
  assert.equal(env.allowLocalModels, false);
});
