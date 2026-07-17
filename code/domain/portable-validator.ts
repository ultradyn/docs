import { Ajv, type ErrorObject } from "ajv";

export interface PortableValidationResult {
  valid: boolean;
  errors: readonly ErrorObject[];
}

export type PortableQuestionRecordValidator = (
  candidate: unknown,
) => PortableValidationResult;

export type PortableSchemaValidator<SchemaName extends string = string> = (
  schema: SchemaName,
  candidate: unknown,
) => PortableValidationResult;

const calendarDate =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
const clockTime = "(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?";
const canonicalOffsetDateTime = new RegExp(
  `^${calendarDate}T${clockTime}(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`,
  "u",
);

function createPortableAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat("date-time", (value) => canonicalOffsetDateTime.test(value));
  ajv.addKeyword({
    keyword: "x-uniqueBy",
    type: "array",
    schemaType: "string",
    validate: (property: string, value: unknown[]) => {
      const keys = value.map((item) =>
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)[property]
          : undefined,
      );
      return new Set(keys).size === keys.length;
    },
  });
  ajv.addKeyword({
    keyword: "x-utf16MinLength",
    type: "string",
    schemaType: "number",
    validate: (minimum: number, value: string) => value.length >= minimum,
  });
  ajv.addKeyword({
    keyword: "x-utf16MaxLength",
    type: "string",
    schemaType: "number",
    validate: (maximum: number, value: string) => value.length <= maximum,
  });
  return ajv;
}

export function createPortableSchemaValidator<
  const SchemaName extends string,
>(input: {
  schemas: Record<SchemaName, object>;
}): PortableSchemaValidator<SchemaName> {
  const ajv = createPortableAjv();
  const validators = new Map<SchemaName, ReturnType<Ajv["compile"]>>();
  for (const [name, schema] of Object.entries(input.schemas) as Array<
    [SchemaName, object]
  >) {
    const schemaId = (schema as { $id?: unknown }).$id;
    if (typeof schemaId !== "string" || schemaId.length === 0) {
      throw new Error(`Portable schema ${name} must declare a nonempty $id.`);
    }
    ajv.addSchema(schema);
  }
  for (const [name, schema] of Object.entries(input.schemas) as Array<
    [SchemaName, object]
  >) {
    const schemaId = (schema as { $id: string }).$id;
    const validate = ajv.getSchema(schemaId);
    if (!validate) {
      throw new Error(`Portable schema ${name} could not be compiled.`);
    }
    validators.set(name, validate);
  }

  return (schema, candidate) => {
    const validate = validators.get(schema);
    if (!validate) throw new Error(`Unknown portable schema ${schema}.`);
    return {
      valid: Boolean(validate(candidate)),
      errors: validate.errors ? [...validate.errors] : [],
    };
  };
}

export function createPortableQuestionRecordValidator(input: {
  questionSchema: object;
  provenanceSchema: object;
}): PortableQuestionRecordValidator {
  const validate = createPortableSchemaValidator({
    schemas: {
      provenanceEvent: input.provenanceSchema,
      questionRecord: input.questionSchema,
    },
  });

  return (candidate) => validate("questionRecord", candidate);
}
