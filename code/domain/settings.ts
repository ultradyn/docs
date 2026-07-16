import { z } from "zod";

export const ActorHandleSchema = z
  .string()
  .trim()
  .max(96)
  .refine(
    (value) => value === "" || /^[a-z0-9][a-z0-9._:-]*$/u.test(value),
    "Use a lowercase stable handle containing letters, numbers, dots, underscores, colons, or hyphens.",
  );
export type ActorHandle = z.infer<typeof ActorHandleSchema>;

const providerSelection = z.object({
  llm: z.string().min(1),
  stt: z.string().min(1),
  codec: z.string().min(1),
  gitHost: z.string().min(1).optional(),
});

export const ProjectSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  acceptanceTimeoutDays: z.number().int().min(1).max(365).default(14),
  integrationMode: z.enum(["manual", "auto"]).default("manual"),
  checkpointCommits: z.boolean().default(true),
  maintenance: z
    .object({
      enabled: z.boolean().default(false),
      pollIntervalMinutes: z.number().int().min(1).max(1440).default(15),
    })
    .default({ enabled: false, pollIntervalMinutes: 15 }),
  providers: providerSelection.default({
    llm: "fake-llm",
    stt: "fake-stt",
    codec: "fake-codec",
  }),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ConsentReceiptSchema = z.object({
  decision: z.enum(["granted", "denied", "revoked"]),
  decidedAt: z.string().datetime({ offset: true }),
  sourceId: z.string().min(1),
  scope: z.enum(["model", "transcription", "git-host"]),
});
export type ConsentReceipt = z.infer<typeof ConsentReceiptSchema>;

export const PersonalSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z
    .object({
      actorHandle: ActorHandleSchema.default(""),
    })
    .default({ actorHandle: "" }),
  appearance: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      reducedMotion: z.boolean().default(false),
    })
    .default({ theme: "system", reducedMotion: false }),
  audio: z
    .object({
      preferredFormat: z.enum(["ogg", "mp3"]).default("ogg"),
      keepConvertedAudio: z.boolean().default(true),
    })
    .default({ preferredFormat: "ogg", keepConvertedAudio: true }),
  providerPreferences: providerSelection.partial().default({}),
  consent: z.record(z.string(), ConsentReceiptSchema).default({}),
});
export type PersonalSettings = z.infer<typeof PersonalSettingsSchema>;

export interface EffectiveSettings extends ProjectSettings {
  appearance: PersonalSettings["appearance"];
  audio: PersonalSettings["audio"];
}

export function mergeSettings(
  projectInput: z.input<typeof ProjectSettingsSchema>,
  personalInput: z.input<typeof PersonalSettingsSchema>,
): {
  project: ProjectSettings;
  personal: PersonalSettings;
  effective: EffectiveSettings;
} {
  const project = ProjectSettingsSchema.parse(projectInput);
  const personal = PersonalSettingsSchema.parse(personalInput);
  const personalProviders = Object.fromEntries(
    Object.entries(personal.providerPreferences).filter(
      (entry) => entry[1] !== undefined,
    ),
  ) as Partial<ProjectSettings["providers"]>;
  return {
    project,
    personal,
    effective: {
      ...project,
      providers: { ...project.providers, ...personalProviders },
      appearance: personal.appearance,
      audio: personal.audio,
    },
  };
}
