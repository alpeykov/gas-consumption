// Test suite for Gas Consumption: smoke, sanity and regression.
// Run before every push:  npm test   (or: node tests/run.mjs [smoke|sanity|regression])
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
      const page = await open({ width: w, storage: { ...readings(2445, 2475, "2026-10-01", "2026-10-17"), "gas-bill-lang": lang } });
      await page.click("#chart-btn"); await page.click("#help-btn"); await page.click("#tariff-toggle"); await settle(1200);
      for (const th of ["dark", "light", "blue", "contrast"]) {
        await page.click(`.themes button[data-theme-choice="${th}"]`); await settle(80);
        const r = await page.evaluate((phone) => {
          const W = document.documentElement.clientWidth;
          const out = { pageWide: document.documentElement.scrollWidth > W + 1 };
          const sc = document.querySelector(".table-scroll"); out.tableScrolls = sc.scrollWidth > sc.clientWidth + 1;
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

// ---------- run ----------
server.listen(PORT, "127.0.0.1", async () => {
  if (!CHROME) { console.error("Chrome not found; set CHROME_PATH"); process.exit(2); }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--disable-gpu"] });
  try { await smoke(); await sanity(); await regression(); }
  finally { await browser.close(); server.close(); }
  let failed = 0;
  for (const s of ["smoke", "sanity", "regression"]) {
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
