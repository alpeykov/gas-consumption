# Gas Bill Forecast

Tracks household gas use since the last Overgas bill and forecasts the month-end bill in euro (with 20% VAT and the BGN equivalent).

- Pick your region: Овергаз Мрежи, Банско и Разлог, Бяла or Карнобат.
- Prices come from the “Крайна цена на ПГ” column of the household price list on [overgas.bg](https://www.overgas.bg/za-overgaz/produkti-i-uslugi/tseni-na-prirodniya-gaz/). If this month's price isn't uploaded yet, last month's is used and marked with an info note.
- kWh per m³ comes from the [Bulgartransgaz gas quality certificates](https://bulgartransgaz.bg/pages/gas-quality-46.html) for the chosen gas zone (latest published month, as used on the Overgas bill). It can be overridden.
- A daily GitHub Actions job (`.github/workflows/update-data.yml` → `scripts/update_data.py`) refreshes `data/prices.json` and `data/gcv.json`; the app reads those files and only asks for them when its saved values are out of date.
- Bulgarian by default with an English switch, and four themes (dark by default, light, blue, high contrast). Language, theme and the folded tariff panel on phones are remembered per browser.
- VAT (20%) and the BGN rate (1.95583) are fixed; kWh per m³ can be set from your bill.
- Meter readings stay in your browser; nothing is uploaded.

## Install on a phone

Open the app link, then **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Install app / Add to Home screen** (Android, Chrome).

## Releasing an update

Change the app, bump `VERSION` in `sw.js`, commit and push. Installed apps show **“Update now”** the next time they're opened.
