import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/** A host access failure says nothing about ProofKit's or the model's test quality. */
export function classifyHostBlocker(jsonl) {
  let approvalCancelled = false;
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "error") {
      const provider = providerBlocker(event.message);
      if (provider) return provider;
    }
    if (event.item?.type === "mcp_tool_call" && event.item.status === "failed"
      && /user cancelled MCP tool call/i.test(JSON.stringify(event.item.error ?? event.item.result ?? {}))) {
      approvalCancelled = true;
    }
  }
  return approvalCancelled ? "mcp-tool-call-cancelled" : null;
}

function providerBlocker(message) {
  if (typeof message !== "string") return null;
  if (/insufficient[ _-]*(?:balance|quota)|quota[ _-]*exceeded|billing[ _-]*(?:limit|error)/i.test(message)) return "provider-balance";
  if (/\b(?:401 Unauthorized|403 Forbidden)\b|invalid[ _-]*(?:api[ _-]*)?key|authentication[ _-]*failed/i.test(message)) return "provider-access";
  return null;
}

/** Keep the complete event trace on disk and stop provider retries on a decisive access error. */
export async function runHost(executable, args, cwd, timeoutMs, eventsPath) {
  const started = Date.now();
  const events = createWriteStream(eventsPath);
  const decoder = new StringDecoder("utf8");
  let partialLine = "";
  let eventBytes = 0;
  let stopReason = null;
  let timedOut = false;
  let child;
  let stopping = false;
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill(); } catch { /* already stopped */ } });
      killer.on("exit", (code) => { if (code !== 0) try { child.kill(); } catch { /* already stopped */ } });
      setTimeout(() => { if (child.exitCode === null) try { child.kill(); } catch { /* already stopped */ } }, 5_000).unref();
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch { /* already stopped */ } }
      setTimeout(() => { if (child.exitCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ } }, 5_000).unref();
    }
  };
  const execution = await new Promise((resolveRun, reject) => {
    child = spawn(executable, args, { cwd, windowsHide: true, shell: false,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; stop("host-deadline-exceeded"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      eventBytes += chunk.length;
      if (eventBytes > MAX_EVENT_BYTES) { stop("host-event-limit-exceeded"); return; }
      if (!events.write(chunk)) child.stdout.pause();
      partialLine += decoder.write(chunk);
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() ?? "";
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "error") {
          const provider = providerBlocker(event.message);
          if (provider) { stop(provider); break; }
        }
      }
    });
    events.on("drain", () => child.stdout.resume());
    child.stderr.resume(); // Drain without persisting account/provider details.
    let finished = false;
    const finish = (error, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      events.end(() => error ? reject(error) : resolveRun({ code, timedOut, stopReason, durationMs: Date.now() - started }));
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(null, code));
    events.once("error", (error) => { stop("host-event-write-failed"); reject(error); });
  });
  const transcript = await readFile(eventsPath, "utf8");
  return { ...execution, transcript, blocker: classifyHostBlocker(transcript) ??
    (execution.stopReason === "provider-balance" || execution.stopReason === "provider-access" ? execution.stopReason : null) };
}
