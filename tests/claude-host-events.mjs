/** Claude Code stream-json observations. Only a completed tool_result counts as a read. */
export function parseClaudeToolEvents(jsonl, serverName) {
  const prefix = `mcp__${serverName}__`;
  const calls = new Map();
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const block of Array.isArray(event?.message?.content) ? event.message.content : []) {
      if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string"
        && typeof block.name === "string" && block.name.startsWith(prefix)) {
        calls.set(block.id, { id: block.id, server: serverName, tool: block.name.slice(prefix.length),
          arguments: block.input ?? {}, status: "in_progress", isError: false, result: undefined });
      }
      if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        call.status = block.is_error ? "failed" : "completed";
        call.isError = Boolean(block.is_error);
        call.result = decodeToolResult(block.content);
      }
    }
  }
  return [...calls.values()];
}

/** Intermediate assistant text is never an official host answer. */
export function parseClaudeHostAnswer(jsonl) {
  for (const line of jsonl.split(/\r?\n/).reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "result" || event.subtype !== "success" || event.is_error) continue;
    if (event.structured_output && typeof event.structured_output === "object") return event.structured_output;
    if (typeof event.result === "string") {
      try { return JSON.parse(event.result); } catch { return undefined; }
    }
  }
  return undefined;
}

function decodeToolResult(content) {
  if (Array.isArray(content)) return decodeToolResult(content.find((item) => item?.type === "text")?.text);
  if (content && typeof content === "object") {
    if (content.structuredContent) return content.structuredContent;
    if (content.content) return decodeToolResult(content.content);
    return content;
  }
  if (typeof content !== "string") return undefined;
  try { return decodeToolResult(JSON.parse(content)); } catch { return undefined; }
}
