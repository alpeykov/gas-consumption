// Test suite for Gas Consumption: smoke, sanity, ui (themes/language/layout on desktop and phone) and regression.
// Run before every push:  npm test   (or: node tests/run.mjs [smoke|sanity|ui|regression])
// Serves the project locally and drives the installed Chrome in headless mode (puppeteer-core).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8766;
const URL = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium-browser",
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
const ONLY = process.argv[2];

// ---------- tiny static server ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new globalThis.URL(req.url, URL).pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// ---------- helpers ----------
const results = [];
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const json = (f) => JSON.parse(read(f));
const swVersion = () => read("sw.js").match(/const VERSION = "([\d.]+)"/)[1];
const num = (txt) => parseFloat(String(txt).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
const numEn = (txt) => parseFloat(String(txt).replace(/[^\d.-]/g, ""));
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { expect(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`); }

let browser;
// A clean browser profile per test; optional localStorage and viewport.
// The page's clock is fixed (default 17 Oct 2026, noon) so dates and sums don't depend on the real day;
// window.__setNow(iso) moves it later in a test.
async function open({ width = 1280, height = 900, storage = {}, waitChart = false, now = "2026-10-17T12:00:00", motion = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g/.test(m.text())) errors.push("console: " + m.text()); });
  await page.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: motion ? "no-preference" : "reduce" }]);
  await page.evaluateOnNewDocument((iso) => {
    const Real = Date; let off = new Real(iso).getTime() - Real.now();
    class FakeDate extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } }
    globalThis.Date = FakeDate;
    globalThis.__setNow = (s) => { off = new Real(s).getTime() - Real.now(); };
  }, now);
  await page.evaluateOnNewDocument((items) => {
    if (sessionStorage.getItem("__seeded")) return;
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    sessionStorage.setItem("__seeded", "1");
  }, storage);
  await page.goto(URL, { waitUntil: "networkidle0" });
  const click = page.click.bind(page);
  page.click = async (sel, o) => {
    await page.evaluate((s) => {
      const el = document.querySelector(s), menu = document.getElementById("menu");
      if (!el || !menu || el.closest("#menu-btn")) return;
      if (menu.contains(el) === menu.hidden) document.getElementById("menu-btn").click();
    }, sel);
    return click(sel, o);
  };
  page.errors = errors;
  page.close2 = () => ctx.close();
  return page;
}
const readings = (start, cur, sd, cd, extra = {}) => ({
  "gas-bill-forecast-v1": { "start-reading": String(start), "cur-reading": String(cur), "start-date": sd, "cur-date": cd,
    override: "", vat: "20", factor: "", rate: "1.95583", region: "Овергаз Мрежи", ...extra },
  "gas-bill-help-seen": "1",
});
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function test(suite, name, fn) {
  if (ONLY && ONLY !== suite) return;
  const t0 = Date.now();
  try { await fn(); results.push({ suite, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ suite, name, ok: false, ms: Date.now() - t0, err: e.message }); }
}

// ======================================================================
// SMOKE — the app and its data files load at all
// ======================================================================
async function smoke() {
  await test("smoke", "S1 data files are valid and complete", async () => {
    const prices = json("data/prices.json");
    expect(prices.regions.length >= 1 && prices.regions.every((r) => r.price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.uploaded)), "prices.json regions");
    expect(prices.regions.some((r) => r.name === "Овергаз Мрежи"), "prices.json has Овергаз Мрежи");
    const gcv = json("data/gcv.json");
    expect(Object.values(gcv.months).every((v) => v > 9 && v < 12), "gcv.json values in 9–12 kWh/m³");
    const hist = json("data/price-history.json");
    expect(hist.region === "Овергаз Мрежи" && Object.keys(hist.months).length > 40, "price-history.json months");
    expect(Object.values(hist.months).every((m) => m.priceEur > 20 && m.priceEur < 300 && m.pdf), "price-history.json values");
    const chart = json("data/price-chart.json");
    expect(Object.values(chart.months).every((m) => m.eurMwhVat > 10 && ["blog", "old", "full"].includes(m.basis)), "price-chart.json values");
  });
  await test("smoke", "S2 changelog top entry matches the app version", async () => {
    const log = json("data/changelog.json").versions;
    expect(log[0].version === swVersion(), `changelog top ${log[0].version} ≠ sw.js ${swVersion()}`);
    expect(log.every((v) => v.bg?.length && v.en?.length && v.date), "every changelog entry has bg, en and date");
  });
  await test("smoke", "S3 every offline (service worker) file exists", async () => {
    const shell = [...read("sw.js").matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1] || "index.html");
    const missing = shell.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(!missing.length, "missing: " + missing.join(", "));
  });
  await test("smoke", "S4 manifest is valid and its icons exist", async () => {
    const m = json("manifest.webmanifest");
    expect(m.name === "Gas Consumption", "install name is Gas Consumption");
    const missing = m.icons.filter((i) => !fs.existsSync(path.join(ROOT, i.src)));
    expect(!missing.length, "missing icons: " + missing.map((i) => i.src).join(", "));
  });
  for (const [w, lang] of [[1280, "bg"], [390, "bg"], [1280, "en"], [390, "en"]]) {
    await test("smoke", `S5 page loads without errors (${w}px, ${lang})`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
      expect(!page.errors.length, page.errors.join(" | "));
      expect((await text(page, "#out-fc-eur")) !== "–", "forecast is shown");
      await page.close2();
    });
  }
  await test("smoke", "S6 new visitor: the guide opens once, then empty readings", async () => {
    const page = await open({ width: 390 });
    expect(!(await page.$eval("#guide", (el) => el.hidden)), "guide is open on the first visit");
    expect(await page.$eval("#about", (el) => el.hidden), "help stays closed");
    await page.click("#g-skip");
    expect((await page.$eval("#cur-reading", (el) => el.value)) === "", "today's reading is empty after the guide");
    expect((await text(page, "#out-days")).length > 10, "explains what to enter");
    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.$eval("#guide", (el) => el.hidden), "guide stays closed on the second visit");
    await page.close2();
  });
}

// ======================================================================
// SANITY — each feature does its job
// ======================================================================
async function sanity() {
  await test("sanity", "N1 every text key exists in Bulgarian and English", async () => {
    const html = read("index.html");
    // The two string tables: "    bg: { … }," and "    en: { … }," inside const STR.
    const table = (name) => html.match(new RegExp(`\\n    ${name}: \\{\\n([\\s\\S]*?)\\n    \\},`))[1];
    const keys = (b) => new Set([...b.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]));
    const bg = keys(table("bg")), en = keys(table("en"));
    const onlyBg = [...bg].filter((k) => !en.has(k)), onlyEn = [...en].filter((k) => !bg.has(k));
    expect(!onlyBg.length && !onlyEn.length, `only bg: ${onlyBg} | only en: ${onlyEn}`);
    const used = [...html.matchAll(/data-i18n(?:-html|-aria|-placeholder|-tip|-alt|-title)?="(\w+)"/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((k) => !bg.has(k));
    expect(!missing.length, "used in the page but not defined: " + missing);
  });
  await test("sanity", "N2 English screen has no Cyrillic (except the bill column name)", async () => {
    const page = await open({ storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": "en", "gas-bill-tariff-open": "1" } });
    await page.click("#help-btn"); await page.click("#chart-btn"); await settle(1200);
    const cyr = await page.evaluate(() => (document.body.innerText.match(/[^\n]*[а-яА-Я][^\n]*/g) || []).filter((l) => !/Ново/.test(l)));
    expect(!cyr.length, "Cyrillic in English: " + cyr.slice(0, 3).join(" / "));
    await page.close2();
  });
  await test("sanity", "N3 language switch and its memory", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    expect((await text(page, "h1")) === "Консумация на газ", "Bulgarian by default");
    await page.click('.lang button[data-lang="en"]');
    expect((await text(page, "h1")) === "Gas Consumption", "switches to English");
    await page.reload({ waitUntil: "networkidle0" });
    expect((await text(page, "h1")) === "Gas Consumption", "English remembered after reload");
    await page.close2();
  });
  await test("sanity", "N4 themes switch and are remembered", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "blue", "dark blue by default");
    const order = await page.$$eval(".themes button", (b) => b.map((x) => x.dataset.themeChoice).join(","));
    expect(order === "blue,light,dark,contrast", "order " + order);
    expect((await page.$eval('.themes button[data-theme-choice="blue"]', (b) => b.getAttribute("aria-pressed"))) === "true", "dark blue dot marked");
    for (const th of ["light", "dark", "contrast", "blue"]) {
      await page.click(`.themes button[data-theme-choice="${th}"]`);
      expect((await page.evaluate(() => document.documentElement.dataset.theme)) === th, `${th} applied`);
    }
    await page.click('.themes button[data-theme-choice="light"]');
    await page.reload({ waitUntil: "networkidle0" });
    expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "theme remembered");
    await page.close2();
  });
  await test("sanity", "N5 tariff line opens, closes and is remembered", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    const collapsed = () => page.$eval(".tariff", (el) => el.classList.contains("collapsed"));
    expect(await collapsed(), "closed by default");
    expect(/68,90.*от 01\.10\.2026/.test(await text(page, "#tariff-summary")), "summary shows price and its date");
    await page.click("#tariff-toggle");
    expect(!(await collapsed()), "opens");
    await page.reload({ waitUntil: "networkidle0" });
    expect(!(await collapsed()), "stays open after reload");
    await page.close2();
  });
  await test("sanity", "N10 'How it adds up' is closed by default, opens and is remembered", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    const shown = () => page.$eval(".breakdown table", (el) => el.getClientRects().length > 0);
    expect(!(await shown()), "closed by default");
    expect((await page.$eval("#breakdown-toggle", (b) => b.getAttribute("aria-expanded"))) === "false", "aria-expanded false");
    expect(num(await text(page, "#t-tot-fc")) === 51.90, "totals still calculated while closed");
    await page.click("#breakdown-toggle");
    expect(await shown(), "opens");
    expect((await text(page, "#t-price-line")).endsWith("Прогнозата е базирана на същото дневно потребление до края на месеца."), "forecast note wording");
    expect((await page.$eval("#breakdown-toggle", (b) => b.getAttribute("aria-expanded"))) === "true", "aria-expanded true");
    await page.reload({ waitUntil: "networkidle0" });
    expect(await shown(), "stays open after reload");
    await page.click("#breakdown-toggle");
    await page.reload({ waitUntil: "networkidle0" });
    expect(!(await shown()), "stays closed after reload");
    await page.close2();
  });
  await test("sanity", "N6 dates in the app's language and the Today button", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-10") });
    expect((await text(page, "#start-date-text")).startsWith("1 октомври 2026"), "Bulgarian date text");
    await page.click("#today-btn");
    const today = await page.evaluate(() => new Date().toLocaleDateString("bg-BG", { day: "numeric", month: "long", year: "numeric" }));
    expect((await text(page, "#cur-date-text")) === today, "Today sets today's date");
    await page.close2();
  });
  await test("sanity", "N7 price chart: opens, currency and years change it", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#chart-btn"); await settle(1200);
    expect((await page.$$eval("#chart-svg path", (p) => p.filter((x) => x.getAttribute("d")).length)) >= 1, "line is drawn");
    await page.select("#chart-cur", "BGN"); await settle(200);
    expect((await text(page, "#chart-sub")).includes("лв./MWh"), "BGN subtitle");
    await page.select("#chart-from", "2022"); await page.select("#chart-to", "2022"); await settle(200);
    expect(/2022/.test(await page.$eval("#chart-svg", (s) => s.getAttribute("aria-label"))), "year range applied");
    await page.click("#chart-btn");
    expect(await page.$eval("#chart-panel", (el) => el.hidden), "closes with its menu item");
    await page.close2();
  });
  await test("sanity", "N12 chart defaults on first open: 2020 to the latest year, EUR", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#chart-btn"); await settle(1200);
    const r = await page.evaluate(() => ({ from: document.getElementById("chart-from").value, to: document.getElementById("chart-to").value,
      last: [...document.getElementById("chart-to").options].pop().value, cur: document.getElementById("chart-cur").value }));
    expect(r.from === "2020" && r.to === r.last && r.cur === "EUR", `got ${r.from}–${r.to} ${r.cur}, latest year ${r.last}`);
    await page.close2();
  });
  await test("sanity", "N13 'Reading today' date moves to today on opening and on returning to the app", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-10") });
    expect((await page.$eval("#cur-date", (el) => el.value)) === "2026-10-17", "opening: date is today");
    expect((await text(page, "#cur-date-text")).startsWith("17 октомври 2026"), "opening: date text is today");
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem("gas-bill-forecast-v1"))["cur-date"])) === "2026-10-17", "today's date is saved");
    expect((await page.$eval("#cur-reading", (el) => el.value)) === "2475", "the reading is kept");
    await page.evaluate(() => { __setNow("2026-10-19T08:00:00"); document.dispatchEvent(new Event("visibilitychange")); });
    expect((await text(page, "#cur-date-text")).startsWith("19 октомври 2026"), "returning on another day: date is today");
    await page.close2();
  });
  await test("sanity", "N14 × clears only its own reading; Undo brings it back", async () => {
    const page = await open({ storage: readings(2445, 2480, "2026-10-01", "2026-10-17") });
    const val = (id) => page.$eval("#" + id, (el) => el.value);
    const clrHidden = (id) => page.$eval(`.clr[data-clear="${id}"]`, (b) => b.hidden);
    expect(!(await clrHidden("cur-reading")) && !(await clrHidden("start-reading")), "× shown when there is a number");
    await page.click('.clr[data-clear="cur-reading"]');
    expect((await val("cur-reading")) === "" && (await val("start-reading")) === "2445", "today's reading cleared, the bill reading kept");
    expect((await val("cur-date")) === "2026-10-17" && (await val("start-date")) === "2026-10-01", "dates kept");
    expect(await page.evaluate(() => document.activeElement.id === "cur-reading"), "cursor in the cleared field");
    expect(await clrHidden("cur-reading"), "× hidden on an empty field");
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem("gas-bill-forecast-v1"))["cur-reading"])) === "", "clearing is saved");
    await page.click("#toast-undo");
    expect((await val("cur-reading")) === "2480", "Undo restores the reading");
    await page.click('.clr[data-clear="start-reading"]');
    expect((await val("start-reading")) === "" && (await val("cur-reading")) === "2480", "bill reading cleared, today's kept");
    await page.close2();
  });
  await test("sanity", "N15 ⇅ swaps only the two reading values; Undo swaps back", async () => {
    const page = await open({ storage: readings(2445, 2480, "2026-10-01", "2026-10-17") });
    const val = (id) => page.$eval("#" + id, (el) => el.value);
    await page.click("#swap-btn");
    expect((await val("cur-reading")) === "2445" && (await val("start-reading")) === "2480", "values swapped");
    expect((await val("cur-date")) === "2026-10-17" && (await val("start-date")) === "2026-10-01", "dates not swapped");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("gas-bill-forecast-v1")));
    expect(saved["cur-reading"] === "2445" && saved["start-reading"] === "2480", "swap is saved");
    expect((await text(page, "#toast")).includes("разменени"), "note says swapped");
    await page.click("#toast-undo");
    expect((await val("cur-reading")) === "2480" && (await val("start-reading")) === "2445", "Undo swaps back");
    await page.close2();
  });
  await test("sanity", "N16 help says the app is independent and links to the privacy policy (bg, en, phone)", async () => {
    for (const lang of ["bg", "en"]) {
      const page = await open({ storage: { ...readings(2445, 2480, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
      await page.click("#help-btn");
      const legal = await text(page, "#about .about-legal");
      expect(lang === "bg" ? /не е свързано с Овергаз/.test(legal) : /not affiliated with Overgas/.test(legal), lang + " independence note: " + legal);
      expect((await page.$eval("#about .about-legal a", (a) => a.getAttribute("href"))) === "privacy.html", lang + " privacy link");
      await page.close2();
    }
    const page = await open({ width: 320 });
    await page.goto(URL + "privacy.html", { waitUntil: "networkidle0" });
    const r = await page.evaluate(() => ({ bg: !!document.querySelector('#bg[lang="bg"]'), en: !!document.querySelector('#en[lang="en"]'),
      txt: document.body.innerText, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
    expect(r.bg && r.en, "privacy page has Bulgarian and English sections");
    expect(/не събира/.test(r.txt) && /does not collect/.test(r.txt), "privacy page states no data is collected");
    expect(!r.wide, "privacy page scrolls sideways at 320 px");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N17 help has a Send feedback email with subject, version and language (bg, en)", async () => {
    for (const lang of ["bg", "en"]) {
      const page = await open({ storage: { ...readings(2445, 2480, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
      await page.click("#help-btn");
      expect((await text(page, "#feedback")) === (lang === "bg" ? "Изпрати отзив" : "Send feedback"), lang + " button text");
      // Keep the test page from following the mailto: link.
      await page.evaluate(() => document.addEventListener("click", (e) => e.preventDefault()));
      await page.click("#feedback");
      const href = decodeURIComponent(await page.$eval("#feedback", (a) => a.getAttribute("href")));
      expect(href.startsWith("mailto:aleksandar.peykov@gmail.com?subject=Gas Consumption"), lang + " address and subject: " + href.slice(0, 80));
      expect(href.includes(" · " + lang + " · ") && /browser|installed web app/.test(href), lang + " body carries where and language");
      expect((await text(page, "#toast")).includes("aleksandar.peykov@gmail.com"), lang + " note names the address");
      await page.close2();
    }
  });
  await test("sanity", "N18 backup saves readings and settings to a file; restore loads them back, with Undo", async () => {
    const page = await open({ storage: { ...readings(2445, 2480, "2026-10-01", "2026-10-17"), "gas-bill-theme": "blue", "gas-bill-prices-v1": "{}" } });
    expect(await page.$eval("#backup-btn", (b) => b.previousElementSibling.id === "share-btn"), "backup sits after share in the menu");
    await page.click("#backup-btn");
    expect(!(await page.$eval("#backup", (e) => e.hidden)), "backup panel opens");
    // Catch the download instead of saving it.
    await page.evaluate(() => { HTMLAnchorElement.prototype.click = function () { window.__dl = { name: this.download, href: this.href }; }; });
    await page.click("#backup-save");
    const dl = await page.evaluate(async () => ({ name: window.__dl.name, json: await (await fetch(window.__dl.href)).text() }));
    expect(dl.name === "gas-consumption-backup-2026-10-17.json", "file name " + dl.name);
    const b = JSON.parse(dl.json);
    expect(b.app === "gas-consumption" && JSON.parse(b.data["gas-bill-forecast-v1"])["cur-reading"] === "2480" && b.data["gas-bill-theme"] === "blue", "file has readings and theme");
    expect(!("gas-bill-prices-v1" in b.data), "downloaded price data is left out");
    expect((await text(page, "#backup-msg")).includes(dl.name), "panel names the saved file");
    // Change the readings, then restore the file.
    await page.evaluate(() => { const c = document.getElementById("cur-reading"); c.value = "9999"; c.dispatchEvent(new Event("input")); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-backup-"));
    const good = path.join(dir, dl.name); fs.writeFileSync(good, dl.json);
    const bad = path.join(dir, "other.json"); fs.writeFileSync(bad, JSON.stringify({ hello: 1 }));
    let [fc] = await Promise.all([page.waitForFileChooser(), page.click("#backup-load")]);
    await fc.accept([bad]); await settle(500);
    expect((await text(page, "#backup-msg")).includes("не е копие"), "a wrong file is refused");
    [fc] = await Promise.all([page.waitForFileChooser(), page.click("#backup-load")]);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), fc.accept([good])]);
    expect((await page.$eval("#cur-reading", (e) => e.value)) === "2480", "reading restored");
    expect((await text(page, "#toast")).includes("възстановени"), "note says restored");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#toast-undo")]);
    expect((await page.$eval("#cur-reading", (e) => e.value)) === "9999", "Undo brings back the readings from before");
    expect(!page.errors.length, page.errors.join(" | "));
    fs.rmSync(dir, { recursive: true, force: true });
    await page.close2();
  });
  await test("sanity", "N19 guide: four steps with 163 and 127 that are never saved; replay puts own readings back", async () => {
    const page = await open({ width: 390 });
    const val = (id) => page.$eval("#" + id, (el) => el.value);
    const savedCur = () => page.evaluate(() => (JSON.parse(localStorage.getItem("gas-bill-forecast-v1") || "{}"))["cur-reading"] || "");
    expect((await text(page, "#g-title")).startsWith("1"), "step 1");
    expect((await val("cur-reading")) === "163" && (await val("start-reading")) === "", "step 1 fills 163");
    await page.click("#g-next");
    expect((await val("start-reading")) === "127", "step 2 fills 127");
    await page.click("#g-next");
    expect((await text(page, "#g-text")).includes("36 m³") && (await text(page, "#out-fc-eur")) !== "–", "step 3 shows the bill for 36 m³");
    expect((await savedCur()) === "", "example readings are not saved");
    await page.click("#g-next");
    expect((await text(page, "#g-next")) === "Започни" && await page.$eval("#g-skip", (e) => e.hidden), "last step: Start, no Skip");
    await page.click("#g-next");
    expect(await page.$eval("#guide", (e) => e.hidden), "Start closes the guide");
    expect((await val("cur-reading")) === "" && (await val("start-reading")) === "", "readings are empty again");
    await page.close2();
    for (const from of ["help", "menu"]) {
      const p2 = await open({ width: 390, storage: readings(2445, 2480, "2026-10-01", "2026-10-17") });
      if (from === "help") { await p2.click("#help-btn"); await p2.click("#guide-show"); } else await p2.click("#menu-guide");
      expect(!(await p2.$eval("#guide", (e) => e.hidden)) && (await p2.$eval("#cur-reading", (e) => e.value)) === "163", from + ": guide replays with 163");
      await p2.keyboard.press("Escape");
      expect((await p2.$eval("#cur-reading", (e) => e.value)) === "2480" && (await p2.$eval("#start-reading", (e) => e.value)) === "2445", from + ": own readings are back");
      expect(!p2.errors.length, p2.errors.join(" | "));
      await p2.close2();
    }
  });
  // ---- Monthly history ----
  const monthsOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("gas-bill-months-v1") || "{}"));
  const setVal = (p, sel, v, ev = "input") => p.evaluate((s, x, e) => { const el = document.querySelector(s); el.value = x; el.dispatchEvent(new Event(e, { bubbles: true })); }, sel, v, ev);
  const SEPT = { "2026-09": { start: 2429, end: 2445, date: "2026-09-30", bill: null } };
  await test("sanity", "N25 history: on the 1st the month is saved with its last reading and the new month starts from it", async () => {
    const stamped = (sd) => ({ "gas-bill-forecast-v1": { ...readings(2445, 2502, sd, "2026-10-28")["gas-bill-forecast-v1"], "cur-stamp": { value: "2502", date: "2026-10-28" } }, "gas-bill-help-seen": "1" });
    let page = await open({ now: "2026-11-01T08:00:00", storage: stamped("2026-10-01") });
    expect(JSON.stringify((await monthsOf(page))["2026-10"]) === JSON.stringify({ start: 2445, end: 2502, date: "2026-10-28", bill: null }), "October saved: " + JSON.stringify(await monthsOf(page)));
    expect((await page.$eval("#start-reading", (e) => e.value)) === "2502" && (await page.$eval("#start-date", (e) => e.value)) === "2026-11-01", "last bill reading moves to 2502 on 1 November");
    expect(/^Октомври 2026 е записан в историята \(57 m³ · .+ € \/ .+ лв\.\)\. „Показание от последната сметка“ е 2502 от 1-ви ноември\./.test(await text(page, "#toast")), "toast: " + await text(page, "#toast"));
    expect((await text(page, "#out-now-eur")) === "0,00 €" && (await text(page, "#out-fc-eur")) === "–" && (await text(page, "#out-days")) === "Първи ден от периода на сметката – прогнозата се появява от утре.", "1st day: no warning, forecast from tomorrow");
    await page.click("#toast-undo");
    expect(!(await monthsOf(page))["2026-10"] && (await page.$eval("#start-reading", (e) => e.value)) === "2445" && (await page.$eval("#start-date", (e) => e.value)) === "2026-10-01", "Undo puts everything back");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
    page = await open({ now: "2026-11-03T08:00:00", storage: stamped("2026-10-01") });
    await page.reload({ waitUntil: "networkidle0" });
    expect(Object.keys(await monthsOf(page)).join() === "2026-10" && (await page.$eval("#start-reading", (e) => e.value)) === "2502", "opening again doesn't save it twice");
    await page.close2();
    // The last bill is from another month than the last reading: nothing is guessed.
    page = await open({ now: "2026-11-01T08:00:00", storage: stamped("2026-09-01") });
    expect(!Object.keys(await monthsOf(page)).length && (await page.$eval("#start-reading", (e) => e.value)) === "2445", "dates in different months: nothing saved");
    await page.close2();
  });
  await test("sanity", "N26 history: readings typed on the main screen for a past month are saved as that month; dates in different months are not", async () => {
    const page = await open({ storage: readings(2429, 2445, "2026-09-01", "2026-10-17") });
    expect(!Object.keys(await monthsOf(page)).length, "nothing for the current month");
    await setVal(page, "#cur-date", "2026-09-30", "change");
    expect(JSON.stringify(await monthsOf(page)) === JSON.stringify({ "2026-09": { start: 2429, end: 2445, date: "2026-09-30", bill: null } }), "September saved: " + JSON.stringify(await monthsOf(page)));
    expect((await text(page, "#toast")).startsWith("Записано в историята: Септември 2026 · 16 m³ · 13,61 € / 26,62 лв."), "toast: " + await text(page, "#toast"));
    await setVal(page, "#cur-reading", "2447", "change");
    expect((await monthsOf(page))["2026-09"].end === 2447, "a changed reading overwrites the month");
    await page.click("#toast-undo");
    expect((await monthsOf(page))["2026-09"].end === 2445, "Undo brings the old row back");
    await setVal(page, "#start-date", "2026-08-15", "change");
    await setVal(page, "#start-reading", "2400", "change");
    expect((await monthsOf(page))["2026-09"].start === 2429 && !(await monthsOf(page))["2026-08"], "dates in different months: nothing saved");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N27 history: list, edit m³ and bill, estimate follows, delete with Undo", async () => {
    const page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": SEPT } });
    await page.click("#history-btn");
    expect(!(await page.$eval("#mh-panel", (e) => e.hidden)) && !(await page.$eval("#menu", (e) => e.hidden)) && (await page.$eval("#mh-panel", (e) => !!e.closest("#menu"))), "opens inside the menu, menu stays open");
    await page.click("#mh-list-toggle");
    const rows = () => page.$$eval("#mh-rows tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
    let r = await rows();
    expect(r[0][0].startsWith("Октомври 2026до момента") && r[0][1] === "30", "this month so far first: " + r[0].join(" | "));
    expect(r[1][0] === "Септември 20262429 → 2445" && r[1][1] === "16" && r[1][2] === "13,61 €26,62 лв." && r[1][3] === "–" && r[1][4] === "✎", "September row: " + r[1].join(" | "));
    expect(await page.$eval("#mh-rows tr.mh-cur", (tr) => !tr.querySelector(".mh-ed")), "no ✎ on the month still running");
    await page.click(".mh-ed[data-m='2026-09']");
    expect((await page.$eval("#mh-m3", (e) => e.value)) === "16" && /= 13,61 € \/ 26,62 лв\.$/.test(await text(page, "#mh-calc")), "form shows m³ and the estimate in both currencies: " + await text(page, "#mh-calc"));
    await setVal(page, "#mh-m3", "20");
    expect((await page.$eval("#mh-end", (e) => e.value)) === "2449", "m³ moves the end reading");
    const c20 = await text(page, "#mh-calc");
    expect(/^Прогноза: 20 m³ × 10,76 kWh\/m³ × .+\/MWh с ДДС \(цена за септември 2026\) = 17,0\d € \/ 33,\d\d лв\.$/.test(c20), "estimate follows m³: " + c20);
    await setVal(page, "#mh-start", "2430");
    expect((await page.$eval("#mh-m3", (e) => e.value)) === "19", "a reading recalculates m³");
    await setVal(page, "#mh-bill", "16,50");
    expect((await page.$eval("#mh-bill-bgn", (e) => [e.disabled, e.value].join())) === "false,32,27", "leva filled, still editable: " + await page.$eval("#mh-bill-bgn", (e) => [e.disabled, e.value].join()));
    expect(/разлика със сметката [+−]\d/.test(await text(page, "#mh-calc")), "difference from the bill shown");
    await page.click("#mh-save");
    expect(JSON.stringify((await monthsOf(page))["2026-09"]) === JSON.stringify({ start: 2430, end: 2449, date: null, bill: 16.5 }), "saved: " + JSON.stringify((await monthsOf(page))["2026-09"]));
    r = await rows();
    expect(r[1][1] === "19" && r[1][3].startsWith("16,50 €32,27 лв.") && /[+−]\d/.test(r[1][3]), "row updated: " + r[1].join(" | "));
    await page.click(".mh-ed[data-m='2026-09']");
    await setVal(page, "#mh-end", "2420");
    await page.click("#mh-save");
    expect(!(await page.$eval("#mh-msg", (e) => e.hidden)) && (await monthsOf(page))["2026-09"].end === 2449, "end below start is refused");
    await page.click("#mh-del");
    expect(!(await monthsOf(page))["2026-09"] && (await rows()).length === 1, "deleted");
    await page.click("#toast-undo");
    expect((await monthsOf(page))["2026-09"].end === 2449 && (await rows()).length === 2, "Undo brings it back");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N28 history: add a month from an old bill", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#history-btn");
    expect(!(await page.$eval("#mh-empty", (e) => e.hidden)) === false, "the running month is listed, so no empty note");
    await page.click("#mh-add");
    expect(await page.$eval("#mh-add", (e) => e.hidden) && (await page.$eval("#mh-month", (e) => e.options[0].value)) === "2026-09", "form open, last month first");
    await page.select("#mh-month", "2026-06");
    expect((await text(page, "#mh-usage")) === "Потреблението през юни 2026 се смята по цената на Овергаз за юни 2026.", "invoice of June = use in June: " + await text(page, "#mh-usage"));
    await setVal(page, "#mh-start", "2410"); await setVal(page, "#mh-end", "2414"); await setVal(page, "#mh-bill", "4,10");
    expect(/цена за юни 2026/.test(await text(page, "#mh-calc")), "estimate with June's price: " + await text(page, "#mh-calc"));
    await page.click("#mh-save");
    expect(JSON.stringify((await monthsOf(page))["2026-06"]) === JSON.stringify({ start: 2410, end: 2414, date: null, bill: 4.1 }), "saved as June: " + JSON.stringify(await monthsOf(page)));
    expect((await page.$eval("#mh-rows tr[data-m='2026-06']", (tr) => tr.cells[0].textContent)) === "Юни 20262410 → 2414", "row");
    await page.click("#mh-add");
    expect(!(await page.$eval("#mh-month", (e) => [...e.options].some((o) => o.value === "2026-06"))), "that invoice isn't offered again");
    await page.click("#mh-cancel");
    expect((await page.$eval("#mh-form", (e) => e.innerHTML)) === "", "Cancel closes the form");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N31 backup and monthly history open and close inside the ☰ menu; other actions open on the page and scroll to it", async () => {
    const page = await open({ width: 1366, height: 768, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-breakdown-open": "1" } });
    const st = (sel) => page.$eval(sel, (e) => { const b = e.getBoundingClientRect(), m = document.getElementById("menu");
      return { shown: !e.hidden, inMenu: !!e.closest("#menu"), menuOpen: !m.hidden, inView: b.top >= -1 && b.top < innerHeight }; });
    for (const [btn, panel] of [["#backup-btn", "#backup"], ["#history-btn", "#mh-panel"], ["#chart-btn", "#chart-panel"], ["#help-btn", "#about"]]) {
      await page.click(btn); await settle(150);
      let r = await st(panel);
      expect(r.shown && r.inMenu && r.menuOpen && r.inView, btn + " opens in the menu: " + JSON.stringify(r));
      expect((await page.$eval(btn, (b) => b.getAttribute("aria-expanded"))) === "true", btn + " expanded");
      await page.click(btn); await settle(150);
      r = await st(panel);
      expect(!r.shown && r.menuOpen, btn + " collapses, menu stays open");
    }
    expect(await page.evaluate(() => !document.querySelector("main #backup, .main #backup, header #backup, main #mh-panel")), "not on the main page");
    await page.click("#history-btn"); await settle(100);
    expect(await page.$eval("#menu", (m) => m.getBoundingClientRect().width > 400), "menu widens for the history table");
    await page.click("#history-btn");
    expect(await page.$eval("#menu", (m) => m.getBoundingClientRect().width <= 330), "and narrows again");
    await page.click("#chart-btn"); await settle(800);
    expect(await page.$eval("#menu", (m) => m.getBoundingClientRect().width > 400) && (await page.$$eval("#chart-svg path", (p) => p.filter((x) => x.getAttribute("d")).length)) >= 1, "the chart is drawn in the wider menu");
    await page.click("#chart-btn");
    await page.close2();
  });
  // Rule: every ☰ menu option that shows something shows it inside the menu, never on the main page.
  for (const [dev, w] of [["desktop", 1280], ["phone", 390]]) {
    await test("sanity", `N34 every ☰ menu option with a panel opens it inside the menu, not on the main page (${dev})`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": { "2026-09": { start: 2429, end: 2445, date: "2026-09-30", bill: null } } } });
      const items = await page.$$eval("#menu .menu-item[aria-controls]", (bs) => bs.map((b) => [b.id, b.getAttribute("aria-controls")]));
      expect(items.length >= 4, "menu items with a panel: " + items.map((x) => x[0]).join());
      for (const [id, panel] of items) {
        const before = await page.evaluate(() => document.querySelector("main, .main").innerHTML.length);
        await page.click("#" + id); await settle(id === "chart-btn" ? 900 : 150);
        const r = await page.evaluate((p) => {
          const el = document.getElementById(p), m = document.getElementById("menu");
          const b = el.getBoundingClientRect(), mb = m.getBoundingClientRect();
          return { shown: !el.hidden, inMenu: !!el.closest("#menu"), menuOpen: !m.hidden, inside: b.left >= mb.left - 1 && b.right <= mb.right + 1 };
        }, panel);
        expect(r.shown && r.inMenu && r.menuOpen && r.inside, `${id} → #${panel}: ${JSON.stringify(r)}`);
        const outside = await page.evaluate(() => [...document.querySelectorAll("section, [role=region], .ios-help, .chart-panel, .menu-panel")]
          .filter((e) => !e.hidden && e.getClientRects().length && !e.closest("#menu") && !e.closest(".main, main") && e.id !== "ios-help").map((e) => e.id || e.className));
        expect(!outside.length, `${id}: something opened outside the menu: ${outside.join()}`);
        expect((await page.evaluate(() => document.querySelector("main, .main").innerHTML.length)) === before, `${id}: the main page changed`);
        await page.click("#" + id); await settle(100);
        expect(await page.$eval("#" + panel, (e) => e.hidden), `${id} closes it again`);
      }
      expect(!page.errors.length, page.errors.join(" | "));
      await page.close2();
    });
  }
  await test("sanity", "N32 readings from different months: only the cost so far at this month's price, no forecast, a note", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2489, "2024-10-31", "2026-10-17") });
    const tx = async (id) => text(page, "#" + id);
    expect((await tx("out-fc-eur")) === "–" && (await tx("out-rate")) === "–", "no forecast, no daily rate");
    expect((await tx("out-now-bgn")).endsWith("44 m³"), "cost of 44 m³");
    // 44 m³ × this month's kWh/m³ × October 2026 price × 1.2 – the same as typing a last bill of 1 October 2026.
    const p2 = await open({ width: 390, storage: readings(2445, 2489, "2026-10-01", "2026-10-17") });
    expect((await tx("out-now-eur")) === (await text(p2, "#out-now-eur")), "priced like this month: " + await tx("out-now-eur") + " vs " + await text(p2, "#out-now-eur"));
    expect((await tx("head-price")) === (await text(p2, "#head-price")), "header shows this month's price");
    await p2.close2();
    expect((await tx("out-days")).startsWith("Двете показания са от различни месеци.") && (await tx("out-days")).includes("октомври 2026"), "note: " + await tx("out-days"));
    expect((await tx("out-forecast-label")) === "Прогнозна сметка до 1-ви ноември" && (await tx("tl-start")) === "", "label for this month, no timeline");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N30 history: bills before 2026 are typed in leva, converted to euro, shown in both", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#history-btn");
    await page.click("#mh-list-toggle");
    await page.click("#mh-add");
    await page.select("#mh-month", "2026-01");
    expect(!(await text(page, "#mh-bgn-note")).includes("в лева"), "invoice of January 2026: no leva note");
    await page.select("#mh-month", "2025-12");
    expect((await text(page, "#mh-bgn-note")).startsWith("Фактурите преди 1 януари 2026 г. са в лева"), "invoice of December 2025: leva note");
    await setVal(page, "#mh-start", "1900"); await setVal(page, "#mh-end", "2100"); await setVal(page, "#mh-bill-bgn", "300");
    expect((await page.$eval("#mh-bill", (e) => [e.disabled, e.value].join())) === "false,153,39", "euro filled, still editable");
    await setVal(page, "#mh-bill", "150");
    expect((await page.$eval("#mh-bill-bgn", (e) => e.value)) === "293,37", "typing euro recalculates leva");
    await setVal(page, "#mh-bill-bgn", "");
    expect((await page.$eval("#mh-bill", (e) => e.value)) === "", "cleared: both empty");
    await setVal(page, "#mh-bill-bgn", "300");
    expect(/разлика със сметката [+−][\d,]+ € \/ [\d,]+ лв\.$/.test(await text(page, "#mh-calc")), "difference in both: " + await text(page, "#mh-calc"));
    await page.click("#mh-save");
    expect(JSON.stringify((await monthsOf(page))["2025-12"]) === JSON.stringify({ start: 1900, end: 2100, date: null, bill: 300, billCur: "BGN" }), "kept in leva: " + JSON.stringify(await monthsOf(page)));
    const row = await page.$eval("#mh-rows tr[data-m='2025-12']", (tr) => tr.cells[3].textContent);
    expect(row.startsWith("153,39 €300,00 лв."), "shown as € with the leva from the bill: " + row);
    await page.click(".mh-ed[data-m='2025-12']");
    expect((await page.$eval("#mh-bill-bgn", (e) => [e.disabled, e.value].join())) === "false,300,00" && (await page.$eval("#mh-bill", (e) => [e.disabled, e.value].join())) === "false,153,39", "edit shows the leva amount and the euro");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N33 old bills filed one month early by 2.1.4–2.1.5 move back to their invoice month, once; the October 2024 invoice matches", async () => {
    const old = { "2024-09": { start: 0, end: 41, date: null, bill: 53.71, invoice: "2024-10", billCur: "BGN" },
      "2023-10": { start: 41, end: 207, date: null, bill: 217.47, invoice: "2023-11", billCur: "BGN" }, "2026-09": { start: 2429, end: 2445, date: "2026-09-30", bill: null } };
    const page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": old, "gas-bill-months-invoice-fix": "1" } });
    const m = await monthsOf(page);
    expect(Object.keys(m).sort().join() === "2023-11,2024-10,2026-09", "moved: " + Object.keys(m).sort().join());
    expect(JSON.stringify(m["2024-10"]) === JSON.stringify({ start: 0, end: 41, date: null, bill: 53.71, billCur: "BGN" }) && !m["2026-09"].invoice, "invoice key dropped; read months untouched");
    await page.reload({ waitUntil: "networkidle0" });
    expect(Object.keys(await monthsOf(page)).sort().join() === "2023-11,2024-10,2026-09", "only once");
    await page.click("#history-btn"); await settle(600);
    const oct = await page.$eval("#mh-rows tr[data-m='2024-10']", (tr) => [...tr.cells].map((c) => c.textContent));
    // Invoice of 31.10.2024: 41 m³, 0.440955 MWh, 53.71 lv. – the estimate is within a stotinka.
    expect(oct[0] === "Октомври 20240 → 41" && oct[2] === "27,47 €53,72 лв." && oct[3].startsWith("27,46 €53,71 лв."), "row: " + oct.join(" | "));
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N35 history: editing a month can change its month (wrong year) – the row moves and is priced for its new month", async () => {
    const page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-invoice-fix": "1",
      "gas-bill-months-v1": { "2023-10": { start: 0, end: 41, date: null, bill: 51.73, billCur: "BGN" } } } });
    await page.click("#history-btn");
    await page.click("#mh-list-toggle");
    await page.click(".mh-ed[data-m='2023-10']");
    expect((await page.$eval("#mh-month", (e) => e.value)) === "2023-10" && (await text(page, "#mh-usage")).includes("октомври 2023"), "form shows the month");
    await page.select("#mh-month", "2024-10");
    await setVal(page, "#mh-bill-bgn", "53,71"); await settle(600); await setVal(page, "#mh-bill-bgn", "53,71");
    expect((await text(page, "#mh-usage")) === "Потреблението през октомври 2024 се смята по цената на Овергаз за октомври 2024." && /цена за октомври 2024\) = 27,47 € \/ 53,72 лв\./.test(await text(page, "#mh-calc")), "priced for October 2024: " + await text(page, "#mh-calc"));
    expect((await page.$eval("#mh-bill", (e) => e.value)) === "27,46", "the leva bill is shown in euro too");
    await page.click("#mh-save");
    const m = await monthsOf(page);
    expect(Object.keys(m).join() === "2024-10" && JSON.stringify(m["2024-10"]) === JSON.stringify({ start: 0, end: 41, date: null, bill: 53.71, billCur: "BGN" }), "moved: " + JSON.stringify(m));
    expect((await page.$eval("#mh-rows tr[data-m='2024-10']", (tr) => tr.cells[0].textContent)) === "Октомври 20240 → 41", "row");
    // An invoice whose month of use is already saved isn't offered.
    await page.click("#mh-add");
    expect(!(await page.$eval("#mh-month", (e) => [...e.options].some((o) => o.value === "2024-10"))), "taken months aren't offered");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N29 history chart: folded at first, like the price archive – €/лв./m³, a period, tooltip, remembered; English", async () => {
    const H = { "2025-03": { start: 1900, end: 2000, date: null, bill: 150, billCur: "BGN" }, "2026-08": { start: 2420, end: 2429, date: null, bill: null }, ...SEPT };
    const page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": H } });
    await page.click("#history-btn");
    expect(await page.$eval("#mh-cbox", (e) => e.hidden), "chart folded at first");
    await page.click("#mh-chart-toggle"); await settle(300);
    const v = (id) => page.$eval("#" + id, (e) => e.value);
    expect((await v("mh-unit")) === "eur" && (await v("mh-from")) === "2025-10" && (await v("mh-to")) === "2026-10", "€, last 12 months up to now: " + [await v("mh-unit"), await v("mh-from"), await v("mh-to")]);
    expect((await page.$eval("#mh-from", (e) => [e.options[0].value, e.options[e.options.length - 1].value].join())) === "2026-10,2025-03", "newest month on top, back to the oldest");
    const pts = () => page.$$eval("#mh-svg .mh-pt", (c) => c.map((x) => x.dataset.m).join());
    expect((await pts()) === "2026-08,2026-09,2026-10", "points for Aug, Sep and October so far: " + await pts());
    expect((await page.$$eval("#mh-svg path", (p) => p.map((x) => !!x.getAttribute("d")))).join() === "true,true", "a solid line and a dashed one into this month");
    expect(/^25 m³ · [\d,]+ € \/ [\d,]+ лв\.$/.test(await text(page, "#mh-total-val")), "period total: " + await text(page, "#mh-total-val"));
    expect((await text(page, "#mh-tip")).startsWith("Октомври 2026 · прогноза"), "the readout shows the latest month at first: " + await text(page, "#mh-tip"));
    // This month: the forecast, not the use so far (30 m³ in 16 days → 30/16 × 31 ≈ 58 m³).
    const oc = await page.$eval("#mh-svg .mh-pt[data-m='2026-10']", (c) => { const b = c.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    await page.mouse.move(oc[0], oc[1]); await settle(100);
    expect(/^Октомври 2026 · прогноза до края на месеца≈ 58 m³ · [\d,]+ € \/ [\d,]+ лв\.до момента \(17\.10\): 30 m³ · 26,79 € \/ 52,39 лв\.$/.test(await text(page, "#mh-tip")), "forecast tooltip: " + await text(page, "#mh-tip"));
    // Tooltip on September.
    const pt = await page.$eval("#mh-svg .mh-pt[data-m='2026-09']", (c) => { const b = c.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    await page.mouse.move(pt[0], pt[1]); await settle(100);
    expect((await text(page, "#mh-tip")) === "Септември 202616 m³ · 13,61 € / 26,62 лв.", "tooltip: " + await text(page, "#mh-tip"));
    // The readout sits under the chart and never covers it, in either chart.
    const clear = (tip, svg) => page.evaluate((a, b) => { const r = document.getElementById(a).getBoundingClientRect(), s = document.getElementById(b).getBoundingClientRect(); return r.top >= s.bottom - 1; }, tip, svg);
    expect(await clear("mh-tip", "mh-svg"), "history readout is under the chart");
    await page.click("#chart-btn"); await settle(1200);
    await page.evaluate(() => { const h = document.getElementById("chart-hit"), r = h.getBoundingClientRect(); h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + r.width / 2, clientY: r.top + 10, bubbles: true })); });
    expect(await clear("chart-tip", "chart-svg") && (await text(page, "#chart-tip")).length > 5, "price readout is under the chart");
    await page.click("#chart-btn");
    await page.select("#mh-unit", "m3");
    expect((await page.$eval("#mh-svg", (s) => s.textContent)).includes("m³") && (await page.$$eval("#mh-svg text", (x) => x.map((e) => e.textContent))).includes("20"), "m³ axis: " + (await page.$$eval("#mh-svg text", (x) => x.map((e) => e.textContent))).join());
    // "From" after "To": a yellow note instead of the chart, in both charts.
    await page.select("#mh-from", "2026-09"); await page.select("#mh-to", "2025-06");
    expect((await page.$eval("#mh-box", (e) => e.hidden)) && await page.$eval("#mh-total", (e) => e.hidden) && (await text(page, "#mh-bad")).startsWith("„От“ е след „До“"), "history: note instead of the chart");
    expect(await page.$eval("#mh-bad", (e) => { const k = document.createElement("i"); k.style.color = "var(--amber)"; document.body.append(k); const c = getComputedStyle(k).color; k.remove(); return getComputedStyle(e).color === c; }), "yellow (amber) note");
    await page.click("#chart-btn"); await settle(1200);
    await page.select("#chart-from", "2025"); await page.select("#chart-to", "2022");
    expect((await page.$eval("#chart-box", (e) => e.hidden)) && !(await page.$eval("#chart-bad", (e) => e.hidden)), "price archive: note instead of the chart");
    await page.select("#chart-to", "2026");
    expect(!(await page.$eval("#chart-box", (e) => e.hidden)) && (await page.$eval("#chart-bad", (e) => e.hidden)), "price archive: chart back");
    await page.click("#chart-btn");
    await page.select("#mh-from", "2025-03"); await page.select("#mh-to", "2025-06");
    expect(!(await page.$eval("#mh-box", (e) => e.hidden)) && (await page.$eval("#mh-bad", (e) => e.hidden)), "history: chart back");
    expect((await pts()) === "2025-03" && (await text(page, "#mh-total-val")).startsWith("100 m³ · "), "a chosen period: " + await pts() + " · " + await text(page, "#mh-total-val"));
    await page.reload({ waitUntil: "networkidle0" });
    await page.click("#history-btn"); await settle(200);
    expect(!(await page.$eval("#mh-cbox", (e) => e.hidden)) && (await v("mh-unit")) === "m3" && (await v("mh-from")) === "2025-03" && (await v("mh-to")) === "2025-06", "open, unit and period remembered");
    await page.select("#mh-unit", "bgn");
    expect((await page.$eval("#mh-svg", (s) => s.textContent)).includes("лв. с ДДС"), "leva axis");
    await page.click('.lang button[data-lang="en"]'); await settle(100);
    await page.click("#mh-list-toggle");
    const en = await page.$$eval("#mh-rows tr", (trs) => trs.map((tr) => tr.cells[0].textContent));
    expect(en[1] === "September 20262429 → 2445" && !/[А-я]/.test(await text(page, "#mh-panel")), "English: " + en.join(" | "));
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N36 history: saved months are folded at first; ✎ sits in its own last column, lined up on every row; saved months aren't offered to add", async () => {
    const H = { "2024-10": { start: 0, end: 41, date: null, bill: 53.71, billCur: "BGN" }, "2026-05": { start: 2390, end: 2410, date: null, bill: null }, ...SEPT };
    const page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": H } });
    await page.click("#history-btn");
    expect(await page.$eval("#mh-lbox", (e) => e.hidden) && (await text(page, "#mh-list-toggle")) === "Записани месеци (3)", "folded with a count: " + await text(page, "#mh-list-toggle"));
    await page.click("#mh-list-toggle");
    const xs = await page.$$eval("#mh-rows .mh-ed", (b) => b.map((e) => [e.closest("td") === e.closest("tr").lastElementChild, Math.round(e.getBoundingClientRect().left)]));
    expect(xs.length === 3 && xs.every((p) => p[0]) && new Set(xs.map((p) => p[1])).size === 1, "✎ last and lined up: " + JSON.stringify(xs));
    const r = await page.$eval("#menu", (m) => [m.scrollWidth <= m.clientWidth + 1]);
    expect(r[0], "the table fits the menu");
    await page.click("#mh-add");
    const opts = await page.$eval("#mh-month", (e) => [...e.options].map((o) => o.value));
    expect(!opts.some((o) => o in { "2024-10": 1, "2026-05": 1, "2026-09": 1 }) && opts[0] === "2026-08", "taken months not offered: " + opts.slice(0, 6).join());
    await page.click("#mh-cancel");
    await page.reload({ waitUntil: "networkidle0" });
    await page.click("#history-btn");
    expect(!(await page.$eval("#mh-lbox", (e) => e.hidden)), "open list remembered");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N37 forecast compared with the same month last year first, then last month – only when they are in the history", async () => {
    const cmp = (p) => p.$$eval("#cmp .cmp-row", (r) => r.map((e) => e.textContent));
    // No history: nothing.
    let page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    expect(await page.$eval("#cmp", (e) => e.hidden), "hidden without history");
    await page.close2();
    const H = { "2025-10": { start: 1500, end: 1549, date: null, bill: 43.1 }, ...SEPT };
    page = await open({ width: 390, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-months-v1": H } });
    // 30 m³ in 16 days → 58,1 m³ forecast: +19% on 49 m³, +263% on 16 m³.
    expect((await cmp(page)).join(" | ") === "↑ 19%спрямо октомври 2025› | ↑ 263%спрямо септември 2026›", "last year first, then last month: " + (await cmp(page)).join(" | "));
    expect(await page.$eval("#cmp-det-2025-10", (e) => e.hidden), "details folded");
    // The chevron stays on the row's first line, at its end, even on a narrow phone.
    for (const w of [390, 320]) {
      await page.setViewport({ width: w, height: 900 }); await settle(100);
      const ok = await page.$$eval("#cmp .cmp-row", (rs) => rs.every((r) => { const c = r.querySelector(".cmp-chev").getBoundingClientRect(), p = r.querySelector(".cmp-pct").getBoundingClientRect(), b = r.getBoundingClientRect();
        return Math.abs(c.top - p.top) < 6 && b.right - c.right < 4; }));
      expect(ok, "chevron on the first line at the end at " + w + "px");
    }
    await page.setViewport({ width: 390, height: 900 });
    await page.click("#cmp .cmp-row[data-m='2025-10']");
    expect((await text(page, "#cmp-det-2025-10")) === "≈ 58,1 m³ срещу 49 m³ · 51,90 € срещу 43,10 € (по сметка)Месечна история ›", "details: " + await text(page, "#cmp-det-2025-10"));
    await page.click("#cmp-det-2025-10 .cmp-hist"); await settle(400);
    expect(!(await page.$eval("#menu", (e) => e.hidden)) && !(await page.$eval("#mh-panel", (e) => e.hidden)) && !(await page.$eval("#mh-cbox", (e) => e.hidden)), "the link opens the monthly history with its chart");
    await page.click("#menu-close"); await settle(400);
    // Only last month in the history.
    await page.evaluate(() => { const m = JSON.parse(localStorage.getItem("gas-bill-months-v1")); delete m["2025-10"]; localStorage.setItem("gas-bill-months-v1", JSON.stringify(m)); });
    await page.reload({ waitUntil: "networkidle0" });
    expect((await cmp(page)).join(" | ") === "↑ 263%спрямо септември 2026›", "only last month: " + (await cmp(page)).join(" | "));
    // Fewer m³ than last year.
    await page.evaluate(() => { const f = JSON.parse(localStorage.getItem("gas-bill-forecast-v1")); f["cur-reading"] = "2460"; delete f["cur-stamp"]; localStorage.setItem("gas-bill-forecast-v1", JSON.stringify(f));
      const m = JSON.parse(localStorage.getItem("gas-bill-months-v1")); m["2025-10"] = { start: 1500, end: 1549, date: null, bill: null }; localStorage.setItem("gas-bill-months-v1", JSON.stringify(m)); });
    await page.reload({ waitUntil: "networkidle0" });
    expect((await cmp(page))[0].startsWith("↓ 41%спрямо октомври 2025"), "fewer m³: " + (await cmp(page)).join(" | "));
    await page.click('.lang button[data-lang="en"]'); await settle(100);
    expect((await cmp(page))[0] === "↓ 41%vs October 2025›", "English: " + (await cmp(page)).join(" | "));
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
    // No forecast (1st of the month, readings from different months): no comparison.
    for (const [st, now] of [[readings(2445, 2445, "2026-10-01", "2026-10-01"), "2026-10-01T12:00:00"], [readings(2445, 2489, "2024-10-31", "2026-10-17"), undefined]]) {
      page = await open({ width: 390, now, storage: { ...st, "gas-bill-months-v1": H } });
      expect(await page.$eval("#cmp", (e) => e.hidden), "hidden without a forecast: " + await text(page, "#out-days") + " / " + await page.$eval("#cur-date", (e) => e.value) + " / " + await text(page, "#cmp"));
      await page.close2();
    }
  });
  await test("sanity", "N38 phone: forecast, cost so far and both readings fit on the first screen; 'More below' shows while there is more", async () => {
    const H = { "2025-10": { start: 1300, end: 1418, date: null, bill: null }, ...SEPT };
    const page = await open({ width: 412, height: 790, storage: { ...readings(2445, 2489, "2026-10-01", "2026-10-22"), "gas-bill-months-v1": H, "gas-bill-breakdown-open": "1" } });
    const r = await page.evaluate(() => {
      const b = (s) => document.querySelector(s).getBoundingClientRect();
      return { readings: b(".readings").bottom, h: innerHeight, fc: b("#out-fc-eur").top, now: b("#out-now-eur").top, fcR: b("#out-fc-eur").right, nowL: b("#out-now-eur").left,
        wide: document.documentElement.scrollWidth > innerWidth, link: !!b("#head-tariff").height };
    });
    expect(r.readings <= r.h, "both readings above the fold: " + r.readings + " / " + r.h);
    expect(r.nowL > r.fcR && Math.abs(r.now - r.fc) < 30, "forecast and cost so far side by side: " + JSON.stringify(r));
    expect(!r.wide && r.link, "no sideways scroll; the tariff link stays");
    expect(!(await page.$eval("#scroll-hint", (e) => e.hidden)) && (await text(page, "#scroll-more")) === "" && (await page.$eval("#scroll-more", (e) => e.getAttribute("aria-label"))) === "Още отдолу", "hint (an arrow only) shown at the top");
    expect(await page.$eval("#scroll-hint-up", (e) => e.hidden), "no up arrow at the top");
    await page.click("#scroll-more"); await settle(400);
    expect(await page.evaluate(() => scrollY > 200), "a tap scrolls down");
    expect(!(await page.$eval("#scroll-hint-up", (e) => e.hidden)) && (await page.$eval("#scroll-up", (e) => e.getAttribute("aria-label"))) === "Още отгоре", "up arrow once scrolled");
    const y = await page.evaluate(() => scrollY);
    await page.click("#scroll-up"); await settle(400);
    expect(await page.evaluate((y) => scrollY < y, y), "a tap on the up arrow scrolls up");
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle(150);
    expect(await page.$eval("#scroll-hint", (e) => e.hidden), "hidden at the bottom");
    await page.evaluate(() => scrollTo(0, 0)); await settle(150);
    await page.click("#menu-btn"); await settle(100);
    expect(await page.$eval("#scroll-hint", (e) => e.hidden) && await page.$eval("#scroll-hint-up", (e) => e.hidden), "hidden while the menu is open");
    await page.click("#menu-close"); await settle(400);
    expect(!(await page.$eval("#scroll-hint", (e) => e.hidden)), "back after the menu closes");
    await page.click('.lang button[data-lang="en"]').catch(() => {});
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
    // Narrow phones (320 px, e.g. with display zoom) keep the two sums side by side.
    const n = await open({ width: 320, height: 640, storage: readings(2445, 2489, "2026-10-01", "2026-10-22") });
    expect(await n.evaluate(() => document.getElementById("out-now-eur").getBoundingClientRect().left > document.getElementById("out-fc-eur").getBoundingClientRect().right && document.documentElement.scrollWidth <= innerWidth), "side by side at 320 px");
    await n.close2();
    // Desktop with everything on screen: no hint.
    const d = await open({ width: 1280, height: 2000, storage: readings(2445, 2489, "2026-10-01", "2026-10-22") });
    expect(await d.$eval("#scroll-hint", (e) => e.hidden), "no hint when nothing is below");
    await d.close2();
  });
  await test("sanity", "N24 'Last updated' under today's reading when it wasn't changed today", async () => {
    const note = (p) => p.$eval("#cur-updated", (e) => e.hidden ? "" : e.textContent);
    // An older save without the stamp: the last day it was saved counts.
    let page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-15") });
    expect((await note(page)) === "Последно обновено: 15 октомври 2026 г.", "old reading: " + await note(page));
    expect((await page.$eval("#now-updated", (e) => e.hidden ? "" : e.textContent)) === "Последно обновено: 15 октомври 2026 г.", "also under the current cost");
    await page.click('.lang button[data-lang="en"]'); await settle(100);
    expect((await note(page)) === "Last updated: 15 October 2026", "English: " + await note(page));
    await page.click('.lang button[data-lang="bg"]'); await settle(100);
    await page.click("#cur-reading", { clickCount: 3 }); await page.type("#cur-reading", "2480"); await settle(100);
    expect((await note(page)) === "", "a new reading today hides it");
    await page.reload({ waitUntil: "networkidle0" });
    expect((await note(page)) === "" && (await page.$eval("#cur-reading", (e) => e.value)) === "2480", "still hidden after reopening today");
    await page.close2();
    // Saved today, opened two days later.
    const stamp = { ...readings(2445, 2475, "2026-10-01", "2026-10-17")["gas-bill-forecast-v1"], "cur-stamp": { value: "2475", date: "2026-10-17" } };
    page = await open({ now: "2026-10-19T09:00:00", storage: { "gas-bill-forecast-v1": stamp, "gas-bill-help-seen": "1" } });
    expect((await note(page)) === "Последно обновено: 17 октомври 2026 г.", "two days later: " + await note(page));
    await page.click("[data-clear=cur-reading]"); await settle(100);
    expect((await note(page)) === "", "no note for an empty field");
    await page.click("#toast-undo"); await settle(100);
    expect((await note(page)) === "Последно обновено: 17 октомври 2026 г.", "undo brings the old date back: " + await note(page));
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
    // Never shown during the guide.
    page = await open({ width: 390 });
    expect((await note(page)) === "", "hidden in the guide");
    await page.close2();
  });
  await test("sanity", "N23 guide wording; 'новото показание' opens the bill picture above the guide", async () => {
    const page = await open({ width: 390 });
    expect((await text(page, "#g-text")) === "В полето „ПОКАЗАНИЕ ДНЕС“ въвеждате числото от газомера в m³. За демонстрацията сме попълнили 163.", "step 1: " + await text(page, "#g-text"));
    await page.click("#g-next");
    expect((await text(page, "#g-text")) === "В полето „ПОКАЗАНИЕ ОТ ПОСЛЕДНАТА СМЕТКА“ въведете числото от последната ви сметка от Овергаз – от полето „новото показание“. За демонстрацията сме попълнили 127.", "step 2: " + await text(page, "#g-text"));
    await page.click(".g-bill");
    expect(!(await page.$eval("#bill-view", (e) => e.hidden)), "bill picture opens");
    await page.waitForFunction(() => { const i = document.querySelector("#bill-view img"); return i.complete && i.naturalWidth === 1188; }, { timeout: 5000 });
    expect(await page.evaluate(() => { const r = document.querySelector("#bill-view img").getBoundingClientRect(); return r.width > 300 && r.right <= innerWidth; }), "picture fits the phone");
    await page.keyboard.press("Escape");
    expect((await page.$eval("#bill-view", (e) => e.hidden)) && !(await page.$eval("#guide", (e) => e.hidden)), "Escape closes the picture, the guide stays");
    await page.click(".g-bill"); await page.click("#bill-view-close");
    expect((await page.$eval("#bill-view", (e) => e.hidden)) && (await text(page, "#g-title")).startsWith("2"), "× closes it, still on step 2");
    await page.click("#g-next");
    expect(/^В секцията „Прогнозна сметка до .+“ виждате цената на текущото ви потребление \(163 − 127 = 36 m³\) и прогнозната сметка\.$/.test(await text(page, "#g-text")), "step 3: " + await text(page, "#g-text"));
    await page.click("#g-next");
    expect((await text(page, "#g-text")).startsWith("В менюто ☰ може да намерите настройки за тарифите"), "step 4");
    expect(!page.errors.length, page.errors.join(" | "));
    await page.close2();
  });
  await test("sanity", "N22 'Tariff settings' under the title opens the menu with the tariff settings expanded", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    expect((await text(page, "#head-tariff")) === "Тарифни настройки", "link text");
    await page.click("#head-tariff");
    expect(!(await page.$eval("#menu", (e) => e.hidden)), "menu opens");
    expect((await page.$eval("#tariff-toggle", (e) => e.getAttribute("aria-expanded"))) === "true", "tariff settings expanded");
    expect(await page.$eval("#region", (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "region choice visible");
    await page.click("#tariff-toggle");
    expect((await page.$eval("#tariff-toggle", (e) => e.getAttribute("aria-expanded"))) === "false", "Hide still collapses it in the menu");
    await page.close2();
  });
  await test("sanity", "N21 ☰ menu slides in and out", async () => {
    const page = await open({ width: 390, motion: true, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    const x = () => page.$eval("#menu", (m) => m.hidden ? "hidden" : Math.round(m.getBoundingClientRect().left));
    await page.click("#menu-btn");
    const start = await x(); await settle(450);
    expect(typeof start === "number" && start < 0 && (await x()) === 0, `slides in: ${start} → ${await x()}`);
    await page.keyboard.press("Escape");
    const mid = await x(); await settle(450);
    expect(mid !== "hidden" && (await x()) === "hidden", "slides out, then hides");
    await page.close2();
  });
  await test("sanity", "N20 header shows this month's price incl. VAT, per MWh and per m³ (bg, en)", async () => {
    for (const lang of ["bg", "en"]) {
      const page = await open({ storage: { ...readings(2445, 2480, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
      const h = await text(page, "#head-price");
      // 68,90 €/MWh excl. VAT + 20% = 82,68; × 10,8 kWh/m³ = 0,893 €/m³ (built-in October 2026 values).
      expect(lang === "bg" ? /октомври 2026: 82,68 €\/MWh с ДДС · ≈ 0,893 €\/m³ · Овергаз Мрежи/.test(h)
        : /October 2026 price: €82\.68\/MWh incl\. VAT · ≈ €0\.893\/m³ · Overgas Mrezhi/.test(h), lang + ": " + h);
      await page.close2();
    }
  });
  await test("sanity", "N11 chart remembers its period and currency after reopening", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#chart-btn"); await settle(1200);
    await page.select("#chart-from", "2020"); await page.select("#chart-to", "2023"); await page.select("#chart-cur", "BGN");
    await page.reload({ waitUntil: "networkidle0" });
    await page.click("#chart-btn"); await settle(1200);
    const v = await page.evaluate(() => ["chart-from", "chart-to", "chart-cur"].map((id) => document.getElementById(id).value).join("|"));
    expect(v === "2020|2023|BGN", "after reload: " + v);
    expect(/2020.*2023/.test(await page.$eval("#chart-svg", (s) => s.getAttribute("aria-label"))), "chart drawn for the saved years");
    expect((await text(page, "#chart-sub")).includes("лв./MWh"), "chart drawn in the saved currency");
    await page.close2();
  });
  await test("sanity", "N8 update bar: What's new and close", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.evaluate(() => { document.getElementById("update-bar").hidden = false; });
    await page.click("#update-notes-link"); await settle(500);
    expect(/Версия|Подобрения/.test(await text(page, "#update-notes")), "notes appear on click");
    await page.click("#update-dismiss");
    expect(await page.$eval("#update-bar", (el) => el.hidden), "× hides the bar");
    await page.close2();
  });
  await test("sanity", "N9 help panel: bill example and update check", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#help-btn");
    await page.click(".bill-link");
    expect(!(await page.$eval("#bill-example", (el) => el.hidden)), "bill example opens");
    expect(await page.$eval("#bill-example img", (i) => i.complete && i.naturalWidth > 0), "bill image loads");
    await page.click("#check-update");
    expect((await text(page, "#check-update-msg")).length > 0, "update check answers");
    await page.close2();
  });
}

// ======================================================================
// REGRESSION — real bills, numbers and layouts that broke before
// ======================================================================
async function regression() {
  await test("regression", "R1 September 2026 bill = 13,61 € (2429 → 2445)", async () => {
    const page = await open({ storage: readings(2429, 2445, "2026-09-01", "2026-10-01"), now: "2026-10-01T12:00:00" });
    await settle(800);
    near(num(await text(page, "#t-tot-fc")), 13.61, 0.005, "total");
    near(num(await text(page, "#t-net-fc")), 11.34, 0.005, "before VAT");
    expect((await text(page, "#t-energy-label")).includes("10,76"), "kWh/m³ 10,76");
    await page.close2();
  });
  await test("regression", "R2 January 2026 bill = 202,64 € ±1 ct (1620 → 1901)", async () => {
    const page = await open({ storage: readings(1620, 1901, "2026-01-01", "2026-02-01"), now: "2026-02-01T12:00:00" });
    await settle(800);
    near(num(await text(page, "#t-tot-fc")), 202.64, 0.011, "total");
    expect((await text(page, "#t-energy-label")).includes("10,74"), "kWh/m³ 10,74");
    await page.close2();
  });
  await test("regression", "R3 October 2026 example: 26,79 € so far, 51,90 € forecast", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    near(num(await text(page, "#out-now-eur")), 26.79, 0.005, "so far");
    near(num(await text(page, "#out-fc-eur")), 51.90, 0.005, "forecast");
    expect((await text(page, "#out-forecast-label")).includes("1-ви ноември"), "ordinal date in label");
    await page.close2();
  });
  await test("regression", "R4 months up to November 2024 add the 1,60 € supply fee", async () => {
    const page = await open({ storage: readings(1000, 1100, "2024-10-01", "2024-11-01"), now: "2024-11-01T12:00:00" });
    await settle(800);
    expect(!(await page.$eval("#t-fee-row", (el) => el.hidden)), "fee row shown");
    near(num(await text(page, "#t-fee-fc")), 1.60, 0.005, "fee");
    await page.close2();
  });
  await test("regression", "R5 typed price overrides; Restore default price brings it back", async () => {
    const page = await open({ storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-tariff-open": "1" } });
    await page.click("#menu-btn");
    await page.type("#override", "100"); await settle(100);
    expect((await text(page, "#final-price")) === "100,00", "typed price used");
    await page.click("#reset"); await settle(100);
    expect((await text(page, "#final-price")) === "68,90", "Overgas price back");
    await page.close2();
  });
  await test("regression", "R6 chart: September 2026 = 79,07 € / 154,64 лв. per MWh incl. VAT", async () => {
    const page = await open({ storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    await page.click("#chart-btn"); await settle(1200);
    const hover = () => page.evaluate(() => {
      const hit = document.getElementById("chart-hit"), r = hit.getBoundingClientRect();
      // second to last month = September 2026
      const n = (2026 - 2018) * 12 + 10, x = r.left + r.width * ((n - 2) / (n - 1));
      hit.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: r.top + 20, bubbles: true }));
      return document.getElementById("chart-tip").innerText;
    });
    expect(/септември 2026[\s\S]*79,07/.test(await hover()), "EUR value");
    const dots = await page.$$eval("#chart-svg .chart-pt", (c) => c.map((e) => e.dataset.m));
    expect(dots.includes("2026-09") && dots.length === (await page.$$eval("#chart-svg .chart-pt", (c) => new Set(c.map((e) => e.dataset.m)).size)) && dots.length > 50, "a dot per month with a price: " + dots.length);
    await page.select("#chart-cur", "BGN"); await settle(200);
    expect(/154,64[\s\S]*128,87/.test(await hover()), "BGN value and price without VAT");
    await page.close2();
  });
  await test("regression", "R7 English shows region names in Latin letters", async () => {
    const page = await open({ storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": "en" } });
    const opts = await page.$$eval("#region option", (o) => o.map((x) => x.textContent));
    expect(opts.includes("Overgas Mrezhi") && opts.every((o) => !/[а-яА-Я]/.test(o)), "options: " + opts.join(", "));
    expect((await page.$eval("#region", (s) => s.value)) === "Овергаз Мрежи", "stored value stays Bulgarian");
    await page.close2();
  });
  await test("regression", "R8 the ☰ menu holds every setting and action, in order", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    const order = await page.evaluate(() => [...document.querySelectorAll("#menu .menu-item, #menu .lang, #menu .themes, #menu section.tariff")].map((e) => e.id || e.className.split(" ")[0]).join(",")
      + (document.querySelector(".main section.tariff") ? " + tariff on the page" : ""));
    expect(order === "tariff,lang,themes,history-btn,chart-btn,share-btn,backup-btn,help-btn,menu-guide", "order " + order);
    await page.close2();
  });
  // Layout matrix: every width × theme × language — nothing may scroll sideways or leave its card.
  const widths = [1280, 412, 360, 320, 277];
  for (const w of widths) for (const lang of ["bg", "en"]) {
    await test("regression", `R9 layout fits at ${w}px (${lang}, all themes, chart and panels open)`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang, "gas-bill-breakdown-open": "1",
        "gas-bill-months-v1": { "2026-09": { start: 2429, end: 2445, date: "2026-09-28", bill: 13.61 }, "2026-08": { start: 12420, end: 12429.5, date: null, bill: 107.4 } }, "gas-bill-history-view": { chart: true, list: true, unit: "eur" } } });
      await page.click("#chart-btn"); await page.click("#help-btn"); await page.click("#tariff-toggle"); await page.click("#history-btn"); await page.click(".mh-ed[data-m='2026-09']"); await settle(1200);
      for (const th of ["dark", "light", "blue", "contrast"]) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(80);
        const r = await page.evaluate((phone) => {
          const W = document.documentElement.clientWidth;
          const out = { pageWide: document.documentElement.scrollWidth > W + 1 };
          const sc = document.querySelector(".table-scroll"); out.tableShown = sc.getClientRects().length > 0; out.tableScrolls = sc.scrollWidth > sc.clientWidth + 1;
          const cards = [".bill", ".readings", ".tariff", ".breakdown", "#chart-panel", "#mh-panel", "#about"];
          out.outside = [];
          for (const c of cards) {
            const card = document.querySelector(c); if (!card || card.hidden) continue;
            const cr = card.getBoundingClientRect();
            for (const el of card.querySelectorAll("*")) {
              if (!el.getClientRects().length || el.closest("svg") || el.closest(".tip")) continue;
              if (el.getBoundingClientRect().right > cr.right + 1) { out.outside.push(c + " > " + (el.id || el.className || el.tagName)); break; }
            }
          }
          if (phone) {
            const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
            const m = document.getElementById("menu-btn").getBoundingClientRect(), h = document.querySelector("header h1").getBoundingClientRect();
            out.headerOneLine = m.top < h.bottom && h.top < m.bottom && m.right <= h.left;
            out.chartControlsOneRow = [...document.querySelectorAll(".chart-controls")].filter((c) => c.getClientRects().length).every((c) => {
              const sels = [...c.querySelectorAll("select")].map(mid); return Math.max(...sels) - Math.min(...sels) < 4; });
          }
          return out;
        }, w < 500);
        expect(!r.pageWide, `${th}: page scrolls sideways`);
        expect(r.tableShown, `${th}: breakdown table not shown`);
        expect(!r.tableScrolls, `${th}: breakdown table scrolls`);
        expect(!r.outside.length, `${th}: outside its card: ${r.outside.join(", ")}`);
        if (w < 500) {
          expect(r.headerOneLine, `${th}: header controls not on one line`);
          expect(r.chartControlsOneRow, `${th}: chart controls not on one row`);
        }
      }
      expect(!page.errors.length, page.errors.join(" | "));
      await page.close2();
    });
  }
}

// ======================================================================
// UI — themes, language and layout, each on desktop and on a phone
// ======================================================================
const DEVICES = [["desktop", 1280], ["phone", 390]];
const THEMES = { dark: "rgb(15, 20, 26)", light: "rgb(238, 241, 244)", blue: "rgb(10, 26, 51)", contrast: "rgb(0, 0, 0)" };

// WCAG contrast of every visible text element against the background behind it.
const lowContrast = (page, min) => page.evaluate((min) => {
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return rgb(getComputedStyle(document.body).backgroundColor); };
  const bad = [];
  for (const el of document.querySelectorAll("h1, h2, .label, .num, td, p, button, a, .date-text, option, .chip, .tariff-summary span")) {
    if (!el.getClientRects().length || !el.textContent.trim() || el.closest("[hidden]") || el.disabled || el.closest("svg")) continue;
    const s = getComputedStyle(el); if (s.visibility === "hidden" || +s.opacity < 0.5) continue;
    const a = lum(rgb(s.color)), b = lum(bgOf(el)), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < min) bad.push(`${el.id || el.className || el.tagName} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`);
  }
  return bad;
}, min);

async function ui() {
  for (const [dev, w] of DEVICES) {
    // ---- themes ----
    await test("ui", `T1 each theme paints the page and is remembered (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      for (const [th, bg] of Object.entries(THEMES)) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(60);
        const r = await page.evaluate(() => ({
          bg: getComputedStyle(document.body).backgroundColor,
          meta: document.querySelector('meta[name="theme-color"]').content,
          pressed: [...document.querySelectorAll(".themes button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.themeChoice),
        }));
        expect(r.bg === bg, `${th}: page background ${r.bg}, expected ${bg}`);
        expect(r.pressed.length === 1 && r.pressed[0] === th, `${th}: marked as selected`);
        expect(/^#/.test(r.meta), `${th}: phone status bar colour set`);
      }
      await page.click('.themes button[data-theme-choice="light"]');
      await page.reload({ waitUntil: "networkidle0" });
      expect((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === THEMES.light, "last chosen theme (light) remembered");
      await page.close2();
    });
    await test("ui", `T2 update bar and help follow the theme (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      await page.click("#help-btn");
      await page.evaluate(() => { document.getElementById("update-bar").hidden = false; });
      for (const th of Object.keys(THEMES)) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(60);
        const c = await page.evaluate(() => ["#update-bar", "#menu", ".bill"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor));
        expect(c[0] === c[2] && c[1] === c[2], `${th}: update bar ${c[0]}, help ${c[1]}, cards ${c[2]}`);
      }
      await page.close2();
    });
    await test("ui", `T3 text is readable in every theme (contrast, ${dev})`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-tariff-open": "1", "gas-bill-breakdown-open": "1" } });
      await page.click("#help-btn"); await page.click("#chart-btn"); await settle(1000);
      for (const th of Object.keys(THEMES)) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(60);
        const bad = await lowContrast(page, 3);
        expect(!bad.length, `${th}: low contrast: ${bad.slice(0, 4).join("; ")}`);
      }
      await page.close2();
    });

    // ---- language ----
    for (const lang of ["bg", "en"]) {
      await test("ui", `L1 ${lang === "bg" ? "Bulgarian" : "English"}: every text, number and date in the right language (${dev})`, async () => {
        const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
        const r = await page.evaluate(() => ({
          lang: document.documentElement.lang, title: document.title,
          empty: [...document.querySelectorAll("[data-i18n]")].filter((el) => !el.textContent.trim()).map((el) => el.dataset.i18n),
          now: document.getElementById("out-now-eur").textContent, bgn: document.getElementById("out-now-bgn").textContent,
          date: document.getElementById("cur-date-text").textContent, label: document.getElementById("out-forecast-label").textContent,
          pressed: document.querySelector('.lang button[aria-pressed="true"]')?.dataset.lang,
        }));
        expect(r.lang === lang && r.pressed === lang, `page language ${r.lang}, selected flag ${r.pressed}`);
        expect(!r.empty.length, "empty texts: " + r.empty.join(", "));
        if (lang === "bg") {
          expect(r.title === "Консумация на газ", "title " + r.title);
          expect(r.now === "26,79 €" && r.bgn.startsWith("52,39 лв."), `money ${r.now} / ${r.bgn}`);
          expect(r.date.startsWith("17 октомври 2026") && r.label.includes("1-ви ноември"), `dates ${r.date} / ${r.label}`);
        } else {
          expect(r.title === "Gas Consumption", "title " + r.title);
          expect(r.now === "€26.79" && r.bgn.startsWith("52.39 lv."), `money ${r.now} / ${r.bgn}`);
          expect(r.date === "17 October 2026" && r.label.includes("1st Nov"), `dates ${r.date} / ${r.label}`);
        }
        await page.close2();
      });
    }
    await test("ui", `L2 switching language updates open panels and is remembered (${dev})`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-tariff-open": "1" } });
      await page.click("#chart-btn"); await page.click("#help-btn"); await settle(1000);
      await page.click('.lang button[data-lang="en"]'); await settle(200);
      const en = await page.evaluate(() => [document.getElementById("chart-panel").getAttribute("aria-label"), document.getElementById("tariff-toggle").textContent, document.getElementById("check-update").textContent]);
      expect(en.join("|") === "Historical gas prices|Hide|Check for updates", "open panels in English: " + en.join(" | "));
      await page.reload({ waitUntil: "networkidle0" });
      expect((await page.evaluate(() => document.documentElement.lang)) === "en", "English remembered");
      await page.click('.lang button[data-lang="bg"]');
      expect((await text(page, "#tariff-toggle")) === "Скрий", "back to Bulgarian");
      await page.close2();
    });

    // ---- UI ----
    await test("ui", `U1 layout order is right: bill → readings → breakdown in one column (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      const box = await page.evaluate(() => Object.fromEntries([".bill", ".readings", ".breakdown"].map((s) => {
        const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: Math.round(r.left), y: Math.round(r.top) }];
      })));
      expect(box[".bill"].y < box[".readings"].y && box[".readings"].y < box[".breakdown"].y, "bill → readings → breakdown");
      expect(box[".bill"].x === box[".readings"].x && box[".bill"].x === box[".breakdown"].x, "one column");
      const order = await page.$$eval(".readings .label", (l) => l.map((x) => x.textContent));
      expect(order[0] === "Показание днес", "today's reading first");
      await page.close2();
    });
    await test("ui", `U2 every button has a name and is big enough to tap (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      await page.click("#help-btn");
      const r = await page.evaluate(() => [...document.querySelectorAll("button, select, a[href]")].filter((el) => el.getClientRects().length && !el.closest("[hidden]")).map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.id || el.className || el.textContent.trim().slice(0, 15), named: !!(el.getAttribute("aria-label") || el.textContent.trim() || el.labels?.length), w: b.width, h: b.height, inline: el.tagName === "A" };
      }));
      const unnamed = r.filter((x) => !x.named).map((x) => x.id);
      expect(!unnamed.length, "no name: " + unnamed.join(", "));
      const small = r.filter((x) => !x.inline && (x.w < 24 || x.h < 22)).map((x) => `${x.id} ${Math.round(x.w)}×${Math.round(x.h)}`);
      expect(!small.length, "too small to tap: " + small.join(", "));
      await page.close2();
    });
    await test("ui", `U3 panels open and close: tariff, breakdown, chart, help, bill example (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      const hidden = (s) => page.$eval(s, (el) => el.hidden || el.classList.contains("collapsed"));
      await page.click("#tariff-toggle"); expect(!(await hidden(".tariff")), "tariff opens");
      await page.click("#tariff-toggle"); expect(await hidden(".tariff"), "tariff closes");
      expect(await hidden(".breakdown"), "breakdown closed by default");
      await page.click("#breakdown-toggle"); expect(!(await hidden(".breakdown")), "breakdown opens");
      await page.click("#breakdown-toggle"); expect(await hidden(".breakdown"), "breakdown closes");
      await page.click("#chart-btn"); await settle(800); expect(!(await hidden("#chart-panel")), "chart opens");
      await page.click("#chart-btn"); expect(await hidden("#chart-panel"), "chart closes with its menu item");
      await page.click("#help-btn"); expect(!(await hidden("#about")), "help opens");
      await page.click(".bill-link"); expect(!(await hidden("#bill-example")), "bill example opens");
      await page.click("#help-btn"); expect(await hidden("#about"), "help closes with its menu item");
      expect(await hidden("#bill-example"), "bill example closes with the help");
      expect(!page.errors.length, page.errors.join(" | "));
      await page.close2();
    });
    await test("ui", `U5 × inside each meter, ⇅ between the two cards without covering anything (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2480, "2026-10-01", "2026-10-17") });
      const r = await page.evaluate(() => {
        const box = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
        const [c1, c2] = [...document.querySelectorAll(".reading")].map(box);
        const sw = box(document.getElementById("swap-btn"));
        const clrInDial = [...document.querySelectorAll(".clr")].every((b) => { const d = box(b.closest(".dial")), x = box(b); return x.left >= d.left && x.right <= d.right && x.top >= d.top && x.bottom <= d.bottom; });
        const hits = [...document.querySelectorAll(".reading input, .reading .date-field, .reading button, .reading .label")].filter((el) => {
          const b = box(el); return b.width && !(b.right <= sw.left || b.left >= sw.right || b.bottom <= sw.top || b.top >= sw.bottom);
        }).map((el) => el.id || el.className);
        const cx = sw.left + sw.width / 2, cy = sw.top + sw.height / 2;
        return { clrInDial, hits, c1, c2, cx, cy };
      });
      expect(r.clrInDial, "× is inside its meter field");
      expect(!r.hits.length, "⇅ covers: " + r.hits.join(", "));
      if (dev === "desktop") expect(r.cx > r.c1.right - 30 && r.cx < r.c2.left + 30, "⇅ sits between the cards side by side");
      else expect(Math.abs(r.cy - (r.c1.bottom + r.c2.top) / 2) < 3, "⇅ sits centred between the stacked cards");
      await page.close2();
    });
    await test("ui", `U4 ☰ opens a panel from the left that fits the screen and closes (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      await page.click("#menu-btn");
      const r = await page.evaluate(() => {
        const m = document.getElementById("menu"), b = m.getBoundingClientRect();
        return { open: !m.hidden, left: b.left, right: b.right, w: innerWidth, scroll: m.scrollWidth > m.clientWidth + 1,
          expanded: document.getElementById("menu-btn").getAttribute("aria-expanded"), sum: document.getElementById("tariff-summary").textContent };
      });
      expect(r.open && r.expanded === "true", "menu opens");
      expect(r.left === 0 && r.right < r.w, "menu sits on the left, narrower than the screen");
      expect(!r.scroll, "menu scrolls sideways");
      expect(/€\/MWh/.test(r.sum), "tariff line shows the price: " + r.sum);
      await page.click('.themes button[data-theme-choice="light"]');
      expect(!(await page.$eval("#menu", (e) => e.hidden)), "theme choice keeps the menu open");
      await page.keyboard.press("Escape");
      expect(await page.$eval("#menu", (e) => e.hidden), "Escape closes the menu");
      await page.click("#share-btn"); await settle(300);
      expect(await page.$eval("#menu", (e) => e.hidden), "share closes the menu");
      await page.click("#chart-btn"); await settle(800);
      expect(!(await page.$eval("#menu", (e) => e.hidden)) && (await page.$eval("#chart-panel", (e) => !e.hidden && !!e.closest("#menu"))), "the price archive opens inside the menu");
      await page.click("#tariff-toggle");
      expect(await page.$eval("#tariff-toggle", (e) => e.getAttribute("aria-expanded")) === "true" && !(await page.$eval("#menu", (e) => e.hidden)), "tariff settings open inside the menu");
      expect(!page.errors.length, page.errors.join(" | "));
      await page.close2();
    });
  }
}

// ---------- run ----------
server.listen(PORT, "127.0.0.1", async () => {
  if (!CHROME) { console.error("Chrome not found; set CHROME_PATH"); process.exit(2); }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--disable-gpu"] });
  try { await smoke(); await sanity(); await ui(); await regression(); }
  finally { await browser.close(); server.close(); }
  let failed = 0;
  for (const s of ["smoke", "sanity", "ui", "regression"]) {
    const rs = results.filter((r) => r.suite === s);
    if (!rs.length) continue;
    console.log(`\n${s.toUpperCase()}  ${rs.filter((r) => r.ok).length}/${rs.length} passed`);
    for (const r of rs) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "\n        → " + r.err}`);
      if (!r.ok) failed++;
    }
  }
  console.log(`\n${failed ? failed + " FAILED" : "ALL PASSED"} (${results.length} tests, app ${swVersion()})`);
  process.exit(failed ? 1 : 0);
});
