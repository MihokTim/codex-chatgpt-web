import { expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

test("switching Astra Pro to Sol Pro within the same native turn never replays the other model's answer", async () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const original = worker.run;
  const families: (string | undefined)[] = [];
  worker.run = async turn => {
    families.push(turn.capabilities.browserModelFamily);
    const answer = `answer-from-${turn.capabilities.browserModelFamily}`;
    turn.onTextDelta(answer);
    return answer;
  };
  const send = async (model: string) => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model, stream: true,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "family_replay_thread", turn_id: "family_replay_turn" }) },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Return your answer" }],
          internal_chat_message_metadata_passthrough: { turn_id: "family_replay_turn" } }],
      }),
    }), config);
    expect(response.status).toBe(200);
    return response.text();
  };
  try {
    expect(await send("chatgpt-web/pro")).toContain("answer-from-latest");
    const sol = await send("chatgpt-web/light");
    expect(sol).toContain("answer-from-sol");
    expect(sol).not.toContain("answer-from-latest");
    expect(await send("chatgpt-web/light")).toContain("answer-from-sol");
    expect(families).toEqual(["latest", "sol"]);
  } finally {
    worker.run = original;
    chatGptTurnSessions.clear();
  }
});
