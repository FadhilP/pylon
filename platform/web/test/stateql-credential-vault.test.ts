import test from "node:test";
import assert from "node:assert/strict";
import {
  createStateQLCredentialReference,
  isStateQLCredentialReference,
  OsStateQLCredentialVault,
  stateqlCredentialFingerprint,
  type KeyringEntryFactory,
} from "../src/server/pi/stateql-credential-vault.ts";

function fakeKeyring(values = new Map<string, string>()): {
  values: Map<string, string>;
  entry: KeyringEntryFactory;
} {
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
  assert.equal(
    await vault.resolve(reference, "postgres://ada@db.example.com:5432/shop?sslmode=disable"),
    undefined,
  );
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
