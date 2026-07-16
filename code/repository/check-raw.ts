import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { checkRawArtifactsAgainstGit } from "./integrity-checks.js";

export async function checkRawArtifactsCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const root = resolve(argv[0] ?? process.cwd());
  const result = await checkRawArtifactsAgainstGit({
    root,
    ...(argv[1] ? { baseRef: argv[1] } : {}),
  });
  console.log(
    result.base
      ? `Raw artifact immutability verified for ${result.checked} artifact(s) against ${result.base}.`
      : "No parent/base commit exists; raw artifact history check skipped.",
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkRawArtifactsCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
