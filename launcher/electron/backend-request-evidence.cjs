// This supplements the worker's Send-scoped observer, including the maintenance document.
// Return fixed categories only: full URLs, query strings, headers and bodies never reach logs.
function backendRequestLimitEvidence(details, maintenanceId, turnTabs) {
  if (details?.statusCode !== 429) return undefined;
  let url;
  try { url = new URL(details.url); } catch { return undefined; }
  if (url.origin !== "https://chatgpt.com") return undefined;
  const tab = [...turnTabs.values()].find(candidate => candidate.view?.webContents?.id === details.webContentsId);
  const maintenance = details.webContentsId === maintenanceId;
  if (!tab && !maintenance) return undefined;
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(details.method)
    ? details.method : "OTHER";
  const category = url.pathname.startsWith("/api/auth/") ? "authentication"
    : /^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname) && method === "POST" ? "generation"
    : /^\/backend-api\/(?:f\/)?conversations?(?:\/|$)/.test(url.pathname) ? "conversation"
    : url.pathname.startsWith("/backend-api/") ? "other" : undefined;
  if (!category) return undefined;
  const retryHeader = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const raw = typeof retryHeader === "string" ? retryHeader : Array.isArray(retryHeader) ? retryHeader[0] : undefined;
  const milliseconds = typeof raw !== "string" ? NaN : /^\d+$/.test(raw.trim()) ? Number(raw) * 1_000
    : /^[A-Za-z]{3}, /.test(raw) ? Date.parse(raw) - Date.now() : NaN;
  const retryAfterMs = Number.isFinite(milliseconds) && milliseconds <= 31_536_000_000 ? Math.max(0, Math.ceil(milliseconds)) : undefined;
  return { source: "http", surface: maintenance ? "maintenance" : "task", category, method, status: 429,
    ...(tab ? { traceId: tab.traceId, stage: tab.workStage ?? "unknown" } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

module.exports = { backendRequestLimitEvidence };
