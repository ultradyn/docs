import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import YAML from "yaml";
import { z } from "zod";

import type { JsonSchema, LlmProvider } from "../providers/index.js";

export const AgentInputPolicySchema = z.enum([
  "librarian",
  "goal-clerk",
  "registrar",
  "matcher",
  "prioritizer",
  "structurer",
  "critic",
  "integrator",
  "reviewer",
  "diff-summarizer",
  "simulated-asker",
  "agent-smith",
  "researcher",
  "evidence-critic",
]);
export type AgentInputPolicy = z.infer<typeof AgentInputPolicySchema>;

const definitionMetadataSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  inputPolicy: AgentInputPolicySchema,
  maxAttempts: z.number().int().min(1).max(3).default(2),
});

export interface AgentDefinition extends z.infer<
  typeof definitionMetadataSchema
> {
  prompt: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  directory: string;
}

const policyFields: Record<
  AgentInputPolicy,
  { allowed: string[]; required: string[] }
> = {
  librarian: {
    allowed: ["question", "chat", "goals", "documentation"],
    required: ["question", "goals", "documentation"],
  },
  "goal-clerk": {
    allowed: ["question", "goalVocabulary"],
    required: ["question", "goalVocabulary"],
  },
  registrar: {
    allowed: ["question", "chat", "goals", "origin"],
    required: ["question", "goals", "origin"],
  },
  matcher: {
    allowed: ["question", "goals", "candidates"],
    required: ["question", "goals", "candidates"],
  },
  prioritizer: {
    allowed: ["question", "goals", "origin", "depth", "findings"],
    required: ["question", "goals", "origin", "depth"],
  },
  structurer: {
    allowed: ["question", "goals", "transcripts", "corrections"],
    required: ["question", "goals", "transcripts"],
  },
  critic: {
    allowed: ["question", "goals", "structuredAnswer", "documentation"],
    required: ["question", "goals", "structuredAnswer", "documentation"],
  },
  integrator: {
    allowed: ["question", "goals", "structuredAnswer", "documentationIndex"],
    required: ["question", "goals", "structuredAnswer", "documentationIndex"],
  },
  reviewer: {
    allowed: ["question", "goals", "structuredAnswer", "diff"],
    required: ["question", "goals", "structuredAnswer", "diff"],
  },
  "diff-summarizer": { allowed: ["diff"], required: ["diff"] },
  "simulated-asker": {
    allowed: [
      "verbatimQuestion",
      "verbatimChat",
      "goals",
      "postDiffDocumentation",
    ],
    required: [
      "verbatimQuestion",
      "verbatimChat",
      "goals",
      "postDiffDocumentation",
    ],
  },
  "agent-smith": {
    allowed: ["request", "constraints", "existingDefinitions"],
    required: ["request", "constraints"],
  },
  // Researcher: minimal whitelist. Source/documentation text is DATA only —
  // cannot grant tools or widen permissions. Tools come from the ingest
  // allowlist, not from projected input fields.
  researcher: {
    allowed: [
      "questionId",
      "question",
      "facets",
      "goals",
      "documentation",
      "receipts",
    ],
    required: ["questionId", "question"],
  },
  // Evidence Critic: packet + facets as DATA; tools from allowlist only.
  "evidence-critic": {
    allowed: [
      "questionId",
      "question",
      "facets",
      "packet",
      "goals",
      "documentation",
    ],
    required: ["questionId", "question", "facets", "packet"],
  },
};

function inputSchemaForPolicy(policy: AgentInputPolicy): JsonSchema {
  const fields = policyFields[policy];
  return {
    type: "object",
    properties: Object.fromEntries(fields.allowed.map((field) => [field, {}])),
    required: fields.required,
    additionalProperties: true,
  };
}

function parseDefinitionMarkdown(content: string): {
  metadata: z.input<typeof definitionMetadataSchema>;
  prompt: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content);
  if (!match)
    throw new Error(
      "agent.md must contain YAML frontmatter followed by a prompt.",
    );
  return {
    metadata: YAML.parse(match[1] ?? "") as z.input<
      typeof definitionMetadataSchema
    >,
    prompt: (match[2] ?? "").trim(),
  };
}

function definitionDirectory(root: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(name))
    throw new Error(`Invalid agent name ${name}.`);
  const base = resolve(root);
  const result = resolve(base, name);
  if (!result.startsWith(`${base}${sep}`))
    throw new Error("Agent path escapes definitions root.");
  return result;
}

export async function loadAgentDefinition(
  root: string,
  name: string,
): Promise<AgentDefinition> {
  const directory = definitionDirectory(root, name);
  const parsed = parseDefinitionMarkdown(
    await readFile(join(directory, "agent.md"), "utf8"),
  );
  const metadata = definitionMetadataSchema.parse(parsed.metadata);
  if (metadata.name !== name) {
    throw new Error(
      `Agent directory ${name} contains definition for ${metadata.name}.`,
    );
  }
  const outputSchema = JSON.parse(
    await readFile(join(directory, "schema.json"), "utf8"),
  ) as JsonSchema;
  const ajv = new Ajv({ allErrors: true, strict: true });
  if (!ajv.validateSchema(outputSchema)) {
    throw new Error(
      `Agent ${name} has an invalid output schema: ${ajv.errorsText()}`,
    );
  }
  return {
    ...metadata,
    prompt: parsed.prompt,
    inputSchema: inputSchemaForPolicy(metadata.inputPolicy),
    outputSchema,
    directory,
  };
}

export function projectAgentInput(
  policy: AgentInputPolicy,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields = policyFields[policy];
  for (const required of fields.required) {
    if (!(required in input))
      throw new Error(`${policy} input requires ${required}.`);
  }
  return Object.fromEntries(
    fields.allowed
      .filter((field) => field in input)
      .map((field) => [field, input[field]]),
  );
}

export class AgentOutputValidationError extends Error {
  constructor(
    readonly agentName: string,
    readonly errors: ErrorObject[] | null | undefined,
  ) {
    super(
      `Agent ${agentName} returned output that does not match its schema: ${formatErrors(errors)}`,
    );
    this.name = "AgentOutputValidationError";
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map(
      (error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`,
    )
    .join("; ");
}

export class AgentProviderError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AgentProviderError";
  }
}

export class AgentRuntime {
  readonly #definitionsRoot: string;
  readonly #provider: LlmProvider;
  readonly #invocationId: () => string;

  constructor(options: {
    definitionsRoot: string;
    provider: LlmProvider;
    invocationId?: () => string;
  }) {
    this.#definitionsRoot = options.definitionsRoot;
    this.#provider = options.provider;
    this.#invocationId = options.invocationId ?? randomUUID;
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
    let lastValidation: AgentOutputValidationError | undefined;
    for (let attempt = 0; ; attempt += 1) {
      const definition = await loadAgentDefinition(this.#definitionsRoot, name);
      if (attempt >= definition.maxAttempts) break;
      const projected = projectAgentInput(definition.inputPolicy, input);
      const messages = [
        { role: "user" as const, content: JSON.stringify(projected) },
        ...(lastValidation
          ? [
              {
                role: "system" as const,
                content: `The prior fresh attempt failed output validation: ${lastValidation.message}`,
              },
            ]
          : []),
      ];
      let output: unknown;
      let completed = false;
      for await (const event of this.#provider.stream({
        invocationId: this.#invocationId(),
        agent: { name: definition.name, prompt: definition.prompt },
        messages,
        responseSchema: definition.outputSchema,
      })) {
        if (event.type === "failed")
          throw new AgentProviderError(event.code, event.message);
        if (event.type === "completed") {
          output = event.output;
          completed = true;
        }
      }
      if (!completed)
        throw new AgentProviderError(
          "incomplete",
          `${name} provider stream did not complete.`,
        );
      const validate = this.#compile(definition.outputSchema);
      if (validate(output)) return output;
      lastValidation = new AgentOutputValidationError(name, validate.errors);
    }
    throw lastValidation ?? new AgentOutputValidationError(name, []);
  }

  #compile(schema: JsonSchema): ValidateFunction {
    return new Ajv({ allErrors: true, strict: true }).compile(schema);
  }
}

export interface AgentFixtureValidation {
  name: string;
  cases: number;
  valid: boolean;
  errors: string[];
}

export async function validateAgentFixtures(
  root: string,
): Promise<AgentFixtureValidation[]> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const results: AgentFixtureValidation[] = [];
  for (const name of names) {
    let cases = 0;
    try {
      const definition = await loadAgentDefinition(root, name);
      const files = await readdir(join(definition.directory, "fixtures"));
      const inputFiles = files
        .filter((file) => /^\d{3}-input\.json$/u.test(file))
        .sort();
      cases = inputFiles.length;
      const errors: string[] = [];
      const validate = new Ajv({ allErrors: true, strict: true }).compile(
        definition.outputSchema,
      );
      for (const inputFile of inputFiles) {
        const expectedFile = inputFile.replace("-input.json", "-expected.json");
        if (!files.includes(expectedFile)) {
          errors.push(`${inputFile} has no ${expectedFile}.`);
          continue;
        }
        const input = JSON.parse(
          await readFile(
            join(definition.directory, "fixtures", inputFile),
            "utf8",
          ),
        ) as Record<string, unknown>;
        try {
          projectAgentInput(definition.inputPolicy, input);
        } catch (error) {
          errors.push(
            `${inputFile}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const expected = JSON.parse(
          await readFile(
            join(definition.directory, "fixtures", expectedFile),
            "utf8",
          ),
        ) as unknown;
        if (!validate(expected))
          errors.push(`${expectedFile}: ${formatErrors(validate.errors)}`);
      }
      if (inputFiles.length < 3)
        errors.push(`${name} must have at least three fixture cases.`);
      results.push({
        name,
        cases,
        valid: errors.length === 0,
        errors,
      });
    } catch (error) {
      results.push({
        name,
        cases,
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  return results;
}
