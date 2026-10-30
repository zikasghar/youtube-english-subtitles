// Languages supported by the multilingual Whisper model and Transformers.
export const SOURCE_LANGUAGE_CODES = `
  en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms
  cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn
  et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be
  tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln
  ha ba jw su
`.trim().split(/\s+/);

export const SUGGESTED_SOURCE_LANGUAGE_CODES = ["tr", "ur"];

export function requireSourceLanguage(language) {
  if (!SOURCE_LANGUAGE_CODES.includes(language)) {
    throw new Error("Choose the video's spoken language before starting audio translation.");
  }
  return language;
}

export function getSpeechTranslationOptions(language) {
  return {
    language: requireSourceLanguage(language),
    task: "translate", // Whisper always translates into English.
    return_timestamps: true,
  };
}
