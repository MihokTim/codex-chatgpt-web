import { findTopLevelAssignment, firstTableIndex, parseDocument, renderDocument, insertDocumentLine, removeDocumentLine } from "./codex-integration-document";
import type { PreviousAssignment } from "./codex-integration-shared";

const defaults = { model: "chatgpt-web/pro", model_reasoning_effort: "ultra", default_subagent_model: "chatgpt-web/extra-high" } as const;
export interface WebProfileJournal {
  previous: Record<keyof typeof defaults, PreviousAssignment>;
  agentsTablePresent: boolean;
}
function locate(lines: string[], key: keyof typeof defaults): PreviousAssignment {
  if (key !== "default_subagent_model") return findTopLevelAssignment(lines, key);
  const start = lines.findIndex(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));
  if (start < 0) return { present: false };
  const item = findTopLevelAssignment(lines.slice(start + 1), key);
  return item.index === undefined ? item : { ...item, index: item.index + start + 1 };
}
function parsed(text: string): any { return Bun.TOML.parse(text.replace(/^\uFEFF/, "").replace(/\r(?!\n)/g, "\n")); }
export function installWebProfile(text: string): { text: string; webProfile: WebProfileJournal } {
  const config = parsed(text);
  if (config.agents?.default_subagent_reasoning_effort !== undefined) {
    throw new Error("Remove the global child reasoning override from the Web home before setup");
  }
  const doc = parseDocument(text);
  const previous = {} as WebProfileJournal["previous"];
  const agentsTablePresent = doc.lines.some(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));
  for (const [key, value] of Object.entries(defaults) as [keyof typeof defaults, string][]) {
    const item = locate(doc.lines, key);
    // Refuse alternate TOML spellings we cannot restore byte-for-byte.
    const semantic = key === "default_subagent_model" ? config.agents?.[key] : config[key];
    if (item.present !== (semantic !== undefined) || (item.present && item.value !== semantic)) throw new Error(`Use a plain TOML assignment for ${key} before setup`);
    previous[key] = item;
    const line = `${key} = ${JSON.stringify(value)}`;
    if (item.index !== undefined) doc.lines[item.index] = line;
    else if (key !== "default_subagent_model") insertDocumentLine(doc, firstTableIndex(doc.lines), line);
    else {
      let start = doc.lines.findIndex(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));
      if (start < 0) { start = doc.lines.length; insertDocumentLine(doc, start, "[agents]"); }
      insertDocumentLine(doc, start + 1, line);
    }
  }
  const result = renderDocument(doc);
  parsed(result);
  return { text: result, webProfile: { previous, agentsTablePresent } };
}
export function verifyWebProfile(text: string, profile: WebProfileJournal, installed: boolean): void {
  const lines = parseDocument(text).lines;
  for (const [key, value] of Object.entries(defaults) as [keyof typeof defaults, string][]) {
    const actual = locate(lines, key);
    const before = profile.previous[key];
    if (installed ? actual.value !== value || actual.rawLine !== `${key} = ${JSON.stringify(value)}` : actual.present !== before.present || (before.present && actual.rawLine !== before.rawLine)) {
      throw new Error(`Web profile ${key} changed; refusing to overwrite the user's value`);
    }
  }
}
export function restoreWebProfile(text: string, profile?: WebProfileJournal): string {
  if (!profile) return text;
  verifyWebProfile(text, profile, true);
  const doc = parseDocument(text);
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const item = locate(doc.lines, key);
    if (item.index === undefined) throw new Error(`Missing Web profile ${key}`);
    const before = profile.previous[key];
    if (before.present) doc.lines[item.index] = before.rawLine!;
    else removeDocumentLine(doc, item.index);
  }
  const start = doc.lines.findIndex(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));
  if (!profile.agentsTablePresent && start >= 0 && firstTableIndex(doc.lines.slice(start + 1)) === 0) removeDocumentLine(doc, start);
  else if (!profile.agentsTablePresent && start === doc.lines.length - 1) removeDocumentLine(doc, start);
  return renderDocument(doc);
}
