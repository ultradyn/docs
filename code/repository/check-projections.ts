import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { checkProjectionDrift } from "./integrity-checks.js";

export async function checkProjectionsCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const root = resolve(argv[0] ?? process.cwd());
  const result = await checkProjectionDrift(root);
  console.log(
    `Committed question projection is current (${result.bytes} bytes).`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkProjectionsCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
