import { posix } from "node:path";
import type { ProjectMap, RouteHttpMethod } from "@proofkit/contracts";

type Route = ProjectMap["inventory"]["routeHints"][number];
type Diagnostic = NonNullable<ProjectMap["inventory"]["routeDiagnostics"]>["items"][number];
type Token = { kind: "id" | "string" | "symbol" | "newline" | "opaque"; value: string; line: number };
// undefined: not a known router; null: a router with an unresolved base path.
type Binding = string | null | undefined;
type Expression = { prefix: Binding; end: number };
const METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** A conservative, file-local Gin declaration extractor. It never evaluates Go code. */
export function extractGinRoutes(content: string, source: string): { routes: Route[]; diagnostics: Diagnostic[] } | undefined {
  if (!content.includes("github.com/gin-gonic/gin")) return undefined;
  const tokens = tokenize(content);
  const { aliases: imports, found } = ginImports(tokens);
  if (!found) return undefined;
  const scopes: Array<Map<string, Binding>> = [new Map()];
  const routes: Route[] = [];
  const diagnostics: Diagnostic[] = [];
  type HelperTemplate = { path: string; method: RouteHttpMethod; line: number };
  type Helper = { name: string; nameIndex: number; parameter: string; end: number; templates: HelperTemplate[]; mutated: boolean };
  const helpers: Helper[] = [];
  const calls = new Map<string, Binding[]>();
  let activeHelper: Helper | undefined;
  const diagnose = (token: Token, reason: Diagnostic["reason"]) => diagnostics.push({ extractor: "gin", source, line: token.line, reason });
  const lookup = (name: string): Binding => {
    for (let index = scopes.length - 1; index >= 0; index--) if (scopes[index]!.has(name)) return scopes[index]!.get(name);
    return undefined;
  };
  const next = (index: number): number => { while (tokens[index]?.kind === "newline") index++; return index; };
  const symbol = (index: number, value: string): boolean => tokens[index]?.kind === "symbol" && tokens[index]?.value === value;
  const identifier = (index: number, value: string): boolean => tokens[index]?.kind === "id" && tokens[index]?.value === value;
  const closeCall = (open: number): number => {
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
      if (tokens[index]!.kind === "symbol" && tokens[index]!.value === "(") depth++;
      if (tokens[index]!.kind === "symbol" && tokens[index]!.value === ")" && --depth === 0) return index;
    }
    return tokens.length;
  };
  const closeBlock = (open: number): number => {
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
      if (symbol(index, "{")) depth++;
      if (symbol(index, "}") && --depth === 0) return index;
    }
    return tokens.length;
  };
  const literalArgument = (open: number): string | undefined => {
    const first = next(open + 1);
    const after = next(first + 1);
    return tokens[first]?.kind === "string" && (symbol(after, ",") || symbol(after, ")")) ? tokens[first]!.value : undefined;
  };
  const expression = (start: number): Expression | undefined => {
    const token = tokens[start];
    if (token?.kind !== "id") return undefined;
    let prefix = lookup(token.value);
    let end = start + 1;
    if (imports.has(token.value) && !scopes.some((scope) => scope.has(token.value)) && symbol(end, ".") && (identifier(end + 1, "New") || identifier(end + 1, "Default")) && symbol(end + 2, "(")) {
      const close = closeCall(end + 2);
      prefix = next(end + 3) === close ? "" : null;
      end = close + 1;
    }
    if (prefix === undefined) return undefined;
    while (symbol(end, ".") && identifier(end + 1, "Group") && symbol(end + 2, "(")) {
      const path = literalArgument(end + 2);
      prefix = typeof prefix === "string" && path !== undefined ? composePath(prefix, path) : null;
      end = closeCall(end + 2) + 1;
    }
    return { prefix, end };
  };
  let functionParameters = new Map<string, Binding>();
  let pendingFunctionBody = -1;
  let controlHeader = false;
  const invalidate = (name: string, router = false) => {
    const owner = [...scopes].reverse().find((scope) => scope.has(name)) ?? scopes[scopes.length - 1]!;
    owner.set(name, router || lookup(name) !== undefined ? null : undefined);
  };
  const declare = (start: number) => {
    let end = start;
    while (end < tokens.length && tokens[end]?.kind !== "newline" && !symbol(end, "=") && !symbol(end, ";") && !symbol(end, ")") && !symbol(end, "}")) end++;
    for (const [name, binding] of parameterBindings(tokens.slice(start, end), imports)) {
      if (activeHelper?.parameter === name) activeHelper.mutated = true;
      scopes[scopes.length - 1]!.set(name, binding);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (activeHelper && index > activeHelper.end) activeHelper = undefined;
    if (token.kind === "id" && token.value === "func") {
      // Mark typed router parameters unknown: a helper's callers may supply different prefixes.
      functionParameters = new Map();
      let cursor = index + 1;
      let parentheses = 0;
      for (; cursor < tokens.length; cursor++) {
        const item = tokens[cursor]!;
        if (item.kind === "symbol" && ["(", "["].includes(item.value)) parentheses++;
        if (item.kind === "symbol" && [")", "]"].includes(item.value)) parentheses--;
        if (item.kind === "symbol" && item.value === "{" && parentheses === 0) {
          if (identifier(cursor - 1, "struct") || identifier(cursor - 1, "interface")) { cursor = closeBlock(cursor); continue; }
          break;
        }
      }
      // Parameter names shadow outer variables and the package alias, even when not routers.
      for (let start = index + 1; start < cursor; start++) {
        if (!symbol(start, "(")) continue;
        const end = closeCall(start);
        const names = parameterBindings(tokens.slice(start + 1, end), imports);
        for (const [name, binding] of names) functionParameters.set(name, binding);
        start = end;
      }
      const firstParameter = functionParameters.entries().next().value as [string, Binding] | undefined;
      activeHelper = tokens[index + 1]?.kind === "id" && symbol(index + 2, "(")
        && firstParameter?.[1] === null && cursor < tokens.length
        ? { name: tokens[index + 1]!.value, nameIndex: index + 1, parameter: firstParameter[0], end: closeBlock(cursor), templates: [], mutated: false }
        : undefined;
      if (activeHelper) helpers.push(activeHelper);
      pendingFunctionBody = cursor;
      index = cursor - 1;
      continue;
    }
    if (token.kind === "id" && ["if", "for", "switch", "select"].includes(token.value)) controlHeader = true;
    if (token.kind === "symbol" && token.value === "{") {
      scopes.push(index === pendingFunctionBody ? functionParameters : new Map());
      if (index === pendingFunctionBody) pendingFunctionBody = -1;
      controlHeader = false;
      continue;
    }
    if (token.kind === "symbol" && token.value === "}") { if (scopes.length > 1) scopes.pop(); continue; }
    if (token.kind !== "id" || symbol(index - 1, ".")) continue;
    if (symbol(index + 1, "(") && !scopes.some((scope) => scope.has(token.value))) {
      const first = expression(next(index + 2));
      const boundary = first && tokens[first.end];
      const observed = calls.get(token.value) ?? [];
      observed.push(first && boundary?.kind === "symbol" && [",", ")"].includes(boundary.value) ? first.prefix : null);
      calls.set(token.value, observed);
    }
    if (token.value === "var") {
      if (tokens[index + 1]?.kind === "id") declare(index + 1);
      else if (symbol(index + 1, "(")) {
        const end = closeCall(index + 1);
        let depth = 0;
        for (let cursor = index + 2; cursor < end; cursor++) {
          if (depth === 0 && (cursor === index + 2 || tokens[cursor - 1]?.kind === "newline" || symbol(cursor - 1, ";"))) declare(next(cursor));
          if (tokens[cursor]?.kind === "symbol" && ["(", "[", "{"].includes(tokens[cursor]!.value)) depth++;
          if (tokens[cursor]?.kind === "symbol" && [")", "]", "}"].includes(tokens[cursor]!.value)) depth--;
        }
      }
      continue;
    }
    // Unsupported tuple assignments must invalidate existing prefixes, not retain stale ones.
    if (symbol(index + 1, ",")) {
      const names = [token.value];
      let cursor = index + 1;
      while (symbol(cursor, ",") && tokens[next(cursor + 1)]?.kind === "id") {
        cursor = next(cursor + 1);
        names.push(tokens[cursor]!.value);
        cursor++;
      }
      if (symbol(cursor, "=") || symbol(cursor, ":=")) {
        if (activeHelper && names.includes(activeHelper.parameter)) activeHelper.mutated = true;
        const hasRouterValue = expression(next(cursor + 1)) !== undefined;
        for (const name of names) {
          if (symbol(cursor, ":=") && !controlHeader) scopes[scopes.length - 1]!.set(name, !hasRouterValue && lookup(name) === undefined ? undefined : null);
          else invalidate(name, hasRouterValue);
        }
        index = cursor;
        continue;
      }
    }
    // A direct field mutation can affect every alias of a router value.
    let fieldEnd = index + 1;
    while (symbol(fieldEnd, ".") && tokens[fieldEnd + 1]?.kind === "id") fieldEnd += 2;
    let assignmentEnd = fieldEnd;
    while (symbol(assignmentEnd, ",") && tokens[next(assignmentEnd + 1)]?.kind === "id") {
      assignmentEnd = next(assignmentEnd + 1) + 1;
      while (symbol(assignmentEnd, ".") && tokens[assignmentEnd + 1]?.kind === "id") assignmentEnd += 2;
    }
    if (fieldEnd > index + 1 && symbol(assignmentEnd, "=") && lookup(token.value) !== undefined) {
      if (activeHelper?.parameter === token.value) activeHelper.mutated = true;
      for (const scope of scopes) for (const [name, binding] of scope) if (binding !== undefined) scope.set(name, null);
      index = assignmentEnd;
      continue;
    }
    const operator = tokens[index + 1]?.kind === "symbol" ? tokens[index + 1]?.value : undefined;
    if (operator === ":=" || operator === "=") {
      if (activeHelper?.parameter === token.value) activeHelper.mutated = true;
      const value = expression(next(index + 2));
      const boundary = value && tokens[value.end];
      const complete = value && (!boundary || boundary.kind === "newline" || (boundary.kind === "symbol" && [";", "}"].includes(boundary.value)));
      const binding = complete ? value.prefix : lookup(token.value) === undefined ? undefined : null;
      // Header scopes require full Go syntax analysis. Conservatively invalidate the outer
      // name rather than leak a conditionally scoped prefix into following statements.
      if (controlHeader) { invalidate(token.value, binding !== undefined); if (complete) index = value.end - 1; continue; }
      const owner = operator === "=" ? [...scopes].reverse().find((scope) => scope.has(token.value)) ?? scopes[scopes.length - 1]! : scopes[scopes.length - 1]!;
      // A nested assignment to an outer router may be conditional; do not choose one branch.
      owner.set(token.value, owner !== scopes[scopes.length - 1] && binding !== undefined ? null : binding);
      if (complete) index = value.end - 1;
      continue;
    }
    const receiver = expression(index);
    if (!receiver || !symbol(receiver.end, ".") || !symbol(receiver.end + 2, "(")) continue;
    const method = tokens[receiver.end + 1]!;
    if (method.kind !== "id") continue;
    if (!METHODS.has(method.value) && method.value !== "Any" && method.value !== "Handle") continue;
    if (!METHODS.has(method.value)) { diagnose(method, "unsupported-router-operation"); index = closeCall(receiver.end + 2); continue; }
    const path = literalArgument(receiver.end + 2);
    if (receiver.prefix === null) {
      if (activeHelper && token.value === activeHelper.parameter && receiver.end === index + 1 && path !== undefined) {
        activeHelper.templates.push({ path, method: method.value as RouteHttpMethod, line: method.line });
      } else diagnose(method, "unknown-router-prefix");
    }
    else if (path === undefined) diagnose(method, "dynamic-path");
    else {
      const composed = composePath(receiver.prefix!, path);
      if (composed === null) diagnose(method, "dynamic-path");
      else routes.push({ kind: "api", path: composed || "/", source, line: method.line, method: method.value as RouteHttpMethod, discovery: "gin" });
    }
    // Handler bodies are runtime behavior, not startup route declarations.
    index = closeCall(receiver.end + 2);
  }
  for (const helper of helpers) {
    const sites = calls.get(helper.name) ?? [];
    const known = sites.filter((prefix): prefix is string => typeof prefix === "string");
    const references = tokens.reduce((count, token, index) => count + Number(token.kind === "id" && token.value === helper.name && index !== helper.nameIndex), 0);
    for (const template of helper.templates) {
      if (helper.mutated || known.length === 0 || known.length !== sites.length || references !== sites.length) {
        diagnostics.push({ extractor: "gin", source, line: template.line, reason: "unknown-router-prefix" });
        continue;
      }
      for (const prefix of known) {
        const path = composePath(prefix, template.path);
        if (path === null) diagnostics.push({ extractor: "gin", source, line: template.line, reason: "dynamic-path" });
        else routes.push({ kind: "api", path: path || "/", source, line: template.line, method: template.method, discovery: "gin" });
      }
    }
  }
  return { routes, diagnostics };
}

function composePath(base: string, path: string): string | null {
  if (path.length > 256 || /[?#\s{}$]/.test(path)) return null;
  if (path === "") return base;
  const result = posix.join(base || "/", path);
  const composed = path.endsWith("/") && !result.endsWith("/") ? `${result}/` : result;
  return composed.length <= 256 ? composed : null;
}

function ginImports(tokens: Token[]): { aliases: Set<string>; found: boolean } {
  const aliases = new Set<string>();
  let found = false;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.kind !== "id" || tokens[index]!.value !== "import") continue;
    let cursor = index + 1;
    while (tokens[cursor]?.kind === "newline") cursor++;
    const grouped = tokens[cursor]?.kind === "symbol" && tokens[cursor]?.value === "(";
    if (grouped) cursor++;
    for (; cursor < tokens.length; cursor++) {
      const item = tokens[cursor]!;
      if (grouped ? item.kind === "symbol" && item.value === ")" : item.kind === "newline" || (item.kind === "symbol" && item.value === ";")) break;
      if (item.kind !== "string" || item.value !== "github.com/gin-gonic/gin") continue;
      found = true;
      const previous = tokens[cursor - 1];
      const alias = previous?.kind === "id" && previous.value !== "import" ? previous.value : previous?.value === "." ? "." : "gin";
      if (alias !== "_" && alias !== ".") aliases.add(alias);
    }
  }
  return { aliases, found };
}

function parameterBindings(tokens: Token[], imports: Set<string>): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  let names: string[] = [];
  let segment: Token[] = [];
  let depth = 0;
  const flush = () => {
    const values = segment.filter((token) => token.kind !== "newline");
    segment = [];
    if (values[0]?.kind !== "id") { names = []; return; }
    if (values.length === 1) { names.push(values[0].value); return; }
    // An un-named qualified type has no binding in the function body.
    if (values[1]?.kind === "symbol" && values[1].value === ".") { names = []; return; }
    names.push(values[0].value);
    const router = values[1]?.value === "*" && imports.has(values[2]?.value ?? "") && values[3]?.value === "." && ["Engine", "RouterGroup"].includes(values[4]?.value ?? "");
    for (const name of names) bindings.set(name, router ? null : undefined);
    names = [];
  };
  for (const token of tokens) {
    if (token.kind === "symbol" && ["(", "[", "{"].includes(token.value)) depth++;
    if (token.kind === "symbol" && [")", "]", "}"].includes(token.value)) depth--;
    if (token.kind === "symbol" && token.value === "," && depth === 0) flush();
    else segment.push(token);
  }
  flush();
  for (const name of names) bindings.set(name, undefined);
  return bindings;
}

/** Comments and strings cannot contribute identifier/call tokens. Line numbers refer to source. */
function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  for (let index = 0; index < content.length;) {
    const char = content[index]!;
    if (char === "\n") { tokens.push({ kind: "newline", value: "\n", line: line++ }); index++; continue; }
    if (/\s/.test(char)) { index++; continue; }
    if (content.startsWith("//", index)) { while (index < content.length && content[index] !== "\n") index++; continue; }
    if (content.startsWith("/*", index)) {
      index += 2;
      while (index < content.length && !content.startsWith("*/", index)) { if (content[index] === "\n") tokens.push({ kind: "newline", value: "\n", line: line++ }); index++; }
      index += 2;
      continue;
    }
    if (char === '"' || char === "`" || char === "'") {
      const start = index++;
      const startLine = line;
      while (index < content.length && content[index] !== char) {
        if (content[index] === "\n") line++;
        if (char !== "`" && content[index] === "\\") index++;
        index++;
      }
      const closed = content[index] === char;
      if (closed) index++;
      const raw = content.slice(start, index);
      let value: string | undefined;
      if (closed && char === "`") value = raw.slice(1, -1).replaceAll("\r", "");
      if (closed && char === '"') { try { value = JSON.parse(raw) as string; } catch { /* Unsupported Go escapes stay opaque. */ } }
      tokens.push({ kind: value === undefined ? "opaque" : "string", value: value ?? "", line: startLine });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < content.length && /[A-Za-z0-9_]/.test(content[index]!)) index++;
      tokens.push({ kind: "id", value: content.slice(start, index), line });
      continue;
    }
    const pair = content.slice(index, index + 2);
    if ([":=", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "&&", "||", "<<", ">>"].includes(pair)) { tokens.push({ kind: "symbol", value: pair, line }); index += 2; continue; }
    tokens.push({ kind: "symbol", value: char, line }); index++;
  }
  return tokens;
}
