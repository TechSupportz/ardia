import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { useBrowser } from "../store/browser.ts";
import { inPinnedContainer } from "../store/model.ts";

const worker = `
import { readFileSync } from "node:fs";
import { useBrowser } from "./src/store/browser.ts";
import { pinKeyOf } from "./src/store/pinMirror.ts";
import { inPinnedContainer } from "./src/store/model.ts";
import { pinnedAdapter, pinnedGroupHomesAdapter } from "./src/sync/adapters.ts";
import { startPersistence, flushPersistence } from "./src/lib/persist.ts";
import { docs } from "./src/test-native-stub.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
if (input.session) docs.set("session.json", input.session);
const stop = startPersistence();
const S = () => useBrowser.getState();
const homes = pinnedGroupHomesAdapter("default");
const live = input.variant === "empty" ? "" : "https://docs.example/deep";
if (!input.session) {
  const w = S().createWindow({ url: "https://control.example/" });
  if (input.variant === "local") {
    const id = S().newTab(w, { url: live });
    S().groupTabs([id], { pinned: true, name: "Docs" });
    S().updateTab(id, { pinnedUrl: null });
  } else {
    if (input.variant === "repin") {
      const id = S().newTab(w, { url: live });
      S().updateTab(id, { pinKey: "remote-member", unloaded: undefined });
    }
    const visible = new Map([
      ["pin:g:remote-group", { n: "Docs", i: null, c: "blue", pos: "a0" }],
      ["pin:t:remote-member", { g: "remote-group", u: live, ti: "Deep", t: null, i: null, pos: "a0" }],
    ]);
    pinnedAdapter("default").apply(visible, new Set(visible.keys()), () => undefined, { known: () => true, now: 1000, horizon: 1000 });
    if (input.variant === "mirror") {
      S().createWindow({ url: "https://other.example/" });
      S().closeWindow(w);
    }
    if (["park", "adopt"].includes(input.variant)) S().closeWindow(w);
    if (input.variant === "adopt") S().createWindow({ url: "https://adopt.example/" });
  }
}
if (["authoritative", "same"].includes(input.action)) {
  const visible = new Map([["pgh:remote-member", input.action === "same" ? live : "https://docs.example/"]]);
  homes.apply(visible, new Set(visible.keys()));
}
if (input.action === "edit") {
  const t = Object.values(S().tabs).find(t => inPinnedContainer(S(), t.id));
  S().setPinnedUrl(t.id, t.pinnedUrl);
}
if (input.action === "adopt") S().createWindow({ url: "https://reopen.example/" });
S().updateSettings({ tabLayout: S().settings.tabLayout });
const extraction = homes.extract(() => undefined, () => false, 1000, () => true, () => ({ g: "remote-group" }));
flushPersistence();
const result = {
  exported: [...extraction.values],
  members: Object.values(S().tabs).filter(t => inPinnedContainer(S(), t.id)).map(t => ({ key: pinKeyOf(t), home: t.pinnedUrl })),
  session: docs.get("session.json"),
};
stop();
process.stdout.write(JSON.stringify(result));
`;

const run = (input) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--input-type=module", "-e", worker], { input: JSON.stringify(input), encoding: "utf8", timeout: 20000 }));

for (const variant of ["open", "repin", "mirror", "park", "adopt", "empty"]) {
  test(`incomplete remote home stays local across a fresh process: ${variant}`, () => {
    const first = run({ variant });
    assert.deepEqual(first.exported, [], "receiving a remote live URL must not manufacture a home");
    const restarted = run({ session: first.session });
    assert.deepEqual(restarted.exported, [], "restart must not publish the guess");
    const delivered = run({ session: first.session, action: "authoritative" });
    assert.deepEqual(delivered.exported, [["pgh:remote-member", "https://docs.example/"]]);
    const adopted = run({ session: delivered.session, action: variant === "park" ? "adopt" : undefined });
    assert.ok(adopted.members.some(t => t.key === "remote-member" && t.home === "https://docs.example/"));
  });
}

test("delivery equal to the guess and explicit acceptance both make a home authoritative", () => {
  const first = run({ variant: "repin" });
  for (const action of ["same", "edit"]) {
    const accepted = run({ session: first.session, action });
    assert.deepEqual(accepted.exported, [["pgh:remote-member", "https://docs.example/deep"]]);
    assert.deepEqual(run({ session: accepted.session }).exported, accepted.exported);
  }
});

test("old local groups still initialize and publish their first home", () => {
  const first = run({ variant: "local" });
  assert.equal(first.exported.length, 1);
  assert.equal(first.exported[0][1], "https://docs.example/deep");
  assert.deepEqual(run({ session: first.session }).exported, first.exported);
});

test("the actual menu gate includes blank pinned tabs and excludes ordinary tabs", () => {
  const source = ts.createSourceFile("menus.ts", readFileSync(new URL("../components/sidebar/menus.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let gate;
  const visit = (node) => {
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(source).includes('id: "pinnedPage"')) gate = node.condition.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(gate);
  const included = new Function("s", "tab", "inPinnedContainer", `return !!(${gate})`);
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({});
  const id = useBrowser.getState().newTab(w, {});
  assert.equal(included(useBrowser.getState(), useBrowser.getState().tabs[id], inPinnedContainer), false);
  useBrowser.getState().pinTabs([id], true);
  assert.equal(useBrowser.getState().tabs[id].pinnedUrl, null);
  assert.equal(included(useBrowser.getState(), useBrowser.getState().tabs[id], inPinnedContainer), true);
  useBrowser.getState().placeTabs([id], { pinned: true, row: true });
  assert.equal(included(useBrowser.getState(), useBrowser.getState().tabs[id], inPinnedContainer), true);
  useBrowser.getState().groupTabs([id], { pinned: true, name: "Blank" });
  assert.equal(included(useBrowser.getState(), useBrowser.getState().tabs[id], inPinnedContainer), true);
});
