import type {
  FormatTier,
  IngestResult,
  RepresentationAudit,
  RepresentationAuditFinding,
  RepresentationCapability,
  SourceRepresentation,
  SourceRepresentationKind,
} from "../../domain/ingest/index.js";
import {
  RepresentationAuditSchema,
  RepresentationCapabilitySchema,
  SourceRepresentationSchema,
} from "../../domain/ingest/index.js";

const REQUIRED_CHECKS = Object.freeze(["mapping", "structure"] as const);

function builtIn(
  representationKind: SourceRepresentationKind,
): RepresentationCapability {
  return Object.freeze({
    schemaVersion: 1,
    id: `a-tier:${representationKind}`,
    version: 1,
    representationKind,
    tier: "A",
    requiredChecks: REQUIRED_CHECKS,
  });
}

const BUILT_INS: ReadonlyMap<
  SourceRepresentationKind,
  RepresentationCapability
> = new Map(
  (["markdown", "text", "code", "json", "yaml", "csv"] as const).map((kind) => [
    kind,
    builtIn(kind),
  ]),
);

export function capabilityFor(
  kind: SourceRepresentationKind,
): RepresentationCapability | undefined {
  return BUILT_INS.get(kind);
}

interface CapabilityResolution {
  readonly capability: RepresentationAudit["capability"];
  readonly tier: FormatTier;
  readonly findings: RepresentationAuditFinding[];
}

function finding(
  code: RepresentationAuditFinding["code"],
  message: string,
  locatorIndex?: number,
): RepresentationAuditFinding {
  return {
    code,
    severity: "error",
    message,
    ...(locatorIndex === undefined ? {} : { locatorIndex }),
  };
}

function resolveCapability(
  representation: SourceRepresentation,
  input: unknown,
): CapabilityResolution {
  const candidate = input ?? capabilityFor(representation.kind);
  const parsed = RepresentationCapabilitySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      capability: { status: "unresolved" },
      tier: "D",
      findings: [
        finding("INVALID_CAPABILITY", "Representation capability is invalid."),
      ],
    };
  }

  const capability = parsed.data;
  const findings: RepresentationAuditFinding[] = [];
  if (capability.representationKind !== representation.kind) {
    findings.push(
      finding(
        "CAPABILITY_KIND_MISMATCH",
        "Representation capability kind does not match the representation.",
      ),
    );
  }
  if (capability.version !== 1) {
    findings.push(
      finding(
        "CAPABILITY_VERSION_UNSUPPORTED",
        "Representation capability version is unsupported.",
      ),
    );
  }
  if (capability.requiredChecks.includes("render")) {
    findings.push(
      finding(
        "CAPABILITY_CHECK_UNSUPPORTED",
        "The render audit check is not available in this implementation.",
      ),
    );
  }
  if (capability.tier === "B") {
    findings.push(
      finding(
        "TIER_REQUIRES_RENDER_AUDIT",
        "Tier B requires an independent render audit.",
      ),
    );
  } else if (capability.tier === "C") {
    findings.push(
      finding(
        "TIER_REQUIRES_UNIT_VERIFICATION",
        "Tier C requires named human verification per selected source unit.",
      ),
    );
  } else if (capability.tier === "D") {
    findings.push(
      finding("TIER_UNSUPPORTED", "Tier D cannot support accepted claims."),
    );
  }

  return {
    capability: {
      status: "resolved",
      id: capability.id,
      version: capability.version,
    },
    tier: capability.tier,
    findings,
  };
}

interface NormalizedBoundary {
  readonly line: number;
  readonly column: number;
}

interface NormalizedLineRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

function normalizedBoundaries(text: string): readonly NormalizedBoundary[] {
  const boundaries = new Array<NormalizedBoundary>(text.length + 1);
  let line = 1;
  let column = 1;
  for (let offset = 0; offset <= text.length; offset += 1) {
    boundaries[offset] = { line, column };
    if (offset === text.length) break;
    if (text[offset] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return boundaries;
}

function normalizedLineRanges(text: string): readonly NormalizedLineRange[] {
  if (text.length === 0) return [];
  const ranges: NormalizedLineRange[] = [];
  let start = 0;
  let line = 1;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "\n") continue;
    ranges.push({ start, end: offset, line });
    start = offset + 1;
    line += 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length, line });
  return ranges;
}

function validOriginalPosition(
  locator: SourceRepresentation["locatorMap"][number],
): boolean {
  const values = [
    locator.original.byteStart,
    locator.original.byteEnd,
    locator.original.lineStart,
    locator.original.columnStart,
    locator.original.lineEnd,
    locator.original.columnEnd,
  ];
  if (!values.every(Number.isSafeInteger)) return false;
  if (locator.original.byteStart > locator.original.byteEnd) return false;
  if (locator.original.lineStart > locator.original.lineEnd) return false;
  return !(
    locator.original.lineStart === locator.original.lineEnd &&
    locator.original.columnStart > locator.original.columnEnd
  );
}

function auditLineMapping(
  representation: SourceRepresentation,
): RepresentationAuditFinding[] {
  const findings: RepresentationAuditFinding[] = [];
  const boundaries = normalizedBoundaries(representation.normalizedText);
  const expectedLines = normalizedLineRanges(representation.normalizedText);
  const locators = representation.locatorMap;

  if (representation.normalizedText.length > 0 && locators.length === 0) {
    findings.push(
      finding("LOCATOR_MISSING", "Non-empty representation has no locators."),
    );
  }

  let previousNormalizedStart = -1;
  let previousNormalizedEnd = -1;
  let previousOriginalStart = -1;
  let previousOriginalEnd = -1;
  for (const [index, locator] of locators.entries()) {
    if (locator.kind !== "line" || locator.cell !== undefined) {
      findings.push(
        finding(
          "LOCATOR_KIND_MISMATCH",
          "Non-CSV representation requires line locators without cell metadata.",
          index,
        ),
      );
    }

    const start = locator.normalized.utf16Start;
    const end = locator.normalized.utf16End;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      findings.push(
        finding(
          "LOCATOR_INTERVAL_INVALID",
          "Normalized locator interval is invalid.",
          index,
        ),
      );
    } else if (start < 0 || end > representation.normalizedText.length) {
      findings.push(
        finding(
          "LOCATOR_OUT_OF_BOUNDS",
          "Normalized locator is outside the representation text.",
          index,
        ),
      );
    } else {
      const startPosition = boundaries[start]!;
      const endPosition = boundaries[end]!;
      if (
        locator.normalized.lineStart !== startPosition.line ||
        locator.normalized.columnStart !== startPosition.column ||
        locator.normalized.lineEnd !== endPosition.line ||
        locator.normalized.columnEnd !== endPosition.column
      ) {
        findings.push(
          finding(
            "LOCATOR_POSITION_MISMATCH",
            "Normalized locator line or column does not match its offsets.",
            index,
          ),
        );
      }
    }

    if (start < previousNormalizedStart) {
      findings.push(
        finding(
          "LOCATOR_ORDER_INVALID",
          "Normalized locators are not in source order.",
          index,
        ),
      );
    } else if (start < previousNormalizedEnd) {
      findings.push(
        finding("LOCATOR_OVERLAP", "Normalized locators overlap.", index),
      );
    }
    previousNormalizedStart = start;
    previousNormalizedEnd = Math.max(previousNormalizedEnd, end);

    if (!validOriginalPosition(locator)) {
      findings.push(
        finding(
          "ORIGINAL_POSITION_INVALID",
          "Original locator coordinates are invalid.",
          index,
        ),
      );
    }
    if (locator.original.byteStart < previousOriginalStart) {
      findings.push(
        finding(
          "LOCATOR_ORDER_INVALID",
          "Original locators are not in source order.",
          index,
        ),
      );
    } else if (locator.original.byteStart < previousOriginalEnd) {
      findings.push(
        finding("LOCATOR_OVERLAP", "Original locators overlap.", index),
      );
    }
    previousOriginalStart = locator.original.byteStart;
    previousOriginalEnd = Math.max(
      previousOriginalEnd,
      locator.original.byteEnd,
    );
  }

  if (locators.length !== expectedLines.length) {
    findings.push(
      finding(
        "MAPPING_COVERAGE_GAP",
        "Line locator count does not cover normalized text.",
      ),
    );
  }
  const comparable = Math.min(locators.length, expectedLines.length);
  for (let index = 0; index < comparable; index += 1) {
    const locator = locators[index]!;
    const expected = expectedLines[index]!;
    if (
      locator.normalized.utf16Start !== expected.start ||
      locator.normalized.utf16End !== expected.end ||
      locator.normalized.lineStart !== expected.line ||
      locator.normalized.lineEnd !== expected.line
    ) {
      findings.push(
        finding(
          "MAPPING_COVERAGE_GAP",
          "Line locator does not cover the expected normalized line.",
          index,
        ),
      );
    }
  }
  return findings;
}

interface ExpectedCsvCell {
  readonly row: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

function expectedCsvCells(text: string): readonly ExpectedCsvCell[] {
  if (text.length === 0) return [];
  const cells: ExpectedCsvCell[] = [];
  let row = 1;
  let column = 1;
  let start = 0;
  let quoted = false;

  const push = (end: number): void => {
    cells.push({ row, column, start, end });
  };

  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset]!;
    if (quoted) {
      if (character !== '"') continue;
      if (text[offset + 1] === '"') {
        offset += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (offset === start && character === '"') {
      quoted = true;
      continue;
    }
    if (character !== "," && character !== "\n") continue;
    push(offset);
    if (character === ",") {
      column += 1;
    } else {
      row += 1;
      column = 1;
    }
    start = offset + 1;
  }
  if (start < text.length) push(text.length);
  return cells;
}

function auditCsvMapping(
  representation: SourceRepresentation,
): RepresentationAuditFinding[] {
  const findings: RepresentationAuditFinding[] = [];
  const boundaries = normalizedBoundaries(representation.normalizedText);
  const expected = expectedCsvCells(representation.normalizedText);
  const locators = representation.locatorMap;
  let previousNormalizedStart = -1;
  let previousNormalizedEnd = -1;
  let previousOriginalStart = -1;
  let previousOriginalEnd = -1;

  for (const [index, locator] of locators.entries()) {
    if (locator.kind !== "cell" || locator.cell === undefined) {
      findings.push(
        finding(
          "LOCATOR_KIND_MISMATCH",
          "CSV representation requires cell locators with cell metadata.",
          index,
        ),
      );
    }
    const start = locator.normalized.utf16Start;
    const end = locator.normalized.utf16End;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      findings.push(
        finding(
          "LOCATOR_INTERVAL_INVALID",
          "Normalized CSV locator interval is invalid.",
          index,
        ),
      );
    } else if (start < 0 || end > representation.normalizedText.length) {
      findings.push(
        finding(
          "LOCATOR_OUT_OF_BOUNDS",
          "Normalized CSV locator is outside the representation text.",
          index,
        ),
      );
    } else {
      const startPosition = boundaries[start]!;
      const endPosition = boundaries[end]!;
      if (
        locator.normalized.lineStart !== startPosition.line ||
        locator.normalized.columnStart !== startPosition.column ||
        locator.normalized.lineEnd !== endPosition.line ||
        locator.normalized.columnEnd !== endPosition.column
      ) {
        findings.push(
          finding(
            "LOCATOR_POSITION_MISMATCH",
            "Normalized CSV locator line or column does not match its offsets.",
            index,
          ),
        );
      }
    }

    if (start < previousNormalizedStart) {
      findings.push(
        finding(
          "LOCATOR_ORDER_INVALID",
          "CSV locators are not in normalized source order.",
          index,
        ),
      );
    } else if (start < previousNormalizedEnd) {
      findings.push(
        finding("LOCATOR_OVERLAP", "Normalized CSV locators overlap.", index),
      );
    }
    previousNormalizedStart = start;
    previousNormalizedEnd = Math.max(previousNormalizedEnd, end);

    if (!validOriginalPosition(locator)) {
      findings.push(
        finding(
          "ORIGINAL_POSITION_INVALID",
          "Original CSV locator coordinates are invalid.",
          index,
        ),
      );
    }
    if (locator.original.byteStart < previousOriginalStart) {
      findings.push(
        finding(
          "LOCATOR_ORDER_INVALID",
          "CSV locators are not in original source order.",
          index,
        ),
      );
    } else if (locator.original.byteStart < previousOriginalEnd) {
      findings.push(
        finding("LOCATOR_OVERLAP", "Original CSV locators overlap.", index),
      );
    }
    previousOriginalStart = locator.original.byteStart;
    previousOriginalEnd = Math.max(
      previousOriginalEnd,
      locator.original.byteEnd,
    );

    const expectedCell = expected[index];
    if (
      !expectedCell ||
      locator.cell?.row !== expectedCell.row ||
      locator.cell.column !== expectedCell.column
    ) {
      findings.push({
        code: "CSV_CELL_ORDER_INVALID",
        severity: "error",
        message: "CSV cell identity is not in contiguous row-major order.",
        locatorIndex: index,
        ...(locator.cell === undefined ? {} : { cell: locator.cell }),
      });
    }
    if (
      expectedCell &&
      (start !== expectedCell.start || end !== expectedCell.end)
    ) {
      findings.push(
        finding(
          "MAPPING_COVERAGE_GAP",
          "CSV cell locator does not cover the expected serialized cell.",
          index,
        ),
      );
    }
  }
  if (locators.length !== expected.length) {
    findings.push(
      finding(
        "MAPPING_COVERAGE_GAP",
        "CSV locator count does not cover every serialized cell.",
      ),
    );
  }
  return findings;
}

function stableFindings(
  values: readonly RepresentationAuditFinding[],
): RepresentationAuditFinding[] {
  const byKey = new Map<string, RepresentationAuditFinding>();
  for (const value of values) {
    const key = [
      value.code,
      value.locatorIndex ?? -1,
      value.cell?.row ?? -1,
      value.cell?.column ?? -1,
      value.message,
    ].join("\u0000");
    byKey.set(key, value);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function freezeAudit(audit: RepresentationAudit): RepresentationAudit {
  Object.freeze(audit.capability);
  for (const finding of audit.findings) {
    if (finding.cell) Object.freeze(finding.cell);
    Object.freeze(finding);
  }
  Object.freeze(audit.findings);
  return Object.freeze(audit);
}

export function auditRepresentation(
  representationInput: unknown,
  capabilityInput?: unknown,
): IngestResult<RepresentationAudit, "INVALID_INPUT"> {
  const parsedRepresentation =
    SourceRepresentationSchema.safeParse(representationInput);
  if (!parsedRepresentation.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `Invalid source representation: ${parsedRepresentation.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const representation = parsedRepresentation.data as SourceRepresentation;
  const resolution = resolveCapability(representation, capabilityInput);
  const mappingFindings =
    representation.kind === "csv"
      ? auditCsvMapping(representation)
      : auditLineMapping(representation);
  const findings = stableFindings([...resolution.findings, ...mappingFindings]);
  const errors = findings.filter((value) => value.severity === "error");
  const structuralPass = !errors.some((value) =>
    [
      "LOCATOR_MISSING",
      "LOCATOR_KIND_MISMATCH",
      "MAPPING_COVERAGE_GAP",
      "CSV_CELL_ORDER_INVALID",
    ].includes(value.code),
  );
  const mappingPass = !errors.some((value) =>
    [
      "LOCATOR_INTERVAL_INVALID",
      "LOCATOR_OUT_OF_BOUNDS",
      "LOCATOR_ORDER_INVALID",
      "LOCATOR_OVERLAP",
      "LOCATOR_POSITION_MISMATCH",
      "ORIGINAL_POSITION_INVALID",
    ].includes(value.code),
  );
  const claimEligible =
    resolution.tier === "A" &&
    resolution.capability.status === "resolved" &&
    structuralPass &&
    mappingPass &&
    errors.length === 0;
  const parsedAudit = RepresentationAuditSchema.parse({
    schemaVersion: 1,
    representationId: representation.id,
    capability: resolution.capability,
    tier: resolution.tier,
    structuralPass,
    mappingPass,
    humanVerified: false,
    claimEligible,
    findings,
  }) as RepresentationAudit;

  return { ok: true, value: freezeAudit(parsedAudit) };
}
