# ski-snow

Daily download of snow timing for a personal ski-resort comparison sheet.

- `runner.js`: resort coordinates (latitude, longitude, base and top elevation, hemisphere) and the calculations. It also runs as-is in a browser.
- `run.cjs`: runs `runner.js` under Node, keeping progress in `state.json`.
- `fresh.cjs` -> `snow_fresh.csv`: ice-risk and freshness measures at mid-mountain in the trip window (thaw, freeze-thaw, sunny and rain days; average days since the last snowfall).
- `snow_raw.csv`: results, one row per resort (the sheet imports this file).
- `long.cjs` / `snow_long.csv`: long-record timing from ERA5 (0.25°, seasons from 1991-92), plus rain days and temperature at the base from ECMWF IFS 9 km (2017 onwards); top temperature is the base figure adjusted by 0.65 °C per 100 m. Progress in `long_state.json`.
- `.github/workflows/snow.yml`: runs once a day after Open-Meteo's free daily allowance resets, and turns itself off when every resort is done.

Data: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) (ECMWF IFS 9 km from 2017; ERA5 from 1991), free non-commercial tier. Weather data by Open-Meteo.com, licensed CC BY 4.0.
