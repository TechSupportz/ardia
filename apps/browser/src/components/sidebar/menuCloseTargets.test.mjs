import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { useBrowser } from "../../store/browser.ts";
import * as model from "../../store/model.ts";
import { awayFromPin, groupOf, selectedTabIds } from "../../store/organize.ts";
import { splitOf, splitRowPanes } from "../../store/splits.ts";

const source = ts.createSourceFile("menus.ts", readFileSync(process.env.ARDIA_MENU_TEST_SOURCE ?? new URL("./menus.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const menu = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "openTabMenu");
const body = ts.transpileModule(menu.getText(source).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const S = () => useBrowser.getState();

function openMenu(showMenu) {
  const context = {
    ...model,
    store: S,
    awayFromPin,
    groupOf,
    selectedTabIds,
    splitOf,
    splitRowPanes,
    showMenu,
    sep: { separator: true },
    hint: () => ({}),
    canShare: () => false,
    isCalendarUrl: () => false,
    canSwitchEngine: () => false,
    moveToGroupItems: () => [],
    moveToWindowItems: () => [],
    runCalendarMenu: () => false,
  };
  return new Function(...Object.keys(context), `${body}\nreturn openTabMenu;`)(...Object.values(context));
}

for (const action of ["closeAbove", "closeOthers"]) {
  test(`${action} through the actual menu preserves pinned pages and closes exactly the eligible regular tabs`, async () => {
    S().hydrate({});
    const w = S().createWindow({ url: "https://control.example/" });
    const control = S().windows[w].tabIds[0];
    const member = S().newTab(w, { url: "https://member.example/home" });
    S().groupTabs([member], { pinned: true, name: "Pinned" });
    S().navigated(member, { url: "https://member.example/deep", title: "Deep" }, { isLoading: false });
    const tile = S().newTab(w, { url: "https://tile.example/", pinned: true });
    const row = S().newTab(w, { url: "https://row.example/" });
    S().pinTabs([row], true, true);
    const selected = S().newTab(w, { url: "https://selected.example/" });
    const below = S().newTab(w, { url: "https://below.example/" });
    const before = [member, tile, row].map((id) => S().tabs[id]);
    const close = openMenu(async (items) => {
      const entry = items.find((item) => item.id === "closeMore")?.children.find((item) => item.id === action);
      assert.equal(entry?.enabled, true);
      return action;
    });
    await close(w, S().tabs[selected]);
    for (const old of before) {
      const current = S().tabs[old.id];
      assert.ok(current);
      assert.equal(current.url, old.url, `${action} changed a pinned page`);
      assert.equal(current.navigation, old.navigation, `${action} unloaded a pinned page`);
    }
    assert.ok(S().tabs[selected]);
    assert.equal(S().tabs[control], undefined);
    assert.equal(!!S().tabs[below], action === "closeAbove");
  });
}

test("the actual menu exposes Edit Pinned Page for blank pins and no bulk-close targets when only pins remain", async () => {
  S().hydrate({});
  const w = S().createWindow({});
  const id = S().newTab(w, {});
  let items;
  const show = openMenu(async (menu) => { items = menu; return null; });
  await show(w, S().tabs[id]);
  assert.equal(items.some((item) => item.id === "pinnedPage"), false);
  S().pinTabs([id], true);
  await show(w, S().tabs[id]);
  assert.equal(items.some((item) => item.id === "pinnedPage"), true);
  S().placeTabs([id], { pinned: true, row: true });
  await show(w, S().tabs[id]);
  assert.equal(items.some((item) => item.id === "pinnedPage"), true);
  S().groupTabs([id], { pinned: true, name: "Blank" });
  await show(w, S().tabs[id]);
  assert.equal(items.some((item) => item.id === "pinnedPage"), true);
  const regular = S().newTab(w, { url: "https://only-regular.example/" });
  for (const other of model.viewTabIds(S(), w).filter((key) => key !== regular && !model.inPinnedContainer(S(), key))) S().closeTabs([other]);
  await show(w, S().tabs[regular]);
  const bulk = items.find((item) => item.id === "closeMore");
  assert.equal(bulk.enabled, false);
  assert.ok(bulk.children.every((item) => item.enabled === false));
});
