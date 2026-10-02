import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Content-free receipt/reply observations. A sent MCP result is not proof of tool execution. */
export function observeMcpToolCalls(
  transport: Transport,
  knownTools: ReadonlySet<string>,
  write: (event: Record<string, unknown>) => void = event => console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
): Transport {
  let sequence = 0;
  const pending = new Map<string | number, {
    call: number; tool: string; started: number; replies: number; ambiguous: boolean;
  }>();
  const emit = (event: Record<string, unknown>) => {
    // Logging is observational: a broken sink cannot change the invocation or its result.
    try { write({ at: new Date().toISOString(), pid: process.pid, ...event }); } catch { /* Preserve transport semantics. */ }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      const tool = typeof name === "string" && knownTools.has(name) ? name : "unknown";
      const previous = pending.get(message.id);
      if (previous) {
        // An ambiguous protocol ID cannot safely correlate either reply.
        previous.ambiguous = true;
        previous.replies += 1;
        emit({ event: "uncorrelated_call", reason: "duplicate_id", tool });
      } else if (pending.size >= 1_024) {
        emit({ event: "uncorrelated_call", reason: "tracking_limit", tool });
      } else {
        const call = { call: ++sequence, tool, started: performance.now(), replies: 1, ambiguous: false };
        pending.set(message.id, call);
        emit({ event: "call_received", call: call.call, tool });
      }
    }
    receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const call = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
    try {
      await send(message, options);
      if (call && !call.ambiguous) {
        const result = "result" in message ? message.result : undefined;
        emit({
          event: "reply_sent", call: call.call, tool: call.tool,
          elapsed_ms: Math.round(performance.now() - call.started),
          outcome: "error" in message ? "protocol_error" : "result",
          ...("result" in message ? { is_error: result?.isError === true } : {}),
        });
      }
    } catch (error) {
      if (call && !call.ambiguous) emit({ event: "reply_send_failed", call: call.call, tool: call.tool });
      throw error;
    } finally {
      // Keep an ambiguous ID until every outstanding reply has settled. Otherwise
      // a late old reply could be misattributed to a new call reusing that ID.
      if (call && id !== undefined && id !== null && pending.get(id) === call) {
        call.replies -= 1;
        if (call.replies === 0) pending.delete(id);
      }
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    emit({ event: "transport_closed", tracked_calls: pending.size });
    pending.clear();
    close?.();
  };
  return transport;
}
