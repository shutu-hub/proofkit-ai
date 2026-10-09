import { describe, expect, it } from "vitest";
import { extractGinRoutes } from "./gin-routes.js";

function scan(body: string, signature = "func routes()") {
  return extractGinRoutes(`package routes\nimport "github.com/gin-gonic/gin"\n${signature} {\n${body}\n}`, "router.go")!;
}

describe("Gin route discovery", () => {
  it("composes the real AIHR file-upload group including the empty method path", () => {
    const result = scan(`engine := gin.New()
api := engine.Group("/api/v1")
if deps.Files != nil {
  group := api.Group("/resume-collection/files")
  group.POST("", files.Upload)
  group.GET("", files.List)
  group.GET("/:file_id", files.Detail)
}`);
    expect(result.routes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/api/v1/resume-collection/files" },
      { method: "GET", path: "/api/v1/resume-collection/files" },
      { method: "GET", path: "/api/v1/resume-collection/files/:file_id" },
    ]);
    expect(result.routes[0]).toMatchObject({ source: "router.go", line: 8, discovery: "gin" });
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps sibling blocks separate and supports aliases, chains and trailing slashes", () => {
    const result = scan(`engine := gin.Default()
api := engine.Group("/api/v1")
if one { group := api.Group("/files"); group.GET("", handler) }
if two { group := api.Group("/jobs"); group.GET("/:id", handler) }
alias := api
alias.Group("/users").Group("").PATCH("/:id/", handler)`);
    expect(result.routes.map((route) => route.path)).toEqual(["/api/v1/files", "/api/v1/jobs/:id", "/api/v1/users/:id/"]);
  });

  it("handles multiline declarations, raw strings and aliased imports", () => {
    const result = extractGinRoutes('package routes\nimport (\n  g "github.com/gin-gonic/gin"\n)\nfunc routes() {\nengine := g.New()\napi := engine.Group(\n `/api/v1`,\n)\napi.GET(\n `/:id`,\n handler,\n)\n}', "routes.go")!;
    expect(result.routes).toEqual([expect.objectContaining({ path: "/api/v1/:id", method: "GET", line: 10 })]);
  });

  it("does not treat comment, string or handler contents as route declarations", () => {
    const result = scan('engine := gin.New()\n// engine.GET("/fake", handler)\ns := `engine.GET("/fake-raw", handler)`\n/* engine.POST("/fake-block", handler) */\nengine.GET("/real", func(c *gin.Context) { engine.GET("/runtime", handler) })\n_ = s');
    expect(result.routes.map((route) => route.path)).toEqual(["/real"]);
  });

  it("records dynamic paths and typed helper prefixes without emitting fragments", () => {
    const result = scan(`api := gin.New().Group("/api/v1")
api.GET(prefix + "/files", handler)
group := api.Group(prefix)
group.POST("/files", handler)
incoming.GET("/:id", handler)`, "func routes(incoming *gin.RouterGroup)");
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["dynamic-path", "unknown-router-prefix", "unknown-router-prefix"]);
  });

  it("recognizes grouped typed parameters and method receivers as unknown prefixes", () => {
    const result = scan('one.GET("/one", h)\ntwo.POST("/two", h)\nr.GET("/receiver", h)', "func (r *gin.RouterGroup) routes(one, two *gin.RouterGroup)");
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(Array(3).fill("unknown-router-prefix"));
  });

  it("keeps unsupported registration operations explicit", () => {
    const result = scan('api := gin.New()\napi.Any("/all", h)\napi.Handle("TRACE", "/trace", h)');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["unsupported-router-operation", "unsupported-router-operation"]);
  });

  it("invalidates stale prefixes after unresolved reassignment and tuple assignment", () => {
    const result = scan(`api := gin.New().Group("/original")
api = factory()
api.GET("/first", h)
api = gin.New().Group("/reset")
api, err = factory()
api.GET("/second", h)
_ = err`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["unknown-router-prefix", "unknown-router-prefix"]);
  });

  it("does not leak conditional header prefixes into outer declarations", () => {
    const result = scan(`api := gin.New().Group("/original")
if api := gin.New().Group("/conditional"); ready {
  api.GET("/inside", h)
}
api.GET("/outside", h)`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("invalidates conditional assignments to outer routers", () => {
    const result = scan(`api := gin.New().Group("/original")
if ready { api = gin.New().Group("/other") }
api.GET("/unknown", h)`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics[0]?.reason).toBe("unknown-router-prefix");
  });

  it("does not interpret a shadowed import alias or function parameter as a known router", () => {
    const result = scan(`gin := fake()
api := gin.New()
api.GET("/fake", h)`);
    expect(result.routes).toEqual([]);
    const shadowed = extractGinRoutes('package routes\nimport "github.com/gin-gonic/gin"\nvar engine = gin.New()\nfunc routes(engine FakeRouter, gin FakePackage) {\nengine.GET("/fake", h)\napi := gin.New()\napi.GET("/fake2", h)\n}', "router.go")!;
    expect(shadowed.routes).toEqual([]);
  });

  it("invalidates aliases after a router field mutation", () => {
    const result = scan(`api := gin.New().Group("/original")
alias := api
api.RouterGroup = replacement
alias.GET("/unknown", h)`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics[0]?.reason).toBe("unknown-router-prefix");
  });

  it("does not preserve router prefixes behind typed variable shadows or tuple field writes", () => {
    const result = scan(`api := gin.New().Group("/outer")
{ var api FakeRouter; api.GET("/fake", h) }
{ var api *gin.RouterGroup; api.GET("/unknown", h) }
api.RouterGroup, err = replacement()
api.GET("/mutated", h)`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("keeps parameter shadowing when a function returns an anonymous struct", () => {
    const result = extractGinRoutes('package routes\nimport "github.com/gin-gonic/gin"\nvar api = gin.New().Group("/global")\nfunc routes(api *gin.RouterGroup) struct { Value int } {\napi.GET("/unknown", h)\nreturn struct { Value int }{}\n}', "router.go")!;
    expect(result.routes).toEqual([]);
    expect(result.diagnostics[0]?.reason).toBe("unknown-router-prefix");
  });

  it("does not inherit outer prefixes through grouped variable declarations", () => {
    const result = scan('api := gin.New().Group("/outer")\n{\nvar (\n api FakeRouter\n other *gin.RouterGroup\n)\napi.GET("/fake", h)\nother.GET("/unknown", h)\n}\napi.GET("/real", h)');
    expect(result.routes.map((route) => route.path)).toEqual(["/outer/real"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("does not interpret an equality comparison as router reassignment", () => {
    const result = scan('api := gin.New().Group("/api")\nif api == other { api.GET("/same", h) }\napi.GET("/after", h)');
    expect(result.routes.map((route) => route.path)).toEqual(["/api/same", "/api/after"]);
  });

  it("does not confuse strings containing syntax tokens with Go syntax", () => {
    const result = scan('api := gin.New()\n_ = "func"\n_ = "{"\n_ = "import"\napi.GET("/real", h)\n_ = "}"');
    expect(result.routes.map((route) => route.path)).toEqual(["/real"]);
  });

  it("honors newline statement boundaries inside block comments", () => {
    const result = scan('api := gin.New() /* comment\ncontinues */ api.GET("/real", h)');
    expect(result.routes.map((route) => route.path)).toEqual(["/real"]);
  });

  it("does not fall back to fragment extraction for blank or dot Gin imports", () => {
    for (const alias of ["_", "."]) {
      expect(extractGinRoutes(`package routes\nimport ${alias} "github.com/gin-gonic/gin"\nfunc routes() { api.GET("/:id", h) }`, "router.go")).toEqual({ routes: [], diagnostics: [] });
    }
    expect(extractGinRoutes('// github.com/gin-gonic/gin\napi.GET("/not-gin", h)', "router.go")).toBeUndefined();
  });

  it("rejects route literals with queries, interpolation or unsupported Go escapes", () => {
    const result = scan('api := gin.New()\napi.GET("/query?token=x", h)\napi.GET("/users/${id}", h)\napi.GET("/\\x61", h)');
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(Array(3).fill("dynamic-path"));
  });
});
