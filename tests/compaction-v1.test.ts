import { expect, test } from "bun:test";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("compaction retains human instructions, not native grouped runtime preambles", () => {
  const message = (id: string, kinds: string[], texts: string[]) => ({
    type: "message", role: "user", id,
    content: texts.map(text => ({ type: "input_text", text })),
    internal_chat_message_metadata_passthrough: { turn_id: "turn_context", content_item_kinds: kinds },
  });
  const human = message("human", ["user.text"], ["Continue the task"]);
  const grouped = message("runtime", ["agents_md.instructions", "environments.environment_context"],
    ["# AGENTS.md instructions\nFollow the repository rules", "<environment_context><cwd>/project</cwd></environment_context>"]);
  const mixed = message("mixed", ["user.text", "agents_md.instructions"], ["A real human instruction", "Repository rules"]);
  const unknown = message("unknown", ["future.kind"], ["Preserve unknown input"]);
  const context = message("context", ["environments.environment_context"], ["<environment_context>cwd</environment_context>"]);
  const notification = message("notification", ["multi_agent.subagent_notification"], ["<subagent_notification>Done</subagent_notification>"]);
  const input = [human, grouped, context, notification, mixed, unknown];
  const saved = structuredClone(input);
  expect(extractCompactUserMessages(input)).toEqual([human, mixed, unknown]);
  expect(input).toEqual(saved);
});

test.each([undefined, ["user.text"], ["future.kind"], ["user.text", "environments.environment_context"]].map(kinds => ({ kinds })))(
  "compaction preserves human or unattributed XML with provenance %j", ({ kinds }) => {
    const messages = ["environment_context", "subagent_notification", "goal_context", "codex_internal_context"].map(tag => ({
      type: "message", role: "user", content: [
        { type: "input_text", text: "Review this XML without discarding the instruction." },
        { type: "input_text", text: `<${tag}${tag === 'codex_internal_context' ? ' source="example"' : ''}>Review this example.</${tag}>` },
      ],
      ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
    }));
    expect(extractCompactUserMessages(messages)).toEqual(messages);
    expect(buildCompactV1Output(extractCompactUserMessages(messages), "Summary").slice(0, -1)).toEqual(messages);
  },
);

test("v1 compaction keeps only the newest ten structured images without copying them into text", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  const imageUrls = retained.flatMap(item => item.content
    .filter(block => block.type === "input_image")
    .map(block => block.image_url));
  expect(imageUrls).toEqual(input.slice(2).map(item => item.content[1]!.image_url));
  expect(retained.flatMap(item => item.content)
    .filter(block => block.type === "input_text")
    .every(block => !block.text?.includes("data:image"))).toBe(true);
  expect(retained.at(-1)?.content.at(-1)).toMatchObject({ detail: "high" });
});

test("v1 compaction drops persisted one-pixel image sentinels", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).toContain("data:image/png;base64,real-image");
});
