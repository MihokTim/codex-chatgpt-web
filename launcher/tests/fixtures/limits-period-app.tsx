import { createRoot } from "react-dom/client";
import { Gpt6Period } from "../../src/Gpt6Period";
import { useLimits } from "../../src/useLimits";
import type { LimitsApi, LimitsPeriod, LimitsSnapshot } from "../../src/limits-types";

declare global {
  interface Window {
    periodRead(): Promise<LimitsSnapshot>;
    periodSave(period: LimitsPeriod): Promise<LimitsSnapshot>;
  }
}
const api: LimitsApi = {
  getLimits: () => window.periodRead(),
  setupLimits: () => window.periodRead(),
  setLimitsPeriod: period => window.periodSave(period),
  openExternal: async () => false,
};
function App() {
  const tracker = useLimits(api, false);
  return <main className="limits-surface">
    <button type="button" onClick={tracker.refresh}>更新テスト</button>
    {tracker.snapshot ? <Gpt6Period tracker={tracker} language="ja" /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
