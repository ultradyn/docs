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

const roleSet = new Set<string>(roles);
const evaluatorRoles = new Set<IngestAgentRole>([
  "evidence-critic",
  "claim-reviewer",
]);
const terminalRole: IngestAgentRole = "answer-composer";
const retrievalTools = new Set(["source.search", "source.read"]);

function failure(
  code: ManifestError,
  message: string,
): IngestResult<true, ManifestError> {
  return { ok: false, code, message };
}

export function validateIngestManifests(
  input: readonly IngestAgentManifest[],
): IngestResult<true, ManifestError> {
  const schemas = new Set<string>(ingestSchemaRegistry.names());
  const manifests = new Map<IngestAgentRole, IngestAgentManifest>();

  for (const manifest of input) {
    if (!roleSet.has(manifest.role)) {
      return failure(
        "DANGLING_REFERENCE",
        `Unknown ingestion agent role: ${String(manifest.role)}.`,
      );
    }
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
    const deniedRetrievalTool = manifest.tools.find((tool) =>
      retrievalTools.has(tool),
    );
    if (manifest.role === terminalRole && deniedRetrievalTool) {
      return failure(
        "TOOL_DENIED",
        `answer-composer cannot use retrieval tool ${deniedRetrievalTool}.`,
      );
    }
    for (const successor of manifest.next) {
      if (!manifests.has(successor as IngestAgentRole)) {
        return failure(
          "DANGLING_REFERENCE",
          `${manifest.role} references unknown successor ${successor}.`,
        );
      }
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
      if (manifest) {
        pending.push(...(manifest.next as readonly IngestAgentRole[]));
      }
    }
    return false;
  };

  for (const role of roles) {
    const manifest = manifests.get(role);
    if (
      role !== terminalRole &&
      (manifest?.next.length === 0 || !reachesTerminal(role))
    ) {
      return failure(
        "UNREACHABLE_STATE",
        `${role} has no path to terminal state ${terminalRole}.`,
      );
    }
  }

  const reachableFromEntry = new Set<IngestAgentRole>();
  const pendingFromEntry: IngestAgentRole[] = ["researcher"];
  while (pendingFromEntry.length > 0) {
    const role = pendingFromEntry.pop();
    if (!role || reachableFromEntry.has(role)) continue;
    reachableFromEntry.add(role);
    const manifest = manifests.get(role);
    if (manifest) {
      pendingFromEntry.push(...(manifest.next as readonly IngestAgentRole[]));
    }
  }
  const unreachableRole = roles.find((role) => !reachableFromEntry.has(role));
  if (unreachableRole) {
    return failure(
      "UNREACHABLE_STATE",
      `${unreachableRole} is unreachable from workflow entry researcher.`,
    );
  }

  return { ok: true, value: true };
}
