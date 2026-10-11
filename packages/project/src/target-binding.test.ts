import { describe, expect, it } from "vitest";
import { classifyTargetBinding, inspectTargetBinding, parseLinuxListeningInodes, windowsCommandCodePaths } from "./target-binding.js";

const expectedRoot = "D:/code/AIHR";
const origin = "http://localhost:5174";

describe("target binding", () => {
  it("extracts only absolute Windows script arguments, whether quoted or not", () => {
    expect(windowsCommandCodePaths('"C:\\Program Files\\nodejs\\node.exe" C:\\work\\app\\server.mjs --cache="C:\\other\\cache.js"'))
      .toEqual(["C:\\Program Files\\nodejs\\node.exe", "C:\\work\\app\\server.mjs"]);
    expect(windowsCommandCodePaths('node "C:\\work space\\app\\server.js" relative.js')).toEqual(["C:\\work space\\app\\server.js"]);
    expect(windowsCommandCodePaths('node "C:\\unfinished.js')).toEqual([]);
  });

  it("distinguishes a matching listener process path from a different checkout", () => {
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12, projectRoot: expectedRoot }]))
      .toMatchObject({ status: "matching-process-path", processId: 12 });
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12, projectRoot: "D:/tmp/aihr-hotfix" }]))
      .toMatchObject({ status: "different-project", observedProjectRoot: "D:/tmp/aihr-hotfix", processId: 12 });
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12, projectRoot: expectedRoot }],
      new Date().toISOString(), "linux-proc-listener")).toMatchObject({ status: "matching-process-path", method: "linux-proc-listener" });
  });

  it("selects only listening Linux socket inodes on the target port and rejects a foreign owner", () => {
    const header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
    const row = (port: string, state: string, uid: number, inode: number) =>
      `0: 0100007F:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode}`;
    const table = [header, row("1F90", "0A", 1000, 12345), row("1F90", "01", 1000, 23456),
      row("1F91", "0A", 1000, 34567)].join("\n");
    expect([...parseLinuxListeningInodes([table], 8080, 1000)]).toEqual(["12345"]);
    expect(() => parseLinuxListeningInodes([`${header}\n${row("1F90", "0A", 0, 45678)}`], 8080, 1000))
      .toThrow("another user");
    expect(() => parseLinuxListeningInodes([`${header}\n0: 0100007F:1F90 00000000:0000 0A`], 8080, 1000))
      .toThrow("metadata is incomplete");
  });

  it("matches the target loopback address instead of every listener on the port", () => {
    const header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
    const row = (address: string, inode: number) =>
      `0: ${address}:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`;
    const ipv4 = [header,
      row("0100007F", 101), // 127.0.0.1
      row("0200007F", 102), // 127.0.0.2
      row("0102A8C0", 103), // 192.168.2.1
      row("00000000", 104), // all IPv4 interfaces
    ].join("\n");
    const ipv6 = [header,
      row("00000000000000000000000001000000", 105), // ::1
      row("00000000000000000000000000000000", 106), // all IPv6 interfaces
    ].join("\n");

    expect([...parseLinuxListeningInodes([ipv4, ipv6], 8080, 1000, "127.0.0.1")]).toEqual(["101", "104"]);
    expect([...parseLinuxListeningInodes([ipv4, ipv6], 8080, 1000, "127.0.0.2")]).toEqual(["102", "104"]);
    expect([...parseLinuxListeningInodes([ipv4, ipv6], 8080, 1000, "[::1]")]).toEqual(["105", "106"]);
    expect([...parseLinuxListeningInodes([ipv4, ipv6], 8080, 1000, "localhost")]).toEqual(["101", "104", "105", "106"]);
  });

  it("leaves missing or conflicting process roots unverified", () => {
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12 }]).status).toBe("unverified");
    expect(classifyTargetBinding(expectedRoot, origin, [
      { processId: 12, projectRoot: expectedRoot },
      { processId: 13, projectRoot: "D:/tmp/other" },
    ]).status).toBe("unverified");
  });

  it("does not claim source ownership when no local HTTP target is available", async () => {
    expect((await inspectTargetBinding(expectedRoot)).status).toBe("unverified");
    expect((await inspectTargetBinding(expectedRoot, "https://example.com/app")).status).toBe("unverified");
    expect((await inspectTargetBinding(expectedRoot, "file:///app/index.html")).status).toBe("unverified");
  });

  it("does not turn caller cancellation into an unverified target", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop target inspection"));
    await expect(inspectTargetBinding(expectedRoot, origin, controller.signal)).rejects.toThrow("stop target inspection");
  });
});
