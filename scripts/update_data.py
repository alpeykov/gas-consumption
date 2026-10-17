"""Refresh data/prices.json (Overgas household prices) and data/gcv.json (Bulgartransgaz kWh per m³ by month).

Runs daily from GitHub Actions. Needs `pdftotext` (poppler-utils). Standard library only.
Files are rewritten only when the data itself changes, so unchanged days produce no commit.
"""
import datetime as dt
import html
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (gas-consumption data updater; +https://github.com/alpeykov/gas-consumption)"}

OVERGAS_PAGE = "https://www.overgas.bg/za-overgaz/produkti-i-uslugi/tseni-na-prirodniya-gaz/"
BTG_PAGE = "https://bulgartransgaz.bg/pages/gas-quality-46.html"
BTG_BASE = "https://bulgartransgaz.bg/"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def pdf_text(url: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(get(url))
        path = f.name
    out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, check=True)
    Path(path).unlink(missing_ok=True)
    return out.stdout.decode("utf-8", "replace")


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()


# ---- Overgas household prices ----

def overgas_prices() -> list[dict]:
    page = get(OVERGAS_PAGE).decode("utf-8", "replace")
    token = re.compile(
        r"<h[1-6][^>]*>(?P<h>.*?)</h[1-6]>"
        r"|<a [^>]*href=\"(?P<pdf>[^\"]+\.pdf)\"[^>]*>(?P<t>.*?)</a>\s*<i>(?P<d>.*?)</i>",
        re.S,
    )
    regions, in_home, region = [], False, None
    for m in token.finditer(page):
        if m.group("h") is not None:
            h = clean(m.group("h"))
            if h == "За моя Дом":
                in_home = True
            elif h == "За моя Бизнес":
                in_home = False
            elif in_home:
                region = h
            continue
        if not (in_home and region):
            continue
        if not re.search(r"битови потребители за разпределение и снабдяване", clean(m.group("t")), re.I):
            continue
        d = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", clean(m.group("d")))
        if not d or any(r["name"] == region for r in regions):
            continue
        pdf = m.group("pdf")
        # The final price is the sum of the other columns, so it is the largest number in the table.
        nums = [float(x.replace(",", ".")) for x in re.findall(r"(?<![\d.,])\d{1,3}[.,]\d{2}(?![\d])", pdf_text(pdf))]
        if not nums:
            raise RuntimeError(f"No price found in {pdf}")
        regions.append({"name": region, "price": max(nums), "uploaded": f"{d[3]}-{d[2]}-{d[1]}", "pdf": pdf})
    if not regions:
        raise RuntimeError("No household price lists found on overgas.bg")
    return regions


# ---- Bulgartransgaz representative calorific value (kWh per m³) per month ----
# Overgas bills use the "представителна калоричност" Bulgartransgaz sets for the billed month:
# one national value per month, published per gas year (October to September) as an .xlsx file.

XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
BG_MONTHS = {"октомври": 10, "ноември": 11, "декември": 12, "януари": 1, "февруари": 2, "март": 3,
             "април": 4, "май": 5, "юни": 6, "юли": 7, "август": 8, "септември": 9}


def xlsx_rows(data: bytes) -> list[list[str]]:
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(XLSX_NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(XLSX_NS + "t")))
    rows = []
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(XLSX_NS + "row"):
        vals = []
        for c in row.iter(XLSX_NS + "c"):
            v = c.find(XLSX_NS + "v")
            if v is not None:
                vals.append(shared[int(v.text)] if c.get("t") == "s" else v.text)
        rows.append(vals)
    return rows


def btg_representative() -> dict:
    page = get(BTG_PAGE).decode("utf-8", "replace")
    links = []
    for href, text in re.findall(r"<a [^>]*href=\"([^\"]+\.xlsx)\"[^>]*>(.*?)</a>", page, re.S):
        y = re.search(r"Представителна калоричност за газова година\s*(\d{4})\s*-\s*(\d{4})", clean(text))
        if y:
            links.append((int(y[1]), urllib.parse.urljoin(BTG_BASE, href)))
    links.sort(reverse=True)
    if not links:
        raise RuntimeError("No representative calorific value files found on bulgartransgaz.bg")
    months, sources = {}, []
    for start_year, url in links[:2]:  # current and previous gas year
        sources.append(url)
        for row in xlsx_rows(get(url)):
            if len(row) < 2:
                continue
            name = re.search(r"/\s*([А-Яа-я]+)", row[0])
            m = BG_MONTHS.get(name[1].lower()) if name else None
            try:
                value = float(row[1])
            except ValueError:
                continue
            if m and 9 < value < 12:
                months[f"{start_year if m >= 10 else start_year + 1}-{m:02d}"] = value
    if not months:
        raise RuntimeError("No monthly values in " + ", ".join(sources))
    return {"months": dict(sorted(months.items())), "sources": sources}


def write_if_changed(path: Path, data: dict, now: str) -> bool:
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    old.pop("updated", None)
    if old == data:
        return False
    path.write_text(json.dumps({"updated": now, **data}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def main() -> int:
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    failed = False
    for path, fetch in ((DATA / "prices.json", lambda: {"regions": overgas_prices()}),
                        (DATA / "gcv.json", btg_representative)):
        try:
            data = fetch()
            print(f"{path.name}: {'updated' if write_if_changed(path, data, now) else 'unchanged'}")
        except Exception as e:  # keep the other file's update even if one source breaks
            failed = True
            print(f"{path.name}: FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
