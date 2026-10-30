// Target the reported standalone model artifact, not arbitrary sentences or
// YouTube caption tracks. Loud music/noise can pass the audio energy gate.
function isSubscribeArtifact(text) {
  const words = String(text ?? "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return /^(?:(?:please )?subscribe(?: |$))+$/.test(words);
}

// Whisper can loop a word or short phrase during noise/music. Keep one copy
// of runs of at least three, without changing legitimate two-word repetition.
function cleanText(value) {
  const text = String(value ?? "");
  if (isSubscribeArtifact(text)) return "";
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const keys = tokens.map(([word]) => word.normalize("NFKC").toLowerCase());
  const removals = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let size = 1; size <= 12 && start + size * 3 <= tokens.length; size++) {
      let end = start + size;
      while (end + size <= tokens.length &&
        keys.slice(start, start + size).every((key, offset) => key === keys[end + offset])) {
        end += size;
      }
      if (end - start < size * 3) continue;
      const last = tokens[end - 1];
      removals.push([tokens[start + size - 1].index + tokens[start + size - 1][0].length,
        last.index + last[0].length]);
      start = end - 1;
      break;
    }
  }
  let cleaned = text;
  for (const [start, end] of removals.reverse()) cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  return isSubscribeArtifact(cleaned) ? "" : cleaned.trim();
}

export function filterSpeechResult(result) {
  if (!result || typeof result !== "object") return result;
  const chunks = Array.isArray(result.chunks) ? result.chunks : null;
  // Also inspect the aggregate: some decoders split a loop across many chunks.
  if (isSubscribeArtifact(result.text)) {
    return { ...result, text: "", ...(chunks ? { chunks: [] } : {}) };
  }
  const filtered = chunks?.map((chunk) => ({ ...chunk, text: cleanText(chunk?.text) }))
    .filter((chunk) => chunk.text);
  const changedChunks = chunks && (filtered.length !== chunks.length ||
    filtered.some((chunk, index) => chunk.text !== chunks[index]?.text));
  // Whisper also returns full text: rebuild it after removing a chunk so that
  // a missing-timestamp fallback cannot bring the unwanted words back.
  const text = cleanText(changedChunks
    ? filtered.map((chunk) => chunk.text).join(" ")
    : result.text);
  return { ...result, text, ...(chunks ? { chunks: filtered } : {}) };
}
