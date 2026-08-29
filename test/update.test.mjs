import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForUpdate, isNewerVersion } from "../bin/update.mjs";

const response = version => async () => ({ ok: true, text: async () => JSON.stringify({ version }) });

test("compares stable npm versions", () => {
  assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
  assert.equal(isNewerVersion("1.3.0", "1.2.99"), true);
  assert.equal(isNewerVersion("1.2.4+build.1", "1.2.3"), true);
  assert.equal(isNewerVersion("1.2.3", "1.2.3+local"), false);
  assert.equal(isNewerVersion("1.2.2", "1.2.3"), false);
  assert.equal(isNewerVersion("1.3.0-beta.1", "1.2.3"), false);
  assert.equal(isNewerVersion("01.3.0", "1.2.3"), false);
  assert.equal(isNewerVersion("999999999999999999999.0.0", "2.0.0"), true);
});

test("asks before installing the exact update", async () => {
  let offered;
  let installed;
  const messages = [];
  const result = await checkForUpdate("1.2.3", {
    fetch: response("1.3.0"),
    interactive: true,
    confirm: async version => {
      offered = version;
      return true;
    },
    install: version => {
      installed = version;
      return { status: 0 };
    },
    log: message => messages.push(message),
  });
  assert.equal(offered, "1.3.0");
  assert.equal(installed, "1.3.0");
  assert.equal(result, "updated");
  assert.match(messages.at(-1), /Run pylon again/);
});

test("declining or running non-interactively never installs", async () => {
  let installs = 0;
  const install = () => {
    installs++;
    return { status: 0 };
  };
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: response("1.1.0"),
      interactive: true,
      confirm: async () => false,
      install,
      log: () => {},
    }),
    "continue",
  );
  const messages = [];
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: response("1.1.0"),
      interactive: false,
      install,
      log: message => messages.push(message),
    }),
    "continue",
  );
  assert.equal(installs, 0);
  assert.match(messages.at(-1), /npm install --global @fadhilp\/pylon@1\.1\.0/);
});

test("check failures continue but install attempts always stop", async () => {
  const warnings = [];
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: async () => {
        throw new Error("offline");
      },
      warn: message => warnings.push(message),
    }),
    "continue",
  );
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: response("1.1.0"),
      interactive: true,
      confirm: async () => true,
      install: () => ({ status: 1 }),
      log: () => {},
      warn: message => warnings.push(message),
    }),
    "stopped",
  );
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: response("1.1.0"),
      interactive: true,
      confirm: async () => true,
      install: () => {
        throw new Error("spawn failed");
      },
      log: () => {},
      warn: message => warnings.push(message),
    }),
    "stopped",
  );
  assert.equal(warnings.length, 3);
  assert.match(warnings.at(-1), /may be incomplete/);
});

test("invalid registry responses are non-fatal", async () => {
  const warnings = [];
  assert.equal(
    await checkForUpdate("1.0.0", { fetch: response("1.1.0-beta.1"), warn: message => warnings.push(message) }),
    "continue",
  );
  assert.equal(
    await checkForUpdate("1.0.0", {
      fetch: async () => ({ ok: true, text: async () => "x".repeat(10_001) }),
      warn: message => warnings.push(message),
    }),
    "continue",
  );
  assert.equal(warnings.length, 2);
});

test("successful update checks are cached for one day", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-update-cache-"));
  const cacheFile = join(root, "nested", "update.json");
  let fetched = 0;
  const fetch = async () => {
    fetched++;
    return await response("1.0.0")();
  };
  try {
    assert.equal(await checkForUpdate("1.0.0", { fetch, cacheFile, now: () => 1_000, log: () => {} }), "continue");
    assert.equal(await checkForUpdate("1.0.0", { fetch, cacheFile, now: () => 2_000, log: () => {} }), "continue");
    assert.equal(fetched, 1);
    assert.equal(await checkForUpdate("1.0.0", { fetch, cacheFile, now: () => 86_401_001, log: () => {} }), "continue");
    assert.equal(fetched, 2);

    await writeFile(cacheFile, "not json");
    assert.equal(await checkForUpdate("1.0.0", { fetch, cacheFile, now: () => 86_402_000, log: () => {} }), "continue");
    assert.equal(fetched, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid installed versions skip the registry", async () => {
  let fetched = false;
  const warnings = [];
  assert.equal(
    await checkForUpdate("1.0.0-beta.1", {
      fetch: async () => {
        fetched = true;
      },
      warn: message => warnings.push(message),
    }),
    "continue",
  );
  assert.equal(fetched, false);
  assert.match(warnings[0], /installed version is invalid/);
});

test("update checks can be disabled", async () => {
  let fetched = false;
  assert.equal(
    await checkForUpdate("1.0.0", {
      env: { PYLON_NO_UPDATE_CHECK: "1" },
      fetch: async () => {
        fetched = true;
      },
    }),
    "continue",
  );
  assert.equal(fetched, false);
});
