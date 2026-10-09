import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, createConnection, type Server } from "node:net";

type Endpoint = string | { host: string; port: number };
type Request = { key: string; command: "status" | "cancel"; reason?: string };
type Response = { accepted: boolean; active: boolean };

export type MissionExecutionLease = { release(): Promise<void> };

/** A process-owned socket is released by the OS even if Node exits without cleanup. */
export class MissionOwnership {
  constructor(private readonly rootDir: string) {}

  async acquire(missionId: string, onCancel?: (reason: string) => void): Promise<MissionExecutionLease | undefined> {
    const { endpoint, key } = await this.address(missionId);
    const server = createServer((socket) => {
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      let input = "";
      let handled = false;
      socket.on("data", (chunk: Buffer) => {
        if (handled) return;
        input += chunk.toString("utf8");
        if (input.length > 2_048) {
          socket.destroy();
          return;
        }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        try {
          const request = JSON.parse(input.slice(0, newline)) as Request;
          const valid = request.key === key && (request.command === "status" || request.command === "cancel");
          const accepted = valid && request.command === "cancel" && onCancel !== undefined;
          if (accepted) onCancel!(typeof request.reason === "string" ? request.reason.slice(0, 500) : "Mission cancelled by another client");
          socket.end(`${JSON.stringify({ accepted, active: valid } satisfies Response)}\n`);
        } catch {
          socket.end(`${JSON.stringify({ accepted: false, active: false } satisfies Response)}\n`);
        }
      });
    });
    try {
      await listen(server, endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        try {
          const response = await request(endpoint, { key, command: "status" });
          if (response?.active) return undefined;
        } catch {
          // A stale or unrelated endpoint is not proof that this Mission has
          // a live owner. The caller can retry after investigating the port.
        }
        throw new Error(`Mission ${missionId} execution endpoint is occupied but its owner could not be verified`);
      }
      throw error;
    }
    return {
      release: () => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }),
    };
  }

  async isActive(missionId: string): Promise<boolean> {
    const { endpoint, key } = await this.address(missionId);
    try {
      const response = await request(endpoint, { key, command: "status" });
      // An occupied but unresponsive endpoint is treated as busy, never stolen.
      return response?.active ?? true;
    } catch (error) {
      if (isAbsentEndpoint(error)) return false;
      return true;
    }
  }

  async cancel(missionId: string, reason: string): Promise<boolean> {
    const { endpoint, key } = await this.address(missionId);
    try {
      const response = await request(endpoint, { key, command: "cancel", reason: reason.slice(0, 500) });
      if (!response?.active) throw new Error("Mission execution endpoint is occupied but did not identify the Mission");
      return response.accepted;
    } catch (error) {
      if (isAbsentEndpoint(error)) return false;
      throw error;
    }
  }

  private async address(missionId: string): Promise<{ endpoint: Endpoint; key: string }> {
    await mkdir(this.rootDir, { recursive: true });
    const canonical = await realpath(this.rootDir);
    const namespace = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const key = createHash("sha256").update(namespace).update("\0").update(missionId).digest("hex");
    if (process.platform === "win32") return { endpoint: `\\\\.\\pipe\\proofkit-mission-${key}`, key };
    if (process.platform === "linux") return { endpoint: `\0proofkit-mission-${key}`, key };
    // On systems without abstract Unix sockets, use a deterministic loopback
    // address. A rare address collision blocks execution instead of duplicating it.
    const host = `127.${parseInt(key.slice(0, 2), 16)}.${parseInt(key.slice(2, 4), 16)}.${parseInt(key.slice(4, 6), 16)}`;
    const port = 20_000 + (parseInt(key.slice(6, 10), 16) % 40_000);
    return { endpoint: { host, port }, key };
  }
}

function listen(server: Server, endpoint: Endpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (typeof endpoint === "string") server.listen(endpoint);
    else server.listen(endpoint.port, endpoint.host);
  });
}

function request(endpoint: Endpoint, message: Request): Promise<Response | undefined> {
  return new Promise((resolve, reject) => {
    const socket = typeof endpoint === "string"
      ? createConnection(endpoint)
      : createConnection(endpoint.port, endpoint.host);
    let settled = false;
    let output = "";
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    socket.setTimeout(2_000, () => finish(new Error("Mission execution endpoint did not respond")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2_048) return finish(new Error("Mission execution endpoint returned too much data"));
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(output.slice(0, newline)) as Response;
        if (typeof parsed.active !== "boolean" || typeof parsed.accepted !== "boolean") throw new Error("Invalid response");
        finish(undefined, parsed);
      } catch {
        finish(new Error("Mission execution endpoint returned an invalid response"));
      }
    });
    socket.once("close", () => finish());
  });
}

function isAbsentEndpoint(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
}
