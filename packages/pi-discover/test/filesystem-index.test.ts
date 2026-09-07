import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createIndexRegistry, WorkspaceIndex } from "../src/index.ts";
import { openIndexDatabase } from "../src/index-schema.ts";
import { filesystemFingerprint } from "../src/filesystem-scanner.ts";
import { WorkerIndex } from "../src/worker-index.ts";
import type { IndexExecutor } from "../src/repository-scanner.ts";
import { effectiveConfig } from "../src/config.ts";

const nonGit: IndexExecutor = async (_command, args) => {
  assert.equal(args[2], "rev-parse");
  return { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" };
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discover-plain-"));
  const path = join(root, "index.sqlite");
  const index = new WorkspaceIndex(root, nonGit, path);
  return {
    root,
    path,
    index,
    async close() {
      await index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("non-Git searches reconcile edits, renames, exclusions and deletions", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src/first.ts"), "export function firstSymbol() {}\n");
    assert.equal((await f.index.searchSymbols(f.root, { query: "firstSymbol" }))[0].path, "src/first.ts");
    assert.equal(((await f.index.status()) as any).mode, "filesystem");
    await rename(join(f.root, "src/first.ts"), join(f.root, "src/second.ts"));
    await writeFile(join(f.root, "src/second.ts"), "export function secondSymbol() {}\n");
    assert.equal((await f.index.searchSymbols(f.root, { query: "firstSymbol" })).length, 0);
    assert.equal((await f.index.searchCode(f.root, { query: "secondSymbol" }))[0].path, "src/second.ts");
    await writeFile(join(f.root, ".gitignore"), "src/\n");
    assert.equal((await f.index.searchCode(f.root, { query: "secondSymbol" })).length, 0);
    await writeFile(join(f.root, ".gitignore"), "");
    assert.equal((await f.index.searchSymbols(f.root, { query: "secondSymbol" })).length, 1);
    await rm(join(f.root, "src/second.ts"));
    assert.equal((await f.index.searchSymbols(f.root, { query: "secondSymbol" })).length, 0);
  } finally {
    await f.close();
  }
});

test("metadata hits avoid preparation; same-content edits update fingerprints without rewriting symbols", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "file.ts");
    const content = "export function stableSymbol() {}\n";
    await writeFile(source, content);
    await f.index.refresh();
    const db = new DatabaseSync(f.path);
    try {
      const before = db.prepare("SELECT fingerprint,verified_at FROM files").get() as any;
      const symbol = db.prepare("SELECT id FROM symbols").get();
      const scanner = (f.index as any).scanner;
      const prepare = scanner.prepareAll.bind(scanner);
      const candidates: string[][] = [];
      scanner.prepareAll = async (...args: any[]) => {
        candidates.push(args[1]);
        return prepare(...args);
      };
      await f.index.refresh();
      assert.deepEqual(candidates.pop(), []);
      assert.deepEqual(db.prepare("SELECT fingerprint,verified_at FROM files").get(), before);
      await writeFile(source, content);
      await f.index.refresh();
      assert.deepEqual(candidates.pop(), ["file.ts"]);
      assert.notEqual((db.prepare("SELECT fingerprint FROM files").get() as any).fingerprint, before.fingerprint);
      assert.deepEqual(db.prepare("SELECT id FROM symbols").get(), symbol);
      await f.index.refresh();
      assert.deepEqual(candidates.pop(), []);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("due verification repairs metadata-missed content and rebuild rereads unconditionally", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "file.ts");
    await writeFile(source, "export function oldSymbol() {}\n");
    await f.index.refresh();
    const db = new DatabaseSync(f.path);
    try {
      await writeFile(source, "export function newSymbol() {}\n");
      // Model a filesystem reporting unchanged metadata: the stored fingerprint agrees
      // with the current stat even though the persisted content is older.
      db.prepare("UPDATE files SET fingerprint=?").run(filesystemFingerprint(await lstat(source, { bigint: true })));
      await f.index.refresh();
      assert.match((db.prepare("SELECT content FROM files").get() as any).content, /oldSymbol/);
      db.prepare("UPDATE files SET verified_at=1").run();
      assert.equal((await f.index.searchSymbols(f.root, { query: "newSymbol" })).length, 1);
      db.prepare("DELETE FROM symbols").run();
      await f.index.rebuild();
      assert.equal((await f.index.searchSymbols(f.root, { query: "newSymbol" })).length, 1);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("incomplete inventory preserves committed content and freshness, then recovers", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "file.ts"), "export function retained() {}\n");
    await f.index.refresh();
    const before = await f.index.status();
    await rm(join(f.root, "file.ts"));
    await writeFile(join(f.root, ".gitignore"), "x".repeat(513 * 1024));
    await assert.rejects(f.index.searchSymbols(f.root, { query: "retained" }), /limit/);
    assert.deepEqual(await f.index.status(), before);
    const db = new DatabaseSync(f.path);
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM code_fts").get() as any).n, 1);
    } finally {
      db.close();
    }
    await rm(join(f.root, ".gitignore"));
    assert.equal((await f.index.searchSymbols(f.root, { query: "retained" })).length, 0);
  } finally {
    await f.close();
  }
});

test("concurrent filesystem writers retry against generations without losing rows", async () => {
  const f = await fixture();
  const second = new WorkspaceIndex(f.root, nonGit, f.path);
  try {
    await writeFile(join(f.root, "file.ts"), "export function concurrentSymbol() {}\n");
    await Promise.all([f.index.refresh(), second.refresh()]);
    assert.equal((await second.searchSymbols(f.root, { query: "concurrentSymbol" })).length, 1);
    assert.equal(((await f.index.status()) as any).files, 1);
  } finally {
    await second.close();
    await f.close();
  }
});

test("worker preserves missing-Git fallback but surfaces other Git failures", async () => {
  const f = await fixture();
  let code = "ENOENT";
  const worker = new WorkerIndex(
    f.root,
    async () => {
      throw Object.assign(new Error("git spawn failed"), { code });
    },
    f.path,
    30_000,
  );
  try {
    await writeFile(join(f.root, "file.ts"), "export function noGitNeeded() {}\n");
    assert.equal((await worker.searchSymbols(f.root, { query: "noGitNeeded" })).length, 1);
    code = "EACCES";
    await assert.rejects(worker.refresh(), /git spawn failed/);
  } finally {
    await worker.close();
    await f.close();
  }
});

test("v3 migration preserves cached content, symbols and FTS rows", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "file.ts"), "export function migratedSymbol() {}\n");
    await f.index.refresh();
    await f.index.close();
    const old = new DatabaseSync(f.path);
    const before = old.prepare("SELECT id,content,hash FROM files").all();
    old.exec(`ALTER TABLE files DROP COLUMN fingerprint;
      ALTER TABLE files DROP COLUMN verified_at;
      ALTER TABLE repositories DROP COLUMN source_mode;
      ALTER TABLE repositories DROP COLUMN policy;
      PRAGMA user_version=3;`);
    old.close();
    const migrated = openIndexDatabase(f.path);
    try {
      assert.deepEqual(migrated.prepare("SELECT id,content,hash FROM files").all(), before);
      assert.equal(
        (migrated.prepare("SELECT count(*) AS n FROM symbols WHERE name='migratedSymbol'").get() as any).n,
        1,
      );
      assert.equal(
        (migrated.prepare("SELECT count(*) AS n FROM code_fts WHERE code_fts MATCH 'migratedSymbol'").get() as any).n,
        1,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await f.close();
  }
});

test("registry recovers Pi's empty spawn failure and forwards strict verification settings", async () => {
  const f = await fixture();
  const previous = process.env.PI_DISCOVER_INDEX_PATH;
  process.env.PI_DISCOVER_INDEX_PATH = f.path;
  const registry = createIndexRegistry(
    { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
    effectiveConfig({ version: 1, filesystemVerifyIntervalMs: 0 }),
    async () => false,
  );
  try {
    const source = join(f.root, "file.ts");
    await writeFile(source, "export function beforeStrict() {}\n");
    const index = registry.indexFor(f.root);
    await index.refresh();
    const db = new DatabaseSync(f.path);
    try {
      await writeFile(source, "export function afterStrict() {}\n");
      db.prepare("UPDATE files SET fingerprint=?").run(filesystemFingerprint(await lstat(source, { bigint: true })));
      assert.equal((await index.searchSymbols(f.root, { query: "afterStrict" })).length, 1);
    } finally {
      db.close();
    }
  } finally {
    await registry.closeAll();
    if (previous === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previous;
    await f.close();
  }
});

test("mode transitions reconcile at the same root but refuse automatic parent expansion", async () => {
  const f = await fixture();
  let gitRoot: string | undefined;
  const index = new WorkspaceIndex(
    f.root,
    async (command, args, options) => {
      if (!gitRoot) return nonGit(command, args, options);
      if (args[2] === "rev-parse") return { code: 0, stdout: gitRoot, stderr: "" };
      if (args[2] === "status") return { code: 0, stdout: "# branch.oid abc\0# branch.head main\0", stderr: "" };
      return { code: 0, stdout: args.includes("--stage") ? "" : "file.ts\0.hidden.ts\0", stderr: "" };
    },
    f.path,
  );
  try {
    await writeFile(join(f.root, "file.ts"), "export function commonSymbol() {}\n");
    await writeFile(join(f.root, ".hidden.ts"), "export function gitOnlySymbol() {}\n");
    await index.refresh();
    assert.equal(((await index.status()) as any).files, 1);
    gitRoot = f.root;
    assert.equal((await index.searchSymbols(f.root, { query: "gitOnlySymbol" })).length, 1);
    assert.equal(((await index.status()) as any).mode, "git");
    gitRoot = undefined;
    assert.equal((await index.searchSymbols(f.root, { query: "gitOnlySymbol" })).length, 0);
    gitRoot = join(f.root, "..");
    await assert.rejects(index.refresh(), /start a new session/);
    assert.equal(((await index.status()) as any).files, 1);
  } finally {
    await index.close();
    await f.close();
  }
});

test("file mutation after inventory never publishes partial preparation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "file.ts"), "export function stableBeforeRace() {}\n");
    await f.index.refresh();
    const before = await f.index.status();
    const scanner = (f.index as any).scanner;
    const prepare = scanner.prepareAll.bind(scanner);
    scanner.prepareAll = async (...args: any[]) => {
      await rm(join(f.root, "file.ts"));
      return prepare(...args);
    };
    await assert.rejects(f.index.rebuild(), /ENOENT/);
    assert.deepEqual(await f.index.status(), before);
  } finally {
    await f.close();
  }
});
