// Test suite for Gas Consumption: smoke, sanity, ui (themes/language/layout on desktop and phone) and regression.
// Run before every push:  npm test   (or: node tests/run.mjs [smoke|sanity|ui|regression])
// Serves the project locally and drives the installed Chrome in headless mode (puppeteer-core).
import http from "node:http";
import fs from "node:fs";
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
async function open({ width = 1280, height = 900, storage = {}, waitChart = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g/.test(m.text())) errors.push("console: " + m.text()); });
  await page.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
  await page.evaluateOnNewDocument((items) => {
    if (sessionStorage.getItem("__seeded")) return;
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    sessionStorage.setItem("__seeded", "1");
  }, storage);
  await page.goto(URL, { waitUntil: "networkidle0" });
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
  await test("smoke", "S6 new visitor: empty readings and the help opens once", async () => {
    const page = await open({ width: 390 });
    expect(!(await page.$eval("#about", (el) => el.hidden)), "help is open on the first visit");
    expect((await page.$eval("#cur-reading", (el) => el.value)) === "", "today's reading is empty");
    expect((await text(page, "#out-days")).length > 10, "explains what to enter");
    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.$eval("#about", (el) => el.hidden), "help stays closed on the second visit");
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
    expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark by default");
    for (const th of ["light", "blue", "contrast", "dark"]) {
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
    await page.click("#chart-close");
    expect(await page.$eval("#chart-panel", (el) => el.hidden), "closes");
    await page.close2();
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
    const page = await open({ storage: readings(2429, 2445, "2026-09-01", "2026-10-01") });
    await settle(800);
    near(num(await text(page, "#t-tot-fc")), 13.61, 0.005, "total");
    near(num(await text(page, "#t-net-fc")), 11.34, 0.005, "before VAT");
    expect((await text(page, "#t-energy-label")).includes("10,76"), "kWh/m³ 10,76");
    await page.close2();
  });
  await test("regression", "R2 January 2026 bill = 202,64 € ±1 ct (1620 → 1901)", async () => {
    const page = await open({ storage: readings(1620, 1901, "2026-01-01", "2026-02-01") });
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
    const page = await open({ storage: readings(1000, 1100, "2024-10-01", "2024-11-01") });
    await settle(800);
    expect(!(await page.$eval("#t-fee-row", (el) => el.hidden)), "fee row shown");
    near(num(await text(page, "#t-fee-fc")), 1.60, 0.005, "fee");
    await page.close2();
  });
  await test("regression", "R5 typed price overrides; Restore default price brings it back", async () => {
    const page = await open({ storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-tariff-open": "1" } });
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
  await test("regression", "R8 '?' is the last header control", async () => {
    const page = await open({ width: 390, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
    const last = await page.evaluate(() => {
      // Order by row (vertical middle), then left to right; controls differ in height.
      const els = [...document.querySelectorAll(".prefs > :not([hidden])")].map((el) => {
        const r = el.getBoundingClientRect(); return { id: el.id || el.className, mid: Math.round((r.top + r.height / 2) / 8), left: r.left };
      });
      els.sort((a, b) => a.mid - b.mid || a.left - b.left);
      return els[els.length - 1].id;
    });
    expect(last === "help-btn", "last control is " + last);
    await page.close2();
  });
  // Layout matrix: every width × theme × language — nothing may scroll sideways or leave its card.
  const widths = [1280, 412, 360, 320, 277];
  for (const w of widths) for (const lang of ["bg", "en"]) {
    await test("regression", `R9 layout fits at ${w}px (${lang}, all themes, chart and panels open)`, async () => {
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang, "gas-bill-breakdown-open": "1" } });
      await page.click("#chart-btn"); await page.click("#help-btn"); await page.click("#tariff-toggle"); await settle(1200);
      for (const th of ["dark", "light", "blue", "contrast"]) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(80);
        const r = await page.evaluate((phone) => {
          const W = document.documentElement.clientWidth;
          const out = { pageWide: document.documentElement.scrollWidth > W + 1 };
          const sc = document.querySelector(".table-scroll"); out.tableShown = sc.getClientRects().length > 0; out.tableScrolls = sc.scrollWidth > sc.clientWidth + 1;
          const cards = [".bill", ".readings", ".tariff", ".breakdown", "#chart-panel", "#about"];
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
            const prefs = [...document.querySelectorAll(".prefs > :not([hidden])")].map(mid);
            out.headerOneLine = Math.max(...prefs) - Math.min(...prefs) < 4;
            const sels = [...document.querySelectorAll(".chart-controls select")].map(mid);
            out.chartControlsOneRow = Math.max(...sels) - Math.min(...sels) < 4;
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
        const c = await page.evaluate(() => ["#update-bar", "#about", ".bill"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor));
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
      const en = await page.evaluate(() => [document.getElementById("chart-h").textContent, document.getElementById("tariff-toggle").textContent, document.getElementById("check-update").textContent]);
      expect(en.join("|") === "Historical gas prices|Hide|Check for updates", "open panels in English: " + en.join(" | "));
      await page.reload({ waitUntil: "networkidle0" });
      expect((await page.evaluate(() => document.documentElement.lang)) === "en", "English remembered");
      await page.click('.lang button[data-lang="bg"]');
      expect((await text(page, "#tariff-toggle")) === "Скрий", "back to Bulgarian");
      await page.close2();
    });

    // ---- UI ----
    await test("ui", `U1 layout order is right (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      const box = await page.evaluate(() => Object.fromEntries([".bill", ".readings", ".tariff", ".breakdown"].map((s) => {
        const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: Math.round(r.left), y: Math.round(r.top) }];
      })));
      if (dev === "desktop") {
        expect(box[".tariff"].x < box[".bill"].x, "tariff in the left column");
        expect(box[".bill"].y < box[".readings"].y && box[".readings"].y < box[".breakdown"].y, "bill → readings → breakdown on the right");
      } else {
        const ys = [".bill", ".readings", ".tariff", ".breakdown"].map((s) => box[s].y);
        expect(ys.every((y, i) => i === 0 || y > ys[i - 1]), "phone order: bill → readings → tariff → breakdown");
        const order = await page.$$eval(".readings .label", (l) => l.map((x) => x.textContent));
        expect(order[0] === "Показание днес", "today's reading first");
      }
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
      await page.click("#chart-btn"); expect(await hidden("#chart-panel"), "chart closes with its button");
      await page.click("#help-btn"); expect(!(await hidden("#about")), "help opens");
      await page.click(".bill-link"); expect(!(await hidden("#bill-example")), "bill example opens");
      await page.click("#about-close"); expect(await hidden("#about"), "help closes with ×");
      expect(await hidden("#bill-example"), "bill example closes with the help");
      expect(!page.errors.length, page.errors.join(" | "));
      await page.close2();
    });
    await test("ui", `U4 header controls sit on one line, '?' last (${dev})`, async () => {
      const page = await open({ width: w, storage: readings(2445, 2475, "2026-10-01", "2026-10-17") });
      const r = await page.evaluate(() => {
        const els = [...document.querySelectorAll(".prefs > :not([hidden])")].map((el) => { const b = el.getBoundingClientRect(); return { id: el.id || el.className, mid: b.top + b.height / 2, left: b.left }; });
        return { spread: Math.max(...els.map((e) => e.mid)) - Math.min(...els.map((e) => e.mid)), last: els.sort((a, b) => a.left - b.left).pop().id };
      });
      expect(r.spread < 4, "controls on more than one line");
      expect(r.last === "help-btn", "last control is " + r.last);
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
