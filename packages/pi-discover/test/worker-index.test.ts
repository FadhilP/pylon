import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createIndexRegistry, WorkspaceIndex } from "../src/index.ts";
import { WorkerIndex } from "../src/worker-index.ts";
import type { IndexExecutor } from "../src/repository-scanner.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discover-worker-"));
  await writeFile(join(root, "file.ts"), "export function alpha() {}\nexport function alphabet() {}\n");
  const exec: IndexExecutor = async (_command, args) => {
    const command = args.slice(2);
    if (command[0] === "status")
      return { code: 0, stderr: "", stdout: "# branch.oid abc\0# branch.head main\0? file.ts\0" };
    if (command[0] === "ls-files")
      return { code: 0, stderr: "", stdout: command.includes("--stage") ? "" : "file.ts\0" };
    if (command[0] === "rev-parse") return { code: 0, stderr: "", stdout: root };
    throw new Error(`Unexpected git call: ${command.join(" ")}`);
  };
  return { root, exec };
}

test("production registry preserves search freshness and truncation across the worker boundary", async () => {
  const { root, exec } = await fixture();
  const previous = process.env.PI_DISCOVER_INDEX_PATH;
  process.env.PI_DISCOVER_INDEX_PATH = join(root, "index.sqlite");
  const registry = createIndexRegistry({ exec } as any);
  try {
    const index = registry.indexFor(root);
    const result = await index.searchSymbols(root, { query: "alpha", limit: 1 });
    assert.equal(result.length, 1);
    assert.equal(result.moreAvailable, true);
    await writeFile(join(root, "file.ts"), "export function replacement() {}\n");
    assert.equal((await index.searchSymbols(root, { query: "alpha" })).length, 0);
    assert.equal((await index.searchCode(root, { query: "replacement" }))[0].path, "file.ts");
  } finally {
    await registry.closeAll();
    if (previous === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("worker close drains accepted requests and rejects later calls", async () => {
  const { root, exec } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const index = new WorkerIndex(
    root,
    async (...args) => {
      entered();
      await gate;
      return exec(...args);
    },
    join(root, "index.sqlite"),
    30_000,
  );
  try {
    const refresh = index.refresh();
    await started;
    let closed = false;
    const closing = index.close().then(() => {
      closed = true;
    });
    await assert.rejects(index.status(), /closing/);
    await delay(20);
    assert.equal(closed, false);
    release();
    await refresh;
    await closing;
    await assert.rejects(index.refresh(), /closing|exited/);
  } finally {
    release();
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker execution failures reject callers without poisoning later refreshes", async () => {
  const { root, exec } = await fixture();
  let fail = true;
  const index = new WorkerIndex(
    root,
    async (...args) => {
      if (fail) throw new Error("fixture executor failure");
      return exec(...args);
    },
    join(root, "index.sqlite"),
    30_000,
  );
  try {
    await assert.rejects(index.refresh(), /fixture executor failure/);
    fail = false;
    await index.refresh();
    assert.equal(((await index.status()) as any).files, 1);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker termination rejects an in-flight request and close does not hang", async () => {
  const { root, exec } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const index = new WorkerIndex(
    root,
    async (...args) => {
      entered();
      await gate;
      return exec(...args);
    },
    join(root, "index.sqlite"),
    30_000,
  );
  try {
    const rejected = assert.rejects(index.refresh(), /exited/);
    await started;
    await (index as any).worker.terminate();
    await rejected;
    release();
    await index.close();
  } finally {
    release();
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite lock waits in the worker leave the host free to release the lock", async () => {
  const { root, exec } = await fixture();
  const path = join(root, "index.sqlite");
  const index = new WorkerIndex(root, exec, path, 30_000);
  let blocker: DatabaseSync | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await index.refresh();
    blocker = new DatabaseSync(path);
    blocker.exec("BEGIN IMMEDIATE");
    let released = false;
    timer = setTimeout(() => {
      blocker!.exec("ROLLBACK");
      released = true;
    }, 100);
    await index.refresh();
    assert.equal(released, true);
  } finally {
    clearTimeout(timer);
    blocker?.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged hashes preserve symbol rows while dirty state and forced rebuild remain correct", async () => {
  const { root, exec } = await fixture();
  let dirty = true;
  const path = join(root, "index.sqlite");
  const index = new WorkspaceIndex(
    root,
    async (...args) => {
      const result = await exec(...args);
      if (!dirty) result.stdout = result.stdout.replace("? file.ts\0", "");
      return result;
    },
    path,
  );
  let db: DatabaseSync | undefined;
  try {
    await index.refresh();
    db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER protect_symbols BEFORE DELETE ON symbols BEGIN SELECT RAISE(ABORT, 'unchanged symbols rewritten'); END",
    );
    dirty = false;
    await index.refresh();
    assert.equal((db.prepare("SELECT dirty FROM files").get() as any).dirty, 0);
    dirty = true;
    await index.refresh();
    assert.equal((db.prepare("SELECT dirty FROM files").get() as any).dirty, 1);
    assert.equal((await index.searchCode(root, { query: "alpha" })).length, 1);
    db.exec("DROP TRIGGER protect_symbols; UPDATE symbols SET name='stale'");
    await index.rebuild();
    assert.equal((await index.searchSymbols(root, { query: "alpha" })).length, 2);
  } finally {
    db?.close();
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged worker loads TypeScript beneath node_modules and refreshes the index", async () => {
  const { root, exec } = await fixture();
  const installed = join(root, "node_modules", "pi-discover");
  await cp(new URL("../src/", import.meta.url), join(installed, "src"), { recursive: true });
  await symlink(
    fileURLToPath(new URL("../../../node_modules/", import.meta.url)),
    join(installed, "node_modules"),
    "junction",
  );
  const worker = new Worker(join(installed, "src", "index-worker.mjs"), {
    workerData: { cwd: root, path: join(root, "index.sqlite"), timeout: 30_000 },
    execArgv: [],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", async message => {
        if (message.type === "exec") {
          try {
            worker.postMessage({
              type: "exec-result",
              id: message.id,
              value: await exec(message.command, message.args, message.options),
            });
          } catch (error) {
            reject(error);
          }
        } else if (message.type === "result") {
          if (message.error) reject(new Error(message.error.message));
          else resolve();
        }
      });
      worker.postMessage({ type: "call", id: 1, method: "refresh", args: [] });
    });
    const db = new DatabaseSync(join(root, "index.sqlite"));
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM files").get() as any).n, 1);
    } finally {
      db.close();
    }
  } finally {
    await worker.terminate();
    await rm(join(installed, "node_modules"));
    await rm(root, { recursive: true, force: true });
  }
});
