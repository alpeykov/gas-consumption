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
import time
import urllib.error
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


def get(url: str, tries: int = 3) -> bytes:
    """Retries a timeout, a dropped connection, 429 and 5xx: one slow handshake shouldn't fail the day's update."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if (e.code != 429 and e.code < 500) or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
        time.sleep(10 * (attempt + 1))


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
    # Every published gas year, so the price chart can show prices per m³ for every month.
    for start_year, url in links:
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


HISTORY_REGION = "Овергаз Мрежи"


def add_to_history(regions: list[dict]) -> bool:
    """Record this month's Овергаз Мрежи price in data/price-history.json (months are never rewritten)."""
    path = DATA / "price-history.json"
    history = json.loads(path.read_text(encoding="utf-8"))
    main_region = next((r for r in regions if r["name"] == HISTORY_REGION), None)
    if not main_region:
        return False
    month = main_region["uploaded"][:7]
    if month in history["months"]:
        return False
    history["months"][month] = {"priceEur": main_region["price"], "pdf": main_region["pdf"]}
    history["months"] = dict(sorted(history["months"].items()))
    path.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


# ---- Weather (Open-Meteo): daily mean temperatures in each gasified town, for the weather-based forecast ----

# The towns on Overgas's network page (https://www.overgas.bg/za-overgaz/produkti-i-uslugi/mrezha/). The app lists the same ids.
CITIES = [
    ("asenovgrad", "Асеновград", "Asenovgrad", 42.0167, 24.8667), ("bankya", "Банкя", "Bankya", 42.7069, 23.1450),
    ("bansko", "Банско", "Bansko", 41.8361, 23.4874), ("bozhurishte", "Божурище", "Bozhurishte", 42.7630, 23.1973),
    ("bourgas", "Бургас", "Burgas", 42.5065, 27.4689), ("butovo", "Бутово", "Butovo", 43.3000, 25.2333),
    ("byala", "Бяла", "Byala", 43.4559, 25.7349), ("tarnovo", "Велико Търново", "Veliko Tarnovo", 43.0812, 25.6290),
    ("varna", "Варна", "Varna", 43.2191, 27.9102), ("goryahov", "Горна Оряховица", "Gorna Oryahovitsa", 43.1278, 25.7017),
    ("isperih", "Исперих", "Isperih", 43.7167, 26.8333), ("karnobat", "Карнобат", "Karnobat", 42.6500, 26.9833),
    ("kubrat", "Кубрат", "Kubrat", 43.7966, 26.5006), ("kyustendil", "Кюстендил", "Kyustendil", 42.2831, 22.6922),
    ("levski", "Левски", "Levski", 43.3667, 25.1333), ("lovech", "Ловеч", "Lovech", 43.1323, 24.7176),
    ("lyaskovets", "Лясковец", "Lyaskovets", 43.1111, 25.7283), ("mezdra", "Мездра", "Mezdra", 43.1448, 23.7142),
    ("montana", "Монтана", "Montana", 43.4128, 23.2217), ("nova_zagora", "Нова Загора", "Nova Zagora", 42.4833, 26.0167),
    ("novi_pazar", "Нови Пазар", "Novi Pazar", 43.3500, 27.2000), ("pavlikeni", "Павликени", "Pavlikeni", 43.2428, 25.3219),
    ("pazardzhik", "Пазарджик", "Pazardzhik", 42.1993, 24.3332), ("petrich", "Петрич", "Petrich", 41.3985, 23.2070),
    ("peshtera", "Пещера", "Peshtera", 42.0337, 24.2999), ("popovo", "Попово", "Popovo", 43.3500, 26.2333),
    ("parvomai", "Първомай", "Parvomay", 42.1000, 25.2167), ("razgrad", "Разград", "Razgrad", 43.5333, 26.5185),
    ("razlog", "Разлог", "Razlog", 41.8863, 23.4671), ("rousse", "Русе", "Ruse", 43.8487, 25.9534),
    ("sofia", "София", "Sofia", 42.6975, 23.3241), ("s_zagora", "Стара Загора", "Stara Zagora", 42.4320, 25.6426),
    ("yambol", "Ямбол", "Yambol", 42.4824, 26.5001),
]
WEATHER_START = "2016-01-01"
# A town's first file needs ten years from the archive, which Open-Meteo counts as ~280 requests; a few a day keeps us in its free limit.
NEW_TOWNS_PER_RUN = 8
STALE_DAYS = 3  # a town whose temperatures are older than this fails the run


def weather(city: tuple, old: dict | None) -> dict:
    """Daily mean temperature (°C, in tenths) from WEATHER_START to 16 days ahead.

    Past days come from the Open-Meteo archive (ERA5); the last few days the archive doesn't have yet,
    today and the next 15 days come from the Open-Meteo forecast. Days after "observedTo" are forecast.
    A town that already has a file only fetches the last 30 days again and keeps the rest.
    """
    cid, bg, en, lat, lon = city
    q = f"latitude={lat}&longitude={lon}&daily=temperature_2m_mean&timezone=Europe%2FSofia"
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=2))).date()
    yesterday = today - dt.timedelta(days=1)
    first = (yesterday - dt.timedelta(days=30)).isoformat() if old else WEATHER_START
    arch = json.loads(get(f"https://archive-api.open-meteo.com/v1/archive?{q}&start_date={first}&end_date={yesterday}"))["daily"]
    fc = json.loads(get(f"https://api.open-meteo.com/v1/forecast?{q}&past_days=14&forecast_days=16"))["daily"]
    temps = {}
    if old:
        day = dt.date.fromisoformat(old["start"])
        for v in old["t"][: (dt.date.fromisoformat(first) - day).days]:
            temps[day.isoformat()] = v / 10
            day += dt.timedelta(days=1)
    temps.update({d: t for d, t in zip(fc["time"], fc["temperature_2m_mean"]) if t is not None})
    temps.update({d: t for d, t in zip(arch["time"], arch["temperature_2m_mean"]) if t is not None})
    day, end, t = dt.date.fromisoformat(WEATHER_START), dt.date.fromisoformat(max(temps)), []
    while day <= end:
        v = temps.get(day.isoformat())
        if v is None:
            raise RuntimeError(f"{cid}: no temperature for {day}")
        t.append(round(v * 10))
        day += dt.timedelta(days=1)
    if len(t) < 3000:
        raise RuntimeError(f"{cid}: only {len(t)} days of temperatures")
    return {"id": cid, "place": bg, "placeEn": en, "lat": lat, "lon": lon, "source": "https://open-meteo.com/",
            "start": WEATHER_START, "observedTo": yesterday.isoformat(), "t": t}


def write_weather(now: str) -> list[str]:
    """data/weather/<town>.json for every town, compact: one line of ~4000 numbers instead of one per line.
    A failure in one town doesn't stop the others, and the failed towns get one more try at the end.
    Returns only the towns that still fail and whose file is more than STALE_DAYS old: a town that keeps
    yesterday's file after a network blip is fine, a town that stops updating fails the run.
    """
    folder = DATA / "weather"
    folder.mkdir(exist_ok=True)
    todo, new = [], 0
    for city in CITIES:
        if not (folder / f"{city[0]}.json").exists():
            if new >= NEW_TOWNS_PER_RUN:
                print(f"weather/{city[0]}.json: waiting for a later run")
                continue
            new += 1
        todo.append(city)
    for round_ in range(2):
        if round_:
            if not todo:
                break
            time.sleep(60)  # give the service a minute before the second try
        todo = [city for city in todo if not write_town(folder, city, now, last=round_ == 1)]
    stale = []
    for city in todo:
        path = folder / f"{city[0]}.json"
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        age = (dt.date.today() - dt.date.fromisoformat(old["observedTo"])).days if old else None
        if age is None or age > STALE_DAYS:
            stale.append(city[0])
        else:
            print(f"weather/{path.name}: kept the file from {old['observedTo']}")
    return stale


def write_town(folder: Path, city: tuple, now: str, last: bool) -> bool:
    """Updates one town's file; False if the fetch failed."""
    path = folder / f"{city[0]}.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    try:
        data = weather(city, old)
    except Exception as e:
        print(f"weather/{path.name}: {'FAILED' if last else 'failed, will try again'}: {e}", file=sys.stderr)
        return False
    if old:
        old.pop("updated", None)
    if old == data:
        return True
    body = json.dumps({"updated": now, **{k: v for k, v in data.items() if k != "t"}}, ensure_ascii=False, indent=2)
    path.write_text(body[:-2] + ',\n  "t": ' + json.dumps(data["t"], separators=(",", ":")) + "\n}\n", encoding="utf-8")
    print(f"weather/{path.name}: updated")
    return True


def main() -> int:
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    failed = False
    try:
        failed = bool(write_weather(now))
    except Exception as e:  # the prices still update if the weather service is down
        failed = True
        print(f"weather: FAILED: {e}", file=sys.stderr)
    for path, fetch in ((DATA / "prices.json", lambda: {"regions": overgas_prices()}),
                        (DATA / "gcv.json", btg_representative)):
        try:
            data = fetch()
            print(f"{path.name}: {'updated' if write_if_changed(path, data, now) else 'unchanged'}")
            if path.name == "prices.json":
                print(f"price-history.json: {'month added' if add_to_history(data['regions']) else 'unchanged'}")
        except Exception as e:  # keep the other file's update even if one source breaks
            failed = True
            print(f"{path.name}: FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
