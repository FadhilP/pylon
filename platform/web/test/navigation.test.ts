import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

/**
 * The surface handoff is the one piece of navigation with a rule you cannot
 * read off the registries: a surface that fills the main area displaces the
 * conversation into the reference rail, and coming back returns the rail to
 * whatever it was showing — unless you chose something else while it was
 * docked, in which case your choice stands.
 */
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });

test("navigation", async t => {
  const navigation = await vite.ssrLoadModule("/src/client/navigation.ts");
  const { REFERENCES, SURFACES, displacesConversation, referenceRailItems, surfaceDefinition } = navigation;

  const context = (over: Record<string, unknown> = {}) => ({
    surface: "chat",
    stateqlEnabled: true,
    browserAvailable: true,
    browserActive: false,
    timelineEnabled: true,
    memoryEnabled: true,
    papercutEnabled: false,
    ...over,
  });

  await t.test("only the chat surface leaves the conversation in the main area", () => {
    assert.equal(displacesConversation("chat"), false);
    for (const surface of SURFACES.filter((item: { id: string }) => item.id !== "chat"))
      assert.equal(displacesConversation(surface.id), true, `${surface.id} should displace`);
  });

  await t.test("the docked conversation appears in the rail only while displaced", () => {
    const labels = (surface: string) =>
      referenceRailItems(context({ surface }))
        .filter(Boolean)
        .map((item: { id: string }) => item.id);
    assert.ok(!labels("chat").includes("chat"), "chat surface should not offer a docked chat");
    assert.ok(labels("files").includes("chat"), "a displacing surface should offer it");
    assert.equal(labels("files")[0], "chat", "and offer it first");
  });

  await t.test("changes is not offered on the surface that already lists them", () => {
    const ids = (surface: string) =>
      referenceRailItems(context({ surface }))
        .filter(Boolean)
        .map((item: { id: string }) => item.id);
    assert.ok(ids("chat").includes("changes"));
    assert.ok(!ids("files").includes("changes"), "the Files explorer lists them inline");
    assert.ok(ids("database").includes("changes"));
  });

  await t.test("a reference the packages do not provide is not offered", () => {
    const ids = (over: Record<string, unknown>) =>
      referenceRailItems(context(over))
        .filter(Boolean)
        .map((item: { id: string }) => item.id);
    assert.ok(!ids({ timelineEnabled: false }).includes("timeline"));
    assert.ok(!ids({ memoryEnabled: false, papercutEnabled: false }).includes("memory"));
    assert.ok(ids({ memoryEnabled: false, papercutEnabled: true }).includes("memory"));
  });

  await t.test("a surface the packages do not provide is not offered", () => {
    assert.equal(
      SURFACES.find((item: { id: string }) => item.id === "database").available(context({ stateqlEnabled: false })),
      false,
    );
    assert.equal(
      SURFACES.find((item: { id: string }) => item.id === "browser").available(context({ browserAvailable: false })),
      false,
    );
  });

  await t.test("rail groups are separated exactly once each", () => {
    const items = referenceRailItems(context({ surface: "files" }));
    const dividers = items.filter((item: unknown) => item === null).length;
    const groups = new Set(REFERENCES.map((item: { group: string }) => item.group));
    assert.equal(dividers, groups.size - 1, "one hairline between each pair of groups");
    assert.notEqual(items[0], null, "never a leading hairline");
    assert.notEqual(items.at(-1), null, "never a trailing hairline");
  });

  await t.test("an unknown surface falls back rather than throwing", () => {
    assert.equal(surfaceDefinition("nope").id, "chat");
  });
});

test.after(() => vite.close());
