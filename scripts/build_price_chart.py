"""Build data/price-chart.json: Overgas household gas price per month before data/price-history.json starts.

One-off script; the values were read from Overgas sources and are listed below with their basis.
The chart shows euro per MWh WITH VAT, because the older notices only published prices with VAT.

basis:
  "blog"   – Overgas blog posts, лв./kWh with VAT rounded to 0.1 стотинка; held for the quarter
  "old"    – monthly notices "Adv_Mreji_M_YY_Bit.pdf", лв./MWh with VAT, WITHOUT Bulgartransgaz
             transmission and access (charged separately then); monthly supply fee not included
  "full"   – monthly price lists "TSENA-SAJT_red.pdf", лв./MWh without VAT, incl. transmission and access
Months from data/price-history.json onwards are added by the app itself (priceEur × 1.2).

Run: python scripts/build_price_chart.py
"""
import json
from pathlib import Path

RATE = 1.95583
VAT = 1.2
BLOG = "https://blog.overgas.bg/"
UP = "https://www.overgas.bg/wp-content/uploads/"

# Blog: (first month, months it applies to, лв./kWh with VAT, post)
BLOG_POINTS = [
    ("2014-01", 1, 0.125, "tseni-na-prirodniya-gaz/"),
    ("2016-01", 3, 0.099, "tsena-na-prirodniya-gaz-ot-1-april/"),
    ("2016-04", 3, 0.086, "po-niska-tsena-na-prirodniya-gaz/"),
    ("2016-07", 3, 0.081, "prognozni-tseni-na-prirodniya-gaz-i-el-en/"),
    ("2017-04", 3, 0.087, "tseni-na-energoiztochnitsite-april-2017-g/"),
    ("2018-01", 3, 0.079, "tseni-energoiztochnitsite-yanuari-2018-g/"),
    ("2018-04", 3, 0.078, "tseni-energoiztochnitsite-april-2018/"),
    ("2018-07", 3, 0.083, "tseni-energoiztochnitsite-yuli-2018-g/"),
]

# Monthly notices, лв./MWh with VAT, without transmission and access.
OLD = {
    "2019-07": (88.77, "2019/07/Adv_Mreji_7_19_Bit.pdf"),
    "2019-08": (73.89, "2020/06/Adv_Mreji_8_19_Bit.pdf"),
    "2019-09": (71.82, "2020/06/Adv_Mreji_9_19_Bit.pdf"),
    "2019-10": (81.33, "2020/06/Adv_Mreji_10_19_Bit.pdf"),
    "2019-11": (82.81, "2020/06/Adv_Mreji_11_19_Bit.pdf"),
    "2019-12": (82.66, "2020/06/Adv_Mreji_12_19_Bit.pdf"),
    "2020-01": (83.07, "2020/06/Adv_Mreji_1_20_Bit.pdf"),
    "2020-02": (83.61, "2020/06/Adv_Mreji_2_20_Bit.pdf"),
    "2020-03": (83.66, "2020/06/Adv_Mreji_3_20_Bit.pdf"),
    "2020-04": (61.25, "2020/04/Adv_Mreji_4_20_Bit.pdf"),
    "2020-05": (57.83, "2020/05/Adv_Mreji_5_20_Bit.pdf"),
    "2020-06": (55.40, "2020/06/Adv_Mreji_6_20_Bit.pdf"),
    "2020-07": (53.93, "2020/07/Adv_Mreji_7_20_Bit.pdf"),
    "2020-08": (53.41, "2020/08/Adv_Mreji_8_20_Bit.pdf"),
    "2020-09": (57.96, "2020/09/Adv_Mreji_9_20_Bit.pdf"),
    "2020-10": (60.67, "2020/10/Adv_Mreji_10_20_Bit.pdf"),
    "2020-11": (64.86, "2020/11/Adv_Mreji_11_20_Bit.pdf"),
    "2020-12": (64.25, "2020/12/Adv_Mreji_12_20_Bit.pdf"),
    "2021-01": (63.32, "2021/01/Adv_Mreji_1_21_Bit.pdf"),
    "2021-02": (67.48, "2021/02/Adv_Mreji_2_21_Bit.pdf"),
    "2021-03": (65.38, "2021/03/Adv_Mreji_3_21_Bit.pdf"),
    "2021-04": (70.84, "2021/04/Adv_Mreji_4_21_Bit.pdf"),
    "2021-05": (76.26, "2021/05/Adv_Mreji_5_21_Bit.pdf"),
    "2021-06": (85.33, "2021/06/Adv_Mreji_6_21_Bit.pdf"),
    "2021-07": (90.94, "2021/07/Adv_Mreji_7_21_Bit.pdf"),
    "2021-08": (100.13, "2021/08/Adv_Mreji_8_21_Bit.pdf"),
    "2021-09": (114.29, "2021/09/Adv_Mreji_9_21_Bit.pdf"),
    "2021-10": (144.46, "2021/10/Adv_Mreji_10_21_Bit.pdf"),
    "2021-11": (142.84, "2021/11/Adv_Mreji_11_21_Bit.pdf"),
    "2021-12": (153.80, "2021/12/Adv_Mreji_12_21_Bit.pdf"),
    "2022-01": (191.10, "2022/01/Adv_Mreji_1_22_Bit.pdf"),
    "2022-02": (162.86, "2022/02/Adv_Mreji_2_22_Bit-1.pdf"),
    "2022-03": (167.48, "2022/03/Adv_Mreji_3_22_Bit.pdf"),
    "2022-04": (202.12, "2022/04/Adv_Mreji_4_22_Bit.pdf"),
    "2022-06": (200.64, "2022/06/Adv_Mreji_6_22-1_Bit.pdf"),
}

# Price lists in today's format, лв./MWh without VAT, incl. transmission and access.
FULL = {
    "2022-05": (191.45, "2022/05/TSENA-SAJT_red.pdf"),
    "2022-07": (215.24, "2022/07/TSENA-SAJT_red.pdf"),
    "2022-08": (326.96, "2022/08/TSENA-SAJT_red.pdf"),
    "2022-09": (382.28, "2022/09/TSENA-SAJT_red.pdf"),
    "2022-10": (263.56, "2022/10/TSENA-SAJT_red.pdf"),
    "2022-11": (153.21, "2022/11/TSENA-SAJT_red.pdf"),
    "2022-12": (176.29, "2022/12/TSENA-SAJT_red.pdf"),
    "2023-01": (209.78, "2023/01/TSENA-SAJT_red.pdf"),
    "2023-02": (154.79, "2023/02/TSENA-SAJT_red.pdf"),
    "2023-03": (137.19, "2023/03/TSENA-SAJT_red.pdf"),
    "2023-04": (127.65, "2023/04/TSENA-SAJT_red.pdf"),
    "2023-05": (107.04, "2023/05/TSENA-SAJT_red.pdf"),
    "2023-06": (95.31, "2023/06/TSENA-SAJT_red.pdf"),
    "2023-07": (89.87, "2023/07/TSENA-SAJT_red.pdf"),
    "2023-08": (88.96, "2023/08/TSENA-SAJT_red.pdf"),
}


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    m += n
    return f"{y + (m - 1) // 12}-{(m - 1) % 12 + 1:02d}"


months = {}
for start, span, lv_kwh, post in BLOG_POINTS:
    for i in range(span):
        months[add_months(start, i)] = {"eurMwhVat": round(lv_kwh * 1000 / RATE, 2), "basis": "blog", "src": BLOG + post}
for m, (bgn_vat, path) in OLD.items():
    months[m] = {"eurMwhVat": round(bgn_vat / RATE, 2), "basis": "old", "src": UP + path}
for m, (bgn, path) in FULL.items():
    months[m] = {"eurMwhVat": round(bgn * VAT / RATE, 2), "basis": "full", "src": UP + path}

out = Path(__file__).resolve().parent.parent / "data" / "price-chart.json"
out.write_text(json.dumps({
    "region": "Овергаз Мрежи",
    "unit": "EUR/MWh incl. VAT",
    "note": "blog = approximate quarterly values; old = without Bulgartransgaz transmission and access; full = today's format",
    "months": dict(sorted(months.items())),
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(len(months), "months", min(months), "->", max(months))
