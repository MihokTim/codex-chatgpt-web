import { createHash } from "node:crypto";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { parseChatGptModelAnnouncement } from "./model-announcement";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

type UsageAccount = Awaited<ReturnType<typeof readChatGptUsageAccount>>;

/** Cache only while locally observed session cookies are unchanged. No credential leaves memory. */
export class ChatGptUsageAccountCache {
  private value?: { fingerprint: string; account: UsageAccount; expires: number };
  private pending?: { fingerprint: string; promise: Promise<UsageAccount> };
  private revision = 0;
  constructor(private readonly now = Date.now, private readonly ttlMs = 60_000) {}

  invalidate(): void { this.revision++; this.value = undefined; this.pending = undefined; }

  async read(fingerprint: () => Promise<string | undefined>, load: () => Promise<UsageAccount>): Promise<UsageAccount> {
    const before = await fingerprint().catch(error => { this.invalidate(); throw error; });
    if (!before) { this.invalidate(); return load(); }
    if (this.value?.fingerprint === before && this.value.expires > this.now()) return this.value.account;
    if (this.pending?.fingerprint === before) return this.pending.promise;
    this.value = undefined;
    const revision = this.revision;
    let promise!: Promise<UsageAccount>;
    promise = (async () => {
      const account = await load();
      const after = await fingerprint();
      if (before !== after || revision !== this.revision) throw new Error("The ChatGPT account changed during usage verification");
      if (this.pending?.promise === promise) this.value = { fingerprint: before, account, expires: this.now() + this.ttlMs };
      return account;
    })();
    this.pending = { fingerprint: before, promise };
    try { return await promise; }
    finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
}

const usageAccountCaches = new WeakMap<BrowserContext, ChatGptUsageAccountCache>();

export function invalidateChatGptUsageAccountCache(context: BrowserContext): void {
  usageAccountCaches.get(context)?.invalidate();
}

export async function readCachedChatGptUsageAccount(page: Page): Promise<UsageAccount> {
  const context = page.context();
  let cache = usageAccountCaches.get(context);
  if (!cache) { cache = new ChatGptUsageAccountCache(); usageAccountCaches.set(context, cache); }
  return cache.read(async () => {
    // This is a local browser-protocol read, not an /api/auth/session request. Include all
    // session/account cookie changes; do not log the cookies or this private fingerprint.
    const cookies = (await context.cookies("https://chatgpt.com"))
      .filter(cookie => /auth|session|account|login/i.test(cookie.name))
      .sort((a, b) => `${a.domain}:${a.path}:${a.name}`.localeCompare(`${b.domain}:${b.path}:${b.name}`));
    if (!cookies.length) return undefined;
    return createHash("sha256").update(JSON.stringify(cookies)).digest("hex");
  }, () => readChatGptUsageAccount(page));
}

/** Only stable account identity leaves the page; never export session credentials. */
export async function readChatGptUsageAccount(page: Page): Promise<{
  accountKey: string;
  planType: string;
  personal: boolean;
  needsAttention: boolean;
}> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("Open ChatGPT and sign in before setting up Limits.");
  }
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("Limits could not verify the current ChatGPT account.");
    }
    const session = await response.json();
    // Deliberately copy only these fields from the session response.
    return {
      userId: session?.user?.id,
      accountId: session?.account?.id,
      planType: session?.account?.planType,
      structure: session?.account?.structure,
      needsAttention: session?.account?.isDelinquent === true,
    };
  });
  if ([identity.userId, identity.accountId, identity.planType, identity.structure]
    .some(value => typeof value !== "string" || !value || value.length > 256)) {
    throw new Error("Limits could not identify the current ChatGPT account. Sign in and retry.");
  }
  return {
    accountKey: createHash("sha256").update(`${identity.userId}\0${identity.accountId}`).digest("hex"),
    planType: identity.planType,
    personal: identity.structure === "personal",
    needsAttention: identity.needsAttention,
  };
}

/** Read the current subscription heading, not upgrade offers, invoices, or a bare 'Pro' badge. */
export function chatGptLimitsPlanFromHeadings(headings: readonly string[]): "pro_100" | "pro_200" {
  const plans = headings.map(text => text.trim()).filter(text => /^ChatGPT Pro\b/i.test(text));
  if (plans.length === 1 && /^ChatGPT Pro 20x$/i.test(plans[0]!)) return "pro_200";
  if (plans.length === 1 && /^ChatGPT Pro 5x$/i.test(plans[0]!)) return "pro_100";
  throw new Error("Could not distinguish Pro $100 from Pro $200 in ChatGPT billing settings. Limits tracking was not enabled.");
}

export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!before.personal || before.planType !== "pro") return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  if (await page.getByRole("dialog").filter({ visible: true }).count() > 0) {
    throw new Error("Close the open ChatGPT dialog and retry Limits setup.");
  }
  let settings: Locator | undefined;
  try {
    // Enter targets the profile control itself; a center click can hit its nested payment button.
    await page.getByTestId("accounts-profile-button").filter({ visible: true }).last().press("Enter", { timeout: 5_000 });
    await page.getByTestId("settings-menu-item").click({ timeout: 5_000 });
    settings = page.getByRole("dialog").filter({ has: page.locator('[role="tab"][id$="-trigger-Billing"]') });
    await settings.waitFor({ state: "visible", timeout: 10_000 });
    await settings.locator('[role="tab"][id$="-trigger-Billing"]').click({ timeout: 5_000 });
    const panel = settings.locator('[role="tabpanel"][id$="-content-Billing"]');
    await panel.getByRole("heading", { name: /^ChatGPT Pro\b/i }).waitFor({ state: "visible", timeout: 10_000 });
    const plan = chatGptLimitsPlanFromHeadings(await panel.getByRole("heading").allTextContents());
    const after = await readChatGptUsageAccount(page);
    if (after.accountKey !== before.accountKey || after.planType !== "pro" || !after.personal || after.needsAttention) {
      throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
    }
    return { accountKey: after.accountKey, plan };
  } finally {
    // Only dismiss the UI opened by this inspection; no subscription controls are activated.
    if (settings && await settings.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden", timeout: 5_000 });
    } else if (await page.getByTestId("settings-menu-item").isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
    }
  }
}

/** The slider's own accessibility announcement names the selected family, even for 'Latest'. */
export async function readChatGptUsageModel(slider: Locator, isPro: boolean): Promise<ChatGptUsageModel> {
  if (!isPro) return "other";
  const announcements = await slider.locator("xpath=ancestor::*[@role='menuitem'][1]").evaluate(element => (
    (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map(id => element.ownerDocument.getElementById(id)?.textContent ?? "")
  ));
  return chatGptUsageModelFromAnnouncements(announcements);
}

export function chatGptUsageModelFromAnnouncements(announcements: readonly string[]): ChatGptUsageModel {
  const families = new Set<ChatGptUsageModel>();
  for (const text of announcements) {
    const state = parseChatGptModelAnnouncement(text);
    if (!state || !/^Pro$/i.test(state.mode)) continue;
    if (state.version === "6" && (!state.name || state.name === "astra")) families.add("gpt-6-pro");
    if (state.version === "5.6" && (!state.name || state.name === "sol")) families.add("gpt-5.6-pro");
  }
  return families.size === 1 ? [...families][0]! : "pro-unknown";
}
