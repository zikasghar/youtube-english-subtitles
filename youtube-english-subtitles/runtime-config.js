export const ONNX_RUNTIME_FILES = {
  mjs: "ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort-wasm-simd-threaded.asyncify.wasm",
};

export function configureLocalRuntime(env, runtime) {
  env.useBrowserCache = true;
  env.allowLocalModels = false;
  // Transformers' WASM cache imports the factory through a blob URL, which is
  // executable code outside our extension's 'self' policy. Models stay cached.
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm;
  wasm.wasmPaths = Object.fromEntries(
    Object.entries(ONNX_RUNTIME_FILES).map(([kind, filename]) => [
      kind,
      runtime.getURL(`onnx/${filename}`),
    ]),
  );
  // Avoid proxy/blob workers and SharedArrayBuffer isolation requirements.
  wasm.proxy = false;
  wasm.numThreads = 1;
}
