import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SessionRuntime } from "../src/server/pi/session-runtime.ts";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const startupBudgetMs = 5_000;

test("a session starts within budget in a repository with untracked files", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-session-startup-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const git = (...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  let driver: SessionRuntime | undefined;

  try {
    await Promise.all([
      mkdir(join(cwd, "src", "feature"), { recursive: true }),
      mkdir(join(cwd, "src", "shared"), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "pylon-session-startup-fixture",
        pi: { extensions: [resolve(repositoryRoot, "packages/pi-timeline/extensions/pi-timeline.ts")] },
      }),
    );
    await writeFile(join(cwd, "src", "feature", "tracked.ts"), "export const feature = true;\n");
    await writeFile(join(cwd, "src", "shared", "tracked.ts"), "export const shared = true;\n");
    await git("init", "-q");
    await git("config", "user.email", "startup@test.local");
    await git("config", "user.name", "startup-test");
    await git("add", ".");
    await git("commit", "-qm", "fixture");
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writeFile(join(cwd, "src", index % 2 ? "feature" : "shared", `untracked-${index}.ts`), "// untracked\n"),
      ),
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    driver = new SessionRuntime();
    const startedAt = performance.now();
    await driver.start({ cwd, agentDir, repositoryRoot: cwd, inMemory: true });
    const durationMs = performance.now() - startedAt;

    assert.ok(durationMs < startupBudgetMs, `session startup took ${Math.round(durationMs)}ms`);
  } finally {
    await driver?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
