import { describe, expect, it } from "vitest";
import type { CharterCatalogEntry } from "@proofkit/contracts";
import { selectCatalogCharter } from "./catalog.js";

const entries: CharterCatalogEntry[] = [
  { id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["简历", "简历获取"], level: "core", surfaces: ["web", "electron"] },
  { id: "resume-duplicate", path: ".proofkit/charters/duplicate.yml", aliases: ["简历重复上传"], level: "core", surfaces: ["web"] },
  { id: "login-quick", path: ".proofkit/charters/login.yml", aliases: ["登录"], level: "quick", surfaces: ["web"] },
  { id: "login-core", path: ".proofkit/charters/login-core.yml", aliases: ["登录"], level: "core", surfaces: ["web"] },
  { id: "release-web-only", path: ".proofkit/charters/release.yml", aliases: ["上线检查"], level: "release", surfaces: ["web"] },
];

describe("test catalog selection", () => {
  it("uses the most specific configured alias for the selected level and surface", () => {
    expect(selectCatalogCharter(entries, { intent: "测试简历获取核心链路", level: "core", surface: "electron" }))
      .toMatchObject({ entry: { id: "resume-core" }, matchedAlias: "简历获取" });
    expect(selectCatalogCharter(entries, { intent: "测试简历重复上传", level: "core", surface: "web" }))
      .toMatchObject({ entry: { id: "resume-duplicate" }, matchedAlias: "简历重复上传" });
    expect(selectCatalogCharter(entries, { intent: "测试未知功能", level: "core", surface: "web" })).toBeUndefined();
    expect(selectCatalogCharter(entries, { intent: "上线检查", level: "release", surface: "web" })).toBeUndefined();
  });

  it("accepts an explicit ID only within its declared level and surface", () => {
    expect(selectCatalogCharter(entries, { intent: "无关措辞", level: "quick", surface: "web", charterId: "login-quick" }))
      .toMatchObject({ entry: { id: "login-quick" } });
    expect(() => selectCatalogCharter(entries, { intent: "登录", level: "core", surface: "web", charterId: "login-quick" })).toThrow("does not support");
    expect(() => selectCatalogCharter(entries, { intent: "登录", level: "quick", surface: "electron", charterId: "login-quick" })).toThrow("does not support");
  });

  it("requires an explicit ID for tied aliases and rejects duplicate IDs", () => {
    const tied = [...entries, { id: "other", path: "other.yml", aliases: ["简历获取"], level: "core" as const, surfaces: ["web" as const] }];
    expect(() => selectCatalogCharter(tied, { intent: "简历获取", level: "core", surface: "web" })).toThrow("Ambiguous test catalog match");
    expect(() => selectCatalogCharter([...entries, entries[0]!], { intent: "简历获取", level: "core", surface: "web" })).toThrow("Duplicate test catalog ID");
    expect(() => selectCatalogCharter(entries, { intent: "先登录再测试简历获取", level: "core", surface: "web" })).toThrow("Ambiguous test catalog match");
    expect(() => selectCatalogCharter(entries, { intent: "上线检查", level: "release", surface: "web", charterId: "release-web-only" })).toThrow("does not support");
  });
});
