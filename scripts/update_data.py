"""Refresh data/prices.json (Overgas household prices) and data/gcv.json (Bulgartransgaz kWh per m³).

Runs daily from GitHub Actions. Needs `pdftotext` (poppler-utils). Standard library only.
Files are rewritten only when the data itself changes, so unchanged days produce no commit.
"""
import datetime as dt
import difflib
import html
import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (gas-consumption data updater; +https://github.com/alpeykov/gas-consumption)"}

OVERGAS_PAGE = "https://www.overgas.bg/za-overgaz/produkti-i-uslugi/tseni-na-prirodniya-gaz/"
BTG_PAGE = "https://bulgartransgaz.bg/pages/gas-quality-46.html"
BTG_BASE = "https://bulgartransgaz.bg/"

MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]


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


# ---- Bulgartransgaz gross calorific value per zone ----

def month_from_name(path: str, today: dt.date) -> str | None:
    """Certificate file names carry the English month name, sometimes misspelt ("Seotember")."""
    words = re.findall(r"[a-z]+", urllib.parse.unquote(path).lower())
    for w in words:
        hit = difflib.get_close_matches(w, MONTHS, n=1, cutoff=0.75)
        if hit:
            m = MONTHS.index(hit[0]) + 1
            year = today.year if m <= today.month else today.year - 1
            return f"{year}-{m:02d}"
    return None


def btg_zones(today: dt.date) -> list[dict]:
    page = get(BTG_PAGE).decode("utf-8", "replace")
    zones: dict[int, dict] = {}
    # The page lists the newest month first, so the first link per zone is the latest certificate.
    for href, text in re.findall(r"<a [^>]*href=\"([^\"]+\.pdf)\"[^>]*>(.*?)</a>", page, re.S):
        z = re.match(r"Зона\s*-?\s*(\d+)\s*-+\s*(.+)", clean(text))
        if not z or int(z[1]) in zones:
            continue
        url = urllib.parse.urljoin(BTG_BASE, href)
        values = [float(v) for v in re.findall(r"(?<![\d.])1[01]\.\d{3}(?![\d])", pdf_text(url))]
        if not values:
            continue
        name = re.sub(r"\s*/\s*", "/", z[2]).replace("София1", "София 1").strip()
        zones[int(z[1])] = {
            "id": int(z[1]),
            "name": f"Зона {z[1]} – {name}",
            "kwhPerM3": round(sum(values) / len(values), 3),
            "month": month_from_name(href, today),
            "days": len(values),
            "pdf": url,
        }
    if not zones:
        raise RuntimeError("No zone certificates found on bulgartransgaz.bg")
    return [zones[k] for k in sorted(zones)]


def write_if_changed(path: Path, key: str, items: list[dict], now: str) -> bool:
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if old.get(key) == items:
        return False
    path.write_text(json.dumps({"updated": now, key: items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def main() -> int:
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    today = dt.date.today()
    failed = False
    for path, key, fetch in ((DATA / "prices.json", "regions", overgas_prices),
                             (DATA / "gcv.json", "zones", lambda: btg_zones(today))):
        try:
            items = fetch()
            print(f"{path.name}: {'updated' if write_if_changed(path, key, items, now) else 'unchanged'} ({len(items)} {key})")
        except Exception as e:  # keep the other file's update even if one source breaks
            failed = True
            print(f"{path.name}: FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
