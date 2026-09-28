const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const MAX_PERIOD_FILE_BYTES = 4096;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateLimitsPeriod(value) {
  if (keysAre(value, ["mode"]) && value.mode === "off") return { mode: "off" };
  if (keysAre(value, ["mode", "startAt"]) && value.mode === "since"
    && integer(value.startAt, 0, 8_640_000_000_000_000)) return { mode: "since", startAt: value.startAt };
  if (keysAre(value, ["mode", "weekday", "hour", "minute"]) && value.mode === "weekly"
    && integer(value.weekday, 0, 6) && integer(value.hour, 0, 23) && integer(value.minute, 0, 59)) {
    return { mode: "weekly", weekday: value.weekday, hour: value.hour, minute: value.minute };
  }
  throw new Error("Invalid GPT-6 Pro counting period. Choose a start date or a weekly weekday and time.");
}

function readLimitsPeriod(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return { mode: "off" }; throw error; }
  if (!stat.isFile() || stat.size > MAX_PERIOD_FILE_BYTES) throw new Error("Invalid limits period file; it was not changed.");
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!keysAre(state, ["version", "period"]) || state.version !== 1) throw new Error("Unsupported limits period file; it was not changed.");
  return validateLimitsPeriod(state.period);
}

function saveLimitsPeriod(filePath, value, now = Date.now()) {
  const period = validateLimitsPeriod(value);
  if (!integer(now, 0, 8_640_000_000_000_000)) throw new Error("Invalid local clock.");
  if (period.mode === "since" && period.startAt > now) throw new Error("The counting start must not be in the future.");
  // Keep this setting separate from receipt history, including compatibility with older builds.
  // A corrupt or unexpected existing file is never silently overwritten.
  readLimitsPeriod(filePath);
  writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, period })}\n`);
  return period;
}

function summarizeGpt6Period(events, trackingSince, now, value, retentionMs) {
  const period = validateLimitsPeriod(value);
  if (period.mode === "off") return null;
  let startAt;
  let nextStartAt = null;
  if (period.mode === "since") startAt = period.startAt;
  else {
    // Calendar arithmetic preserves the chosen local wall time across DST transitions.
    // The weekly schedule follows this computer's timezone, displayed by the renderer.
    const today = new Date(now);
    const boundary = days => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days,
      period.hour, period.minute, 0, 0);
    let days = -(today.getDay() - period.weekday + 7) % 7;
    if (boundary(days).getTime() > now) days -= 7;
    const start = boundary(days);
    const next = boundary(days + 7);
    startAt = start.getTime();
    nextStartAt = next.getTime();
  }
  const cutoff = now - retentionMs;
  const availableSince = Math.max(trackingSince ?? now, cutoff + 1);
  const observed = events.filter(event => event.at >= startAt && event.at > cutoff && event.at <= now);
  return {
    startAt, endAt: now, nextStartAt, availableSince,
    used: observed.filter(event => event.model === "gpt-6-pro").length,
    uncertainUsed: observed.filter(event => event.model === "pro-unknown").length,
    partialHistory: trackingSince === null || startAt < availableSince,
    future: startAt > now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

module.exports = { validateLimitsPeriod, readLimitsPeriod, saveLimitsPeriod, summarizeGpt6Period };
