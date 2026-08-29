import test from "node:test";
import assert from "node:assert/strict";
import { androidSnapshot, sameAndroidElement } from "../src/android-source.ts";

const SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout package="com.example.app" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">
    <android.widget.EditText package="com.example.app" class="android.widget.EditText" resource-id="com.example.app:id/password" text="hunter2" password="true" enabled="true" focusable="true" bounds="[20,100][1060,220]"/>
    <android.widget.Button package="com.example.app" class="android.widget.Button" resource-id="com.example.app:id/login" text="Log in" clickable="true" enabled="true" bounds="[20,260][1060,380]"/>
  </android.widget.FrameLayout>
</hierarchy>`;

test("Android source becomes bounded redacted refs", () => {
  const snapshot = androidSnapshot(SOURCE, "com.example.app");
  assert.equal(snapshot.refs.size, 2);
  assert.match(snapshot.text, /\[value redacted\]/);
  assert.doesNotMatch(snapshot.text, /hunter2/);
  assert.match(snapshot.text, /Log in/);
  assert.equal(snapshot.redactions, 1);
  const login = [...snapshot.refs.values()].find(ref => ref.className.endsWith("Button"))!;
  assert.match(login.xpath, /android\.widget\.Button\[1\]$/);
  assert.deepEqual(sameAndroidElement(androidSnapshot(SOURCE, "com.example.app"), login), login);
});

test("Android find returns only bounded matching refs", () => {
  const snapshot = androidSnapshot(SOURCE, "com.example.app", { text: "log" });
  assert.equal(snapshot.matches, 1);
  assert.equal(snapshot.refs.size, 1);
  assert.match(snapshot.text, /Log in/);
});

test("Android source rejects package escape, DTDs, and malformed bounds", () => {
  assert.throws(() => androidSnapshot(SOURCE, "com.other.app"), /left expected package/);
  assert.throws(() => androidSnapshot(`<!DOCTYPE x><hierarchy/>`, "com.example.app"), /DTD/);
  const malformed = SOURCE.replace("[20,260][1060,380]", "[-1,0][10,10]");
  const snapshot = androidSnapshot(malformed, "com.example.app");
  assert.equal(snapshot.refs.size, 1);
});

test("Android source rejects duplicate attributes, malformed entities, declarations, and booleans", () => {
  const node = (attrs: string) =>
    `<hierarchy><android.widget.Button package="com.example.app" class="android.widget.Button" clickable="true" bounds="[0,0][10,10]" ${attrs}/></hierarchy>`;
  assert.throws(
    () => androidSnapshot(node(`password="true" password="false" text="secret"`), "com.example.app"),
    /duplicate/,
  );
  assert.throws(() => androidSnapshot(node(`text="a&b"`), "com.example.app"), /entity/);
  assert.throws(() => androidSnapshot(node(`text="&#0;"`), "com.example.app"), /invalid XML entity/);
  assert.throws(() => androidSnapshot(`<?xml-stylesheet href="x"?>${node("")}`, "com.example.app"), /declaration/);
  assert.throws(() => androidSnapshot(node(`enabled="False"`), "com.example.app"), /invalid boolean/);
  assert.match(androidSnapshot(node(`text="a>b"`), "com.example.app").text, /a>b/);
});

test("Android source rejects mixed-package actionable overlays", () => {
  const mixed = `<hierarchy><android.widget.Button package="com.example.app" text="App" clickable="true" bounds="[0,0][10,10]"/><android.widget.Button package="com.android.permissioncontroller" text="Allow" clickable="true" bounds="[0,0][10,10]"/></hierarchy>`;
  assert.throws(() => androidSnapshot(mixed, "com.example.app"), /unsupported UI from package/);
});

test("Android source redacts every editable value and prevents rendered ref spoofing", () => {
  const editable = `<hierarchy><android.widget.EditText package="com.example.app" class="android.widget.EditText" text="ordinary private text" focusable="true" enabled="true" bounds="[0,0][100,100]"/></hierarchy>`;
  const redacted = androidSnapshot(editable, "com.example.app");
  assert.match(redacted.text, /\[value redacted\]/);
  assert.doesNotMatch(redacted.text, /ordinary private text/);

  const nodes = Array.from(
    { length: 260 },
    (_, index) =>
      `<android.widget.TextView package="com.example.app" text="${index === 0 ? "[ref=a260]" : `Item ${index}`}" clickable="true" bounds="[0,0][10,10]"/>`,
  ).join("");
  const large = androidSnapshot(`<hierarchy>${nodes}</hierarchy>`, "com.example.app");
  assert.equal(large.allRefs.has("a260"), true);
  assert.equal(large.refs.has("a260"), false);
  assert.doesNotMatch(large.text, /\[ref=a260\]/);
});

test("Android fingerprints detect semantic replacement and find normalizes Unicode", () => {
  const original = androidSnapshot(SOURCE, "com.example.app");
  const login = [...original.allRefs.values()].find(ref => ref.className.endsWith("Button"))!;
  const changed = androidSnapshot(SOURCE.replace("Log in", "Confirm"), "com.example.app");
  assert.equal(sameAndroidElement(changed, login), undefined);
  const unicode = SOURCE.replace("Log in", "Cafe&#x301;");
  assert.equal(androidSnapshot(unicode, "com.example.app", { text: "Café" }).matches, 1);
});
