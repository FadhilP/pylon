import test from "node:test";
import assert from "node:assert/strict";

test("copyText reports clipboard success and rejection", async () => {
  const { copyText } = await import(new URL("../src/client/clipboard.ts", import.meta.url).href);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes: string[] = [];
  let reject = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (value: string) => {
      if (reject) throw new Error("denied");
      writes.push(value);
    } } },
  });

  try {
    assert.equal(await copyText("first"), true);
    assert.deepEqual(writes, ["first"]);
    reject = true;
    assert.equal(await copyText("second"), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

