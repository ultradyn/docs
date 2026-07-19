import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";

import {
  ScanFindingSchema,
  ScanPolicySchema,
  type ScanAction,
  type ScanFinding,
  type ScanPolicy,
  type ScanVerdict,
} from "../../domain/ingest/content-scan.js";
import type {
  DataRightsPolicyProfile,
  IngestResult,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import type { SourceRepresentation } from "../../domain/ingest/representation-records.js";

import type { ScanAdapter } from "./testing.js";

export type ContentScannerError =
  | "INVALID_INPUT"
  | "BLOCKED"
  | "PROHIBITED_MATERIAL"
  | "PUBLICATION_FORBIDDEN"
  | "PROHIBITED_CLASS"
  | "COMMIT_FAILED";

export interface QuarantineRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly detectorIds: readonly string[];
  readonly findingKinds: readonly string[];
  readonly action: "quarantine";
}

export interface QuarantineStore {
  append(record: QuarantineRecord): Promise<void>;
  list(): Promise<readonly QuarantineRecord[]>;
}

export interface ContentScanner {
  scanForModelExposure(
    text: unknown,
  ): Promise<IngestResult<ScanVerdict, ContentScannerError>>;
  redactRepresentation(
    rep: SourceRepresentation,
    findings: readonly ScanFinding[],
  ): Promise<IngestResult<SourceRepresentation, ContentScannerError>>;
  scanProposedCommit(
    input: unknown,
  ): Promise<IngestResult<ScanVerdict, ContentScannerError>>;
}

const FIXED_MESSAGES: Record<ContentScannerError, string> = {
  INVALID_INPUT: "Scan input is invalid.",
  BLOCKED: "Content scan blocked exposure of prohibited material.",
  PROHIBITED_MATERIAL: "Proposed commit contains prohibited material.",
  PUBLICATION_FORBIDDEN: "Publication is forbidden for this material.",
  PROHIBITED_CLASS: "Data rights class prohibits the proposed commit.",
  COMMIT_FAILED: "Content scan commit failed.",
};

function failure(
  code: ContentScannerError,
): IngestResult<never, ContentScannerError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success<T>(value: T): IngestResult<T, ContentScannerError> {
  return Object.freeze({ ok: true as const, value: deepFreeze(value) });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const child of Object.values(value as object)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function actionFor(policy: ScanPolicy, kind: ScanFinding["kind"]): ScanAction {
  return policy.actionsByKind[kind] ?? policy.defaultAction;
}

function collectFindings(
  adapters: readonly ScanAdapter[],
  text: string,
): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const adapter of adapters) {
    const found = adapter.scan(text);
    for (const item of found) {
      const parsed = ScanFindingSchema.safeParse(item);
      if (parsed.success) {
        out.push(parsed.data as ScanFinding);
      }
    }
  }
  // Sort by span start for determinism
  out.sort(
    (a, b) => a.span.normalized.utf16Start - b.span.normalized.utf16Start,
  );
  return out;
}

function deriveOutcome(
  findings: readonly ScanFinding[],
  actions: readonly ScanAction[],
): ScanVerdict["outcome"] {
  if (findings.length === 0) return "clean";
  if (actions.includes("block")) return "blocked";
  if (actions.includes("quarantine")) return "quarantined";
  if (actions.includes("redact")) return "redacted";
  return "clean";
}

function crockfordBody(hex: string): string {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return body;
}

function newRepresentationId(
  supersedes: string,
  version: number,
): SourceRepresentationId {
  const hex = createHash("sha256")
    .update(`scan-redact:${supersedes}:${version}`)
    .digest("hex")
    .toUpperCase();
  return `repr-${crockfordBody(hex)}` as SourceRepresentationId;
}

const PLACEHOLDER = "[REDACTED]";

function applyRedaction(
  text: string,
  findings: readonly ScanFinding[],
): string {
  // Apply from end so earlier offsets stay valid.
  const spans = [...findings]
    .map((f) => ({
      start: f.span.normalized.utf16Start,
      end: f.span.normalized.utf16End,
    }))
    .filter((s) => s.start >= 0 && s.end > s.start && s.end <= text.length)
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of spans) {
    out = `${out.slice(0, span.start)}${PLACEHOLDER}${out.slice(span.end)}`;
  }
  return out;
}

export function createInMemoryQuarantineStore(): QuarantineStore {
  const records: QuarantineRecord[] = [];
  return {
    async append(record) {
      records.push(deepFreeze(structuredClone(record)));
    },
    async list() {
      return Object.freeze(records.map((r) => deepFreeze(structuredClone(r))));
    },
  };
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FD_BOUND = process.platform === "linux";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function createFileQuarantineStore(root: string): QuarantineStore {
  if (!FD_BOUND) {
    const unavailable = () => {
      throw new Error(
        "Descriptor binding unavailable: quarantine store fail-closed.",
      );
    };
    return {
      append: unavailable as QuarantineStore["append"],
      list: unavailable as QuarantineStore["list"],
    };
  }

  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();
  const components = [".ultradyn", "scan-quarantine"] as const;

  async function openBound() {
    let handle = await open(root, DIRECTORY_FLAGS).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error("Refusing symbolic-link quarantine root.", {
          cause: error,
        });
      }
      throw error;
    });
    const handles = [handle];
    try {
      for (const component of components) {
        const viaFd = `/proc/self/fd/${handle.fd}/${component}`;
        try {
          await mkdir(viaFd, { mode: 0o700 });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        const child = await open(viaFd, DIRECTORY_FLAGS);
        handles.push(child);
        await handle.close();
        handles.shift();
        handle = child;
      }
      const bound = handle;
      return {
        at: (name: string) => `/proc/self/fd/${bound.fd}/${name}`,
        list: async () => readdir(`/proc/self/fd/${bound.fd}`),
        close: async () => {
          await bound.close();
        },
      };
    } catch (error) {
      for (const h of handles) await h.close().catch(() => undefined);
      throw error;
    }
  }

  function locked<T>(operation: () => Promise<T>): Promise<T> {
    if (holder.getStore()) return operation();
    const run = () => holder.run(true, operation);
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    async append(record) {
      await locked(async () => {
        const bound = await openBound();
        try {
          const leaf = `${record.id}.json`;
          const path = bound.at(leaf);
          const bytes = `${JSON.stringify(record)}\n`;
          const temporary = bound.at(`.${leaf}.${process.pid}.tmp`);
          const file = await open(
            temporary,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          try {
            await lstat(path);
            await rm(temporary, { force: true });
            return;
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
          await rename(temporary, path);
        } finally {
          await bound.close();
        }
      });
    },
    async list() {
      return locked(async () => {
        const bound = await openBound();
        try {
          const names = await bound.list();
          const out: QuarantineRecord[] = [];
          for (const name of names) {
            if (!name.endsWith(".json") || name.startsWith(".")) continue;
            const handle = await open(
              bound.at(name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const bytes = await handle.readFile("utf8");
              out.push(deepFreeze(JSON.parse(bytes) as QuarantineRecord));
            } finally {
              await handle.close();
            }
          }
          return Object.freeze(out);
        } finally {
          await bound.close();
        }
      });
    },
  };
}

export function createContentScanner(options: {
  readonly adapters: readonly ScanAdapter[];
  readonly policy: ScanPolicy;
  readonly quarantine?: QuarantineStore;
}): ContentScanner {
  if (!options || typeof options !== "object") {
    throw new Error("Content scanner options are required.");
  }
  const { adapters, policy, quarantine } = options;
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error("At least one scan adapter is required.");
  }
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.scan !== "function") {
      throw new Error("Each adapter must implement scan().");
    }
  }
  if (!policy || !ScanPolicySchema.safeParse(policy).success) {
    throw new Error("A valid scan policy is required.");
  }

  async function runScan(text: string): Promise<{
    findings: ScanFinding[];
    actions: ScanAction[];
    outcome: ScanVerdict["outcome"];
  }> {
    const findings = collectFindings(adapters, text);
    const actions = [
      ...new Set(findings.map((f) => actionFor(policy, f.kind))),
    ];
    const outcome = deriveOutcome(findings, actions);
    if (outcome === "quarantined" && quarantine) {
      const idHex = createHash("sha256")
        .update(`quarantine:${text.length}:${findings.length}`)
        .digest("hex")
        .slice(0, 26)
        .toUpperCase();
      await quarantine.append(
        deepFreeze({
          schemaVersion: 1 as const,
          id: `qrn-${idHex}`,
          createdAt: new Date(0).toISOString(),
          detectorIds: Object.freeze([
            ...new Set(findings.map((f) => f.detectorId)),
          ]),
          findingKinds: Object.freeze([
            ...new Set(findings.map((f) => f.kind)),
          ]),
          action: "quarantine" as const,
        }),
      );
    }
    return { findings, actions, outcome };
  }

  return {
    async scanForModelExposure(text) {
      if (typeof text !== "string") {
        return failure("INVALID_INPUT");
      }
      const { findings, actions, outcome } = await runScan(text);
      if (outcome === "blocked") {
        return failure("BLOCKED");
      }
      const verdict: ScanVerdict = {
        outcome,
        findings: Object.freeze([...findings]),
        appliedActions: Object.freeze([...actions]),
      };
      return success(verdict);
    },

    async redactRepresentation(rep, findings) {
      if (
        !rep ||
        typeof rep !== "object" ||
        typeof rep.normalizedText !== "string"
      ) {
        return failure("INVALID_INPUT");
      }
      const safeFindings: ScanFinding[] = [];
      for (const finding of findings ?? []) {
        const parsed = ScanFindingSchema.safeParse(finding);
        if (parsed.success) safeFindings.push(parsed.data as ScanFinding);
      }
      const redactedText = applyRedaction(rep.normalizedText, safeFindings);
      const nextVersion = rep.version + 1;
      const next: SourceRepresentation = deepFreeze({
        schemaVersion: 1 as const,
        id: newRepresentationId(rep.id, nextVersion),
        sourceFileId: rep.sourceFileId,
        supersedesId: rep.id,
        version: nextVersion,
        kind: rep.kind,
        normalizedText: redactedText,
        // Preserve authorized mapping structure; re-span whole text as one map entry.
        locatorMap: Object.freeze(
          rep.locatorMap.length > 0
            ? structuredClone(rep.locatorMap)
            : [
                {
                  kind: "span" as const,
                  normalized: {
                    utf16Start: 0,
                    utf16End: redactedText.length,
                    lineStart: 1,
                    columnStart: 1,
                    lineEnd: 1,
                    columnEnd: Math.max(1, redactedText.length + 1),
                  },
                  original: {
                    byteStart: 0,
                    byteEnd: redactedText.length,
                    lineStart: 1,
                    columnStart: 1,
                    lineEnd: 1,
                    columnEnd: Math.max(1, redactedText.length + 1),
                  },
                },
              ],
        ),
        warnings: Object.freeze([...(rep.warnings ?? [])]),
      });
      return success(next);
    },

    async scanProposedCommit(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT");
      }
      const dataRights = (input as { dataRights?: DataRightsPolicyProfile })
        .dataRights;
      if (dataRights) {
        if (dataRights.dataRightsClass === "prohibited") {
          return failure("PROHIBITED_CLASS");
        }
        if (dataRights.publication === "forbidden") {
          return failure("PUBLICATION_FORBIDDEN");
        }
      }
      const textByPath = (input as { textByPath?: Record<string, string> })
        .textByPath;
      if (!textByPath || typeof textByPath !== "object") {
        return failure("INVALID_INPUT");
      }
      const combined = Object.values(textByPath)
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      const { findings, actions, outcome } = await runScan(combined);
      if (outcome === "blocked" || actions.includes("block")) {
        return failure("PROHIBITED_MATERIAL");
      }
      const verdict: ScanVerdict = {
        outcome: findings.length === 0 ? "clean" : outcome,
        findings: Object.freeze([...findings]),
        appliedActions: Object.freeze([...actions]),
      };
      return success(verdict);
    },
  };
}
