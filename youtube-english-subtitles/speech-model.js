export const SPEECH_MODEL_ID = "onnx-community/whisper-small";
export const SPEECH_MODEL_NAME = "Whisper Small (multilingual)";

export async function loadSpeechModel(pipeline, {
  gpuAvailable = false,
  progressCallback,
  onCpuFallback,
} = {}) {
  const choices = gpuAvailable
    ? [{ device: "webgpu", dtype: "fp16" }, { device: "wasm", dtype: "q8" }]
    : [{ device: "wasm", dtype: "q8" }];
  let lastError;
  for (const choice of choices) {
    try {
      return await pipeline("automatic-speech-recognition", SPEECH_MODEL_ID, {
        ...choice,
        progress_callback: progressCallback,
      });
    } catch (error) {
      lastError = error;
      if (choice.device === "webgpu") onCpuFallback?.();
    }
  }
  throw lastError ?? new Error(`${SPEECH_MODEL_NAME} could not be loaded.`);
}
