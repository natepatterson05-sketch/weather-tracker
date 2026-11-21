# Weather Tracker

[![Tests](https://github.com/natepatterson05-sketch/weather-tracker/actions/workflows/tests.yml/badge.svg)](https://github.com/natepatterson05-sketch/weather-tracker/actions/workflows/tests.yml)

[Open Weather Tracker](https://natepatterson05-sketch.github.io/weather-tracker/) · [Daily issues](https://github.com/natepatterson05-sketch/weather-tracker/issues)

The tracker archives one snapshot of temperature and wind per UTC day. GitHub Actions starts collection daily at **15:23 UTC**. Use the browser’s Install app option when available. After the service worker finishes setup, the installed app and browser pages can open offline using cached data.

## Sources

| Source | Raw format | Coverage |
| --- | --- | --- |
| [Open-Meteo Forecast API](https://open-meteo.com/en/docs) | JSON | Current model estimates for Berlin, London, Madrid, and Paris |
| [NOAA Aviation Weather Center METAR API](https://aviationweather.gov/data/api/) | JSON | Latest terminal observations for KDFW, KJFK, KLAX, KMCI, KORD, and KSEA |

A failed source has no archive or history rows for that date. Its failure and zero count appear in the run status. A successful response can report zero locations. The collector replaces the current UTC day’s archives and updates the same issue when run again that day.

## History columns

| Column | Meaning | Unit or format |
| --- | --- | --- |
| `date` | UTC collection date | YYYY-MM-DD |
| `item_id` | Stable city slug or ICAO station code prefixed with `city:` or `airport:` | Text |
| `item` | Display name of the city or airport | Text |
| `source` | Source identifier | `open-meteo` or `noaa-metar` |
| `category` | Type of reading | City estimate or Airport observation |
| `temperature_c` | Current air temperature | Degrees Celsius |
| `wind_kmh` | Current sustained wind speed. METAR knots are multiplied by 1.852 and rounded to two decimals. | km/h |

Empty numeric cells indicate missing readings. History is ordered by date, then item ID. Rebuild it from the archived source responses with:

```sh
python pipeline.py build
```

The status file reports the latest UTC run timestamp, earliest raw date, distinct dates with an archive, number of latest locations, appearance and disappearance counts, and each source’s outcome and row count. Its `previous_run_date` field preserves the comparison date through a same-day rerun, including when the previous run had no data.

## Move rule

Compare each location with the preceding distinct UTC run date. Score its temperature change by absolute degrees Celsius and its wind change by absolute km/h divided by five. Use the larger score per location, favoring temperature for an equal score. Exclude unchanged values or values missing on either date. Sort by descending score, then ascending item ID, and show up to five locations with old and new readings. List all appearances and disappearances in the issue, including those caused by changing source availability. The daily issue is still updated when every comparable value is unchanged.

## Files

| Path | Purpose |
| --- | --- |
| `README.md` | Project, data, and calculation documentation |
| `.gitignore` | Ignores Python caches and local virtual environments |
| `pipeline.py` | Fetches, archives, normalizes, rebuilds, writes run status, and publishes Issues |
| `requirements-dev.txt` | pytest dependency for developers and CI |
| `tests/test_pipeline.py` | Source, moves, history, and rerun tests |
| `.github/workflows/tests.yml` | Runs pytest on pushes and pull requests |
| `.github/workflows/daily.yml` | Runs pytest, collects and reports, commits the snapshot, and deploys Pages |
| `data/raw/<date>/open-meteo.json.gz` | Original Open-Meteo body, gzipped |
| `data/raw/<date>/noaa-metar.json.gz` | Original NOAA Aviation Weather Center body, gzipped |
| `data/history.csv` | Rebuilt history across all archived dates |
| `data/status.json` | Most recent run metadata and statuses |
| `index.html` | Today page with run status, top moves, and the latest readings |
| `browse.html` | Filterable, sortable locations and a browser-local shortlist |
| `trends.html` | Interactive time series and four browser-computed findings |
| `app.js` | Shared data loading, calculations, accessible charts, and page behavior |
| `style.css` | Shared responsive layout and styles |
| `manifest.webmanifest` | App identity, install scope, colors, and icons |
| `sw.js` | Network-first service worker with offline fallback |
| `icon-192.png` | 192-pixel app icon |
| `icon-512.png` | 512-pixel app icon |

## Run locally

Requires Python 3.12 or newer. Run these commands from the repository root:

```sh
python -m pip install -r requirements-dev.txt
python -m pytest
python pipeline.py run
python -m http.server 8000
```

Open [localhost:8000](http://localhost:8000/) for the local site. The local collection command writes the archives and both data files. The scheduled workflow adds `--issue` and uses its GitHub token to manage the daily report.
