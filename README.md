# Gas Bill Forecast

Tracks household gas use since the last Overgas bill and forecasts the month-end bill in euro (with 20% VAT and the BGN equivalent).

- Pick your region: Овергаз Мрежи, Банско и Разлог, Бяла or Карнобат.
- Prices come from the “Крайна цена на ПГ” column of the household price list on [overgas.bg](https://www.overgas.bg/za-overgaz/produkti-i-uslugi/tseni-na-prirodniya-gaz/). If this month's price isn't uploaded yet, last month's is used and marked with an info note.
- kWh per m³ is the Bulgartransgaz [representative calorific value](https://bulgartransgaz.bg/pages/gas-quality-46.html) for the billed month (one national value per month), the same conversion factor Overgas prints on the bill. It can be overridden.
- Price history for Овергаз Мрежи since September 2023 (`data/price-history.json`, links to each month's Overgas PDF): when the last bill's date is in an earlier month, that month's price, kWh per m³ and (until November 2024) the 3.13 лв. monthly supply fee are used.
- Historical prices chart (€/m³ incl. VAT, chosen year range): monthly price lists since July 2019, approximate quarterly values from the Overgas blog for 2014–2018 (`data/price-chart.json`, built by `scripts/build_price_chart.py`), and the price history for newer months.
- A daily GitHub Actions job (`.github/workflows/update-data.yml` → `scripts/update_data.py`) refreshes `data/prices.json` and `data/gcv.json` and adds each new month to `data/price-history.json`; the app reads those files and only asks for them when its saved values are out of date.
- Bulgarian by default with an English switch, and four themes (dark by default, light, blue, high contrast). Language, theme and the folded tariff panel on phones are remembered per browser.
- VAT (20%) and the BGN rate (1.95583) are fixed; kWh per m³ can be set from your bill.
- Meter readings stay in your browser; nothing is uploaded.

## Install on a phone

Open the app link, then **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Install app / Add to Home screen** (Android, Chrome).

## Releasing an update

Change the app, bump `VERSION` in `sw.js`, commit and push. Installed apps show **“Update now”** the next time they're opened.
