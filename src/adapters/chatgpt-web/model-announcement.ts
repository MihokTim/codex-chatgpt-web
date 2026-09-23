/** Read the model identity before the localized position announcement. */
export function parseChatGptModelAnnouncement(text: string): {
  version: string;
  name?: string;
  mode: string;
} | undefined {
  // Unicode Other_Punctuation covers localized commas and sentence separators.
  // Dashes and brackets remain part of the mode, so Pro-preview is not Pro.
  const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^\p{Po}]+)(?:\p{Po}|$)/iu
    .exec(text.replace(/\s+/g, " ").trim());
  return match ? { version: match[1]!, name: match[2]?.toLowerCase(), mode: match[3]!.trim() } : undefined;
}
