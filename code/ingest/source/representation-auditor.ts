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
): RepresentationAuditFinding {
  return { code, severity: "error", message };
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
  const findings = stableFindings(resolution.findings);
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
