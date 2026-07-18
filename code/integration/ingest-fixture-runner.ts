import {
  scoreIngestRun,
  type IngestMetricCounts,
  type IngestMetrics,
} from "./ingest-metrics.js";

export const INGEST_FIXTURE_KINDS = [
  "deterministic",
  "agent",
  "workflow",
  "retrieval",
  "claim",
  "navigation",
] as const;

export type IngestFixtureKind = (typeof INGEST_FIXTURE_KINDS)[number];

const VERSION_KEYS = ["model", "prompt", "tools", "index", "schemas"] as const;

export interface IngestFixtureVersions {
  model: string;
  prompt: string;
  tools: string;
  index: string;
  schemas: string;
}

export interface IngestFixtureExecution {
  decisive: unknown;
  counts: IngestMetricCounts;
}

export interface IngestFixtureAdapter {
  run(input: {
    kind: IngestFixtureKind;
    corpus: "tiny" | "small";
    versions: IngestFixtureVersions;
    cacheEnabled: false;
  }): Promise<IngestFixtureExecution>;
}

export interface IngestFixtureRecord {
  status: "complete" | "not_implemented";
  decisive: unknown;
}

export interface IngestFixtureResultStore {
  readBaseline(): Promise<string>;
  writeResult(result: IngestFixtureResult): Promise<void>;
}

export interface IngestFixtureResultFileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
}

export function createIngestFixtureResultStore(
  fileSystem: IngestFixtureResultFileSystem,
  paths: { baselinePath: string; resultPath: string },
): IngestFixtureResultStore {
  return {
    readBaseline: () => fileSystem.readText(paths.baselinePath),
    writeResult: (result) =>
      fileSystem.writeText(
        paths.resultPath,
        `${JSON.stringify(stableJson(result), null, 2)}\n`,
      ),
  };
}

export interface IngestFixtureInput {
  corpus: "tiny" | "small";
  versions: IngestFixtureVersions;
  cacheEnabled: false;
  adapters?: Partial<Record<IngestFixtureKind, IngestFixtureAdapter>>;
  resultStore: IngestFixtureResultStore;
}

export interface IngestFixtureResult {
  schemaVersion: 1;
  corpus: "tiny" | "small";
  versions: IngestFixtureVersions;
  cacheEnabled: false;
  fixtures: Record<IngestFixtureKind, IngestFixtureRecord>;
  metrics: IngestMetrics;
  decisiveDiffs: string[];
  status: "complete" | "not_implemented";
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface IngestFixtureBaseline {
  schemaVersion: 1;
  corpus: "tiny" | "small";
  versions: IngestFixtureVersions;
  cacheEnabled: false;
  fixtures: Record<IngestFixtureKind, IngestFixtureRecord>;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function requireJson(value: unknown, path = "$"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${path} must contain valid JSON`);
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${path}[${index}] must contain valid JSON`);
      }
      result.push(requireJson(value[index], `${path}[${index}]`));
    }
    return result;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const ownKeys = Reflect.ownKeys(value);
    const enumerableKeys = Object.keys(value as Record<string, unknown>);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.length !== enumerableKeys.length
    ) {
      throw new Error(`${path} must contain valid JSON`);
    }
    return Object.fromEntries(
      enumerableKeys
        .sort(compareCodeUnits)
        .map((key) => [
          key,
          requireJson(
            (value as Record<string, unknown>)[key],
            `${path}.${key}`,
          ),
        ]),
    );
  }
  throw new Error(`${path} must contain valid JSON`);
}

function stableJson<T>(value: T): T {
  return requireJson(value) as T;
}

function decisiveDiffs(
  expected: JsonValue,
  observed: JsonValue,
  pointer = "",
): string[] {
  if (Object.is(expected, observed)) return [];
  if (Array.isArray(expected) && Array.isArray(observed)) {
    const diffs: string[] = [];
    const length = Math.max(expected.length, observed.length);
    for (let index = 0; index < length; index += 1) {
      const childPointer = `${pointer}/${index}`;
      if (index >= expected.length || index >= observed.length) {
        diffs.push(childPointer);
      } else {
        diffs.push(
          ...decisiveDiffs(expected[index]!, observed[index]!, childPointer),
        );
      }
    }
    return diffs;
  }
  if (
    expected !== null &&
    observed !== null &&
    typeof expected === "object" &&
    typeof observed === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(observed)
  ) {
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(observed)]),
    ].sort(compareCodeUnits);
    return keys.flatMap((key) => {
      const childPointer = `${pointer}/${jsonPointerToken(key)}`;
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(observed, key)) {
        return [childPointer];
      }
      return decisiveDiffs(expected[key]!, observed[key]!, childPointer);
    });
  }
  return [pointer || "/"];
}

function validateVersions(
  value: unknown,
  prefix = "versions",
): IngestFixtureVersions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${prefix} must contain exactly model, prompt, tools, index, and schemas`,
    );
  }
  for (const name of VERSION_KEYS) {
    if (!Object.hasOwn(value, name))
      throw new Error(`${prefix}.${name} is required`);
  }
  if (Object.keys(value).length !== VERSION_KEYS.length) {
    throw new Error(
      `${prefix} must contain exactly model, prompt, tools, index, and schemas`,
    );
  }
  for (const name of VERSION_KEYS) {
    const version = (value as Record<string, unknown>)[name];
    if (typeof version !== "string" || version.trim().length === 0) {
      throw new Error(`${prefix}.${name} must be a non-empty string`);
    }
  }
  return value as IngestFixtureVersions;
}

function requireExactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const required = [...expected].sort(compareCodeUnits);
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${path} must contain exactly ${expected.join(", ")}`);
  }
}

function parseBaseline(serialized: string): IngestFixtureBaseline {
  if (typeof serialized !== "string") {
    throw new Error("Fixture baseline must be serialized JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Fixture baseline contains malformed JSON");
  }
  const json = requireJson(parsed, "baseline");
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new Error("Fixture baseline must be a JSON object");
  }
  requireExactKeys(
    json,
    ["schemaVersion", "corpus", "cacheEnabled", "versions", "fixtures"],
    "Fixture baseline",
  );
  if (json.schemaVersion !== 1)
    throw new Error("Fixture baseline schemaVersion must be 1");
  if (json.corpus !== "tiny" && json.corpus !== "small") {
    throw new Error("Fixture baseline corpus is invalid");
  }
  if (json.cacheEnabled !== false)
    throw new Error("Fixture baseline cacheEnabled must be false");
  validateVersions(json.versions, "baseline.versions");
  if (
    !json.fixtures ||
    Array.isArray(json.fixtures) ||
    typeof json.fixtures !== "object"
  ) {
    throw new Error("Fixture baseline fixtures are invalid");
  }
  requireExactKeys(
    json.fixtures,
    INGEST_FIXTURE_KINDS,
    "Fixture baseline fixtures",
  );
  for (const kind of INGEST_FIXTURE_KINDS) {
    const fixture = json.fixtures[kind];
    if (!fixture || Array.isArray(fixture) || typeof fixture !== "object") {
      throw new Error(`Fixture baseline fixtures.${kind} is required`);
    }
    requireExactKeys(
      fixture,
      ["status", "decisive"],
      `Fixture baseline fixtures.${kind}`,
    );
    if (fixture.status !== "complete" && fixture.status !== "not_implemented") {
      throw new Error(`Fixture baseline fixtures.${kind}.status is invalid`);
    }
    if (!Object.hasOwn(fixture, "decisive")) {
      throw new Error(`Fixture baseline fixtures.${kind}.decisive is required`);
    }
  }
  return json as unknown as IngestFixtureBaseline;
}

function emptyCounts(): IngestMetricCounts {
  return {
    evidence: { truePositive: 0, falsePositive: 0, falseNegative: 0 },
    noEvidence: { falseNoEvidence: 0, actualAnswerable: 0 },
    claims: { entailed: 0, reviewed: 0 },
    merges: { falseMerge: 0, proposedMerge: 0 },
    contradictions: { found: 0, expected: 0 },
    sources: { covered: 0, total: 0 },
    answers: { sufficient: 0, evaluated: 0 },
  };
}

function validateCounts(value: unknown, path: string): IngestMetricCounts {
  try {
    scoreIngestRun(value as IngestMetricCounts);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is invalid: ${detail}`, { cause: error });
  }
  return value as IngestMetricCounts;
}

function addCounts(total: IngestMetricCounts, next: IngestMetricCounts): void {
  total.evidence.truePositive += next.evidence.truePositive;
  total.evidence.falsePositive += next.evidence.falsePositive;
  total.evidence.falseNegative += next.evidence.falseNegative;
  total.noEvidence.falseNoEvidence += next.noEvidence.falseNoEvidence;
  total.noEvidence.actualAnswerable += next.noEvidence.actualAnswerable;
  total.claims.entailed += next.claims.entailed;
  total.claims.reviewed += next.claims.reviewed;
  total.merges.falseMerge += next.merges.falseMerge;
  total.merges.proposedMerge += next.merges.proposedMerge;
  total.contradictions.found += next.contradictions.found;
  total.contradictions.expected += next.contradictions.expected;
  total.sources.covered += next.sources.covered;
  total.sources.total += next.sources.total;
  total.answers.sufficient += next.answers.sufficient;
  total.answers.evaluated += next.answers.evaluated;
}

export async function runIngestFixture(
  input: IngestFixtureInput,
): Promise<IngestFixtureResult> {
  if (input.cacheEnabled !== false) {
    throw new Error("Provider cache must be disabled for ingestion fixtures");
  }
  const versions = Object.freeze(stableJson(validateVersions(input.versions)));

  const baseline = parseBaseline(await input.resultStore.readBaseline());
  if (baseline.corpus !== input.corpus) {
    throw new Error(
      `Fixture baseline corpus ${baseline.corpus} does not match ${input.corpus}`,
    );
  }
  if (
    JSON.stringify(stableJson(baseline.versions)) !== JSON.stringify(versions)
  ) {
    throw new Error(
      "Fixture baseline versions do not match the requested fixture versions",
    );
  }
  const counts = emptyCounts();
  const fixtures = {} as Record<IngestFixtureKind, IngestFixtureRecord>;
  const missing: string[] = [];

  for (const kind of INGEST_FIXTURE_KINDS) {
    const hasAdapter = input.adapters
      ? Object.hasOwn(input.adapters, kind)
      : false;
    if (!hasAdapter) {
      fixtures[kind] = { status: "not_implemented", decisive: null };
      missing.push(`/fixtures/${kind}/status`);
      continue;
    }
    const fixtureAdapter = input.adapters![kind];
    if (!fixtureAdapter || typeof fixtureAdapter.run !== "function") {
      throw new Error(`adapters.${kind}.run must be a function`);
    }
    const execution = await fixtureAdapter.run({
      kind,
      corpus: input.corpus,
      versions: stableJson(versions),
      cacheEnabled: false,
    });
    addCounts(
      counts,
      validateCounts(execution?.counts, `fixtures.${kind}.counts`),
    );
    fixtures[kind] = {
      status: "complete",
      decisive: requireJson(execution.decisive, `fixtures.${kind}.decisive`),
    };
  }

  const comparedDiffs = INGEST_FIXTURE_KINDS.flatMap((kind) =>
    input.adapters && Object.hasOwn(input.adapters, kind)
      ? decisiveDiffs(
          requireJson(baseline.fixtures[kind], `baseline.fixtures.${kind}`),
          requireJson(fixtures[kind], `fixtures.${kind}`),
          `/fixtures/${kind}`,
        )
      : [],
  );
  const result: IngestFixtureResult = {
    schemaVersion: 1,
    corpus: input.corpus,
    versions,
    cacheEnabled: false,
    fixtures,
    metrics: scoreIngestRun(counts),
    decisiveDiffs: [...new Set([...missing, ...comparedDiffs])].sort(
      compareCodeUnits,
    ),
    status: missing.length === 0 ? "complete" : "not_implemented",
  };
  const stableResult = stableJson(result);
  await input.resultStore.writeResult(stableResult);
  return stableResult;
}
