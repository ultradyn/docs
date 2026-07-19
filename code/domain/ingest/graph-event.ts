/**
 * T-23-01 — Graph event / commit domain.
 *
 * GraphCommit is the VISIBILITY GATE for automatic generated-question branches:
 * precursor question/link/obligation records may physically exist before the
 * commit appends, but authoritative readers MUST resolve branches through the
 * commit — never by scanning stores for unreferenced precursors.
 */
import { z } from "zod";

import { ULID_PATTERN } from "./id-schemas.js";
import type { GraphRevision as GraphRevisionBrand } from "./types.js";

export const GraphRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(1_000_000_000)
  .transform((value) => value as GraphRevisionBrand);

export type GraphRevision = GraphRevisionBrand;

export const GraphOperationTypeSchema = z.enum([
  "create_generated_branch",
  /**
   * T-23-03 — registered for invalidation *event records* and the closed
   * command set. GraphGateway.apply deliberately does NOT execute this op yet
   * (explicit INVALID_EDGE via exhaustive switch). Wiring execution is a
   * separate mutation-authority change; deleting the refuse test is the
   * conversation that must happen first — not an accidental default fallthrough.
   */
  "propagate_invalidation",
  // Closed set — unknown types → INVALID_EDGE
]);

export type GraphOperationType = z.infer<typeof GraphOperationTypeSchema>;

/**
 * Operation body for create_generated_branch.
 * STRICT: no obligations / admitted / lexicalCandidates / link fields —
 * those are never authoritative and must not appear on the command.
 */
export const CreateGeneratedBranchOperationSchema = z
  .object({
    type: z.literal("create_generated_branch"),
    wording: z.string().trim().min(1).max(8_000),
    parentQuestionId: z
      .string()
      .regex(new RegExp(`^q-${ULID_PATTERN}$`))
      .optional(),
    /** Trigger source units for admission (from authoritative parent/context). */
    sourceUnitIds: z.array(z.string().min(1).max(256)).min(1).max(64),
  })
  .strict();

/**
 * Operation body for propagate_invalidation.
 * Present so the closed set can name the op; gateway execution is refused
 * until a later task wires it (see graph-gateway exhaustive switch).
 */
export const PropagateInvalidationOperationSchema = z
  .object({
    type: z.literal("propagate_invalidation"),
    rootArtifactIds: z.array(z.string().min(1).max(256)).min(1).max(64),
  })
  .strict();

export const GraphOperationSchema = z.discriminatedUnion("type", [
  CreateGeneratedBranchOperationSchema,
  PropagateInvalidationOperationSchema,
]);

export type GraphOperation = z.infer<typeof GraphOperationSchema>;

export const GraphEventIdSchema = z
  .string()
  .regex(new RegExp(`^gev-${ULID_PATTERN}$`));

export const GraphCommitIdSchema = z
  .string()
  .regex(new RegExp(`^gcm-${ULID_PATTERN}$`));

export const GraphEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: GraphEventIdSchema,
    revision: GraphRevisionSchema,
    operationType: GraphOperationTypeSchema,
    subjectIds: z.array(z.string().min(1)).max(64),
  })
  .strict();

export type GraphEvent = z.infer<typeof GraphEventSchema>;

export const GraphCommitSchema = z
  .object({
    schemaVersion: z.literal(1),
    commitId: GraphCommitIdSchema,
    revision: GraphRevisionSchema,
    idempotencyKey: z.string().min(1).max(256),
    events: z.array(GraphEventSchema).min(1).max(64),
    createdQuestionId: z
      .string()
      .regex(new RegExp(`^q-${ULID_PATTERN}$`))
      .optional(),
    createdLinkQuestionId: z
      .string()
      .regex(new RegExp(`^q-${ULID_PATTERN}$`))
      .optional(),
    createdObligationId: z
      .string()
      .regex(new RegExp(`^obl-${ULID_PATTERN}$`))
      .optional(),
  })
  .strict();

export type GraphCommit = z.infer<typeof GraphCommitSchema>;
