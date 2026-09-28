const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { LimitsController } = require("../electron/limits-controller.cjs");
const { validateLimitsPeriod, readLimitsPeriod, saveLimitsPeriod, summarizeGpt6Period } = require("../electron/limits-period.cjs");
const { DAY_MS, RETENTION_MS } = require("../electron/limits-store.cjs");
const A = "a".repeat(64);
const B = "b".repeat(64);
const START = Date.UTC(2026, 8, 20, 0);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-period-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "limits.json");
  const periodFile = path.join(root, "limits-period.json");
  let time = START;
  let mode = "automatic";
  const options = { now: () => time, getInteractionMode: () => mode };
  const controller = new LimitsController(file, options);
  return { file, periodFile, options, controller, setTime: value => { time = value; }, setMode: value => { mode = value; } };
}

test("specified datetime includes the start boundary and excludes Sol, other, duplicates and earlier sends", async t => {
  const { controller, file, periodFile, options, setTime } = fixture(t);
  await controller.setup(async () => ({ accountKey: A, plan: "pro_200" }));
  for (const [id, model, at] of [["before", "gpt-6-pro", START], ["boundary", "gpt-6-pro", START + 1000],
    ["after", "gpt-6-pro", START + 2000], ["sol", "gpt-5.6-pro", START + 2000],
    ["other", "other", START + 2000], ["unknown", "pro-unknown", START + 2000]]) {
    setTime(at);
    assert.equal(controller.record({ receipt: { id, model, at, accountKey: A } }), true);
  }
  const original = fs.readFileSync(file, "utf8");
  const config = { mode: "since", startAt: START + 1000 };
  const snapshot = controller.setPeriod(config);
  assert.equal(snapshot.gpt6Period.used, 2);
  assert.equal(snapshot.gpt6Period.uncertainUsed, 1);
  assert.equal(snapshot.gpt6Period.partialHistory, false);
  assert.equal(snapshot.gpt6Period.nextStartAt, null);
  assert.equal(snapshot.windows[0].used, 3);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(readLimitsPeriod(periodFile), config);
  const restarted = new LimitsController(file, options);
  assert.deepEqual(restarted.snapshot().period, config);
  assert.equal(restarted.snapshot().gpt6Period.used, 2);
  assert.equal(restarted.record({ receipt: { id: "after", model: "gpt-6-pro", at: START + 2000, accountKey: A } }), false);
  assert.equal(restarted.setPeriod({ mode: "off" }).gpt6Period, null);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("weekly period rolls at the configured local weekday and minute", () => {
  const start = new Date(2026, 8, 21, 9, 30).getTime();
  const end = new Date(2026, 8, 28, 9, 30).getTime();
  const period = { mode: "weekly", weekday: 1, hour: 9, minute: 30 };
  const events = [{ model: "gpt-6-pro", at: start }, { model: "gpt-6-pro", at: end }];
  const before = summarizeGpt6Period(events, start - DAY_MS, end - 1, period, RETENTION_MS);
  assert.equal(before.startAt, start);
  assert.equal(before.nextStartAt, end);
  assert.equal(before.used, 1);
  assert.equal(before.partialHistory, false);
  const after = summarizeGpt6Period(events, start - DAY_MS, end, period, RETENTION_MS);
  assert.equal(after.startAt, end);
  assert.equal(after.used, 1);
  assert.equal(after.nextStartAt, new Date(2026, 9, 5, 9, 30).getTime());
});

test("old starts and pre-tracking dates are lower bounds; counts remain isolated by account", async t => {
  const { controller, setTime } = fixture(t);
  await controller.setup(async () => ({ accountKey: A, plan: "pro_200" }));
  controller.record({ receipt: { id: "old", model: "gpt-6-pro", at: START, accountKey: A } });
  assert.equal(controller.setPeriod({ mode: "since", startAt: START - 1 }).gpt6Period.partialHistory, true);
  setTime(START + RETENTION_MS);
  const expired = controller.snapshot();
  assert.equal(expired.gpt6Period.used, 0);
  assert.equal(expired.gpt6Period.partialHistory, true);
  assert.equal(expired.gpt6Period.availableSince, START + 1);
  controller.record({ receipt: { id: "new", model: "gpt-6-pro", at: START + RETENTION_MS, accountKey: A } });
  assert.equal(controller.snapshot().gpt6Period.used, 1);
  await controller.setup(async () => ({ accountKey: B, plan: "pro_100" }));
  assert.equal(controller.snapshot().gpt6Period.used, 0);
  await controller.setup(async () => ({ accountKey: A, plan: "pro_200" }));
  assert.equal(controller.snapshot().gpt6Period.used, 1);
});

test("invalid and future settings are rejected without changing usage or saved settings", async t => {
  const { controller, file, periodFile, setMode } = fixture(t);
  assert.throws(() => controller.setPeriod({ mode: "off" }), /Enable tracking/);
  await controller.setup(async () => ({ accountKey: A, plan: "pro_200" }));
  controller.setPeriod({ mode: "since", startAt: START });
  const original = fs.readFileSync(periodFile, "utf8");
  const usage = fs.readFileSync(file, "utf8");
  for (const value of [null, [], { mode: "since", startAt: NaN }, { mode: "since", startAt: -1 },
    { mode: "weekly", weekday: 7, hour: 0, minute: 0 }, { mode: "weekly", weekday: 1, hour: 24, minute: 0 },
    { mode: "weekly", weekday: 1, hour: 0, minute: 60 }, { mode: "off", extra: true }]) {
    assert.throws(() => validateLimitsPeriod(value), /Invalid/);
    assert.throws(() => controller.setPeriod(value), /Invalid/);
  }
  assert.throws(() => controller.setPeriod({ mode: "since", startAt: START + 1 }), /future/);
  setMode("manual");
  assert.throws(() => controller.setPeriod({ mode: "off" }), /Zero Risk/);
  assert.equal(fs.readFileSync(periodFile, "utf8"), original);
  assert.equal(fs.readFileSync(file, "utf8"), usage);
});

test("corrupt period settings cannot overwrite history or prevent valid receipts being recorded", async t => {
  const { controller, periodFile } = fixture(t);
  await controller.setup(async () => ({ accountKey: A, plan: "pro_200" }));
  fs.writeFileSync(periodFile, "{broken");
  assert.match(controller.snapshot().periodError, /Could not load/);
  assert.equal(controller.snapshot().enabled, true);
  assert.equal(controller.record({ receipt: { id: "still-counted", at: START, model: "gpt-6-pro", accountKey: A } }), true);
  assert.equal(controller.snapshot().windows[0].used, 1);
  assert.throws(() => saveLimitsPeriod(periodFile, { mode: "off" }, START));
  assert.equal(fs.readFileSync(periodFile, "utf8"), "{broken");
  fs.writeFileSync(periodFile, " ".repeat(4097));
  assert.throws(() => readLimitsPeriod(periodFile), /Invalid limits period file/);
});

test("weekly boundaries use calendar time across DST, including a nonexistent spring hour", () => {
  const modulePath = require.resolve("../electron/limits-period.cjs");
  const result = JSON.parse(execFileSync(process.execPath, ["-e", `
    const {summarizeGpt6Period: summarize} = require(${JSON.stringify(modulePath)});
    const windowMs = 7*86400000;
    const now = new Date(2026,2,8,12).getTime();
    const monday = summarize([], 0, now, {mode:'weekly',weekday:1,hour:9,minute:0}, windowMs);
    const sunday = summarize([], 0, now, {mode:'weekly',weekday:0,hour:2,minute:30}, windowMs);
    const beforeGap = summarize([], 0, new Date(2026,2,8,1).getTime(), {mode:'weekly',weekday:0,hour:2,minute:30}, windowMs);
    console.log(JSON.stringify({hours:(monday.nextStartAt-monday.startAt)/3600000,
      gapHour:new Date(sunday.startAt).getHours(), nextHour:new Date(sunday.nextStartAt).getHours(),
      beforeHour:new Date(beforeGap.startAt).getHours(), zone:monday.timeZone}));
  `], { encoding: "utf8", env: { ...process.env, TZ: "America/New_York" }, windowsHide: true }));
  assert.deepEqual(result, { hours: 167, gapHour: 3, nextHour: 2, beforeHour: 2, zone: "America/New_York" });
});
