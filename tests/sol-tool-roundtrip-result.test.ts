import { expect, test } from "bun:test";
import { summarizeSolToolRoundtrip } from "../scripts/sol-tool-roundtrip-result";

const token = "SOLTOOL-random-fixture";
const answer = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
const command = { type: "item.completed", item: { type: "command_execution", aggregated_output: `${token}\n` } };
const done = { type: "turn.completed" };

test("success requires native tool evidence, the exact final answer, and turn completion", () => {
  expect(summarizeSolToolRoundtrip(0, [command, answer(token), done], token)).toMatchObject({ success: true, failureReason: null });
  expect(summarizeSolToolRoundtrip(0, [answer(token), done], token).failureReason).toBe("unverified_tool_result");
  expect(summarizeSolToolRoundtrip(0, [command, answer(token)], token).failureReason).toBe("incomplete_turn");
  expect(summarizeSolToolRoundtrip(0, [command, answer("wrong"), done], token).failureReason).toBe("unexpected_answer");
});

for (const code of ["TOOL_NOT_EXPOSED", "TOOL_CALL_BLOCKED", "TOOL_CALL_FAILED"]) {
  test(`records ${code} as model-reported diagnosis`, () => {
    expect(summarizeSolToolRoundtrip(0, [answer(`${code}\nObserved diagnostic details.`), done], token))
      .toMatchObject({ success: false, failureReason: code, reportedToolFailure: code, diagnosisSource: "model_report" });
  });
}

test("native errors take precedence and conflicting model reports stay unclassified", () => {
  expect(summarizeSolToolRoundtrip(1, [answer("TOOL_NOT_EXPOSED")], token))
    .toMatchObject({ failureReason: "native_error", diagnosisSource: "native_events", reportedToolFailure: "TOOL_NOT_EXPOSED" });
  expect(summarizeSolToolRoundtrip(0, [command, answer(token), done, { type: "turn.failed" }], token).success).toBeFalse();
  expect(summarizeSolToolRoundtrip(0, [answer("TOOL_NOT_EXPOSED or TOOL_CALL_BLOCKED"), done], token))
    .toMatchObject({ failureReason: "unexpected_answer", reportedToolFailure: null });
});
