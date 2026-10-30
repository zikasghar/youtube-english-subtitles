import { env, pipeline } from "@huggingface/transformers";
import { configureLocalRuntime } from "./runtime-config.js";
import { requireSourceLanguage, getSpeechTranslationOptions } from "./speech-language.js";
import { SPEECH_MODEL_ID, SPEECH_MODEL_NAME, loadSpeechModel } from "./speech-model.js";
import { SynchronizedAudio } from "./sync-audio.js";
import { filterSpeechResult } from "./speech-output.js";

const TARGET_SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 12;
const HOP_SECONDS = 8;
const RING_SECONDS = 90;

configureLocalRuntime(env, chrome.runtime);

let tabId = null;
let sourceLanguage = null;
let stream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let outputGain = null;
let synchronized = false;
let syncAudio = null;
let transcriberPromise = null;
let transcriber = null;
let modelReady = false;
let processing = false;
let captureTimer = 0;
let captureToken = 0;
let totalSamples = 0;
let nextWindowStart = 0;
let lastEmittedEnd = 0;
let lastFallbackText = "";
let lastTelemetryAt = 0;
let captureStats = { audioLevel: 0, lastAudioAt: null, windows: 0, lastInferenceMs: 0, resultCharacters: 0, cues: 0 };
const ringBuffer = new Float32Array(TARGET_SAMPLE_RATE * RING_SECONDS);

function emit(event, values = {}) {
  if (!Number.isInteger(tabId)) return;
  if (event === "cue") captureStats.cues++;
  void chrome.runtime
    .sendMessage({
      type: "OFFSCREEN_EVENT",
      tabId,
      event,
      ...values,
    })
    .catch(() => {});
}

function reportTelemetry() {
  lastTelemetryAt = Date.now();
  emit("telemetry", {
    telemetry: {
      ...captureStats,
      model: SPEECH_MODEL_ID,
      playbackMode: synchronized ? "synchronized" : "continuous",
      syncStage: syncAudio?.state,
      recordedSeconds: Math.round(totalSamples / 1600) / 10,
      modelReady,
      processing,
      contextState: audioContext?.state || "closed",
      language: sourceLanguage,
      updatedAt: lastTelemetryAt,
    },
  });
}

function reportProgress(progress) {
  if (progress.status === "progress") {
    const percent = Number.isFinite(progress.progress)
      ? ` ${Math.round(progress.progress)}%`
      : "";
    emit("status", { text: `Downloading ${SPEECH_MODEL_NAME}${percent}…`, buffering: true });
  } else if (progress.status === "initiate") {
    emit("status", { text: `Preparing ${SPEECH_MODEL_NAME}…`, buffering: true });
  }
}

async function loadTranscriber() {
  return loadSpeechModel(pipeline, {
    gpuAvailable: !!navigator.gpu,
    progressCallback: reportProgress,
    onCpuFallback: () => emit("status", {
      text: "Loading Whisper Small on the CPU. Translation may be slower.",
      buffering: true,
    }),
  });
}

function downsample(input, inputRate) {
  if (inputRate === TARGET_SAMPLE_RATE) return input.slice();
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const blend = position - left;
    output[index] = input[left] * (1 - blend) + input[right] * blend;
  }
  return output;
}

function appendSamples(samples) {
  for (let index = 0; index < samples.length; index++) {
    ringBuffer[(totalSamples + index) % ringBuffer.length] = samples[index];
  }
  totalSamples += samples.length;
}

function readWindow(startSample, length) {
  const result = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    result[index] = ringBuffer[(startSample + index) % ringBuffer.length];
  }
  return result;
}

function calculateRms(samples) {
  let squareSum = 0;
  for (let index = 0; index < samples.length; index++) {
    squareSum += samples[index] * samples[index];
  }
  return Math.sqrt(squareSum / Math.max(1, samples.length));
}

function cleanText(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function removeOverlap(previousText, nextText) {
  const previousWords = cleanText(previousText).match(/\S+/g) ?? [];
  const nextWords = cleanText(nextText).match(/\S+/g) ?? [];
  const maxOverlap = Math.min(previousWords.length, nextWords.length, 30);
  let overlap = 0;
  for (let count = maxOverlap; count > 0; count--) {
    const left = previousWords.slice(-count).join(" ").toLowerCase();
    const right = nextWords.slice(0, count).join(" ").toLowerCase();
    if (left === right) {
      overlap = count;
      break;
    }
  }
  return nextWords.slice(overlap).join(" ");
}

function emitTranscription(result, windowStartSeconds) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const timedChunks = chunks.filter(
    (chunk) =>
      cleanText(chunk.text) &&
      Array.isArray(chunk.timestamp) &&
      Number.isFinite(chunk.timestamp[0]) &&
      Number.isFinite(chunk.timestamp[1]),
  );

  if (timedChunks.length) {
    for (const chunk of timedChunks) {
      const [start, end] = chunk.timestamp;
      const absoluteStart = windowStartSeconds + start;
      const absoluteEnd = windowStartSeconds + end;
      if (absoluteEnd <= lastEmittedEnd + 0.12) continue;
      if (absoluteStart < lastEmittedEnd - 0.35) continue;
      const text = cleanText(chunk.text);
      const durationMs = Math.max(1100, Math.min(5200, (end - start) * 1000));
      emit("cue", { text, durationMs });
      lastEmittedEnd = absoluteEnd;
    }
    return;
  }

  const fullText = cleanText(result?.text);
  if (!fullText) return;
  const newText = removeOverlap(lastFallbackText, fullText);
  lastFallbackText = fullText;
  if (newText) {
    const wordCount = newText.split(/\s+/).length;
    emit("cue", {
      text: newText,
      durationMs: Math.max(1800, Math.min(5200, wordCount * 330)),
    });
  }
}

async function transcribeAudio(audio, runId) {
  processing = true;
  const startedAt = Date.now();
  try {
    const result = filterSpeechResult(await transcriber(audio, getSpeechTranslationOptions(sourceLanguage)));
    if (runId === captureToken) {
      captureStats.windows++;
      captureStats.lastInferenceMs = Date.now() - startedAt;
      captureStats.resultCharacters = cleanText(result?.text || result?.chunks?.map((chunk) => chunk.text).join(" ")).length;
    }
    return result;
  } finally {
    if (runId === captureToken) {
      processing = false;
      reportTelemetry();
    }
  }
}

async function processNextWindow(runId) {
  if (synchronized) return;
  if (!modelReady || !transcriber || processing) return;
  const windowSamples = TARGET_SAMPLE_RATE * WINDOW_SECONDS;
  if (totalSamples < nextWindowStart + windowSamples) return;

  const oldestSample = Math.max(0, totalSamples - ringBuffer.length);
  if (nextWindowStart < oldestSample) {
    nextWindowStart = Math.max(oldestSample, totalSamples - windowSamples);
  }
  if (nextWindowStart + windowSamples > totalSamples) return;

  const startSample = nextWindowStart;
  const audio = readWindow(startSample, windowSamples);
  processing = true;
  try {
    if (calculateRms(audio) < 0.004) {
      nextWindowStart = startSample + TARGET_SAMPLE_RATE * HOP_SECONDS;
      emit("status", { text: "No clear audio detected. Play the video and check its volume." });
      return;
    }

    emit("status", { text: "Translating speech on this device…" });
    const result = await transcribeAudio(audio, runId);
    if (runId !== captureToken) return;
    emitTranscription(result, startSample / TARGET_SAMPLE_RATE);
    nextWindowStart = startSample + TARGET_SAMPLE_RATE * HOP_SECONDS;
    emit("status", {
      text: captureStats.resultCharacters
        ? "Local audio translation is running."
        : "No speech recognized in the last segment. Check the spoken language and video audio.",
    });
  } catch (error) {
    if (runId !== captureToken) return;
    nextWindowStart = startSample + TARGET_SAMPLE_RATE * HOP_SECONDS;
    emit("status", {
      text:
        error instanceof Error
          ? `Audio translation paused: ${error.message}`
          : "Audio translation could not process this segment.",
    });
  } finally {
    if (runId === captureToken) {
      processing = false;
      reportTelemetry();
    }
  }
}

async function startCapture({ streamId, tabId: requestedTabId, language, synchronized: requestedSync = false, preparationMinutes = 0, silentCapture = false }) {
  if (![0, 1, 3, 5].includes(preparationMinutes)) throw new Error("Invalid preparation length.");
  const requestedLanguage = requireSourceLanguage(language);
  await stopCapture(false);
  tabId = requestedTabId;
  sourceLanguage = requestedLanguage;
  synchronized = requestedSync === true;
  const runId = ++captureToken;
  totalSamples = 0;
  nextWindowStart = 0;
  lastEmittedEnd = 0;
  lastFallbackText = "";
  modelReady = false;
  processing = false;
  lastTelemetryAt = 0;
  captureStats = { audioLevel: 0, lastAudioAt: null, windows: 0, lastInferenceMs: 0, resultCharacters: 0, cues: 0 };

  try {
    const capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    if (runId !== captureToken) {
      capturedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = capturedStream;

    const captureContext = new AudioContext();
    audioContext = captureContext;
    await captureContext.audioWorklet.addModule(
      chrome.runtime.getURL("audio-worklet.js"),
    );
    if (runId !== captureToken) return;

    sourceNode = captureContext.createMediaStreamSource(capturedStream);
    outputGain = captureContext.createGain();
    outputGain.gain.value = silentCapture ? 0 : 1;
    if (synchronized) {
      syncAudio = new SynchronizedAudio({
        onMute: (muted) => {
          if (outputGain) outputGain.gain.value = silentCapture || muted ? 0 : 1;
        },
        transcribe: (audio) => transcribeAudio(audio, runId),
        onSegment: (segment) => {
          if (runId !== captureToken) return;
          captureStats.cues += segment.cues.length;
          emit("sync-segment", segment);
          reportTelemetry();
        },
        onError: (error) => {
          if (runId !== captureToken) return;
          emit("error", { text: error.message || "Synchronized audio translation failed." });
          void stopCapture(false);
        },
      });
    }
    processorNode = new AudioWorkletNode(captureContext, "youtube-audio-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    if (synchronized) {
      processorNode.port.postMessage({ type: "SYNC_CAPTURE", epoch: -1, playing: false });
    }
    processorNode.port.onmessage = ({ data }) => {
      if (runId !== captureToken) return;
      const samples = synchronized ? data?.samples : data;
      if (!(samples instanceof Float32Array)) return;
      if (synchronized && data.epoch !== syncAudio?.epoch) return;
      captureStats.audioLevel = Math.round(calculateRms(samples) * 10000) / 10000;
      captureStats.lastAudioAt = Date.now();
      const mono = downsample(samples, captureContext.sampleRate);
      appendSamples(mono);
      syncAudio?.append(mono, data.epoch);
    };
    processorNode.onprocessorerror = () => {
      if (runId !== captureToken) return;
      emit("error", {
        text: "The audio processor stopped unexpectedly. Start audio translation again.",
      });
      void stopCapture(false);
    };
    sourceNode.connect(processorNode);
    processorNode.connect(outputGain);
    outputGain.connect(captureContext.destination);
    await captureContext.resume();
    if (runId !== captureToken) return;

    const audioTrack = stream.getAudioTracks()[0];
    audioTrack?.addEventListener("ended", () => {
      if (runId === captureToken) void stopCapture(true);
    });

    captureTimer = window.setInterval(() => {
      void processNextWindow(runId);
      if (Date.now() - lastTelemetryAt >= 2000) reportTelemetry();
    }, 500);

    emit("status", {
      text: "Audio is being processed on this device. Preparing the speech model…",
      buffering: true,
    });
    if (synchronized) emit("sync-prepare", { text: "Synchronized mode: waiting for the speech model…", preparationSeconds: preparationMinutes * 60 });
    transcriberPromise ??= loadTranscriber();
    transcriberPromise
      .then((loadedTranscriber) => {
        if (runId !== captureToken) return;
        transcriber = loadedTranscriber;
        modelReady = true;
        nextWindowStart = Math.max(
          0,
          totalSamples - TARGET_SAMPLE_RATE * WINDOW_SECONDS,
        );
        emit("status", { text: "Local audio translation is running." });
        if (synchronized) emit("sync-ready", { preparationSeconds: preparationMinutes * 60 });
        reportTelemetry();
      })
      .catch(async (error) => {
        if (runId !== captureToken) return;
        transcriberPromise = null;
        emit("error", {
          text:
            error instanceof Error
              ? `Could not load the local speech model: ${error.message}`
              : "Could not load the local speech model.",
        });
        await stopCapture(false);
      });
  } catch (error) {
    if (runId !== captureToken) return;
    emit("error", {
      text:
        error instanceof Error
          ? `Could not start local audio translation: ${error.message}`
          : "Could not start local audio translation.",
    });
    await stopCapture(false);
    throw error;
  }
}

async function stopCapture(notify = true) {
  captureToken++;
  syncAudio?.command({ action: "cancel", epoch: Number.MAX_SAFE_INTEGER });
  syncAudio = null;
  window.clearInterval(captureTimer);
  captureTimer = 0;
  modelReady = false;
  processing = false;
  if (processorNode) {
    processorNode.port.onmessage = null;
    processorNode.port.close();
    processorNode.onprocessorerror = null;
    processorNode.disconnect();
    processorNode = null;
  }
  sourceNode?.disconnect();
  sourceNode = null;
  outputGain?.disconnect();
  outputGain = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close().catch(() => {});
  }
  audioContext = null;
  if (notify) emit("stopped", { text: "Local audio translation stopped." });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "PING") {
    sendResponse({ ready: true });
    return;
  }
  if (message.type === "SYNC_COMMAND") {
    try {
      if (!syncAudio || !synchronized) throw new Error("Synchronized capture is not running.");
      if (message.action !== "cancel" && !modelReady) throw new Error("The speech model is not ready yet.");
      if (!["begin", "clock", "finish", "replay", "cancel"].includes(message.action)) {
        throw new Error("Unknown synchronized playback command.");
      }
      syncAudio.command(message);
      if (message.epoch === syncAudio.epoch) {
        processorNode?.port.postMessage({
          type: "SYNC_CAPTURE",
          epoch: message.epoch,
          playing: message.action === "clock" && message.playing === true,
        });
      }
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return;
  }
  if (message.type === "START_CAPTURE") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Audio capture failed.",
        }),
      );
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stopCapture(message.notify !== false)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Could not stop audio capture.",
        }),
      );
    return true;
  }
});
