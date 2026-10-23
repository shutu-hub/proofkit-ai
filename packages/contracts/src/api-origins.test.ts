import { describe, expect, it } from "vitest";
import { ProofkitConfigSchema } from "./index.js";

describe("explicit API origins", () => {
  it("accepts exact HTTP(S) origins independently of the browser origin", () => {
    const web = { baseUrl: "https://shop.example.test", apiOrigins: ["https://api.example.test", "http://localhost:8080"] };
    expect(ProofkitConfigSchema.parse({ surfaces: { web } }).surfaces.web?.apiOrigins).toEqual(web.apiOrigins);
  });
  it.each(["invalid", "https://*.example.test", "https://api.example.test/", "https://api.example.test/path", "https://api.example.test?key=x",
    "https://api.example.test#fragment", "https://user:password@api.example.test", "file:///tmp/api", "ftp://api.example.test"])("rejects %s", (origin) => {
    expect(ProofkitConfigSchema.safeParse({ surfaces: { web: { apiOrigins: [origin] } } }).success).toBe(false);
  });
  it("rejects duplicate and unbounded origin lists", () => {
    for (const apiOrigins of [["https://api.example.test", "https://api.example.test"], Array.from({ length: 9 }, (_, index) => "https://api" + index + ".example.test")]) {
      expect(ProofkitConfigSchema.safeParse({ surfaces: { web: { apiOrigins } } }).success).toBe(false);
    }
  });
});
