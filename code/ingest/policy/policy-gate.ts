// T-13-02 — mandatory policy gate over the retrieval and model boundaries.
//
// Enforcement only. This module opens no unit text on its own behalf beyond a
// bounded, policy-authorised preview projection; it calls no provider and has no
// delete / erase / purge / redaction path (content scanning is T-13-03, deletion
// is T-10-04). Every public method performs a FRESH assertRunAllowed on the
// approval ledger and fails closed; it never trusts a profile handed in by the
// caller, and it re-derives the approved profile internally by id on every call
// so a mid-session rotation or revocation is caught immediately.
//
// The approved profile, its content digest, the principal and the snapshot are
// the only things a decision binds to. Denials never carry a unit's path, text,
// or the provider token that was refused — a fixed message per code, so a
// hostile value can never ride out through an error string.

import { createHash } from "node:crypto";

import type {
  DataRightsPolicyProfile,
  SnapshotId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import type { IngestResult } from "../../domain/ingest/types.js";
import type { SearchHit, SearchResponse } from "../retrieval/lexical-index.js";

import type {
  ApprovedPolicyProfile,
  PolicyApprovalFailure,
  PolicyService,
} from "./policy-service.js";

/**
 * The repository binding for one source unit: which snapshot it belongs to,
 * which policy governs that snapshot, and its logical path for include /
 * exclude matching. This is metadata resolution over the SourceUnit / SourceFile
 * / Snapshot repositories, NOT a future per-unit access label (that is later
 * work). A production adapter composes those repositories; T-13-02 defines only
 * the seam and consumes a deterministic fake in tests.
 */
export interface UnitAccessRecord {
  readonly snapshotId: SnapshotId;
  readonly policyId: string;
  readonly logicalPath: string;
}

/**
 * A unit resolution. A metadata-store outage (`UNIT_METADATA_UNAVAILABLE`) is
 * deliberately distinct from a genuine miss (`UNIT_NOT_FOUND`): infrastructure
 * failure must never be laundered into a policy denial, and a missing unit must
 * never read as an outage. This is NOT an `IngestResult`; it carries no message.
 */
export type UnitAccessResolution =
  | { readonly ok: true; readonly value: UnitAccessRecord }
  | {
      readonly ok: false;
      readonly code: "UNIT_NOT_FOUND" | "UNIT_METADATA_UNAVAILABLE";
    };

export interface UnitAccessResolver {
  resolve(unitId: string): Promise<UnitAccessResolution>;
}

/**
 * Every way a gate decision can refuse. The run-authority codes are propagated
 * verbatim from `assertRunAllowed`; the rest are the gate's own boundary codes.
 * `UNIT_METADATA_UNAVAILABLE` surfaces a resolver outage without collapsing it
 * into a denial.
 */
export type PolicyGateFailure =
  | PolicyApprovalFailure
  | "ACCESS_DENIED"
  | "PROVIDER_DENIED"
  | "REGION_DENIED"
  | "QUOTE_DENIED"
  | "UNIT_METADATA_UNAVAILABLE";

/** Why a unit was dropped. A fixed vocabulary: never a path or text fragment. */
export type DenialReason =
  | "unit-unknown"
  | "snapshot-mismatch"
  | "policy-mismatch"
  | "path-excluded"
  | "outside-include";

/** The identity a filtered response binds to. Enough to prove which approved
 * profile, principal and snapshot governed the filter; nothing more. */
export interface PolicyIdentity {
  readonly profileId: string;
  readonly profileSha256: string;
  readonly principalId: string;
  readonly snapshotId: SnapshotId;
}

export interface DeniedUnit {
  readonly unitId: SourceUnitId;
  readonly reason: DenialReason;
}

export interface FilteredSearchResponse {
  readonly selectedIds: readonly SourceUnitId[];
  readonly candidateIds: readonly SourceUnitId[];
  readonly hits: readonly SearchHit[];
  readonly deniedIds: readonly DeniedUnit[];
  readonly policy: PolicyIdentity;
}

export interface ModelExposure {
  readonly profileId: string;
  readonly profileSha256: string;
  readonly principalId: string;
  readonly snapshotId: SnapshotId;
  readonly provider: string;
  readonly region: string;
  readonly unitIds: readonly SourceUnitId[];
  readonly quoteBytes: number;
}

export interface UnitPreview {
  readonly unitId: SourceUnitId;
  readonly snapshotId: SnapshotId;
  readonly policyId: string;
  readonly quote: string;
}

export interface FilterRetrievalInput {
  readonly response: SearchResponse;
  readonly profileId: string;
  readonly principalId: string;
}

export interface AuthoriseModelInput {
  readonly profileId: string;
  readonly principalId: string;
  readonly provider: string;
  readonly region: string;
  readonly unitIds: readonly SourceUnitId[];
  readonly quoteBytes?: number;
}

export interface PolicyNamespaceInput {
  readonly profileId: string;
  readonly principalId: string;
  readonly snapshotId: SnapshotId;
}

export interface ProjectUnitPreviewInput {
  readonly profileId: string;
  readonly principalId: string;
  readonly unitId: SourceUnitId;
  readonly text?: string;
}

export interface PolicyGate {
  filterRetrieval(
    input: FilterRetrievalInput,
  ): Promise<IngestResult<FilteredSearchResponse, PolicyGateFailure>>;
  authoriseModel(
    input: AuthoriseModelInput,
  ): Promise<IngestResult<ModelExposure, PolicyGateFailure>>;
  policyNamespace(
    input: PolicyNamespaceInput,
  ): Promise<IngestResult<string, PolicyGateFailure>>;
  projectUnitPreview(
    input: ProjectUnitPreviewInput,
  ): Promise<IngestResult<UnitPreview, PolicyGateFailure>>;
}

export interface PolicyGateDependencies {
  policyService: PolicyService;
  units: UnitAccessResolver;
}

/** An upper bound on how many unit ids a single model authorisation may name,
 * so a hostile or runaway caller cannot force unbounded resolver work. */
const MAX_UNIT_IDS = 10_000;

/**
 * Fixed message per code. Denials interpolate NOTHING: no path, no unit id, no
 * provider token. A caller learns the class of refusal, never a value that a
 * hostile input placed in front of us.
 */
const MESSAGES: Readonly<Record<PolicyGateFailure, string>> = Object.freeze({
  POLICY_UNAPPROVED: "no approved policy profile authorises this run",
  PROFILE_PROHIBITED: "the policy profile is prohibited and may never run",
  PROFILE_NOT_RUNNABLE:
    "the policy profile is not a runnable data rights profile",
  APPROVER_NOT_AUTHORIZED: "the approval actor is not authorised",
  APPROVAL_CONFLICT: "the approval ledger is in conflict",
  APPROVAL_NOT_AUTHENTIC:
    "the approval is not authentic and may not authorise a run",
  AUTHORITY_UNAVAILABLE:
    "the attestation authority is unavailable to authorise a run",
  INVALID_APPROVAL: "the approval record is invalid",
  CUSTODY_UNAVAILABLE: "the approval ledger is unavailable",
  ACCESS_DENIED: "the request is not permitted by the approved policy profile",
  PROVIDER_DENIED:
    "the requested provider is not permitted by the approved policy profile",
  REGION_DENIED:
    "the requested region is not permitted by the approved policy profile",
  QUOTE_DENIED:
    "the requested quote budget exceeds the approved policy profile",
  UNIT_METADATA_UNAVAILABLE:
    "unit metadata is unavailable, so no decision can be made",
});

function fail<T>(code: PolicyGateFailure): IngestResult<T, PolicyGateFailure> {
  return { ok: false, code, message: MESSAGES[code] };
}

/**
 * Recursive freeze. `Object.freeze` is shallow, so freezing only the outer
 * record would leave nested arrays and objects mutable.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

/** Reject an input object that carries any key beyond the expected set, so a
 * smuggled extra field can never alter a decision unnoticed. */
function hasOnlyKeys(input: object, allowed: readonly string[]): boolean {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

const globCache = new Map<string, RegExp>();

/** Compile a minimal glob: `**` spans path separators, `*` stays within a
 * segment, everything else is matched literally. Anchored end to end. */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (/[A-Za-z0-9/_-]/u.test(c)) {
      out += c;
    } else {
      out += `\\${c}`;
    }
  }
  out += "$";
  return new RegExp(out, "u");
}

function matchesGlob(pattern: string, path: string): boolean {
  let re = globCache.get(pattern);
  if (re === undefined) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(path);
}

/** Exclude-first path policy: an exclude match denies outright; otherwise the
 * path must match at least one include. Returns the denial reason, or null when
 * the path is allowed. */
function pathDenial(
  profile: DataRightsPolicyProfile,
  logicalPath: string,
): DenialReason | null {
  if (profile.exclude.some((rule) => matchesGlob(rule, logicalPath))) {
    return "path-excluded";
  }
  if (!profile.include.some((rule) => matchesGlob(rule, logicalPath))) {
    return "outside-include";
  }
  return null;
}

/** Byte-accurate truncation to a quote budget. A zero budget yields no quote at
 * all (metadata only); a partial trailing multibyte character is dropped. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  const sliced = buffer.subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false })
    .decode(sliced)
    .replace(/�+$/u, "");
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export function createPolicyGate(
  dependencies: PolicyGateDependencies,
): PolicyGate {
  const { policyService, units } = dependencies;

  // Fresh on EVERY call: re-read the ledger and re-verify the attestation. A
  // rotation or revocation between two calls must flip the second to a refusal,
  // so nothing derived here may be cached across calls.
  const authorise = async (
    profileId: string,
  ): Promise<IngestResult<ApprovedPolicyProfile, PolicyGateFailure>> => {
    const allowed = await policyService.assertRunAllowed(profileId);
    if (!allowed.ok) return fail(allowed.code);
    return { ok: true, value: allowed.value };
  };

  const filterRetrieval = async (
    input: FilterRetrievalInput,
  ): Promise<IngestResult<FilteredSearchResponse, PolicyGateFailure>> => {
    if (!hasOnlyKeys(input, ["response", "profileId", "principalId"])) {
      return fail("ACCESS_DENIED");
    }
    if (isBlank(input.principalId)) return fail("ACCESS_DENIED");

    const authorised = await authorise(input.profileId);
    if (!authorised.ok) return authorised;
    const profile = authorised.value.profile;
    const snapshotId = input.response.receipt.snapshotId;

    if (input.response.hits.length > MAX_UNIT_IDS) return fail("ACCESS_DENIED");

    // Reconstruct the filtered selection from the scored hits alone. The
    // caller's parallel selectedIds / candidateIds arrays are never read, so a
    // getter smuggled onto one of them can never inject an id past the gate.
    const allowedHits: SearchHit[] = [];
    const deniedIds: DeniedUnit[] = [];
    for (const hit of input.response.hits) {
      const resolution = await units.resolve(hit.unitId);
      if (!resolution.ok) {
        if (resolution.code === "UNIT_METADATA_UNAVAILABLE") {
          return fail("UNIT_METADATA_UNAVAILABLE");
        }
        deniedIds.push({ unitId: hit.unitId, reason: "unit-unknown" });
        continue;
      }
      const record = resolution.value;
      let reason: DenialReason | null;
      if (record.snapshotId !== snapshotId) {
        reason = "snapshot-mismatch";
      } else if (record.policyId !== profile.id) {
        reason = "policy-mismatch";
      } else {
        reason = pathDenial(profile, record.logicalPath);
      }
      if (reason === null) {
        allowedHits.push({ unitId: hit.unitId, score: hit.score });
      } else {
        deniedIds.push({ unitId: hit.unitId, reason });
      }
    }

    const allowedIds = allowedHits.map((hit) => hit.unitId);
    return {
      ok: true,
      value: deepFreeze<FilteredSearchResponse>({
        selectedIds: allowedIds,
        candidateIds: allowedIds,
        hits: allowedHits,
        deniedIds,
        policy: {
          profileId: profile.id,
          profileSha256: authorised.value.profileSha256,
          principalId: input.principalId,
          snapshotId,
        },
      }),
    };
  };

  const authoriseModel = async (
    input: AuthoriseModelInput,
  ): Promise<IngestResult<ModelExposure, PolicyGateFailure>> => {
    if (
      !hasOnlyKeys(input, [
        "profileId",
        "principalId",
        "provider",
        "region",
        "unitIds",
        "quoteBytes",
      ])
    ) {
      return fail("ACCESS_DENIED");
    }
    if (isBlank(input.principalId)) return fail("ACCESS_DENIED");
    // An empty unit set must never authorise a provider by accident, and a list
    // beyond the bound is refused before any resolver work.
    if (input.unitIds.length === 0) return fail("ACCESS_DENIED");
    if (input.unitIds.length > MAX_UNIT_IDS) return fail("ACCESS_DENIED");

    const authorised = await authorise(input.profileId);
    if (!authorised.ok) return authorised;
    const profile = authorised.value.profile;

    // Every unit must resolve, bind the SAME snapshot as its peers, be governed
    // by the approved profile, and pass path policy — all before a provider,
    // region or quote is even considered.
    let snapshotId: SnapshotId | null = null;
    for (const unitId of input.unitIds) {
      const resolution = await units.resolve(unitId);
      if (!resolution.ok) {
        if (resolution.code === "UNIT_METADATA_UNAVAILABLE") {
          return fail("UNIT_METADATA_UNAVAILABLE");
        }
        return fail("ACCESS_DENIED");
      }
      const record = resolution.value;
      if (snapshotId === null) {
        snapshotId = record.snapshotId;
      } else if (record.snapshotId !== snapshotId) {
        return fail("ACCESS_DENIED");
      }
      if (record.policyId !== profile.id) return fail("ACCESS_DENIED");
      if (pathDenial(profile, record.logicalPath) !== null) {
        return fail("ACCESS_DENIED");
      }
    }
    if (snapshotId === null) return fail("ACCESS_DENIED");

    if (
      input.provider === "*" ||
      !profile.allowedProviders.includes(input.provider)
    ) {
      return fail("PROVIDER_DENIED");
    }
    if (!profile.allowedRegions.includes(input.region)) {
      return fail("REGION_DENIED");
    }
    const quoteBytes = input.quoteBytes ?? 0;
    if (quoteBytes > profile.maxQuoteBytes) return fail("QUOTE_DENIED");

    return {
      ok: true,
      value: deepFreeze<ModelExposure>({
        profileId: profile.id,
        profileSha256: authorised.value.profileSha256,
        principalId: input.principalId,
        snapshotId,
        provider: input.provider,
        region: input.region,
        unitIds: [...input.unitIds],
        quoteBytes,
      }),
    };
  };

  const policyNamespace = async (
    input: PolicyNamespaceInput,
  ): Promise<IngestResult<string, PolicyGateFailure>> => {
    if (!hasOnlyKeys(input, ["profileId", "principalId", "snapshotId"])) {
      return fail("ACCESS_DENIED");
    }
    if (isBlank(input.principalId)) return fail("ACCESS_DENIED");

    const authorised = await authorise(input.profileId);
    if (!authorised.ok) return authorised;
    const profile = authorised.value.profile;

    // The key ALWAYS binds the complete tuple in a fixed order: schema tag,
    // canonical profile id, profile digest, principal and snapshot. Two runs
    // may share a cache namespace only when all of these are identical, so a
    // changed profile digest can never collide with the profile it replaced.
    const digest = createHash("sha256")
      .update(
        [
          "ultradyn.policy-namespace.v1",
          profile.id,
          authorised.value.profileSha256,
          input.principalId,
          input.snapshotId,
        ].join("\n"),
      )
      .digest("hex");
    return { ok: true, value: `ns-${digest}` };
  };

  const projectUnitPreview = async (
    input: ProjectUnitPreviewInput,
  ): Promise<IngestResult<UnitPreview, PolicyGateFailure>> => {
    if (!hasOnlyKeys(input, ["profileId", "principalId", "unitId", "text"])) {
      return fail("ACCESS_DENIED");
    }
    if (isBlank(input.principalId)) return fail("ACCESS_DENIED");

    const authorised = await authorise(input.profileId);
    if (!authorised.ok) return authorised;
    const profile = authorised.value.profile;

    const resolution = await units.resolve(input.unitId);
    if (!resolution.ok) {
      if (resolution.code === "UNIT_METADATA_UNAVAILABLE") {
        return fail("UNIT_METADATA_UNAVAILABLE");
      }
      return fail("ACCESS_DENIED");
    }
    const record = resolution.value;
    if (record.policyId !== profile.id) return fail("ACCESS_DENIED");
    if (pathDenial(profile, record.logicalPath) !== null) {
      return fail("ACCESS_DENIED");
    }

    // Projection, not scanning: the quote is truncated to the profile budget and
    // is empty when the profile permits no quotes. The full text never leaves.
    return {
      ok: true,
      value: deepFreeze<UnitPreview>({
        unitId: input.unitId,
        snapshotId: record.snapshotId,
        policyId: record.policyId,
        quote: truncateToBytes(input.text ?? "", profile.maxQuoteBytes),
      }),
    };
  };

  return {
    filterRetrieval,
    authoriseModel,
    policyNamespace,
    projectUnitPreview,
  };
}
