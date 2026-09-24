import { expect, test } from "bun:test";
import { issuedToolCallProof, nativeToolCallProof } from "../src/adapters/chatgpt-web/native-tool-proof";

test("call proofs preserve namespaced identity and normalize only JSON object order", () => {
  const request = { callId: "saved", wireName: "files__write", freeform: false,
    arguments: { path: "alpha.txt", options: { append: false, mode: "text" }, values: [1, 2] } };
  const expected = issuedToolCallProof(request);
  const history = { type: "function_call", name: "write", namespace: "files",
    arguments: '{"values":[1,2],"options":{"mode":"text","append":false},"path":"alpha.txt"}' };
  expect(nativeToolCallProof(history)).toBe(expected);
  expect(nativeToolCallProof({ ...history, namespace: "other" })).not.toBe(expected);
  expect(nativeToolCallProof({ ...history, arguments: history.arguments.replace("[1,2]", "[2,1]") })).not.toBe(expected);
  expect(nativeToolCallProof({ ...history, arguments: "null" })).toBeUndefined();
  expect(nativeToolCallProof({ ...history, arguments: "invalid" })).toBeUndefined();
  const plain = { type: "function_call", name: "write", arguments: "{}" };
  expect(nativeToolCallProof({ ...plain, namespace: null })).toBe(nativeToolCallProof(plain));
});

test("freeform and tool search proofs retain their native call contracts", () => {
  const custom = { callId: "patch", wireName: "apply_patch", freeform: true, input: "exact\npatch\n" };
  expect(nativeToolCallProof({ type: "custom_tool_call", name: custom.wireName, input: custom.input }))
    .toBe(issuedToolCallProof(custom));
  expect(nativeToolCallProof({ type: "custom_tool_call", name: custom.wireName, input: "exact\npatch" }))
    .not.toBe(issuedToolCallProof(custom));
  expect(nativeToolCallProof({ type: "function_call", name: custom.wireName,
    arguments: JSON.stringify({ input: custom.input }) })).not.toBe(issuedToolCallProof(custom));
  const search = { callId: "search", wireName: "tool_search", freeform: false, arguments: { query: "tools", limit: 3 } };
  expect(nativeToolCallProof({ type: "tool_search_call", arguments: { limit: 3, query: "tools" } }))
    .toBe(issuedToolCallProof(search));
  expect(nativeToolCallProof({ type: "tool_search_call", arguments: '{"query":"tools"}' })).toBeUndefined();
});
