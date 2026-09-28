export type LimitsPeriod = { mode: "off" } | { mode: "since"; startAt: number }
  | { mode: "weekly"; weekday: number; hour: number; minute: number };

export interface Gpt6PeriodSummary {
  startAt: number;
  endAt: number;
  nextStartAt: number | null;
  availableSince: number;
  used: number;
  uncertainUsed: number;
  partialHistory: boolean;
  future: boolean;
  timeZone: string;
}

export interface LimitsWindow {
  id: string;
  label: string;
  model: "gpt-6-pro" | "gpt-5.6-pro" | "shared";
  durationMs: number;
  limit: number;
  // Observed sends; shared windows already include messages with an unknown Pro model.
  used: number;
  // Unknown Pro model, excluded from family used counts and included in shared used counts.
  uncertainUsed: number;
}

export interface LimitsSnapshot {
  enabled: boolean;
  plan: null | "pro_100" | "pro_200" | "unsupported";
  trackingSince: number | null;
  checkedAt: number | null;
  // Retained local history (rolling seven days), not a lifetime total.
  totalMessages: number;
  unknownProMessages: number;
  incomplete: boolean;
  windows: LimitsWindow[];
  period?: LimitsPeriod;
  periodError?: string | null;
  gpt6Period?: Gpt6PeriodSummary | null;
  disabledReason?: "zero-risk" | null;
  error?: string | null;
}

export interface LimitsApi {
  getLimits(): Promise<LimitsSnapshot>;
  setupLimits(): Promise<LimitsSnapshot>;
  setLimitsPeriod(period: LimitsPeriod): Promise<LimitsSnapshot>;
  openExternal(url: string): Promise<boolean>;
}
