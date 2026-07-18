import { z } from "zod";

import {
  ingestSchemaRegistry,
  type IngestResult,
} from "../domain/ingest/index.js";

export type IngestAgentRole =
  | "researcher"
  | "evidence-critic"
  | "claim-extractor"
  | "claim-reviewer"
  | "answer-composer";

export interface IngestAgentManifest {
  role: IngestAgentRole;
  outputSchema: string;
  tools: readonly string[];
  freshContext: boolean;
  next: readonly string[];
}

type ManifestError =
  | "DANGLING_REFERENCE"
  | "EVALUATOR_NOT_FRESH"
  | "UNREACHABLE_STATE"
  | "TOOL_DENIED";

const roles = [
  "researcher",
  "evidence-critic",
  "claim-extractor",
  "claim-reviewer",
  "answer-composer",
] as const satisfies readonly IngestAgentRole[];

export const INGEST_ROLE_TOOL_ALLOWLIST = {
  researcher: [
    "source.exact",
    "source.maps",
    "source.lexical",
    "source.open_unit",
    "source.follow_links",
  ],
  "evidence-critic": ["source.open_reference", "source.open_reference_context"],
  "claim-extractor": ["source.open_reference"],
  "claim-reviewer": ["source.open_reference", "claim.find_candidates"],
  "answer-composer": ["answer.format"],
} as const satisfies Record<IngestAgentRole, readonly string[]>;

const successorAllowlist = {
  researcher: ["evidence-critic"],
  "evidence-critic": ["researcher", "claim-extractor"],
  "claim-extractor": ["claim-reviewer"],
  "claim-reviewer": ["answer-composer"],
  "answer-composer": [],
} as const satisfies Record<IngestAgentRole, readonly IngestAgentRole[]>;

const evaluatorRoles = new Set<IngestAgentRole>([
  "evidence-critic",
  "claim-reviewer",
]);
const terminalRole: IngestAgentRole = "answer-composer";

const manifestInputSchema = z.array(
  z.object({
    role: z.enum(roles),
    outputSchema: z.string(),
    tools: z.array(z.string()),
    freshContext: z.boolean(),
    next: z.array(z.string()),
  }),
);

function failure(
  code: ManifestError,
  message: string,
): IngestResult<true, ManifestError> {
  return { ok: false, code, message };
}

export function validateIngestManifests(
  input: readonly IngestAgentManifest[],
): IngestResult<true, ManifestError> {
  const parsed = manifestInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "DANGLING_REFERENCE",
      `Malformed ingestion manifest: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.`,
    );
  }

  const schemas = new Set<string>(ingestSchemaRegistry.names());
  const manifests = new Map<IngestAgentRole, IngestAgentManifest>();

  for (const manifest of parsed.data) {
    if (manifests.has(manifest.role)) {
      return failure(
        "DANGLING_REFERENCE",
        `Duplicate ingestion agent role: ${manifest.role}.`,
      );
    }
    if (!schemas.has(manifest.outputSchema)) {
      return failure(
        "DANGLING_REFERENCE",
        `${manifest.role} references unknown schema ${manifest.outputSchema}.`,
      );
    }
    manifests.set(manifest.role, manifest);
  }

  for (const role of roles) {
    if (!manifests.has(role)) {
      return failure(
        "DANGLING_REFERENCE",
        `Missing ingestion agent role: ${role}.`,
      );
    }
  }

  for (const manifest of manifests.values()) {
    if (evaluatorRoles.has(manifest.role) && !manifest.freshContext) {
      return failure(
        "EVALUATOR_NOT_FRESH",
        `${manifest.role} must run with fresh context.`,
      );
    }

    const allowedTools = new Set<string>(
      INGEST_ROLE_TOOL_ALLOWLIST[manifest.role],
    );
    const deniedTool = manifest.tools.find((tool) => !allowedTools.has(tool));
    if (deniedTool) {
      return failure(
        "TOOL_DENIED",
        `${manifest.role} cannot use tool ${deniedTool}.`,
      );
    }

    const allowedSuccessors = new Set<string>(
      successorAllowlist[manifest.role],
    );
    const danglingSuccessor = manifest.next.find(
      (successor) => !manifests.has(successor as IngestAgentRole),
    );
    if (danglingSuccessor) {
      return failure(
        "DANGLING_REFERENCE",
        `${manifest.role} references unknown successor ${danglingSuccessor}.`,
      );
    }
    const deniedSuccessor = manifest.next.find(
      (successor) => !allowedSuccessors.has(successor),
    );
    if (deniedSuccessor) {
      return failure(
        "UNREACHABLE_STATE",
        `${manifest.role} cannot transition to ${deniedSuccessor}.`,
      );
    }
  }

  const terminal = manifests.get(terminalRole);
  if (!terminal || terminal.next.length > 0) {
    return failure(
      "UNREACHABLE_STATE",
      `${terminalRole} must be the terminal state.`,
    );
  }

  const reachesTerminal = (start: IngestAgentRole): boolean => {
    const pending: IngestAgentRole[] = [start];
    const visited = new Set<IngestAgentRole>();
    while (pending.length > 0) {
      const role = pending.pop();
      if (!role || visited.has(role)) continue;
      if (role === terminalRole) return true;
      visited.add(role);
      const manifest = manifests.get(role);
      if (manifest) pending.push(...(manifest.next as IngestAgentRole[]));
    }
    return false;
  };

  const reachableFromEntry = new Set<IngestAgentRole>();
  const pendingFromEntry: IngestAgentRole[] = ["researcher"];
  while (pendingFromEntry.length > 0) {
    const role = pendingFromEntry.pop();
    if (!role || reachableFromEntry.has(role)) continue;
    reachableFromEntry.add(role);
    const manifest = manifests.get(role);
    if (manifest)
      pendingFromEntry.push(...(manifest.next as IngestAgentRole[]));
  }

  for (const role of roles) {
    const manifest = manifests.get(role);
    if (
      (role !== terminalRole && manifest?.next.length === 0) ||
      !reachesTerminal(role) ||
      !reachableFromEntry.has(role)
    ) {
      return failure(
        "UNREACHABLE_STATE",
        `${role} is not on a reachable path from researcher to ${terminalRole}.`,
      );
    }
  }

  return { ok: true, value: true };
}
