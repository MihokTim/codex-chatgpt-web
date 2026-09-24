import { useState } from "react";
import type { Language, LauncherApi, UpdateState } from "./types";
import { updateCopyFor } from "./update-copy";
import "./updates.css";

export function UpdatesPanel({ update, version, language, api }: {
  update: UpdateState; version: string; language: Language; api: LauncherApi;
}) {
  const copy = updateCopyFor(language);
  const info = update.information;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checking = busy || update.status === "checking";
  const date = (value?: string | null) => value
    ? new Date(value).toLocaleString(language === "ja" ? "ja-JP" : "en-US") : copy.unknown;
  const check = async () => {
    setBusy(true);
    setError(null);
    try { await api.checkUpdates(); }
    catch { setError(copy.checkError); }
    finally { setBusy(false); }
  };
  const open = async (url: string) => {
    try { await api.openExternal(url); }
    catch { setError(copy.actionError); }
  };
  const source = info?.source;
  const sourceText = !source ? copy.unknown : source.status === "identical" ? copy.sourceCurrent
    : source.status === "ahead" ? `${source.aheadBy} ${copy.sourceAhead}` : copy.sourceChanged;

  return <section className="updates-panel" aria-labelledby="updates-title">
    <header className="updates-heading">
      <h2 id="updates-title">{copy.title}</h2>
      <button className="button-secondary" type="button" onClick={() => void check()}
        disabled={checking || ["disabled", "downloading", "installing"].includes(update.status)}>
        {checking ? copy.checking : copy.check}
      </button>
    </header>
    <dl className="updates-facts">
      <dt>{copy.installed}</dt><dd>{info?.installedBuild || version}</dd>
      <dt>{copy.release}</dt><dd>{info?.release ? <>
        v{info.release.version}<small>{info.release.newer ? copy.newer
          : info.release.version === version ? copy.current : copy.installedNewer}</small>
      </> : update.status === "up-to-date" ? version : copy.unknown}</dd>
      {info?.release && <><dt>{copy.published}</dt><dd>{date(info.release.publishedAt)}</dd></>}
      {info && <>
        <dt>{copy.integrated}</dt><dd><code>{info.integratedCommit?.slice(0, 12) || copy.unknown}</code></dd>
        <dt>{copy.source}</dt><dd>{sourceText}</dd>
        <dt>{copy.checked}</dt><dd>{date(info.checkedAt)}</dd>
      </>}
    </dl>
    <div role="status" aria-live="polite">
      {checking && <p>{copy.checking}</p>}
      {update.status === "disabled" && <p>{copy.disabled}</p>}
      {(error || update.status === "error") && <div className="updates-error" role="alert">
        <p>{error || copy.failed}</p>
        {update.status === "error" && <p>{update.message}</p>}
        {info?.lastSuccessfulCheckAt && <p>{copy.lastSuccess}: {date(info.lastSuccessfulCheckAt)}</p>}
      </div>}
    </div>
    <div className="updates-links">
      <button className="button-secondary" type="button" onClick={() => void open(
        info?.release?.url || "https://github.com/miuuyy/codex-chatgpt-web/releases",
      )}>{copy.notes}</button>
      {source && <button className="button-secondary" type="button" onClick={() => void open(source.url)}>{copy.compare}</button>}
    </div>
    {info && <><p>{copy.explanation}</p><p>{copy.fork}</p></>}
    <p>{copy.schedule}</p>
  </section>;
}
