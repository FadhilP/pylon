import test from "node:test";
import assert from "node:assert/strict";
import {
  definePackageSettings,
  effectivePackageSettingValue,
  effectivePackageSettingsReadModel,
  extractPackageSettingsUpdate,
  parsePackageSettingValue,
  validPackageSettingValue,
  type PackageSettingField,
} from "../src/package-settings.ts";

const fields: PackageSettingField[] = [
  { version: 1, key: "enabled", label: "Enabled", type: "boolean", defaultValue: false, env: "ENABLED", apply: "immediate" },
  { version: 1, key: "turns", label: "Turns", type: "integer", defaultValue: 4, min: 1, max: 10, env: "TURNS", apply: "next-operation" },
  { version: 1, key: "cost", label: "Cost", type: "number", defaultValue: 1, min: 0.1, max: 10, apply: "next-operation" },
  { version: 1, key: "mode", label: "Mode", type: "enum", defaultValue: "safe", choices: ["safe", "fast"], apply: "next-session" },
  {
    version: 1,
    key: "tags",
    label: "Tags",
    type: "string-list",
    defaultValue: ["one"],
    choices: ["one", "two"],
    min: 1,
    max: 2,
    env: "TAGS",
    apply: "immediate",
  },
];

const descriptor = definePackageSettings({ version: 1, packageId: "pi-example", fields });

test("package setting descriptors parse bounded primitive environment values", () => {
  assert.equal(parsePackageSettingValue(fields[0]!, "1"), true);
  assert.equal(parsePackageSettingValue(fields[1]!, "10"), 10);
  assert.equal(parsePackageSettingValue(fields[2]!, "1.25"), 1.25);
  assert.equal(parsePackageSettingValue(fields[3]!, "fast"), "fast");
  assert.deepEqual(parsePackageSettingValue(fields[4]!, "one, two"), ["one", "two"]);
  assert.equal(parsePackageSettingValue(fields[1]!, "11"), undefined);
  assert.equal(parsePackageSettingValue(fields[2]!, "NaN"), undefined);
  assert.equal(parsePackageSettingValue(fields[4]!, "one,one"), undefined);
});

test("persisted package values override environment fallbacks and invalid values are rejected", () => {
  const turns = fields[1]!;
  assert.equal(effectivePackageSettingValue(turns, 7, { TURNS: "3" }), 7);
  assert.equal(effectivePackageSettingValue(turns, undefined, { TURNS: "3" }), 3);
  assert.equal(effectivePackageSettingValue(turns, undefined, {}), 4);
  assert.throws(() => effectivePackageSettingValue(turns, undefined, { TURNS: "0" }), /invalid/);
  assert.throws(() => effectivePackageSettingValue(turns, 0, { TURNS: "3" }), /invalid/);
  assert.equal(validPackageSettingValue(turns, 1), true);
  assert.equal(validPackageSettingValue(turns, "1"), false, "stored config must retain primitive number types");
});

test("generic read models resolve persisted values, environment fallbacks, and defaults without exposing env names", () => {
  const model = effectivePackageSettingsReadModel(descriptor, { enabled: true, mode: "fast" }, { TURNS: "7", TAGS: "two" });
  assert.equal(model.kind, "generic");
  assert.equal(model.packageId, "pi-example");
  assert.deepEqual(
    Object.fromEntries(model.fields.map(field => [field.key, field.value])),
    { enabled: true, turns: 7, cost: 1, mode: "fast", tags: ["two"] },
  );
  assert.equal("env" in model.fields[0]!, false);
});

test("generic updates extract only values validated by the authoritative descriptor", () => {
  const current = effectivePackageSettingsReadModel(descriptor, {}, {});
  const update = {
    ...current,
    fields: current.fields.map(field => (field.key === "cost" ? { ...field, value: 1.5, max: 999 } : field)),
  };
  assert.deepEqual(extractPackageSettingsUpdate(descriptor, update), {
    enabled: false,
    turns: 4,
    cost: 1.5,
    mode: "safe",
    tags: ["one"],
  });
  assert.throws(
    () => extractPackageSettingsUpdate(descriptor, { ...update, packageId: "pi-other" }),
    /invalid generic/,
  );
  assert.throws(
    () => extractPackageSettingsUpdate(descriptor, { ...update, fields: update.fields.filter(field => field.key !== "mode") }),
    /invalid generic/,
  );
  assert.throws(
    () =>
      extractPackageSettingsUpdate(descriptor, {
        ...update,
        fields: update.fields.map(field => (field.key === "turns" ? { ...field, value: 11 } : field)),
      }),
    /invalid value/,
  );
});
