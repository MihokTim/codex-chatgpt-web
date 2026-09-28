const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { LimitsController } = require("../electron/limits-controller.cjs");
const { readLimitsPeriod } = require("../electron/limits-period.cjs");

test("Japanese period form saves actual settings, retains edits during refresh and survives reload", {
  skip: !process.env.CHATGPT_DOM_TEST_BROWSER,
  timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-period-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "limits.json");
  let now = Date.parse("2026-09-28T00:00:00+09:00");
  const accountKey = "a".repeat(64);
  const controller = new LimitsController(file, { now: () => now, getInteractionMode: () => "automatic" });
  await controller.setup(async () => ({ accountKey, plan: "pro_200" }));
  for (const [id, model, time] of [["before", "gpt-6-pro", "08:59:59"], ["start", "gpt-6-pro", "09:00:00"],
    ["after", "gpt-6-pro", "09:01:00"], ["sol", "gpt-5.6-pro", "09:02:00"], ["unknown", "pro-unknown", "09:03:00"]]) {
    now = Date.parse(`2026-09-28T${time}+09:00`);
    controller.record({ receipt: { accountKey, id, model, at: now } });
  }
  now = Date.parse("2026-09-28T12:00:00+09:00");
  const code = await build({
    entryPoints: [path.join(__dirname, "fixtures", "limits-period-app.tsx")],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 960, height: 820 } });
  page.setDefaultTimeout(5_000);
  page.on("pageerror", error => t.diagnostic(`Renderer error: ${error.message}`));
  let reads = 0;
  let failSave = false;
  await page.exposeFunction("periodRead", () => { reads++; return controller.snapshot(); });
  await page.exposeFunction("periodSave", period => {
    if (failSave) throw new Error("TEST_SAVE_FAILURE");
    return controller.setPeriod(period);
  });
  const theme = `*{box-sizing:border-box}body{margin:0;padding:24px;background:#17181c;color:#eee;font:14px Arial,sans-serif}
    :root{--color-border:#45464c;--radius-lg:12px;--radius-md:6px;--color-background-control:#222329;
    --color-text-primary:#eee;--color-text-secondary:#ddd;--color-text-tertiary:#aaa;--text-base:15px;--text-xs:12px}
    button{background:#363841;color:inherit;border:1px solid #666;border-radius:6px;padding:9px 14px}
    .limits-surface{max-width:900px;margin:auto}.limits-surface>button{margin-bottom:16px}`;
  const mount = async () => {
    await page.setContent(`<html lang="ja"><head><meta charset="utf-8"><style>${theme}\n${fs.readFileSync(path.join(__dirname, "..", "src", "limits.css"), "utf8")}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: code.outputFiles[0].text });
    await page.getByRole("heading", { name: "GPT-6 Proの集計期間" }).waitFor();
  };
  await mount();
  t.diagnostic("Mounted the real period component and shared polling hook.");
  await page.getByLabel("集計の起点").selectOption("since");
  await page.getByLabel("開始日時", { exact: true }).fill("2026-09-28T09:00");
  await page.getByRole("button", { name: "集計期間を保存", exact: true }).click();
  await page.getByText("集計期間を保存しました", { exact: true }).waitFor();
  assert.equal(await page.locator(".limits-period-result strong").textContent(), "少なくとも2件");
  assert.match(await page.locator(".limits-period-result").textContent(), /モデルを特定できないPro送信: 1件/);
  assert.deepEqual(readLimitsPeriod(path.join(root, "limits-period.json")), { mode: "since", startAt: Date.parse("2026-09-28T09:00:00+09:00") });
  t.diagnostic("Specified datetime saved and receipt totals verified.");
  await page.getByLabel("開始日時", { exact: true }).fill("2026-09-28T09:30");
  const before = reads;
  await page.getByRole("button", { name: "更新テスト" }).click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(reads > before);
  assert.equal(await page.getByLabel("開始日時", { exact: true }).inputValue(), "2026-09-28T09:30");
  assert.equal(await page.locator(".limits-period-result strong").textContent(), "少なくとも2件");
  failSave = true;
  await page.getByRole("button", { name: "集計期間を保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "TEST_SAVE_FAILURE" }).waitFor();
  assert.equal(controller.snapshot().gpt6Period.used, 2);
  failSave = false;
  await page.getByLabel("集計の起点").selectOption("weekly");
  await page.getByLabel("曜日", { exact: true }).selectOption("1");
  await page.getByLabel("時刻", { exact: true }).fill("09:00");
  await page.getByRole("button", { name: "集計期間を保存", exact: true }).click();
  await page.getByText("集計期間を保存しました", { exact: true }).waitFor();
  await page.getByText("次回の集計開始", { exact: true }).waitFor();
  assert.deepEqual(controller.snapshot().period, { mode: "weekly", weekday: 1, hour: 9, minute: 0 });
  t.diagnostic("Weekly schedule and save-error recovery verified.");
  if (process.env.LIMITS_UI_EVIDENCE_DIR) {
    const evidence = path.resolve(process.env.LIMITS_UI_EVIDENCE_DIR);
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, "limits-period-desktop.png"), fullPage: true });
  }
  await mount();
  await page.waitForFunction(() => document.querySelector(".limits-period-mode select")?.value === "weekly");
  assert.equal(await page.getByLabel("曜日", { exact: true }).inputValue(), "1");
  assert.equal(await page.getByLabel("時刻", { exact: true }).inputValue(), "09:00");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.LIMITS_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(path.resolve(process.env.LIMITS_UI_EVIDENCE_DIR), "limits-period-narrow.png"), fullPage: true });
  await page.getByLabel("集計の起点").selectOption("off");
  await page.getByRole("button", { name: "集計期間を保存", exact: true }).click();
  await page.getByText("集計期間を保存しました", { exact: true }).waitFor();
  assert.equal(await page.locator(".limits-period-result").count(), 0);
  assert.equal(controller.snapshot().windows[0].used, 3);
});
