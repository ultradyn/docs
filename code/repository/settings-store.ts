import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import writeFileAtomic from "write-file-atomic";
import {
  PersonalSettingsSchema,
  ProjectSettingsSchema,
  mergeSettings,
  type PersonalSettings,
  type ProjectSettings,
} from "../domain/index.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

const defaultProject = ProjectSettingsSchema.parse({ schemaVersion: 1 });
const defaultPersonal = PersonalSettingsSchema.parse({ schemaVersion: 1 });

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class RepositorySettingsStore {
  readonly repositoryRoot: string;
  readonly personalPath: string;
  readonly projectPath: string;

  constructor(repositoryRoot: string, personalPath: string) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.personalPath = resolve(personalPath);
    this.projectPath = join(this.repositoryRoot, "settings", "project.json");
  }

  async readProject(): Promise<ProjectSettings> {
    return ProjectSettingsSchema.parse(
      (await readJson(await this.#projectFile())) ?? defaultProject,
    );
  }

  async readPersonal(): Promise<PersonalSettings> {
    return PersonalSettingsSchema.parse(
      (await readJson(await this.#personalFile())) ?? defaultPersonal,
    );
  }

  async readMerged(): Promise<ReturnType<typeof mergeSettings>> {
    return mergeSettings(await this.readProject(), await this.readPersonal());
  }

  async writeProject(
    input: Parameters<typeof ProjectSettingsSchema.parse>[0],
  ): Promise<ProjectSettings> {
    const settings = ProjectSettingsSchema.parse(input);
    const projectPath = await this.#projectFile();
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFileAtomic(
      projectPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      { encoding: "utf8" },
    );
    return settings;
  }

  async writePersonal(
    input: Parameters<typeof PersonalSettingsSchema.parse>[0],
  ): Promise<PersonalSettings> {
    const settings = PersonalSettingsSchema.parse(input);
    const personalPath = await this.#personalFile();
    await mkdir(dirname(personalPath), { recursive: true });
    await writeFileAtomic(
      personalPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      { encoding: "utf8" },
    );
    return settings;
  }

  #projectFile(): Promise<string> {
    return resolveContainedPathNoSymlinks(
      this.repositoryRoot,
      this.projectPath,
    );
  }

  #personalFile(): Promise<string> {
    return resolveContainedPathNoSymlinks(
      dirname(this.personalPath),
      this.personalPath,
    );
  }
}
