# ski-snow

Daily download of snow timing for a personal ski-resort comparison sheet.

- `runner.js`: resort coordinates (latitude, longitude, base and top elevation, hemisphere) and the calculations. It also runs as-is in a browser.
- `run.cjs`: runs `runner.js` under Node, keeping progress in `state.json`.
- `snow_raw.csv`: results, one row per resort (the sheet imports this file).
- `.github/workflows/snow.yml`: runs once a day after Open-Meteo's free daily allowance resets, and turns itself off when every resort is done.

Data: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) (ECMWF IFS 9 km, 2017 onwards), free non-commercial tier. Weather data by Open-Meteo.com, licensed CC BY 4.0.
