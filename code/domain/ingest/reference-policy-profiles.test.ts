import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DataRightsPolicyProfileSchema } from "./data-rights-policy-profile.js";

const directory = fileURLToPath(
  new URL("../../../scaffold/policy-profiles", import.meta.url),
);

const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

function load(name: string): unknown {
  return JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
}

function portableValidator() {
  const Ajv2020 = Ajv2020Module.default;
  return new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../scaffold/schemas/ingest/data-rights-policy-profile.schema.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
}

describe("reference profiles cover the specified class set", () => {
  it("ships one profile per named class", () => {
    expect(files).toEqual([
      "confidential-no-publish.json",
      "internal-docs.json",
      "prohibited.json",
      "public-docs.json",
      "restricted-local-only.json",
    ]);
  });

  it("covers every class in the closed vocabulary", () => {
    const classes = files
      .map(
        (name) => (load(name) as { dataRightsClass: string }).dataRightsClass,
      )
      .sort();
    expect(classes).toEqual([
      "confidential",
      "internal",
      "prohibited",
      "public",
      "restricted-local-only",
    ]);
  });
});

describe("every reference profile validates natively and portably", () => {
  it.each(files)("%s parses under the native schema", (name) => {
    const result = DataRightsPolicyProfileSchema.safeParse(load(name));
    expect(result.success).toBe(true);
  });

  it.each(files)(
    "%s validates under the portable Draft 2020-12 schema",
    (name) => {
      expect(portableValidator()(load(name))).toBe(true);
    },
  );
});

describe("reference profiles encode the rules they are meant to demonstrate", () => {
  it("permits external publication only for the public profile", () => {
    for (const name of files) {
      const profile = load(name) as {
        dataRightsClass: string;
        publication: string;
      };
      if (profile.publication === "external") {
        expect(profile.dataRightsClass).toBe("public");
      }
    }
  });

  it("distinguishes local-only from egressing material by REGION, not provider", () => {
    // Comparing the two fixtures is the point: both declare model providers, so
    // an assertion about one alone would pass vacuously. What separates them is
    // the region list, which is where egress is actually governed.
    type Profile = { allowedRegions: string[]; allowedProviders: string[] };
    const restricted = load("restricted-local-only.json") as Profile;
    const publicDocs = load("public-docs.json") as Profile;

    expect(restricted.allowedRegions).toEqual(["local"]);
    expect(publicDocs.allowedRegions).not.toContain("local");
    expect(publicDocs.allowedRegions.length).toBeGreaterThan(0);

    // Both carry providers; the fixtures would be indistinguishable on this
    // axis, which is precisely why region is the control.
    expect(restricted.allowedProviders.length).toBeGreaterThan(0);
    expect(publicDocs.allowedProviders.length).toBeGreaterThan(0);
    expect(publicDocs.allowedProviders).not.toEqual(
      restricted.allowedProviders,
    );
  });

  it("gives the prohibited profile no quotable bytes and no publication", () => {
    const profile = load("prohibited.json") as {
      maxQuoteBytes: number;
      publication: string;
    };
    expect(profile.maxQuoteBytes).toBe(0);
    expect(profile.publication).toBe("forbidden");
  });

  it("declares no deletion or legal hold field anywhere", () => {
    for (const name of files) {
      const keys = Object.keys(load(name) as Record<string, unknown>);
      for (const key of keys) {
        expect(key).not.toMatch(/delete|erase|purge|unlink|legalHold/iu);
      }
    }
  });
});
