/** A fresh, non-secret receipt proves which physical Send produced an orphaned DOM answer. */
export function responseMarkerInstruction(marker: string): string {
  if (!/^CODEXRESPONSE[a-f0-9]{32}$/.test(marker)) throw new Error("Invalid response ownership marker");
  return `\n\n<response_transport_receipt>\nBegin your final answer with exactly ${marker} on its own plain-text line, before the requested answer or JSON. Do not put it in a code block or repeat it in progress updates. The client removes this transport receipt before delivering the answer.\n</response_transport_receipt>`;
}

// Usage and part planning estimate a same-shape receipt; the actual Send uses fresh randomness.
export const ESTIMATE_RESPONSE_MARKER = "CODEXRESPONSE0123456789abcdef0123456789abcdef";
export function withResponseMarker<T extends {text: string; multipart?: {commit: string}}>(prepared: T, marker: string): T {
  const instruction = responseMarkerInstruction(marker);
  return {...prepared, text: prepared.text + instruction,
    ...(prepared.multipart ? {multipart: {...prepared.multipart, commit: prepared.multipart.commit + instruction}} : {})};
}

export function hasResponseMarker(text: string, marker: string): boolean {
  const value = text.trimStart();
  return value === marker || (value.startsWith(marker) && /^[ \t]*\r?\n/.test(value.slice(marker.length)));
}

export function stripResponseMarker(text: string, marker: string): string {
  if (!hasResponseMarker(text, marker)) return text;
  return text.trimStart().slice(marker.length).replace(/^[ \t]*\r?\n(?:[ \t]*\r?\n)?/, "");
}

/** Trace snapshots are cumulative, so normalize before computing their public deltas. */
export function responseMarkerTraceText(text: string, marker: string, complete: boolean): string {
  const value = text.trimStart();
  if (marker.startsWith(value) && (!complete || value.startsWith("CODEXRESPONSE"))) return "";
  return stripResponseMarker(text, marker);
}

/** Hold only the possible private prefix; never leak a split receipt to the outer stream. */
export class ResponseMarkerStream {
  private pending = "";
  private decided = false;
  constructor(private readonly marker: string) {}
  push(delta: string): string {
    if (this.decided) return delta;
    this.pending += delta;
    const value = this.pending.trimStart();
    if (this.marker.startsWith(value) || (value.startsWith(this.marker)
      && /^[ \t\r\n]*$/.test(value.slice(this.marker.length)))) return "";
    this.decided = true;
    const output = stripResponseMarker(this.pending, this.marker);
    this.pending = "";
    return output;
  }
  finish(): string {
    if (this.decided) return "";
    this.decided = true;
    const value = this.pending.trimStart();
    if (value !== this.marker && value.startsWith("CODEXRESPONSE") && this.marker.startsWith(value)) {
      throw new Error("ChatGPT returned an incomplete response receipt");
    }
    const output = stripResponseMarker(this.pending, this.marker);
    this.pending = "";
    return output;
  }
}
