#!/usr/bin/env node

import { runNodeCli } from "./node.js";

try {
  process.exitCode = await runNodeCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Ultradyn Docs could not start: ${message}\n`);
  process.exitCode = 1;
}
