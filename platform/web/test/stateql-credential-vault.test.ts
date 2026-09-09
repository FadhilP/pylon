import test from "node:test";
import assert from "node:assert/strict";
import {
  createStateQLCredentialReference,
  isStateQLCredentialReference,
  OsStateQLCredentialVault,
  stateqlCredentialFingerprint,
  type KeyringEntryFactory,
} from "../src/server/database/stateql-credential-vault.ts";

function fakeKeyring(values = new Map<string, string>()): { values: Map<string, string>; entry: KeyringEntryFactory } {
  return {
    values,
    entry: (service, account) => ({
      async setPassword(value) {
        values.set(`${service}\0${account}`, value);
      },
      async getPassword() {
        return values.get(`${service}\0${account}`);
      },
      async deleteCredential() {
        return values.delete(`${service}\0${account}`);
      },
    }),
  };
}

test("OS credential vault resolves only the exact password-free connection identity", async () => {
  const keyring = fakeKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const reference = createStateQLCredentialReference();
  const target = "postgres://ada@db.example.com:5432/shop?sslmode=verify-full";
  const source = "postgres://ada:s3ntinel@db.example.com:5432/shop?sslmode=verify-full";

  assert.equal(isStateQLCredentialReference(reference), true);
  assert.equal(await vault.save(reference, target, source), true);
  assert.equal(await vault.resolve(reference, target), source);
  assert.equal(await vault.resolve(reference), source);
  assert.equal(await vault.invalidate(reference), true);
  assert.equal(await vault.resolve(reference), undefined);
  assert.equal(await vault.save(reference, undefined, source), true);
  assert.equal(await vault.resolve(reference), source);
  assert.equal(JSON.stringify([...keyring.values.keys()]).includes("s3ntinel"), false);

  assert.equal(
    await vault.resolve(reference, "postgres://ada@other.example.com:5432/shop?sslmode=verify-full"),
    undefined,
  );
  assert.equal(await vault.resolve(reference, "postgres://ada@db.example.com:5432/shop?sslmode=disable"), undefined);
  assert.equal(await vault.forget(reference), true);
  assert.equal(await vault.resolve(reference, target), undefined);
});

test("OS credential vault rejects rebinding, malformed records, and unavailable providers", async () => {
  const keyring = fakeKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const reference = createStateQLCredentialReference();
  const target = "mysql://ada@localhost:3306/shop";

  assert.equal(await vault.save(reference, target, "mysql://ada:secret@elsewhere:3306/shop"), false);
  assert.equal(keyring.values.size, 0);

  keyring.values.set(`works.earendil.pylon.stateql\0${reference}`, "not-json");
  assert.equal(await vault.resolve(reference, target), undefined);
  assert.equal(isStateQLCredentialReference("DATABASE_URL"), false);
  assert.equal(stateqlCredentialFingerprint("sqlite:./shop.db"), undefined);

  const unavailable = new OsStateQLCredentialVault(() => ({
    async setPassword() {
      throw new Error("vault locked: secret must not escape");
    },
    async getPassword() {
      throw new Error("vault locked: secret must not escape");
    },
    async deleteCredential() {
      throw new Error("vault locked: secret must not escape");
    },
  }));
  assert.equal(await unavailable.save(reference, target, "mysql://ada:secret@localhost:3306/shop"), false);
  assert.equal(await unavailable.resolve(reference, target), undefined);
  assert.equal(await unavailable.invalidate(reference), false);
  assert.equal(await unavailable.forget(reference), false);
});


test("OS credential vault persists v2 passwords without connection URLs", async () => {
  const keyring = fakeKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const reference = createStateQLCredentialReference();
  const target = "postgres://ada@db.example.com:5432/shop?sslmode=verify-full&application_name=pylon";

  assert.equal(await vault.savePassword(reference, target, "s3ntinel"), true);
  const stored = keyring.values.get(`works.earendil.pylon.stateql\0${reference}`) ?? "";
  const storedRecord = JSON.parse(stored) as Record<string, unknown>;
  assert.equal(storedRecord.version, 2);
  assert.equal(storedRecord.password, "s3ntinel");
  assert.equal("source" in storedRecord, false);
  assert.equal("target" in storedRecord, false);
  assert.equal(stored.includes(target), false);
  assert.equal(await vault.resolvePassword(reference, "postgres://ada@db.example.com/shop?sslmode=disable&application_name=pylon"), "s3ntinel");
  assert.equal(await vault.resolve(reference, target), undefined);

  assert.equal(await vault.savePassword(reference, "postgres://ada:secret@db.example.com/shop", "replacement"), false);
  assert.equal(await vault.savePassword(reference, "postgres://ada@db.example.com/shop?host=other", "replacement"), false);
  assert.equal(await vault.resolvePassword(reference, "postgres://ada@other.example.com/shop?application_name=pylon"), undefined);
});

test("OS credential vault resolves empty and legacy passwords without rewriting v1 records", async () => {
  const keyring = fakeKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const reference = createStateQLCredentialReference();
  const target = "mysql://ada@db.example.com:3306/shop?sslmode=verify-ca";

  assert.equal(await vault.savePassword(reference, target, ""), true);
  assert.equal(await vault.resolvePassword(reference, "mysql://ada@db.example.com/shop?sslmode=disable"), "");
  assert.equal(await vault.invalidate(reference), true);
  assert.equal(await vault.resolvePassword(reference, target), undefined);
  assert.equal(await vault.forget(reference), true);

  const legacyReference = createStateQLCredentialReference();
  const source = "postgres://ada:legacy%40password@db.example.com:5432/shop?sslmode=verify-full";
  assert.equal(await vault.save(legacyReference, "postgres://ada@db.example.com/shop?sslmode=verify-full", source), true);
  const before = keyring.values.get(`works.earendil.pylon.stateql\0${legacyReference}`);
  assert.equal(await vault.resolvePassword(legacyReference, "postgres://ada@db.example.com:5432/shop?sslmode=disable"), "legacy@password");
  assert.equal(await vault.resolvePassword(legacyReference, "postgres://ada@other.example.com:5432/shop?sslmode=disable"), undefined);
  assert.equal(keyring.values.get(`works.earendil.pylon.stateql\0${legacyReference}`), before);
});

test("OS credential vault fails closed for v2 cancellation and forget", async () => {
  const keyring = fakeKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const reference = createStateQLCredentialReference();
  const target = "redis://ada@cache.example.com:6379/0";

  assert.equal(await vault.savePassword(reference, target, "secret"), true);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await vault.savePassword(reference, target, "replacement", cancelled.signal), false);
  assert.equal(await vault.resolvePassword(reference, target, cancelled.signal), undefined);
  assert.equal(await vault.invalidate(reference, cancelled.signal), false);
  assert.equal(await vault.forget(reference, cancelled.signal), false);
  assert.equal(await vault.resolvePassword(reference, target), "secret");
  assert.equal(await vault.forget(reference), true);
  assert.equal(await vault.resolvePassword(reference, target), undefined);
});
