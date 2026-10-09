import { CharterCatalogEntrySchema, SuiteCatalogEntrySchema, type CharterCatalogEntry, type SuiteCatalogEntry, type TestLevel } from "@proofkit/contracts";

export type CatalogSelection = {
  entry: CharterCatalogEntry;
  matchedAlias?: string;
};

export type SuiteSelection = {
  entry: SuiteCatalogEntry;
  matchedAlias?: string;
};

export function selectCatalogSuite(
  entries: SuiteCatalogEntry[],
  request: { intent: string; level: TestLevel; surface: "web" | "electron" | "mobile"; suiteId?: string },
): SuiteSelection | undefined {
  const requiredSurfaces: Array<"web" | "electron" | "mobile"> = request.surface === "mobile"
    ? ["mobile"]
    : ["web", "electron"];
  const byId = new Map<string, SuiteCatalogEntry>();
  for (const rawEntry of entries) {
    const entry = SuiteCatalogEntrySchema.parse(rawEntry);
    if (byId.has(entry.id)) throw new Error(`Duplicate test suite ID: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const supportsRequest = (entry: SuiteCatalogEntry) => request.level === "release"
    && requiredSurfaces.every((surface) => entry.surfaces.includes(surface));
  if (request.suiteId) {
    const entry = byId.get(request.suiteId);
    if (!entry) throw new Error(`Unknown test suite ID: ${request.suiteId}`);
    if (!supportsRequest(entry)) throw new Error(`Test suite ${entry.id} does not support ${request.level} on ${request.surface}`);
    return { entry };
  }
  if (request.level !== "release") return undefined;
  const intent = normalize(request.intent);
  const matches = [...byId.values()].flatMap((entry) => {
    if (!supportsRequest(entry)) return [];
    const aliases = entry.aliases.filter((alias) => intent.includes(normalize(alias)));
    if (aliases.length === 0) return [];
    const matchedAlias = aliases.sort((left, right) => normalize(right).length - normalize(left).length)[0]!;
    return [{ entry, matchedAlias, score: normalize(matchedAlias).length }];
  }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
  if (matches.length === 0) return undefined;
  const selected = matches[0]!;
  const selectedAlias = normalize(selected.matchedAlias);
  const competing = matches.slice(1).filter((match) => {
    const alias = normalize(match.matchedAlias);
    return selectedAlias.length <= alias.length || !selectedAlias.includes(alias);
  });
  if (competing.length > 0) {
    const ids = [selected, ...competing].map((match) => match.entry.id);
    throw new Error(`Ambiguous test suite match: ${ids.join(", ")}; specify suiteId`);
  }
  return { entry: selected.entry, matchedAlias: selected.matchedAlias };
}

export function selectCatalogCharter(
  entries: CharterCatalogEntry[],
  request: { intent: string; level: TestLevel; surface: "web" | "electron" | "mobile"; charterId?: string },
): CatalogSelection | undefined {
  const requiredSurfaces: Array<"web" | "electron" | "mobile"> = request.level === "release" && request.surface !== "mobile"
    ? ["web", "electron"]
    : [request.surface];
  const supportsRequest = (entry: CharterCatalogEntry) => entry.level === request.level
    && requiredSurfaces.every((surface) => entry.surfaces.includes(surface));
  const byId = new Map<string, CharterCatalogEntry>();
  for (const rawEntry of entries) {
    const entry = CharterCatalogEntrySchema.parse(rawEntry);
    if (byId.has(entry.id)) throw new Error(`Duplicate test catalog ID: ${entry.id}`);
    byId.set(entry.id, entry);
  }

  if (request.charterId) {
    const entry = byId.get(request.charterId);
    if (!entry) throw new Error(`Unknown test catalog ID: ${request.charterId}`);
    if (!supportsRequest(entry)) {
      throw new Error(`Test catalog entry ${entry.id} does not support ${request.level} on ${request.surface}`);
    }
    return { entry };
  }

  const intent = normalize(request.intent);
  const matches = [...byId.values()].flatMap((entry) => {
    if (!supportsRequest(entry)) return [];
    const aliases = entry.aliases.filter((alias) => intent.includes(normalize(alias)));
    if (aliases.length === 0) return [];
    const matchedAlias = aliases.sort((left, right) => normalize(right).length - normalize(left).length)[0]!;
    return [{ entry, matchedAlias, score: normalize(matchedAlias).length }];
  }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
  if (matches.length === 0) return undefined;
  const selected = matches[0]!;
  const selectedAlias = normalize(selected.matchedAlias);
  const competing = matches.slice(1).filter((match) => {
    const alias = normalize(match.matchedAlias);
    return selectedAlias.length <= alias.length || !selectedAlias.includes(alias);
  });
  if (competing.length > 0) {
    const ids = [selected, ...competing].map((match) => match.entry.id);
    throw new Error(`Ambiguous test catalog match: ${ids.join(", ")}; specify charterId`);
  }
  return { entry: selected.entry, matchedAlias: selected.matchedAlias };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
