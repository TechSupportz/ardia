#!/usr/bin/env node
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, "evidence");
mkdirSync(evidence, { recursive: true });
const pageUrl = pathToFileURL(join(here, "index.html")).href;
const VARIANTS = [
  { v: 1, kind: "seamless", name: "Seamless", scrim: true },
  { v: 2, kind: "little", name: "Little Window", scrim: false },
  { v: 3, kind: "genie", name: "Genie", scrim: true },
];
const BUDGET_MS = 300 + 17;
const REDUCED_BUDGET_MS = 150 + 34;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(p)) return p;
  }
  return undefined;
}

const results = [];
const errors = [];
let failed = 0;
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail ?? null });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${group} :: ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
}

function watch(page, label) {
  page.on("console", (m) => m.type() === "error" && errors.push({ label, text: m.text() }));
  page.on("pageerror", (e) => errors.push({ label, text: String(e) }));
}

const phase = (page) => page.locator(".win").getAttribute("data-peek");
const waitPhase = (page, want, timeout = 2000) =>
  page.waitForFunction((w) => document.querySelector(".win")?.dataset.peek === w, want, { timeout });

async function spans(page, from, to) {
  return page.evaluate(([f, t]) => {
    const log = window.__peekLog;
    const out = [];
    for (let i = 0; i < log.length; i++) {
      if (log[i].phase !== f) continue;
      const end = log.slice(i + 1).find((e) => e.phase === t || e.phase === "closed" || e.phase === f);
      if (end && end.phase === t) out.push(Math.round(end.t - log[i].t));
    }
    return out;
  }, [from, to]);
}

async function load(page, v) {
  await page.goto(`${pageUrl}?v=${v}`);
  await page.waitForSelector(".win");
  await waitPhase(page, "open").catch(async (e) => {
    throw new Error(`load v=${v}: ${JSON.stringify(await page.evaluate(() => window.__peekLog))} ${e.message}`);
  });
}

async function pinch(page, deltas, at) {
  const box = at ?? (await page.locator(".pk").boundingBox());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const dpr = await page.evaluate(() => devicePixelRatio);
  await page.keyboard.down("Control");
  for (const d of deltas) {
    await page.mouse.wheel(0, d * dpr);
    await page.waitForTimeout(16);
  }
  await page.keyboard.up("Control");
}

const tabCount = (page) => page.locator(".tab").count();
const activeRows = (page) => page.locator('.tab[aria-current="page"]').evaluateAll((els) => els.map((e) => e.dataset.tab));
const contentTitle = (page) => page.locator(".scroller h1").innerText();

async function sampleMotion(page, ms) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const frames = [];
    const start = performance.now();
    const tick = () => {
      const card = document.querySelector(".pk");
      const strips = [...document.querySelectorAll(".gn-strip")];
      if (card) {
        const r = (strips[0] ?? card).getBoundingClientRect();
        frames.push({
          t: performance.now() - start,
          ow: card.offsetWidth, oh: card.offsetHeight,
          rw: r.width, rh: r.height,
          transform: getComputedStyle(card).transform,
          strips: strips.map((e, i) => { const b = e.getBoundingClientRect(); return { w: b.width, cy: b.top + (b.height * (i + 0.5)) / strips.length }; }),
          rows: [...document.querySelectorAll(".tab")].map((e) => e.style.transform || ""),
        });
      }
      if (performance.now() - start < duration) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  }), ms);
}

async function restTransform(page, kind) {
  return page.evaluate((k) => {
    const card = document.querySelector(".pk");
    if (!card) return { missing: true };
    const m = new DOMMatrix(getComputedStyle(card).transform);
    return { identity: Math.abs(m.a - 1) < 1e-3 && Math.abs(m.d - 1) < 1e-3 && Math.abs(m.e) < 0.5 && Math.abs(m.f) < 0.5, animating: card.hasAttribute("data-animating"), strips: document.querySelectorAll(".gn-strip").length, kind: k };
  }, kind);
}

async function runVariant(browser, variant) {
  const g = variant.name;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  watch(page, g);
  await load(page, variant.v);
  check(g, "auto-open reaches open", (await phase(page)) === "open");
  const openSpans = await spans(page, "opening", "open");
  check(g, "F10 open settles under 300 ms", openSpans.length && Math.max(...openSpans) <= BUDGET_MS, openSpans);
  await page.screenshot({ path: join(evidence, `${variant.kind}-1-open.png`) });

  await page.keyboard.press("Escape");
  await waitPhase(page, "closed");
  const closeSpans = await spans(page, "closing", "closed");
  check(g, "F10 Esc close under 300 ms", closeSpans.length && Math.max(...closeSpans) <= BUDGET_MS, closeSpans);
  await page.keyboard.press("Escape");
  check(g, "F7 Esc with nothing open is harmless", (await phase(page)) === "closed" && (await page.locator(".pk").count()) === 0);

  const top = page.locator('.scroller a[data-peek="webkit"]');
  const bottom = page.locator('.scroller a[data-peek="genie"]');
  await top.click();
  const openFrames = await sampleMotion(page, 320);
  const sizes = new Set(openFrames.map((f) => `${f.ow}x${f.oh}`));
  const rectWidths = openFrames.map((f) => Math.round(f.rw));
  check(g, "F9 open animates transform, not layout", sizes.size === 1 && Math.max(...rectWidths) - Math.min(...rectWidths) > 4, { layoutSizes: [...sizes], rectMin: Math.min(...rectWidths), rectMax: Math.max(...rectWidths) });
  await waitPhase(page, "open");
  if (variant.kind === "genie") {
    for (const [label, link] of [["mid-page", top], ["bottom", bottom]]) {
      await page.keyboard.press("Escape");
      await waitPhase(page, "closed");
      await link.scrollIntoViewIfNeeded();
      const lb = await link.boundingBox();
      const linkY = lb.y + lb.height / 2;
      await link.click();
      const frames = await sampleMotion(page, 320);
      const mid = frames.find((f) => f.strips.length && f.t > 30);
      const near = mid && mid.strips.reduce((a, b) => (Math.abs(b.cy - linkY) < Math.abs(a.cy - linkY) ? b : a));
      const far = mid && mid.strips.reduce((a, b) => (Math.abs(b.cy - linkY) > Math.abs(a.cy - linkY) ? b : a));
      check(g, `F11 ${label} link: strip nearest the link lags (narrower) mid-open`, near && near.w < far.w - 4, { linkY: Math.round(linkY), near: near && Math.round(near.w), far: far && Math.round(far.w) });
      await waitPhase(page, "open");
    }
  }

  const body = page.locator(".pk .pk-view");
  await body.click({ position: { x: 60, y: 60 } });
  check(g, "F17 clicking inside the card keeps it open", (await phase(page)) === "open");

  if (variant.scrim) {
    const content = await page.locator(".content").boundingBox();
    await page.mouse.click(content.x + 6, content.y + content.height / 2);
    await waitPhase(page, "closed");
    check(g, "F5 scrim click closes", (await page.locator(".pk").count()) === 0);
  } else {
    const content = await page.locator(".content").boundingBox();
    await page.mouse.click(content.x + 30, content.y + content.height - 30);
    check(g, "page behind stays usable; outside click keeps the window", (await phase(page)) === "open");
    await page.locator('.pk [data-act="close"]').click();
    await waitPhase(page, "closed");
    check(g, "F5 close button closes", (await page.locator(".pk").count()) === 0);
  }

  await top.click();
  await waitPhase(page, "open");
  await pinch(page, [-10, -10]);
  await page.waitForTimeout(200);
  const pinchLog = await page.evaluate(() => window.__peekLog.map((e) => e.phase));
  check(g, "F1 ctrl-wheel pinches the Peek, page doesn't zoom", pinchLog.includes("pinch") && (await page.evaluate(() => visualViewport.scale)) === 1);
  await waitPhase(page, "open");
  await page.waitForTimeout(40);
  const rest = await restTransform(page, variant.kind);
  check(g, "F2 below-threshold pinch springs back to rest", rest.identity && !rest.animating && rest.strips === 0, rest);
  check(g, "F13 ctrl held never flips the variant", new URL(page.url()).searchParams.get("v") === String(variant.v));
  await page.keyboard.press("Control+2");
  check(g, "F13 ctrl+number ignored by picker", new URL(page.url()).searchParams.get("v") === String(variant.v));

  await pinch(page, [10, 10, 10]);
  await waitPhase(page, "closed");
  check(g, "F5 pinch-in closes", (await page.locator(".pk").count()) === 0);

  await top.click();
  await page.waitForTimeout(60);
  await pinch(page, [-6, -6]);
  const f16 = await sampleMotion(page, 120);
  check(g, "F16 pinch during open keeps the card (no reset, no error)", f16.length > 0 && (await page.locator(".pk").count()) === 1);
  await waitPhase(page, "open");

  let peekScroll = 0;
  if (variant.kind === "seamless") {
    peekScroll = await page.evaluate(() => {
      const sheet = document.querySelector(".pk-sheet");
      sheet.scrollTop = 180;
      return sheet.scrollTop;
    });
  }
  const before = await tabCount(page);
  const peekTitle = await page.locator(".pk h1").first().innerText();
  await pinch(page, [-10, -10, -10, -10, -10]);
  await page.waitForTimeout(175);
  await page.keyboard.down("Control");
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");
  await page.waitForFunction(() => window.__peekLog.some((e) => e.phase === "promoted"), null, { timeout: 2000 });
  await page.waitForTimeout(260);
  check(g, "F3 one pinch promotes exactly once", (await tabCount(page)) === before + 1, { before, after: await tabCount(page) });
  const active = await activeRows(page);
  check(g, "F4 the new tab is the only active row", active.length === 1 && active[0].startsWith("n"), active);
  check(g, "F4 content shows the promoted page", (await contentTitle(page)) === peekTitle, { peekTitle });
  const promoteSpans = await spans(page, "promoting", "promoted");
  check(g, "F10 pinch promote under 300 ms", promoteSpans.length && Math.max(...promoteSpans) <= BUDGET_MS, promoteSpans);
  if (variant.kind === "seamless") {
    const after = await page.evaluate(() => document.querySelector(".scroller").scrollTop);
    check(g, "F19 scroll position carries into the tab", peekScroll > 0 && Math.abs(after - peekScroll) <= 2, { peekScroll, after });
  }
  await page.screenshot({ path: join(evidence, `${variant.kind}-2-after-pinch-promote.png`) });

  await page.locator('.tab[data-tab="t1"]').click();
  await bottom.click();
  const promoteFrames = [];
  await waitPhase(page, "open");
  const promoteBtn = page.getByRole("button", { name: "Open as Tab" });
  check(g, "promote button is reachable by accessible name", (await promoteBtn.count()) >= 1);
  const sampling = sampleMotion(page, 330);
  await promoteBtn.first().click();
  promoteFrames.push(...(await sampling));
  await page.waitForFunction(() => window.__peekLog.filter((e) => e.phase === "promoted").length >= 2, null, { timeout: 2000 });
  await page.waitForTimeout(220);
  const sizesP = new Set(promoteFrames.map((f) => `${f.ow}x${f.oh}`));
  check(g, "F9 promote animates transform, not layout", sizesP.size <= 1, [...sizesP]);
  const active2 = await activeRows(page);
  check(g, "button promote: new tab active, 5 tabs", (await tabCount(page)) === 5 && active2.length === 1 && active2[0].startsWith("n"), active2);
  await page.screenshot({ path: join(evidence, `${variant.kind}-3-after-button-promote.png`) });

  await page.locator('.tab[data-tab="t1"]').click();
  await top.click();
  await waitPhase(page, "open");
  await page.locator('.tab[data-tab="t2"]').click();
  const a3 = await activeRows(page);
  check(g, "F18 switching tabs closes the Peek and activates that row", (await page.locator(".pk").count()) === 0 && a3.length === 1 && a3[0] === "t2", a3);

  await page.locator('.tab[data-tab="t1"]').click();
  await top.click();
  await waitPhase(page, "open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
  await page.locator('.scroller a[data-peek="motion"]').click();
  check(g, "F12 clicking during close leaves exactly one card", (await page.locator(".pk").count()) === 1);
  await waitPhase(page, "open");

  if (variant.kind === "little") {
    await page.locator('.pk [data-act="copy"]').click();
    await page.waitForTimeout(80);
    const tip = await page.locator(".copied-tip").innerText();
    check(g, "F15 Copy Link gives feedback", tip === "Copied", tip);
    const bar = await page.locator(".pk .lw-field").boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + 3000, bar.y + 3000, { steps: 6 });
    await page.mouse.up();
    const win = await page.locator(".win").boundingBox();
    const card = await page.locator(".pk").boundingBox();
    check(g, "F14 drag stays inside the window", card.x >= win.x && card.y >= win.y && card.x + card.width <= win.x + win.width + 0.5 && card.y + card.height <= win.y + win.height + 0.5, { win, card });
    await page.screenshot({ path: join(evidence, `little-4-dragged.png`) });
  }

  await page.reload();
  await page.waitForSelector(".win");
  await page.waitForTimeout(360);
  await page.keyboard.press("r");
  await page.waitForSelector(".win");
  await waitPhase(page, "open");
  check(g, "F6 replay mid-open resets the scene", (await tabCount(page)) === 3 && (await page.locator(".pk").count()) === 1);
  await page.locator('.pk [data-act="promote"]').first().click();
  await page.waitForTimeout(40);
  const next = variant.v % 3 + 1;
  await page.keyboard.press(String(next));
  await page.waitForSelector(`.win[data-kind="${VARIANTS[next - 1].kind}"]`);
  await waitPhase(page, "open");
  await page.waitForTimeout(400);
  check(g, "F6 switching variant mid-promote leaves a clean scene", (await tabCount(page)) === 3);

  await context.close();
}

async function runReduced(browser, variant) {
  const g = `${variant.name} (reduced motion)`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const page = await context.newPage();
  watch(page, g);
  await page.goto(`${pageUrl}?v=${variant.v}`);
  await page.waitForSelector(".win");
  const frames = await sampleMotion(page, 600);
  await waitPhase(page, "open");
  const moved = frames.filter((f) => f.transform !== "none" && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(f.transform));
  check(g, "F8 open never scales or moves the card", moved.length === 0 && !(await page.locator(".gn-strip").count()), moved.slice(0, 2));
  const openSpans = await spans(page, "opening", "open");
  check(g, "reduced open is a short fade", openSpans.length && Math.max(...openSpans) <= REDUCED_BUDGET_MS, openSpans);
  await page.screenshot({ path: join(evidence, `${variant.kind}-reduced-open.png`) });
  const before = await tabCount(page);
  const sampling = sampleMotion(page, 260);
  await pinch(page, [-10, -10, -10, -10, -10]);
  const pf = await sampling;
  await page.waitForFunction(() => window.__peekLog.some((e) => e.phase === "promoted"), null, { timeout: 2000 });
  await page.waitForTimeout(200);
  const movedP = pf.filter((f) => f.transform !== "none" && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(f.transform));
  const rowMoves = pf.flatMap((f) => f.rows).filter((t) => t && t !== "none");
  check(g, "F8 pinch promote with no travel or scale", movedP.length === 0 && rowMoves.length === 0, { movedP: movedP.length, rowMoves: rowMoves.slice(0, 2) });
  const active = await activeRows(page);
  check(g, "reduced pinch still promotes to an active tab", (await tabCount(page)) === before + 1 && active.length === 1 && active[0].startsWith("n"), active);
  await page.locator('.tab[data-tab="t1"]').click();
  await page.locator('.scroller a[data-peek="webkit"]').click();
  await waitPhase(page, "open");
  await page.keyboard.press("Escape");
  await waitPhase(page, "closed");
  check(g, "reduced Esc closes", (await page.locator(".pk").count()) === 0);
  await context.close();
}

async function runFrames(browser, variant) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
  const page = await context.newPage();
  watch(page, `${variant.name} frames`);
  await page.clock.install();
  await page.goto(`${pageUrl}?v=${variant.v}`);
  await page.clock.runFor(700);
  await page.waitForSelector(".pk");
  await page.keyboard.press("Escape");
  await page.clock.runFor(400);
  await page.locator('.scroller a[data-peek="genie"]').click();
  for (const at of [50, 100]) {
    await page.clock.runFor(50);
    await page.screenshot({ path: join(evidence, `${variant.kind}-frame-open-${at}ms.png`) });
  }
  await page.clock.runFor(400);
  await page.locator('.pk [data-act="promote"]').first().click();
  await page.clock.runFor(90);
  await page.screenshot({ path: join(evidence, `${variant.kind}-frame-promote-90ms.png`) });
  await page.clock.runFor(600);
  await context.close();
}

async function runDark(browser, variant) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  watch(page, `${variant.name} dark`);
  await load(page, variant.v);
  await page.screenshot({ path: join(evidence, `${variant.kind}-dark-open.png`) });
  await context.close();
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
try {
  for (const v of VARIANTS) await runVariant(browser, v);
  for (const v of VARIANTS) await runReduced(browser, v);
  for (const v of VARIANTS) await runFrames(browser, v);
  for (const v of VARIANTS) await runDark(browser, v);
} catch (e) {
  failed++;
  errors.push({ label: "runner", text: String(e?.stack ?? e) });
  console.log("RUNNER ERROR", e);
} finally {
  await browser.close();
}
check("all", "F20 no console or page errors", errors.length === 0, errors.slice(0, 5));
writeFileSync(join(evidence, "report.json"), JSON.stringify({ when: new Date().toISOString(), page: pageUrl, passed: results.filter((r) => r.ok).length, failed, results, errors }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed} failed. Evidence in ${evidence}`);
process.exit(failed ? 1 : 0);
