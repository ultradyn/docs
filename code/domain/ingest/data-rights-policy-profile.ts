import { z } from "zod";

/**
 * Vocabulary (binding, see the T-13-01 handoff):
 *
 *   PolicyProfile            - frozen minimal intake/preflight contract (v1,
 *                              ./policy-profile.ts). Never silently upgraded,
 *                              never run-authoritative.
 *   DataRightsPolicyProfile  - this module. The expanded declarative candidate
 *                              record, registered under its own registry name
 *                              at schemaVersion 1 and its own portable scaffold
 *                              schema. Additive: it does not redefine v1 of the
 *                              legacy name.
 *   ApprovedPolicyProfile    - the approval-ledger, content-digest-bound view
 *                              returned by PolicyService (../../ingest/policy).
 *
 * Known legacy drift, deliberately left unrepaired: the frozen PolicyProfile
 * exports a `DataClass` union that names "prohibited", while its Zod enum
 * omits it, so a prohibited profile can never parse. That contract is frozen,
 * so the drift stays. `DataRightsClass` below is the aligned replacement:
 * prohibited material is expressed by having no approved profile at all, not
 * by a class that is unrepresentable by construction.
 *
 * Declarative policy only. This module must never grow a delete, erase, purge,
 * or unlink field, nor retention semantics meaning physical erasure. Authorised
 * deletion is T-10-04, blocked on ADR 0007, ratified D9, and every capability
 * gate.
 */
export type DataRightsClass =
  "public" | "internal" | "confidential" | "restricted-local-only";

/** Where a profile's material may be published. Closed by design: a downstream
 * gate must never invent a default for material whose licence forbids it. */
export type PublicationRule =
  "forbidden" | "internal-only" | "change-request-required" | "external";

/** Machine-checkable licence restriction codes. Closed so that T-13-02 and the
 * publication gate cannot be handed a code they do not understand. */
export type LicenceRestriction =
  | "no-redistribution"
  | "no-derivatives"
  | "no-verbatim-quotes"
  | "attribution-required";

/** Retention is a declaration of intent for ingestion exposure. It is NOT a
 * custody erase schedule: nothing here expires or removes retained bytes. */
export type RetentionClass =
  "project-lifetime" | "engagement-scoped" | "session-scoped";

/** What may be written to logs. Never bytes, never secrets. */
export type LoggingRule = "none" | "ids-only" | "ids-and-paths";

/** Dimensions a cache key must include, so T-13-02 can derive a namespace that
 * cannot collide across profiles or principals. */
export type CacheDimension = "profileId" | "principalId" | "snapshotId";

export interface DataRightsPolicyProfile {
  schemaVersion: 1;
  id: string;
  dataRightsClass: DataRightsClass;
  include: readonly string[];
  exclude: readonly string[];
  allowedMediaTypes: readonly string[];
  /** LOCAL extraction capabilities. Read bytes already in custody, no egress. */
  allowedProcessors: readonly string[];
  /** REMOTE model/STT capabilities. Carry egress, hence region concerns. Kept
   * distinct from processors precisely because the threat profiles differ. */
  allowedProviders: readonly string[];
  allowedStorage: readonly string[];
  /** Region codes, or the explicit "local" token. Never empty: an empty list
   * would read as allow-all to a careless consumer. */
  allowedRegions: readonly string[];
  retentionClass: RetentionClass;
  retentionDays: number;
  logging: LoggingRule;
  cache: readonly CacheDimension[];
  accessClass: string;
  licenceRestrictions: readonly LicenceRestriction[];
  publication: PublicationRule;
  /** Bytes of source text exposable to model or quote surfaces. 0 = no quotes. */
  maxQuoteBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
}

/**
 * Rule budgets. Unbounded pattern lists are a denial-of-service surface for
 * every consumer that walks them, so the limits are published and frozen rather
 * than left implicit in the schema.
 */
export const DATA_RIGHTS_POLICY_LIMITS = Object.freeze({
  maxRulesPerList: 256,
  maxRuleChars: 512,
  maxCapabilitiesPerList: 64,
});

const NonEmptyStringSchema = z.string().trim().min(1);

const RuleSchema = z
  .string()
  .trim()
  .min(1)
  .max(DATA_RIGHTS_POLICY_LIMITS.maxRuleChars);
const RuleListSchema = z
  .array(RuleSchema)
  .max(DATA_RIGHTS_POLICY_LIMITS.maxRulesPerList);

/**
 * Capability identifiers are opaque tokens, never executable input. "*" is
 * rejected outright: a wildcard would silently mean "any processor", which is
 * the opposite of the acceptance criterion that every profile map to explicit
 * processors and storage.
 */
const CapabilitySchema = z
  .string()
  .trim()
  .min(1)
  .max(DATA_RIGHTS_POLICY_LIMITS.maxRuleChars)
  .refine((value) => !value.includes("*"), {
    message: "wildcard capabilities are not permitted; list ids explicitly",
  });

const CapabilityListSchema = z
  .array(CapabilitySchema)
  .min(1)
  .max(DATA_RIGHTS_POLICY_LIMITS.maxCapabilitiesPerList);

const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const DATA_RIGHTS_CLASSES = [
  "public",
  "internal",
  "confidential",
  "restricted-local-only",
] as const;

export const PUBLICATION_RULES = [
  "forbidden",
  "internal-only",
  "change-request-required",
  "external",
] as const;

export const LICENCE_RESTRICTIONS = [
  "no-redistribution",
  "no-derivatives",
  "no-verbatim-quotes",
  "attribution-required",
] as const;

export const RETENTION_CLASSES = [
  "project-lifetime",
  "engagement-scoped",
  "session-scoped",
] as const;

export const LOGGING_RULES = ["none", "ids-only", "ids-and-paths"] as const;

export const CACHE_DIMENSIONS = [
  "profileId",
  "principalId",
  "snapshotId",
] as const;

export const DataRightsPolicyProfileSchema: z.ZodType<DataRightsPolicyProfile> =
  z
    .object({
      schemaVersion: z.literal(1),
      id: NonEmptyStringSchema,
      dataRightsClass: z.enum(DATA_RIGHTS_CLASSES),
      include: RuleListSchema.min(1),
      exclude: RuleListSchema,
      allowedMediaTypes: CapabilityListSchema,
      allowedProcessors: CapabilityListSchema,
      allowedProviders: CapabilityListSchema,
      allowedStorage: CapabilityListSchema,
      allowedRegions: CapabilityListSchema,
      retentionClass: z.enum(RETENTION_CLASSES),
      // Positive, never zero: a zero window must not be readable as "purge now".
      retentionDays: PositiveIntegerSchema,
      logging: z.enum(LOGGING_RULES),
      cache: z.array(z.enum(CACHE_DIMENSIONS)).min(1),
      accessClass: NonEmptyStringSchema,
      licenceRestrictions: z
        .array(z.enum(LICENCE_RESTRICTIONS))
        .max(LICENCE_RESTRICTIONS.length),
      publication: z.enum(PUBLICATION_RULES),
      maxQuoteBytes: NonNegativeIntegerSchema,
      maxFiles: PositiveIntegerSchema,
      maxFileBytes: PositiveIntegerSchema,
      maxExpandedBytes: PositiveIntegerSchema,
    })
    .strict()
    .superRefine((profile, context) => {
      const overlap = [
        ...new Set(
          profile.include.filter((path) => profile.exclude.includes(path)),
        ),
      ].sort();
      if (overlap.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["exclude"],
          message: `include/exclude overlap: ${overlap.join(", ")}`,
        });
      }

      // Licence restrictions reach the publication rule. Presence of the field
      // proves nothing if its value may contradict the classification, so the
      // cross-field check is where the acceptance criterion actually lands.
      if (profile.publication === "external") {
        if (profile.dataRightsClass !== "public") {
          context.addIssue({
            code: "custom",
            path: ["publication"],
            message: `external publication requires dataRightsClass "public", not "${profile.dataRightsClass}"`,
          });
        }
        if (profile.licenceRestrictions.length > 0) {
          context.addIssue({
            code: "custom",
            path: ["publication"],
            message: `external publication is incompatible with licence restrictions: ${[...profile.licenceRestrictions].sort().join(", ")}`,
          });
        }
      }

      // Quotable bytes must be licensed. A profile forbidding verbatim quotes
      // cannot also budget for them.
      if (
        profile.maxQuoteBytes > 0 &&
        profile.licenceRestrictions.includes("no-verbatim-quotes")
      ) {
        context.addIssue({
          code: "custom",
          path: ["maxQuoteBytes"],
          message:
            'maxQuoteBytes must be 0 when the licence carries "no-verbatim-quotes"',
        });
      }
    });

/** Lists whose order carries no meaning, and which are therefore sorted before
 * hashing so that two semantically identical profiles share one digest. */
const ORDER_INSENSITIVE_KEYS = [
  "include",
  "exclude",
  "allowedMediaTypes",
  "allowedProcessors",
  "allowedProviders",
  "allowedStorage",
  "allowedRegions",
  "cache",
  "licenceRestrictions",
] as const;

/**
 * Canonicalize for digest purposes only.
 *
 * Returns a NEW object; the caller's profile is never sorted in place. Preflight
 * reports the first matching pattern by name, so reordering a stored list would
 * silently change which rule is blamed in a diagnostic. Keys are emitted in a
 * fixed order because `JSON.stringify` is not canonical equality: Zod rebuilds
 * parsed objects in schema key order, so relying on insertion order would make
 * the digest depend on how the value happened to be constructed.
 */
export function canonicalDataRightsPolicyProfile(
  profile: DataRightsPolicyProfile,
): DataRightsPolicyProfile {
  const sorted = new Map<string, readonly string[]>();
  for (const key of ORDER_INSENSITIVE_KEYS) {
    sorted.set(key, [...profile[key]].sort());
  }

  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    dataRightsClass: profile.dataRightsClass,
    include: sorted.get("include") as readonly string[],
    exclude: sorted.get("exclude") as readonly string[],
    allowedMediaTypes: sorted.get("allowedMediaTypes") as readonly string[],
    allowedProcessors: sorted.get("allowedProcessors") as readonly string[],
    allowedProviders: sorted.get("allowedProviders") as readonly string[],
    allowedStorage: sorted.get("allowedStorage") as readonly string[],
    allowedRegions: sorted.get("allowedRegions") as readonly string[],
    retentionClass: profile.retentionClass,
    retentionDays: profile.retentionDays,
    logging: profile.logging,
    cache: sorted.get("cache") as readonly CacheDimension[],
    accessClass: profile.accessClass,
    licenceRestrictions: sorted.get(
      "licenceRestrictions",
    ) as readonly LicenceRestriction[],
    publication: profile.publication,
    maxQuoteBytes: profile.maxQuoteBytes,
    maxFiles: profile.maxFiles,
    maxFileBytes: profile.maxFileBytes,
    maxExpandedBytes: profile.maxExpandedBytes,
  });
}
