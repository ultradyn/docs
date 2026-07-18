import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import YAML from "yaml";
import { z } from "zod";

import {
  AskerSchema,
  QuestionRecordSchema,
  IdSchemas,
  QuestionRevisionConflictError,
  RawArtifactKindSchema,
  RawArtifactManifestEntrySchema,
  RawArtifactManifestSchema,
  SafeSlugSchema,
  applyQuestionTransition,
  assignPriority,
  createIdGenerator,
  queueForState,
  type Asker,
  type IdGenerator,
  type PriorityFacts,
  type PriorityTier,
  type QuestionOrigin,
  type QuestionRecord,
  type QuestionState,
  type QueueBucket,
  type RawArtifactKind,
  type RawArtifactManifest,
  type RawArtifactManifestEntry,
} from "../domain/index.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

const queueBuckets: QueueBucket[] = ["active", "deferred", "answered"];

export class QuestionNotFoundError extends Error {
  constructor(id: string) {
    super(`Question ${id} was not found.`);
    this.name = "QuestionNotFoundError";
  }
}

export class RawArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawArtifactIntegrityError";
  }
}

export class RawArtifactImmutableError extends Error {
  constructor(path: string) {
    super(
      `Raw artifact ${path} is immutable and cannot be changed or deleted.`,
    );
    this.name = "RawArtifactImmutableError";
  }
}

export interface CreateQuestionInput {
  title: string;
  verbatimQuestion: string;
  chatlog?: string;
  goals: string[];
  tags?: string[];
  asker: Asker;
  origin: QuestionOrigin;
  depth?: number;
  initialState?: "active" | "deferred";
  priority?: Omit<PriorityFacts, "origin" | "depth">;
}

export interface AppendRawArtifactInput {
  kind: RawArtifactKind;
  content: string | Uint8Array;
}

export interface AttachMatchedAskInput {
  verbatimQuestion: string;
  chatlog?: string;
  acceptanceGoals: string[];
  requestedGoals: string[];
  asker: Asker;
  expectedRevision: number;
  by: string;
}

export interface RejectAskerInput {
  askerId: string;
  reason: string;
  by: string;
}

export type MatchedAskCheckpoint =
  | "after-question-artifact"
  | "after-chat-artifact"
  | "before-record-update"
  | "after-record-update";

export type AskerRejectionCheckpoint =
  "after-artifact" | "before-record-update" | "after-record-update";

export interface KnowledgeRepositoryOptions {
  ids?: IdGenerator;
  now?: () => string;
  lockRetries?: number;
  /** Machine-local directory in which this repository's runtime lock lives. */
  lockRoot?: string;
  /** Optional deterministic mutation checkpoint used by process supervisors. */
  onMatchedAskCheckpoint?: (
    checkpoint: MatchedAskCheckpoint,
  ) => void | Promise<void>;
  /** Optional deterministic rejection checkpoint used by recovery tests. */
  onAskerRejectionCheckpoint?: (
    checkpoint: AskerRejectionCheckpoint,
  ) => void | Promise<void>;
}

interface LocatedQuestion {
  bucket: QueueBucket;
  directory: string;
  record: QuestionRecord;
}

const MatchedAskJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^[0-9a-f]{64}$/u),
  questionId: IdSchemas.question,
  baseRevision: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true }),
  questionArtifact: RawArtifactManifestEntrySchema,
  chatArtifact: RawArtifactManifestEntrySchema.optional(),
});
type MatchedAskJournal = z.infer<typeof MatchedAskJournalSchema>;

const AskerRejectionJournalSchema = z.object({
  schemaVersion: z.literal(2),
  operationId: z.string().regex(/^[0-9a-f]{64}$/u),
  questionId: IdSchemas.question,
  askerId: SafeSlugSchema,
  reason: z.string().min(1),
  by: z.string().min(1).max(160),
  baseRevision: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true }),
  artifact: RawArtifactManifestEntrySchema,
});
type AskerRejectionJournal = z.infer<typeof AskerRejectionJournalSchema>;

interface ValidatedMatchedAskInput {
  verbatimQuestion: string;
  chatlog?: string;
  acceptanceGoals: string[];
  requestedGoals: string[];
  asker: Asker;
  expectedRevision: number;
  by: string;
}

interface ValidatedRejectAskerInput {
  askerId: string;
  reason: string;
  by: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalRepositoryIdentity(repositoryRoot: string): string {
  let identity: string;
  try {
    identity = realpathSync.native(resolve(repositoryRoot));
  } catch {
    identity = resolve(repositoryRoot);
  }
  return process.platform === "win32" ? identity.toLocaleLowerCase() : identity;
}

function repositoryIdentityKey(repositoryRoot: string): string {
  return createHash("sha256")
    .update(canonicalRepositoryIdentity(repositoryRoot))
    .digest("hex");
}

function repositoryLockPath(repositoryRoot: string, lockRoot: string): string {
  return join(
    resolve(lockRoot),
    `${repositoryIdentityKey(repositoryRoot)}.lock`,
  );
}

function defaultRepositoryLockRoot(): string {
  if (process.platform === "win32") {
    return resolve(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Ultradyn Docs",
      "repository-locks",
    );
  }
  if (process.platform === "darwin") {
    return resolve(
      homedir(),
      "Library",
      "Application Support",
      "Ultradyn Docs",
      "repository-locks",
    );
  }
  const uid = process.getuid?.();
  const ownerKey =
    uid === undefined
      ? createHash("sha256").update(homedir()).digest("hex").slice(0, 16)
      : String(uid);
  return resolve(
    process.env.XDG_RUNTIME_DIR ?? tmpdir(),
    `ultradyn-docs-${ownerKey}-repository-locks`,
  );
}

function matchedAskOperationId(
  questionId: string,
  input: ValidatedMatchedAskInput,
): string {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        questionId,
        verbatimQuestion: input.verbatimQuestion,
        chatlog: input.chatlog ?? null,
        acceptanceGoals: input.acceptanceGoals,
        requestedGoals: input.requestedGoals,
        asker: input.asker,
        expectedRevision: input.expectedRevision,
        by: input.by,
      }),
    ),
  );
}

function askerRejectionOperationId(
  questionId: string,
  input: ValidatedRejectAskerInput,
  baseRevision: number,
): string {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        questionId,
        askerId: input.askerId,
        reason: input.reason,
        by: input.by,
        baseRevision,
      }),
    ),
  );
}

async function readMatchedAskJournal(
  path: string,
): Promise<MatchedAskJournal | undefined> {
  try {
    return MatchedAskJournalSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeMatchedAskJournal(
  path: string,
  journal: MatchedAskJournal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readAskerRejectionJournal(
  path: string,
): Promise<AskerRejectionJournal | undefined> {
  try {
    return AskerRejectionJournalSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAskerRejectionJournal(
  path: string,
  journal: AskerRejectionJournal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function frontmatter(record: QuestionRecord): string {
  const { question, ...metadata } = record;
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${question}\n`;
}

function parseQuestionFile(content: string): QuestionRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/u.exec(
    content,
  );
  if (!match) throw new Error("question.md is missing valid YAML frontmatter.");
  const metadata = YAML.parse(match[1] ?? "") as Record<string, unknown>;
  const question = (match[2] ?? "").replace(/\r?\n$/u, "");
  return QuestionRecordSchema.parse({ ...metadata, question });
}

function provenanceFile(record: QuestionRecord): string {
  return YAML.stringify(
    { schemaVersion: 1, origin: record.origin, events: record.provenance },
    { lineWidth: 0 },
  );
}

function artifactDirectory(kind: RawArtifactKind): string {
  return kind === "transcript" || kind === "correction" ? "answers/raw" : "raw";
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split(/[\\/]/u).includes("..") &&
    (path.startsWith("raw/") || path.startsWith("answers/raw/"))
  );
}

function safeDerivedPath(path: string): boolean {
  return (
    path.startsWith("answers/") &&
    !path.startsWith("answers/raw/") &&
    !path.split(/[\\/]/u).includes("..") &&
    /\.(json|md|ya?ml)$/u.test(path)
  );
}

async function writeExclusiveDurable(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o444);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o444);
}

async function readManifest(
  repositoryRoot: string,
  directory: string,
): Promise<RawArtifactManifest> {
  const path = await resolveContainedPathNoSymlinks(
    repositoryRoot,
    join(directory, "raw", "manifest.json"),
  );
  try {
    return RawArtifactManifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, artifacts: [] };
    }
    throw error;
  }
}

async function writeManifest(
  repositoryRoot: string,
  directory: string,
  manifest: RawArtifactManifest,
): Promise<void> {
  const path = await resolveContainedPathNoSymlinks(
    repositoryRoot,
    join(directory, "raw", "manifest.json"),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
  });
}

async function readOptionalBytes(
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function hasSameContent(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && sha256(left) === sha256(right);
}

function artifactContentBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  throw new TypeError("Raw artifact content must be text or bytes.");
}

function sameManifestEntry(
  left: RawArtifactManifestEntry,
  right: RawArtifactManifestEntry,
): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.createdAt === right.createdAt
  );
}

function reserveArtifactFromManifest(
  manifest: RawArtifactManifest,
  input: AppendRawArtifactInput,
  createdAt: string,
): RawArtifactManifestEntry {
  const kind = RawArtifactKindSchema.parse(input.kind);
  const bytes = artifactContentBytes(input.content);
  const targetDirectory = artifactDirectory(kind);
  const ordinal =
    manifest.artifacts.filter(
      (artifact) => dirname(artifact.path) === targetDirectory,
    ).length + 1;
  const artifactPath = `${targetDirectory}/${String(ordinal).padStart(3, "0")}-${kind}.md`;
  if (manifest.artifacts.some((artifact) => artifact.path === artifactPath)) {
    throw new RawArtifactImmutableError(artifactPath);
  }
  return RawArtifactManifestEntrySchema.parse({
    path: artifactPath,
    kind,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    createdAt,
  });
}

async function reserveArtifactUnlocked(
  repositoryRoot: string,
  directory: string,
  input: AppendRawArtifactInput,
  createdAt: string,
): Promise<RawArtifactManifestEntry> {
  return reserveArtifactFromManifest(
    await readManifest(repositoryRoot, directory),
    input,
    createdAt,
  );
}

async function appendReservedArtifactUnlocked(
  repositoryRoot: string,
  directory: string,
  input: AppendRawArtifactInput,
  entry: RawArtifactManifestEntry,
): Promise<RawArtifactManifestEntry> {
  const kind = RawArtifactKindSchema.parse(input.kind);
  const bytes = artifactContentBytes(input.content);
  const expectedDirectory = artifactDirectory(kind);
  if (
    entry.kind !== kind ||
    dirname(entry.path) !== expectedDirectory ||
    !safeRelativePath(entry.path) ||
    entry.sha256 !== sha256(bytes) ||
    entry.bytes !== bytes.byteLength
  ) {
    throw new RawArtifactIntegrityError(
      `Reserved raw artifact ${entry.path} does not match its append input.`,
    );
  }
  const manifest = await readManifest(repositoryRoot, directory);
  const destination = await resolveContainedPathNoSymlinks(
    repositoryRoot,
    join(directory, entry.path),
  );
  const pending = await resolveContainedPathNoSymlinks(
    repositoryRoot,
    join(dirname(destination), `.ultradyn-pending-${basename(destination)}`),
  );
  const manifested = manifest.artifacts.find(
    (artifact) => artifact.path === entry.path,
  );
  if (manifested) {
    if (!sameManifestEntry(manifested, entry)) {
      throw new RawArtifactIntegrityError(
        `Manifested raw artifact ${entry.path} does not match its operation reservation.`,
      );
    }
    const manifestedBytes = await readOptionalBytes(destination);
    if (
      manifestedBytes === undefined ||
      !hasSameContent(manifestedBytes, bytes)
    ) {
      throw new RawArtifactIntegrityError(
        `Manifested raw artifact ${entry.path} is missing or modified.`,
      );
    }
    await rm(pending, { force: true });
    return manifested;
  }

  const publishedBytes = await readOptionalBytes(destination);
  if (publishedBytes !== undefined) {
    if (!hasSameContent(publishedBytes, bytes)) {
      throw new RawArtifactIntegrityError(
        `Unmanifested raw artifact ${entry.path} does not match the retried append.`,
      );
    }
    await rm(pending, { force: true });
    await chmod(destination, 0o444);
    await writeManifest(repositoryRoot, directory, {
      schemaVersion: 1,
      artifacts: [...manifest.artifacts, entry],
    });
    return entry;
  }

  const pendingBytes = await readOptionalBytes(pending);
  if (pendingBytes !== undefined && !hasSameContent(pendingBytes, bytes)) {
    // The pending file was never exposed through the manifest. A partial
    // pre-rename write is therefore safe to discard before retrying it.
    await rm(pending);
  }
  if (pendingBytes === undefined || !hasSameContent(pendingBytes, bytes)) {
    await writeExclusiveDurable(pending, bytes);
  }
  await rename(pending, destination);
  await chmod(destination, 0o444);
  await writeManifest(repositoryRoot, directory, {
    schemaVersion: 1,
    artifacts: [...manifest.artifacts, entry],
  });
  return entry;
}

async function appendArtifactUnlocked(
  repositoryRoot: string,
  directory: string,
  input: AppendRawArtifactInput,
  createdAt: string,
): Promise<RawArtifactManifestEntry> {
  const reservation = await reserveArtifactUnlocked(
    repositoryRoot,
    directory,
    input,
    createdAt,
  );
  return appendReservedArtifactUnlocked(
    repositoryRoot,
    directory,
    input,
    reservation,
  );
}

function validateMatchedAskInput(
  input: AttachMatchedAskInput,
): ValidatedMatchedAskInput {
  return {
    verbatimQuestion: z.string().min(1).parse(input.verbatimQuestion),
    ...(input.chatlog === undefined
      ? {}
      : { chatlog: z.string().parse(input.chatlog) }),
    acceptanceGoals: [
      ...new Set(SafeSlugSchema.array().min(1).parse(input.acceptanceGoals)),
    ],
    requestedGoals: [
      ...new Set(SafeSlugSchema.array().min(1).parse(input.requestedGoals)),
    ],
    asker: AskerSchema.parse(input.asker),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .parse(input.expectedRevision),
    by: z.string().min(1).max(160).parse(input.by),
  };
}

function buildMatchedAskRecord(
  base: QuestionRecord,
  input: ValidatedMatchedAskInput,
  at: string,
  operationId: string,
  questionArtifact: RawArtifactManifestEntry,
  chatArtifact?: RawArtifactManifestEntry,
): QuestionRecord {
  const provenanceAt = [
    at,
    base.updatedAt,
    ...base.provenance.map((event) => event.at),
  ].reduce((latest, candidate) =>
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
  );
  const existingAsker = base.askers.some(
    (candidate) => candidate.id === input.asker.id,
  );
  const addedGoals = input.acceptanceGoals.filter(
    (goal) => !base.goals.includes(goal),
  );
  const artifactEvents = [questionArtifact, chatArtifact]
    .filter(
      (artifact): artifact is RawArtifactManifestEntry =>
        artifact !== undefined,
    )
    .map((artifact) => ({
      at: provenanceAt,
      type: "raw-artifact-appended" as const,
      by: input.by,
      details: {
        operationId,
        path: artifact.path,
        kind: artifact.kind,
        askerId: input.asker.id,
        ...(artifact.kind === "question"
          ? {
              requestedGoals: input.requestedGoals,
              addedGoals,
            }
          : {}),
      },
    }));
  return QuestionRecordSchema.parse({
    ...base,
    goals: [...base.goals, ...addedGoals],
    askers: existingAsker ? base.askers : [...base.askers, input.asker],
    revision: base.revision + 1,
    updatedAt: provenanceAt,
    provenance: [
      ...base.provenance,
      ...artifactEvents,
      ...(existingAsker
        ? []
        : [
            {
              at: provenanceAt,
              type: "asker-attached" as const,
              by: input.by,
              details: { operationId, askerId: input.asker.id },
            },
          ]),
    ],
  });
}

function hasCompletedMatchedAsk(
  record: QuestionRecord,
  input: ValidatedMatchedAskInput,
  operationId: string,
): boolean {
  const operationEvents = record.provenance.filter(
    (event) => event.details?.operationId === operationId,
  );
  if (operationEvents.length === 0) return false;
  const rawKinds = operationEvents
    .filter((event) => event.type === "raw-artifact-appended")
    .map((event) => event.details?.kind)
    .sort();
  const expectedKinds =
    input.chatlog === undefined ? ["question"] : ["chatlog", "question"];
  if (
    rawKinds.length !== expectedKinds.length ||
    rawKinds.some((kind, index) => kind !== expectedKinds[index]) ||
    !input.acceptanceGoals.every((goal) => record.goals.includes(goal)) ||
    !record.askers.some((asker) => asker.id === input.asker.id)
  ) {
    throw new RawArtifactIntegrityError(
      `Matched-ask operation ${operationId} has incomplete portable provenance.`,
    );
  }
  return true;
}

function validateRejectAskerInput(
  input: RejectAskerInput,
): ValidatedRejectAskerInput {
  return {
    askerId: SafeSlugSchema.parse(input.askerId),
    reason: z.string().min(1).parse(input.reason),
    by: z.string().min(1).max(160).parse(input.by),
  };
}

function assertAskerMayReject(record: QuestionRecord, askerId: string): void {
  const asker = record.askers.find((candidate) => candidate.id === askerId);
  if (record.state !== "merged" || !asker) {
    throw new Error("Only an attached asker may reject a merged answer.");
  }
  if (asker.acceptance !== "pending") {
    throw new Error(
      `Asker ${askerId} has already decided; only pending askers may decide.`,
    );
  }
}

function buildRejectedAskerRecord(
  base: QuestionRecord,
  input: ValidatedRejectAskerInput,
  at: string,
  operationId: string,
  artifact: RawArtifactManifestEntry,
): QuestionRecord {
  assertAskerMayReject(base, input.askerId);
  return QuestionRecordSchema.parse({
    ...base,
    state: "reopened",
    tier: "P1",
    priorityRationale: "Reopened after explicit asker rejection.",
    prioritySource: "rule",
    askers: base.askers.map((asker) =>
      asker.id === input.askerId
        ? {
            ...asker,
            acceptance: "rejected",
            decidedAt: at,
            rawReason: artifact.path,
          }
        : asker,
    ),
    revision: base.revision + 1,
    updatedAt: at,
    provenance: [
      ...base.provenance,
      {
        at,
        type: "raw-artifact-appended",
        by: input.by,
        details: {
          operationId,
          baseRevision: base.revision,
          path: artifact.path,
          kind: artifact.kind,
          askerId: input.askerId,
        },
      },
      {
        at,
        type: "rejected",
        by: input.by,
        details: {
          operationId,
          baseRevision: base.revision,
          askerId: input.askerId,
          rawReason: artifact.path,
        },
      },
      {
        at,
        type: "state-transitioned",
        by: input.by,
        details: {
          operationId,
          baseRevision: base.revision,
          from: "merged",
          to: "reopened",
          rawReason: artifact.path,
        },
      },
    ],
  });
}

function hasCompletedAskerRejection(
  record: QuestionRecord,
  journal: AskerRejectionJournal,
): boolean {
  const operationEvents = record.provenance
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.details?.operationId === journal.operationId);
  if (operationEvents.length === 0) return false;
  const [rawArtifact, rejection, transition] = operationEvents;
  const complete =
    operationEvents.length === 3 &&
    rawArtifact?.event.type === "raw-artifact-appended" &&
    rejection?.event.type === "rejected" &&
    transition?.event.type === "state-transitioned" &&
    rejection.index === rawArtifact.index + 1 &&
    transition.index === rejection.index + 1 &&
    operationEvents.every(({ event }) => event.at === journal.at) &&
    operationEvents.every(
      ({ event }) => event.details?.baseRevision === journal.baseRevision,
    ) &&
    operationEvents.every(({ event }) => event.by === journal.by) &&
    rawArtifact.event.details?.path === journal.artifact.path &&
    rawArtifact.event.details?.kind === "rejection" &&
    rawArtifact.event.details?.askerId === journal.askerId &&
    rejection.event.details?.askerId === journal.askerId &&
    rejection.event.details?.rawReason === journal.artifact.path &&
    transition.event.details?.from === "merged" &&
    transition.event.details?.to === "reopened" &&
    transition.event.details?.rawReason === journal.artifact.path &&
    journal.artifact.kind === "rejection" &&
    journal.artifact.createdAt === journal.at &&
    record.revision >= journal.baseRevision + 1;
  if (!complete) {
    throw new RawArtifactIntegrityError(
      `Asker-rejection operation ${journal.operationId} has incomplete portable provenance.`,
    );
  }
  if (record.revision === journal.baseRevision + 1) {
    const asker = record.askers.find(
      (candidate) => candidate.id === journal.askerId,
    );
    if (
      record.state !== "reopened" ||
      record.tier !== "P1" ||
      record.priorityRationale !== "Reopened after explicit asker rejection." ||
      record.prioritySource !== "rule" ||
      record.updatedAt !== journal.at ||
      asker?.acceptance !== "rejected" ||
      asker.decidedAt !== journal.at ||
      asker.rawReason !== journal.artifact.path
    ) {
      throw new RawArtifactIntegrityError(
        `Asker-rejection operation ${journal.operationId} has incomplete canonical state.`,
      );
    }
  }
  return true;
}

export class KnowledgeRepository {
  readonly root: string;
  readonly #ids: IdGenerator;
  readonly #now: () => string;
  readonly #lockRetries: number;
  readonly #lockRoot: string;
  readonly #onMatchedAskCheckpoint:
    KnowledgeRepositoryOptions["onMatchedAskCheckpoint"] | undefined;
  readonly #onAskerRejectionCheckpoint:
    KnowledgeRepositoryOptions["onAskerRejectionCheckpoint"] | undefined;

  constructor(root: string, options: KnowledgeRepositoryOptions = {}) {
    this.root = resolve(root);
    this.#ids = options.ids ?? createIdGenerator();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#lockRetries = options.lockRetries ?? 20;
    this.#lockRoot = resolve(options.lockRoot ?? defaultRepositoryLockRoot());
    this.#onMatchedAskCheckpoint = options.onMatchedAskCheckpoint;
    this.#onAskerRejectionCheckpoint = options.onAskerRejectionCheckpoint;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const directories = [
      join(this.root, ".ultradyn"),
      ...queueBuckets.map((bucket) => join(this.root, "questions", bucket)),
      join(this.root, "docs"),
      join(this.root, "goals"),
      join(this.root, "agents"),
    ];
    for (const directory of directories) {
      const safeDirectory = await resolveContainedPathNoSymlinks(
        this.root,
        directory,
      );
      await mkdir(safeDirectory, { recursive: true });
    }
    const index = await resolveContainedPathNoSymlinks(
      this.root,
      join(this.root, "questions", "index.jsonl"),
    );
    try {
      await writeFile(index, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async createQuestion(input: CreateQuestionInput): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const at = this.#now();
      const id = this.#ids.next("question");
      const depth = input.origin.kind === "raw" ? 0 : (input.depth ?? 1);
      const assignment = assignPriority({
        origin: input.origin.kind,
        depth,
        ...(input.priority ?? {}),
      });
      const state =
        input.initialState ??
        (input.origin.kind === "raw" ? "active" : "deferred");
      const tags = [...new Set([input.origin.kind, ...(input.tags ?? [])])];
      const record = QuestionRecordSchema.parse({
        schemaVersion: 1,
        id,
        title: input.title,
        question: input.verbatimQuestion,
        state,
        tier: assignment.tier,
        priorityRationale: assignment.rationale,
        prioritySource: assignment.source,
        goals: input.goals,
        tags,
        askers: [input.asker],
        origin: input.origin,
        depth,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        provenance: [
          { at, type: "logged", by: "registrar" },
          {
            at,
            type: "prioritized",
            by: "prioritizer",
            details: { tier: assignment.tier, rationale: assignment.rationale },
          },
        ],
      });
      const stage = await resolveContainedPathNoSymlinks(
        this.root,
        join(this.root, ".ultradyn", "staging", `${id}-${process.pid}`),
      );
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      try {
        await this.#writeRecord(stage, record);
        await appendArtifactUnlocked(
          this.root,
          stage,
          { kind: "question", content: input.verbatimQuestion },
          at,
        );
        if (input.chatlog !== undefined) {
          await appendArtifactUnlocked(
            this.root,
            stage,
            { kind: "chatlog", content: input.chatlog },
            at,
          );
        }
        const destination = await resolveContainedPathNoSymlinks(
          this.root,
          join(this.root, "questions", queueForState(record.state), id),
        );
        await rename(stage, destination);
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
      await this.#regenerateIndexUnlocked();
      return record;
    });
  }

  async getQuestion(id: string): Promise<QuestionRecord> {
    return (await this.#locate(id)).record;
  }

  async listQuestions(
    options: {
      bucket?: QueueBucket;
      states?: QuestionState[];
    } = {},
  ): Promise<QuestionRecord[]> {
    const buckets = options.bucket ? [options.bucket] : queueBuckets;
    const records: QuestionRecord[] = [];
    for (const bucket of buckets) {
      for (const directory of await this.#questionDirectories(bucket)) {
        const record = await this.#readRecord(directory);
        if (!options.states || options.states.includes(record.state))
          records.push(record);
      }
    }
    return records.sort((left, right) => {
      const tier = Number(left.tier.slice(1)) - Number(right.tier.slice(1));
      return (
        tier ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      );
    });
  }

  async transition(
    id: string,
    input: {
      to: QuestionState;
      expectedRevision: number;
      by: string;
      details?: Record<string, unknown>;
    },
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      let next = applyQuestionTransition(located.record, {
        ...input,
        at: this.#now(),
      });
      if (next.state === "reopened") {
        const assignment = assignPriority({
          origin: next.origin.kind,
          depth: next.depth,
          reopenedAfterRejection: true,
        });
        next = QuestionRecordSchema.parse({
          ...next,
          tier: assignment.tier,
          priorityRationale: assignment.rationale,
          prioritySource: assignment.source,
        });
      }
      const expectedBucket = queueForState(next.state);
      const destination =
        located.bucket === expectedBucket
          ? undefined
          : await resolveContainedPathNoSymlinks(
              this.root,
              join(this.root, "questions", expectedBucket, id),
            );
      await this.#writeRecord(located.directory, next);
      if (destination) {
        await rename(located.directory, destination);
      }
      await this.#regenerateIndexUnlocked();
      return next;
    });
  }

  async appendRawArtifact(
    id: string,
    input: AppendRawArtifactInput,
  ): Promise<RawArtifactManifestEntry> {
    return this.#locked(async () => {
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      return appendArtifactUnlocked(
        this.root,
        located.directory,
        input,
        this.#now(),
      );
    });
  }

  async listRawArtifacts(id: string): Promise<RawArtifactManifestEntry[]> {
    const located = await this.#locate(id);
    await this.#verifyQuestionRawArtifacts(located);
    return (await readManifest(this.root, located.directory)).artifacts;
  }

  async readRawArtifact(id: string, artifactPath: string): Promise<string> {
    if (!safeRelativePath(artifactPath))
      throw new Error("Invalid raw artifact path.");
    const located = await this.#locate(id);
    await this.#verifyQuestionRawArtifacts(located);
    const manifest = await readManifest(this.root, located.directory);
    if (
      !manifest.artifacts.some((artifact) => artifact.path === artifactPath)
    ) {
      throw new QuestionNotFoundError(`${id}/${artifactPath}`);
    }
    const destination = await resolveContainedPathNoSymlinks(
      this.root,
      join(located.directory, artifactPath),
    );
    return readFile(destination, "utf8");
  }

  async deleteRawArtifact(_id: string, artifactPath: string): Promise<never> {
    throw new RawArtifactImmutableError(artifactPath);
  }

  async writeDerived(
    id: string,
    artifactPath: string,
    content: string,
    options: { expectedRevision: number; by: string },
  ): Promise<QuestionRecord> {
    if (!safeDerivedPath(artifactPath)) {
      throw new Error(
        "Derived artifacts must be Markdown, JSON, or YAML below answers/ and outside answers/raw/.",
      );
    }
    return this.#locked(async () => {
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      if (located.record.revision !== options.expectedRevision) {
        throw new QuestionRevisionConflictError(
          options.expectedRevision,
          located.record.revision,
        );
      }
      const at = this.#now();
      const updated = QuestionRecordSchema.parse({
        ...located.record,
        revision: located.record.revision + 1,
        updatedAt: at,
        provenance: [
          ...located.record.provenance,
          {
            at,
            type: "derived-artifact-written",
            by: options.by,
            details: { path: artifactPath },
          },
        ],
      });
      const destination = await resolveContainedPathNoSymlinks(
        this.root,
        join(located.directory, artifactPath),
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeFileAtomic(destination, content, { encoding: "utf8" });
      await this.#writeRecord(located.directory, updated);
      await this.#regenerateIndexUnlocked();
      return updated;
    });
  }

  async readDerived(id: string, artifactPath: string): Promise<string> {
    if (!safeDerivedPath(artifactPath))
      throw new Error("Invalid derived artifact path.");
    const located = await this.#locate(id);
    const destination = await resolveContainedPathNoSymlinks(
      this.root,
      join(located.directory, artifactPath),
    );
    return readFile(destination, "utf8");
  }

  async overridePriority(
    id: string,
    input: {
      tier: PriorityTier;
      rationale: string;
      expectedRevision: number;
      by: string;
    },
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      if (located.record.revision !== input.expectedRevision) {
        throw new QuestionRevisionConflictError(
          input.expectedRevision,
          located.record.revision,
        );
      }
      const at = this.#now();
      const assignment = assignPriority({
        origin: located.record.origin.kind,
        depth: located.record.depth,
        override: { tier: input.tier, rationale: input.rationale },
      });
      const updated = QuestionRecordSchema.parse({
        ...located.record,
        tier: assignment.tier,
        priorityRationale: assignment.rationale,
        prioritySource: assignment.source,
        revision: located.record.revision + 1,
        updatedAt: at,
        provenance: [
          ...located.record.provenance,
          {
            at,
            type: "priority-overridden",
            by: input.by,
            details: { tier: assignment.tier, rationale: assignment.rationale },
          },
        ],
      });
      await this.#writeRecord(located.directory, updated);
      await this.#regenerateIndexUnlocked();
      return updated;
    });
  }

  async attachAsker(
    id: string,
    input: { asker: Asker; expectedRevision: number; by: string },
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      const existing = located.record.askers.find(
        (asker) => asker.id === input.asker.id,
      );
      if (existing) return located.record;
      if (located.record.revision !== input.expectedRevision) {
        throw new QuestionRevisionConflictError(
          input.expectedRevision,
          located.record.revision,
        );
      }
      const at = this.#now();
      const updated = QuestionRecordSchema.parse({
        ...located.record,
        askers: [...located.record.askers, input.asker],
        revision: located.record.revision + 1,
        updatedAt: at,
        provenance: [
          ...located.record.provenance,
          {
            at,
            type: "asker-attached",
            by: input.by,
            details: { askerId: input.asker.id },
          },
        ],
      });
      await this.#writeRecord(located.directory, updated);
      await this.#regenerateIndexUnlocked();
      return updated;
    });
  }

  async attachMatchedAsk(
    id: string,
    input: AttachMatchedAskInput,
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const validated = validateMatchedAskInput(input);
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      const operationId = matchedAskOperationId(located.record.id, validated);
      const journalPath = await this.#matchedAskJournalPath(
        located.record.id,
        validated.expectedRevision,
      );

      if (hasCompletedMatchedAsk(located.record, validated, operationId)) {
        // question.md is the canonical record. Rewriting both record files and
        // the projection completes crashes after either record replacement.
        await this.#writeRecord(located.directory, located.record);
        await this.#regenerateIndexUnlocked();
        await rm(journalPath, { force: true });
        return located.record;
      }

      let journal = await readMatchedAskJournal(journalPath);
      if (!journal) {
        if (located.record.revision !== validated.expectedRevision) {
          throw new QuestionRevisionConflictError(
            validated.expectedRevision,
            located.record.revision,
          );
        }
        const at = this.#now();
        const manifest = await readManifest(this.root, located.directory);
        const questionArtifact = reserveArtifactFromManifest(
          manifest,
          { kind: "question", content: validated.verbatimQuestion },
          at,
        );
        const chatArtifact =
          validated.chatlog === undefined
            ? undefined
            : reserveArtifactFromManifest(
                {
                  schemaVersion: 1,
                  artifacts: [...manifest.artifacts, questionArtifact],
                },
                { kind: "chatlog", content: validated.chatlog },
                at,
              );
        journal = MatchedAskJournalSchema.parse({
          schemaVersion: 1,
          operationId,
          questionId: located.record.id,
          baseRevision: located.record.revision,
          at,
          questionArtifact,
          ...(chatArtifact ? { chatArtifact } : {}),
        });
        // Validate the complete portable record before publishing either raw
        // artifact. The journal itself is atomic, private machine state.
        buildMatchedAskRecord(
          located.record,
          validated,
          journal.at,
          operationId,
          journal.questionArtifact,
          journal.chatArtifact,
        );
        await writeMatchedAskJournal(journalPath, journal);
      } else {
        if (
          journal.operationId !== operationId ||
          journal.questionId !== located.record.id ||
          (validated.chatlog === undefined) !==
            (journal.chatArtifact === undefined)
        ) {
          throw new RawArtifactIntegrityError(
            `Matched-ask operation journal ${operationId} does not match its retry input.`,
          );
        }
        if (located.record.revision < journal.baseRevision) {
          throw new QuestionRevisionConflictError(
            journal.baseRevision,
            located.record.revision,
          );
        }
        buildMatchedAskRecord(
          located.record,
          validated,
          journal.at,
          operationId,
          journal.questionArtifact,
          journal.chatArtifact,
        );
      }

      const questionArtifact = await appendReservedArtifactUnlocked(
        this.root,
        located.directory,
        { kind: "question", content: validated.verbatimQuestion },
        journal.questionArtifact,
      );
      await this.#matchedAskCheckpoint("after-question-artifact");
      const chatArtifact =
        validated.chatlog === undefined || journal.chatArtifact === undefined
          ? undefined
          : await appendReservedArtifactUnlocked(
              this.root,
              located.directory,
              { kind: "chatlog", content: validated.chatlog },
              journal.chatArtifact,
            );
      await this.#matchedAskCheckpoint("after-chat-artifact");
      const updated = buildMatchedAskRecord(
        located.record,
        validated,
        journal.at,
        operationId,
        questionArtifact,
        chatArtifact,
      );
      await this.#matchedAskCheckpoint("before-record-update");
      await this.#writeRecord(located.directory, updated);
      await this.#matchedAskCheckpoint("after-record-update");
      await this.#regenerateIndexUnlocked();
      await rm(journalPath, { force: true });
      return updated;
    });
  }

  async rejectAsker(
    id: string,
    input: RejectAskerInput,
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      const validated = validateRejectAskerInput(input);
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      const journalPath = await this.#askerRejectionJournalPath(
        located.record.id,
        validated.askerId,
      );
      let journal = await readAskerRejectionJournal(journalPath);
      const baseRevision = journal?.baseRevision ?? located.record.revision;
      const operationId = askerRejectionOperationId(
        located.record.id,
        validated,
        baseRevision,
      );

      if (journal) {
        if (
          journal.operationId !== operationId ||
          journal.questionId !== located.record.id ||
          journal.askerId !== validated.askerId ||
          journal.reason !== validated.reason ||
          journal.by !== validated.by ||
          journal.baseRevision !== baseRevision
        ) {
          throw new RawArtifactIntegrityError(
            `Pending asker-rejection journal for ${validated.askerId} does not match the retry input.`,
          );
        }
        if (hasCompletedAskerRejection(located.record, journal)) {
          await this.#assertAskerRejectionArtifact(located, journal);
          await this.#regenerateIndexUnlocked();
          await rm(journalPath, { force: true });
          return located.record;
        }
        if (located.record.revision !== journal.baseRevision) {
          throw new QuestionRevisionConflictError(
            journal.baseRevision,
            located.record.revision,
          );
        }
        buildRejectedAskerRecord(
          located.record,
          validated,
          journal.at,
          journal.operationId,
          journal.artifact,
        );
      } else {
        assertAskerMayReject(located.record, validated.askerId);
        const at = this.#now();
        const artifact = reserveArtifactFromManifest(
          await readManifest(this.root, located.directory),
          { kind: "rejection", content: validated.reason },
          at,
        );
        journal = AskerRejectionJournalSchema.parse({
          schemaVersion: 2,
          operationId,
          questionId: located.record.id,
          askerId: validated.askerId,
          reason: validated.reason,
          by: validated.by,
          baseRevision: located.record.revision,
          at,
          artifact,
        });
        buildRejectedAskerRecord(
          located.record,
          validated,
          journal.at,
          journal.operationId,
          journal.artifact,
        );
        await writeAskerRejectionJournal(journalPath, journal);
      }

      const artifact = await appendReservedArtifactUnlocked(
        this.root,
        located.directory,
        { kind: "rejection", content: validated.reason },
        journal.artifact,
      );
      await this.#askerRejectionCheckpoint("after-artifact");
      const updated = buildRejectedAskerRecord(
        located.record,
        validated,
        journal.at,
        journal.operationId,
        artifact,
      );
      await this.#askerRejectionCheckpoint("before-record-update");
      await this.#writeRecord(located.directory, updated);
      await this.#askerRejectionCheckpoint("after-record-update");
      await this.#regenerateIndexUnlocked();
      await rm(journalPath, { force: true });
      return updated;
    });
  }

  async decideAsker(
    id: string,
    input: {
      askerId: string;
      decision: Extract<Asker["acceptance"], "accepted" | "timed-out">;
      expectedRevision: number;
      by: string;
    },
  ): Promise<QuestionRecord> {
    return this.#locked(async () => {
      if (input.decision !== "accepted" && input.decision !== "timed-out") {
        throw new Error(
          "Asker rejection must use rejectAsker so the reason is published and the question reopens atomically.",
        );
      }
      const located = await this.#locate(id);
      await this.#verifyQuestionRawArtifacts(located);
      await this.#reconcileCompletedAskerRejectionJournals(located);
      if (located.record.revision !== input.expectedRevision) {
        throw new QuestionRevisionConflictError(
          input.expectedRevision,
          located.record.revision,
        );
      }
      if (located.record.state !== "merged") {
        throw new Error(
          "Asker decisions are allowed only after the question is merged.",
        );
      }
      const decidingAsker = located.record.askers.find(
        (asker) => asker.id === input.askerId,
      );
      if (!decidingAsker) {
        throw new Error(
          `Asker ${input.askerId} is not attached to question ${id}.`,
        );
      }
      if (decidingAsker.acceptance !== "pending") {
        throw new Error(
          `Asker ${input.askerId} has already decided; only pending askers may decide.`,
        );
      }
      const at = this.#now();
      const eventType =
        input.decision === "timed-out" ? "timeout-accepted" : "accepted";
      const updated = QuestionRecordSchema.parse({
        ...located.record,
        askers: located.record.askers.map((asker) =>
          asker.id === input.askerId
            ? {
                ...asker,
                acceptance: input.decision,
                decidedAt: at,
              }
            : asker,
        ),
        revision: located.record.revision + 1,
        updatedAt: at,
        provenance: [
          ...located.record.provenance,
          {
            at,
            type: eventType,
            by: input.by,
            details: { askerId: input.askerId },
          },
        ],
      });
      await this.#writeRecord(located.directory, updated);
      await this.#regenerateIndexUnlocked();
      return updated;
    });
  }

  async verifyRawArtifacts(): Promise<void> {
    for (const bucket of queueBuckets) {
      for (const directory of await this.#questionDirectories(bucket)) {
        await this.#verifyQuestionRawArtifacts({
          bucket,
          directory,
          record: await this.#readRecord(directory),
        });
      }
    }
  }

  async repairQueueProjections(): Promise<
    Array<{ id: string; from: QueueBucket; to: QueueBucket }>
  > {
    return this.#locked(async () => {
      const repairs: Array<{ id: string; from: QueueBucket; to: QueueBucket }> =
        [];
      const seen = new Set<string>();
      for (const bucket of queueBuckets) {
        for (const directory of await this.#questionDirectories(bucket)) {
          const record = await this.#readRecord(directory);
          if (seen.has(record.id))
            throw new Error(
              `Question ${record.id} exists in more than one queue.`,
            );
          seen.add(record.id);
          const expected = queueForState(record.state);
          if (expected !== bucket)
            repairs.push({ id: record.id, from: bucket, to: expected });
        }
      }
      const safeRepairs = await Promise.all(
        repairs.map(async (repair) => ({
          ...repair,
          source: await resolveContainedPathNoSymlinks(
            this.root,
            join(this.root, "questions", repair.from, repair.id),
          ),
          destination: await resolveContainedPathNoSymlinks(
            this.root,
            join(this.root, "questions", repair.to, repair.id),
          ),
        })),
      );
      for (const repair of safeRepairs) {
        try {
          await stat(repair.destination);
          throw new Error(
            `Cannot repair ${repair.id}: destination already exists.`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      for (const repair of safeRepairs) {
        await rename(repair.source, repair.destination);
      }
      if (repairs.length) await this.#regenerateIndexUnlocked();
      return repairs;
    });
  }

  async expectedIndex(): Promise<string> {
    const records = await this.listQuestions();
    const rows = records
      .map((record) => ({
        id: record.id,
        title: record.title,
        state: record.state,
        tier: record.tier,
        priorityRationale: record.priorityRationale,
        goals: record.goals,
        tags: record.tags,
        askerCount: record.askers.length,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        revision: record.revision,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return rows.length
      ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "";
  }

  async regenerateIndex(): Promise<string> {
    return this.#locked(() => this.#regenerateIndexUnlocked());
  }

  async #regenerateIndexUnlocked(): Promise<string> {
    const expected = await this.expectedIndex();
    const indexPath = await resolveContainedPathNoSymlinks(
      this.root,
      join(this.root, "questions", "index.jsonl"),
    );
    await writeFileAtomic(indexPath, expected, {
      encoding: "utf8",
    });
    return expected;
  }

  async #writeRecord(directory: string, record: QuestionRecord): Promise<void> {
    const questionPath = await resolveContainedPathNoSymlinks(
      this.root,
      join(directory, "question.md"),
    );
    const provenancePath = await resolveContainedPathNoSymlinks(
      this.root,
      join(directory, "provenance.yaml"),
    );
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(questionPath, frontmatter(record), {
      encoding: "utf8",
    });
    await writeFileAtomic(provenancePath, provenanceFile(record), {
      encoding: "utf8",
    });
  }

  async #readRecord(directory: string): Promise<QuestionRecord> {
    const path = await resolveContainedPathNoSymlinks(
      this.root,
      join(directory, "question.md"),
    );
    return parseQuestionFile(await readFile(path, "utf8"));
  }

  async #locate(id: string): Promise<LocatedQuestion> {
    const requestedId = IdSchemas.question.parse(id);
    for (const bucket of queueBuckets) {
      const directory = join(this.root, "questions", bucket, requestedId);
      try {
        const record = await this.#readRecord(directory);
        if (record.id !== requestedId) {
          throw new Error(
            `Question record ${record.id} does not match requested ID ${requestedId}.`,
          );
        }
        return { bucket, directory, record };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new QuestionNotFoundError(requestedId);
  }

  async #questionDirectories(bucket: QueueBucket): Promise<string[]> {
    const root = await resolveContainedPathNoSymlinks(
      this.root,
      join(this.root, "questions", bucket),
    );
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #verifyQuestionRawArtifacts(located: LocatedQuestion): Promise<void> {
    const manifest = await readManifest(this.root, located.directory);
    const paths = new Set<string>();
    for (const entry of manifest.artifacts) {
      if (!safeRelativePath(entry.path) || paths.has(entry.path)) {
        throw new RawArtifactIntegrityError(
          `Invalid raw manifest entry ${entry.path}.`,
        );
      }
      paths.add(entry.path);
      let bytes: Uint8Array;
      try {
        const artifactPath = await resolveContainedPathNoSymlinks(
          this.root,
          join(located.directory, entry.path),
        );
        bytes = await readFile(artifactPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new RawArtifactIntegrityError(
            `Raw artifact ${located.record.id}/${entry.path} was deleted.`,
          );
        }
        throw error;
      }
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new RawArtifactIntegrityError(
          `Raw artifact ${located.record.id}/${entry.path} was modified.`,
        );
      }
    }
  }

  async #matchedAskJournalPath(
    questionId: string,
    baseRevision: number,
  ): Promise<string> {
    const journalId = sha256(
      new TextEncoder().encode(`${questionId}:${baseRevision}`),
    );
    const path = join(
      this.#lockRoot,
      "operations",
      repositoryIdentityKey(this.root),
      `matched-ask-${journalId}.json`,
    );
    return resolveContainedPathNoSymlinks(this.#lockRoot, path);
  }

  async #askerRejectionJournalPath(
    questionId: string,
    askerId: string,
  ): Promise<string> {
    const journalId = sha256(
      new TextEncoder().encode(`${questionId}:${askerId}`),
    );
    const path = join(
      this.#lockRoot,
      "operations",
      repositoryIdentityKey(this.root),
      `asker-rejection-${journalId}.json`,
    );
    return resolveContainedPathNoSymlinks(this.#lockRoot, path);
  }

  async #assertAskerRejectionArtifact(
    located: LocatedQuestion,
    journal: AskerRejectionJournal,
  ): Promise<void> {
    const manifest = await readManifest(this.root, located.directory);
    const artifact = manifest.artifacts.find(
      (candidate) => candidate.path === journal.artifact.path,
    );
    if (!artifact || !sameManifestEntry(artifact, journal.artifact)) {
      throw new RawArtifactIntegrityError(
        `Asker-rejection operation ${journal.operationId} does not match its immutable artifact manifest entry.`,
      );
    }
    const artifactPath = await resolveContainedPathNoSymlinks(
      this.root,
      join(located.directory, journal.artifact.path),
    );
    const reasonBytes = await readFile(artifactPath);
    if (!hasSameContent(reasonBytes, artifactContentBytes(journal.reason))) {
      throw new RawArtifactIntegrityError(
        `Asker-rejection operation ${journal.operationId} does not match its exact immutable reason bytes.`,
      );
    }
    const expectedOperationId = askerRejectionOperationId(
      journal.questionId,
      {
        askerId: journal.askerId,
        reason: journal.reason,
        by: journal.by,
      },
      journal.baseRevision,
    );
    if (journal.operationId !== expectedOperationId) {
      throw new RawArtifactIntegrityError(
        `Asker-rejection operation ${journal.operationId} is not bound to its question, asker, actor, exact reason, and base revision.`,
      );
    }
  }

  async #reconcileCompletedAskerRejectionJournals(
    located: LocatedQuestion,
  ): Promise<void> {
    const completedJournalPaths: string[] = [];
    for (const asker of located.record.askers) {
      const journalPath = await this.#askerRejectionJournalPath(
        located.record.id,
        asker.id,
      );
      const journal = await readAskerRejectionJournal(journalPath);
      if (!journal) continue;
      if (
        journal.questionId !== located.record.id ||
        journal.askerId !== asker.id
      ) {
        throw new RawArtifactIntegrityError(
          `Pending asker-rejection journal for ${asker.id} is bound to a different question or asker.`,
        );
      }
      if (!hasCompletedAskerRejection(located.record, journal)) {
        throw new RawArtifactIntegrityError(
          `Pending asker-rejection operation ${journal.operationId} must be recovered before another question mutation.`,
        );
      }
      await this.#assertAskerRejectionArtifact(located, journal);
      completedJournalPaths.push(journalPath);
    }
    for (const journalPath of completedJournalPaths)
      await rm(journalPath, { force: true });
  }

  async #matchedAskCheckpoint(checkpoint: MatchedAskCheckpoint): Promise<void> {
    await this.#onMatchedAskCheckpoint?.(checkpoint);
  }

  async #askerRejectionCheckpoint(
    checkpoint: AskerRejectionCheckpoint,
  ): Promise<void> {
    await this.#onAskerRejectionCheckpoint?.(checkpoint);
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryLock(this.root, operation, {
      lockRoot: this.#lockRoot,
      lockRetries: this.#lockRetries,
    });
  }
}

export interface RepositoryLockOptions {
  lockRoot?: string;
  lockRetries?: number;
}

export async function withRepositoryLock<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
  options: RepositoryLockOptions = {},
): Promise<T> {
  const lockRoot = resolve(options.lockRoot ?? defaultRepositoryLockRoot());
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockRootMetadata = await lstat(lockRoot);
  if (lockRootMetadata.isSymbolicLink() || !lockRootMetadata.isDirectory()) {
    throw new Error("Repository lock root must be a real directory.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && lockRootMetadata.uid !== uid) {
    throw new Error("Repository lock root must be owned by the current user.");
  }
  await chmod(lockRoot, 0o700);
  const lockfilePath = repositoryLockPath(repositoryRoot, lockRoot);
  const release = await lockfile.lock(repositoryRoot, {
    realpath: false,
    lockfilePath,
    stale: 30_000,
    retries: {
      retries: options.lockRetries ?? 20,
      factor: 1.25,
      minTimeout: 10,
      maxTimeout: 250,
    },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function repositoryRelativePath(root: string, path: string): string {
  const result = relative(resolve(root), resolve(path));
  if (result.startsWith(`..${sep}`) || result === "..")
    throw new Error("Path escapes repository root.");
  return result.split(sep).join("/");
}

export function questionIdFromArtifactPath(path: string): string | undefined {
  const parts = path.split("/");
  if (
    parts[0] !== "questions" ||
    !queueBuckets.includes(parts[1] as QueueBucket)
  )
    return undefined;
  return parts[2];
}

export function isRawArtifactPath(path: string): boolean {
  if (basename(path) === "manifest.json") return false;
  return /questions\/(active|deferred|answered)\/[^/]+\/(raw|answers\/raw)\//u.test(
    path,
  );
}
