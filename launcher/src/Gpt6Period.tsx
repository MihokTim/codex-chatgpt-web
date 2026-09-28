import { useEffect, useState, type FormEvent } from "react";
import type { LimitsPeriod } from "./limits-types";
import type { Language } from "./types";
import type { LimitsTracker } from "./useLimits";
import { limitsPeriodCopyFor } from "./limits-period-copy";

function localInput(value: number) {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Gpt6Period({ tracker, language }: { tracker: LimitsTracker; language: Language }) {
  const copy = limitsPeriodCopyFor(language);
  const { snapshot } = tracker;
  const [mode, setMode] = useState<LimitsPeriod["mode"]>("off");
  const [since, setSince] = useState(() => localInput(Date.now()));
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState("00:00");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    if (dirty) return;
    const period = snapshot?.period;
    setMode(period?.mode ?? "off");
    if (period?.mode === "since") setSince(localInput(period.startAt));
    if (period?.mode === "weekly") {
      setWeekday(period.weekday);
      setTime(`${String(period.hour).padStart(2, "0")}:${String(period.minute).padStart(2, "0")}`);
    }
  }, [snapshot?.period, dirty]);
  const edit = () => { setDirty(true); setSaved(false); setValidation(null); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (tracker.savingPeriod || tracker.settingUp) return;
    let period: LimitsPeriod;
    if (mode === "since") {
      const startAt = new Date(since).getTime();
      if (!Number.isFinite(startAt) || startAt < 0 || startAt > Date.now()) { setValidation(copy.invalidDate); return; }
      period = { mode, startAt };
    } else if (mode === "weekly") {
      const [hour, minute] = time.split(":").map(Number);
      period = { mode, weekday, hour, minute };
    } else period = { mode: "off" };
    try {
      if (await tracker.savePeriod(period)) { setDirty(false); setSaved(true); setValidation(null); }
    } catch { /* The shared tracker exposes the actual persistence error. */ }
  };
  const result = snapshot?.gpt6Period;
  const date = (value: number) => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(value);
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const zone = result?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const error = validation || tracker.periodError || snapshot?.periodError;
  return <section className="limits-period" aria-labelledby="gpt6-period-title">
    <div className="limits-section-heading"><h2 id="gpt6-period-title">{copy.title}</h2></div>
    <p className="limits-section-description">{copy.note}</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={tracker.savingPeriod || tracker.settingUp} className="limits-period-fields">
        <label className="limits-period-mode">{copy.mode}
          <select aria-label={copy.mode} value={mode} onChange={event => { edit(); setMode(event.target.value as LimitsPeriod["mode"]); }}>
            <option value="off">{copy.off}</option><option value="since">{copy.since}</option><option value="weekly">{copy.weekly}</option>
          </select>
        </label>
        {mode === "since" ? <label>{copy.start}
          <input type="datetime-local" step="60" required value={since} max={localInput(Date.now())}
            onChange={event => { edit(); setSince(event.target.value); }} />
        </label> : null}
        {mode === "weekly" ? <>
          <label>{copy.weekday}<select aria-label={copy.weekday} value={weekday} onChange={event => { edit(); setWeekday(Number(event.target.value)); }}>
            {Array.from({ length: 7 }, (_, day) => <option key={day} value={day}>
              {new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, 7 + day))}
            </option>)}
          </select></label>
          <label>{copy.time}<input type="time" required step="60" value={time} onChange={event => { edit(); setTime(event.target.value); }} /></label>
        </> : null}
        <button className="button-secondary" type="submit" disabled={!dirty || Boolean(snapshot?.periodError)}>
          {tracker.savingPeriod ? copy.saving : copy.save}
        </button>
      </fieldset>
    </form>
    <p className="limits-muted">{copy.timezone.replace("{zone}", zone)}</p>
    {error ? <p className="limits-error" role="alert">{error}</p> : null}
    {saved ? <p className="limits-muted" role="status">{copy.saved}</p> : null}
    {result ? <div className="limits-period-result">
      <div className="limits-window-value"><strong>{result.partialHistory || result.uncertainUsed > 0
        ? copy.lowerBound.replace("{count}", number(result.used)) : number(result.used)}</strong><span>{copy.count}</span></div>
      <dl className="limits-history-grid">
        <div><dt>{copy.from}</dt><dd>{date(result.startAt)}</dd></div>
        <div><dt>{copy.through}</dt><dd>{date(result.endAt)}</dd></div>
        {result.nextStartAt !== null ? <div><dt>{copy.next}</dt><dd>{date(result.nextStartAt)}</dd></div> : null}
      </dl>
      {result.partialHistory ? <p className="limits-window-uncertain">{copy.partial} {copy.available}: {date(result.availableSince)}</p> : null}
      {result.uncertainUsed > 0 ? <p className="limits-window-uncertain">{copy.unknown.replace("{count}", number(result.uncertainUsed))}</p> : null}
      {result.future ? <p className="limits-window-uncertain">{copy.future}</p> : null}
    </div> : null}
  </section>;
}
