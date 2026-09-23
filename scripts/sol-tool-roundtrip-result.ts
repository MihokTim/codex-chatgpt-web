type NativeEvent = {
  type?: string;
  item?: { type?: string; text?: string; aggregated_output?: string };
};

const toolFailureCodes = ["TOOL_NOT_EXPOSED", "TOOL_CALL_BLOCKED", "TOOL_CALL_FAILED"] as const;
type ReportedToolFailure = typeof toolFailureCodes[number];

/** Keep model-reported diagnosis separate from the native evidence of a successful round trip. */
export function summarizeSolToolRoundtrip(exitCode: number, events: readonly NativeEvent[], token: string) {
  const completed = events.filter(event => event.type === "item.completed");
  const answers = completed.filter(event => event.item?.type === "agent_message")
    .map(event => event.item?.text ?? "");
  const commands = completed.filter(event => event.item?.type === "command_execution");
  const errors = events.filter(event => event.type === "error" || event.type === "turn.failed");
  const finalAnswer = answers.at(-1)?.trim() ?? "";
  const reportedCodes = toolFailureCodes.filter(code => new RegExp(`\\b${code}\\b`).test(finalAnswer));
  // A contradictory answer is not a reliable diagnosis. Preserve the original text for inspection.
  const reportedToolFailure: ReportedToolFailure | null = reportedCodes.length === 1 ? reportedCodes[0]! : null;
  const toolResultVerified = commands.some(event => event.item?.aggregated_output?.includes(token));
  const turnCompleted = events.some(event => event.type === "turn.completed");
  const failureReason = exitCode !== 0 || errors.length > 0 ? "native_error"
    : reportedToolFailure ? reportedToolFailure
    : finalAnswer !== token ? "unexpected_answer"
    : !toolResultVerified ? "unverified_tool_result"
    : !turnCompleted ? "incomplete_turn"
    : null;
  return {
    answers, commands, errors, reportedToolFailure, failureReason,
    diagnosisSource: failureReason === reportedToolFailure && reportedToolFailure !== null ? "model_report" : "native_events",
    success: failureReason === null,
  };
}
