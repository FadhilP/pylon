import test from "node:test";
import assert from "node:assert/strict";
import { validPackageSettings } from "../src/shared/protocol/validation.ts";

const promptSettings = {
  kind: "generic",
  packageId: "pi-prompt-example",
  fields: [
    {
      version: 1,
      key: "instructions",
      label: "Instructions",
      type: "prompt",
      defaultValue: { mode: "default", text: "" },
      value: { mode: "append", text: "😀" },
      allowedModes: ["default", "append"],
      maxBytes: 4,
      apply: "next-operation",
    },
  ],
};

test("generic prompt snapshots validate mode authorization, default clearing, and UTF-8 limits", () => {
  assert.equal(validPackageSettings(promptSettings), true);
  assert.equal(
    validPackageSettings({
      ...promptSettings,
      fields: [{ ...promptSettings.fields[0], value: { mode: "replace", text: "override" } }],
    }),
    false,
  );
  assert.equal(
    validPackageSettings({
      ...promptSettings,
      fields: [{ ...promptSettings.fields[0], value: { mode: "default", text: "stale" } }],
    }),
    false,
  );
  assert.equal(
    validPackageSettings({
      ...promptSettings,
      fields: [{ ...promptSettings.fields[0], value: { mode: "append", text: "😀a" } }],
    }),
    false,
  );
});
