#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliPackagePath = fileURLToPath(import.meta.resolve("@playwright/cli/package.json"));
const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
const corePackagePath = fileURLToPath(import.meta.resolve("playwright-core/package.json"));
const programModule = await import(
  pathToFileURL(join(dirname(corePackagePath), "lib/tools/cli-client/program.js")).href
);
const program = programModule.program ?? programModule.default?.program;

if (typeof program !== "function") throw new Error("Pinned Playwright CLI program is unavailable");
await program({ embedderVersion: cliPackage.version });
