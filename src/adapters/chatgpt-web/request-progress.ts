/** Explain scheduled waits in the normal Codex stream, not just a launcher tooltip.
 * This is transport status, never model reasoning or proof of submission. */
export function requestPreparationProgress(
  publish: (text: string) => void,
  onProgress?: (stage: string, waitUntil?: number) => void,
  now: () => number = Date.now,
): (stage: string, waitUntil?: number) => void {
  let announcedUntil: number | undefined;
  return (stage, waitUntil) => {
    onProgress?.(stage, waitUntil);
    if (stage === "request_wait") {
      if (waitUntil === undefined || !Number.isFinite(waitUntil)
        || waitUntil - now() < 3_000 || waitUntil === announcedUntil) return;
      announcedUntil = waitUntil;
      publish(`ChatGPTへの送信準備は通信制限のため待機中です。次の試行予定は ${new Date(waitUntil).toLocaleTimeString("ja-JP")} です。待機終了後に自動で再開します。`);
    } else if (announcedUntil !== undefined) {
      announcedUntil = undefined;
      publish("ChatGPTへの送信準備を再開しました。");
    }
  };
}
