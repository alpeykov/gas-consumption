// Temporary: mockups of a denser phone layout (forecast, current cost and both readings above the fold) + a scroll hint. Not shipped.
import puppeteer from "puppeteer-core";
import http from "http"; import fs from "fs"; import path from "path";
const root = "C:/Projects/GasConsumption", out = process.argv[2];
const backup = JSON.parse(fs.readFileSync(root + "/gas-consumption-backup-2026-10-22.json", "utf8")).data;
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith(path.sep) || f.endsWith("/")) f += "index.html";
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); r.end(d); }); }).listen(8780);
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: exe });

// Scroll hint: a fade at the bottom edge with a small "more" chip, shown while there is more page below.
const HINT_CSS = `
.scroll-hint { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; pointer-events: none; z-index: 30;
  background: linear-gradient(to bottom, transparent, var(--bg) 85%); display: flex; align-items: flex-end; justify-content: center; padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
.scroll-hint span { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; font: 600 12px var(--font-body); color: var(--fg);
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px 4px 10px; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
.scroll-hint svg { width: 14px; height: 14px; color: var(--flame); }
`;
const HINT_HTML = '<div class="scroll-hint"><span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Още отдолу</span></div>';

const SMALL = `
body { font-size: 13.5px; }
.wrap { padding-block: 12px 40px; gap: 12px; }
.main { gap: 12px; }
header h1 { font-size: 1.3rem; }
header p { margin-top: 2px; font-size: 0.85rem; line-height: 1.35; }
.menu-btn { width: 36px; height: 36px; }
.bill { padding: 14px 16px; gap: 6px; }
.fc-big, .bill .fc-big { font-size: 2.1rem; }
.fc-sub { font-size: 0.85rem; }
.cmp { padding-top: 4px; gap: 0; }
.cmp-row { min-height: 30px; padding: 2px 0; }
.cmp-pct { font-size: 0.95rem; }
.cmp-what { font-size: 0.85rem; }
.sofar { padding-top: 8px; margin-top: 2px; }
.sofar-val b { font-size: 1.2rem; }
.tl { margin-top: 22px; }
.reading { padding: 10px 12px; gap: 6px; }
.dial { padding: 3px 8px; }
.dial input { font-size: 1.25rem; }
.date-field { padding: 4px 8px; font-size: 0.85rem; }
.readings { gap: 10px; }
`;
// B: header price on one line; forecast and current cost side by side.
const SIDE = SMALL + `
.wrap, .main { grid-template-columns: minmax(0, 1fr); }
.head-text { overflow: hidden; }
.bill .sofar .label { white-space: normal; }
header p { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header p .head-link { display: none; }
.bill { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); column-gap: 14px; }
.bill > * { grid-column: 1 / -1; }
.bill > .fc-head, .bill > #out-fc-eur, .bill > #out-fc-bgn { grid-column: 1; }
.bill > .sofar { grid-column: 2; grid-row: 1 / span 3; border-top: 0; border-left: 1px solid var(--line); padding: 0 0 0 14px; margin: 0; align-content: start; align-items: start; flex-direction: column; flex-wrap: nowrap; justify-content: flex-start; gap: 2px; }
.bill > .sofar .sofar-val b { display: block; }
.bill .fc-head .label, .bill .sofar .label { font-size: 0.62rem; }
.bill .fc-big { font-size: 1.9rem; }
.bill .fc-sub { font-size: 0.78rem; }
#out-rate { font-size: 0.75rem; }
`;
// C: also one-line comparison chips, a slimmer timeline and readings with dial and date in one row.
const MIN = SIDE + `
.cmp { display: flex; flex-wrap: wrap; gap: 6px; border-top: 0; padding-top: 2px; }
.cmp-row { display: inline-flex; width: auto; gap: 6px; min-height: 0; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; }
.cmp-chev { display: none; }
.cmp-pct { font-size: 0.85rem; }
.cmp-what { font-size: 0.78rem; color: var(--muted); }
.tl { margin-top: 18px; }
.tl-track { height: 6px; }
#out-days { display: none; }
.readings { grid-template-columns: 1fr 1fr; gap: 8px; }
.swap-btn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0; width: 30px; height: 30px; }
.swap-btn svg { transform: rotate(90deg); width: 14px; height: 14px; }
.reading { padding: 8px 10px; }
.reading > .label { font-size: 0.6rem; letter-spacing: 0.04em; }
.dial { padding: 2px 6px; gap: 4px; }
.dial input { font-size: 1.1rem; letter-spacing: 0.06em; }
.dial .unit { font-size: 0.7rem; }
.clr { width: 24px; height: 24px; }
.date-field { font-size: 0.78rem; padding: 3px 6px; gap: 5px; }
.date-row .today-btn { display: none; }
`;
const variants = [
  ["0", "Сега", "", false],
  ["A", "A · по-малък шрифт", SMALL, true],
  ["B", "B · прогноза и текуща една до друга", SIDE, true],
  ["C", "C · най-компактно", MIN, true],
];
for (const [k, title, css, hint] of variants) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport({ width: 412, height: 790, deviceScaleFactor: 2 });
  await p.evaluateOnNewDocument((data) => {
    const N = new Date("2026-10-22T18:44:00").getTime(); const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [N])); } static now() { return N; } };
    for (const [key, val] of Object.entries(data)) localStorage.setItem(key, val);
    const m = JSON.parse(data["gas-bill-months-v1"]); m["2025-10"] = { start: 1300, end: 1418, date: null, bill: null }; m["2026-09"] = { start: 2429, end: 2445, date: "2026-09-30", bill: null };
    localStorage.setItem("gas-bill-months-v1", JSON.stringify(m));
    localStorage.setItem("gas-bill-theme", "blue");
  }, backup);
  await p.goto("http://localhost:8780/index.html", { waitUntil: "networkidle0" });
  await p.evaluate((css, hint, hc, hh, title) => {
    const st = document.createElement("style"); st.textContent = css + (hint ? hc : ""); document.head.appendChild(st);
    if (hint) document.body.insertAdjacentHTML("beforeend", hh);
    document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;top:4px;right:6px;z-index:99;background:#ffb454;color:#000;font:700 11px system-ui;padding:2px 8px;border-radius:10px">' + title + "</div>");
  }, css, hint, HINT_CSS, HINT_HTML, title);
  await new Promise((r) => setTimeout(r, 300));
  const fold = await p.evaluate(() => { const r = document.querySelector(".readings").getBoundingClientRect(); return Math.round(r.bottom) + " / " + innerHeight; });
  console.log(k, "readings bottom:", fold);
  await p.screenshot({ path: out + "/fold-" + k + ".png" });
  await ctx.close();
}
await b.close(); srv.close();
