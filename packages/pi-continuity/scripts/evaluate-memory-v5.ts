import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMemoryEvaluationCorpus, scoreMemoryEvaluation } from "../src/memory-evaluation.ts";
import { REQUIRED_ZERO_COUNTS } from "../src/memory-rollout.ts";

const [input, flag, output] = process.argv.slice(2);
if (!input) throw Error("Usage: npm run memory:evaluate -- <corpus.json> [--write <manifest.json>]");
const corpus = parseMemoryEvaluationCorpus(JSON.parse(await readFile(resolve(input), "utf8")));
const report = scoreMemoryEvaluation(corpus);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (flag === "--write") {
  if (!output) throw Error("--write requires a manifest path");
  const manifest = {
    version: 1, generatedAt: new Date().toISOString(), gates: report.gates,
    requirements: { minimumCorpusSize: 500, minimumPrecision: 0.99, minimumNoOpAgreement: 0.95, requiredZeroCounts: REQUIRED_ZERO_COUNTS },
  };
  await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
} else if (flag) throw Error(`unknown argument: ${flag}`);
