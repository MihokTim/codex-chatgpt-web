import type { BrowserTabState } from "./types";
import type { Copy } from "./i18n";

export function browserTaskLabel(tab: BrowserTabState, copy: Copy): string | undefined {
  const identity = tab.taskIdentity;
  const name = identity?.agentName || (identity?.threadId
    ? identity.parentThreadId ? `${copy.browserAgent} ${identity.threadId.slice(-6)}` : copy.browserParentTask
    : undefined);
  const stage = tab.workStage && ({
    preparing: copy.browserPreparing, waiting: copy.browserWaiting, sending: copy.browserSending,
    ingesting: copy.browserIngesting, compacting: copy.browserCompacting,
    generating: copy.browserGenerating, retained: copy.browserRetained,
  })[tab.workStage];
  return name ? [name, stage].filter(Boolean).join(" · ") : stage ? `${tab.title} · ${stage}` : undefined;
}

export function browserTaskTooltip(tab: BrowserTabState, copy: Copy): string {
  return [browserTaskLabel(tab, copy) || tab.title, tab.taskIdentity?.threadId, tab.traceId,
    tab.retryAt ? `${copy.browserNextAttempt} ${new Date(tab.retryAt).toLocaleTimeString()}` : undefined,
  ].filter(Boolean).join("\n");
}

export function browserTabsOverview(tabs: BrowserTabState[], copy: Copy): string {
  return copy.browserTabsOverview
    .replace("{running}", String(tabs.filter(tab => tab.closable && tab.status === "running").length))
    .replace("{retained}", String(tabs.filter(tab => tab.closable && tab.workStage === "retained").length));
}
