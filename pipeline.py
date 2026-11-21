"""Collect daily weather snapshots or rebuild the CSV from archived responses."""
import argparse
import csv
import gzip
import io
import json
import math
import subprocess
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

CITIES = {
    0: ("london", "London", 51.5072, -0.1276),
    1: ("paris", "Paris", 48.8566, 2.3522),
    2: ("berlin", "Berlin", 52.52, 13.405),
    3: ("madrid", "Madrid", 40.4168, -3.7038),
}
AIRPORTS = {
    "KORD": "Chicago O’Hare", "KJFK": "New York JFK", "KLAX": "Los Angeles International",
    "KMCI": "Kansas City International", "KSEA": "Seattle–Tacoma", "KDFW": "Dallas/Fort Worth",
}
METRICS = {"temperature_c": ("Temperature", "°C", 1), "wind_kmh": ("Wind", "km/h", 5)}
COLUMNS = ["date", "item_id", "item", "source", "category", *METRICS]
USER_AGENT = "WeatherTracker/1.0 (https://github.com/natepatterson05-sketch/weather-tracker)"
ISSUE_MARKER = "<!-- weather-tracker:daily -->"


def numeric(value):
    if value is None or value == "":
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite measurement")
    return result


def convert_cities(raw):
    entries = json.loads(raw)
    if not isinstance(entries, list) or not entries:
        raise ValueError("Expected city snapshots")
    rows = {}
    for entry in entries:
        slug, name, _, _ = CITIES[entry.get("location_id", 0)]
        current = entry["current"]
        rows[slug] = dict(item_id=f"city:{slug}", item=name, source="open-meteo",
                          category="City estimate", temperature_c=numeric(current.get("temperature_2m")),
                          wind_kmh=numeric(current.get("wind_speed_10m")))
    return list(rows.values())


def convert_airports(raw):
    # The METAR API returns HTTP 204 with an empty body when no reports are available.
    entries = json.loads(raw) if raw else []
    if not isinstance(entries, list):
        raise ValueError("Expected METAR observations")
    latest = {}
    for entry in sorted(entries, key=lambda item: item["reportTime"]):
        station = entry["icaoId"]
        if station in AIRPORTS:
            latest[station] = entry
    rows = []
    for station, entry in latest.items():
        wind = numeric(entry.get("wspd"))
        rows.append(dict(item_id=f"airport:{station}", item=AIRPORTS[station], source="noaa-metar",
                         category="Airport observation", temperature_c=numeric(entry.get("temp")),
                         wind_kmh=round(wind * 1.852, 2) if wind is not None else None))
    return rows


SOURCES = {
    "open-meteo": ("json", "https://api.open-meteo.com/v1/forecast?latitude="
                   + ",".join(str(city[2]) for city in CITIES.values()) + "&longitude="
                   + ",".join(str(city[3]) for city in CITIES.values())
                   + "&current=temperature_2m,wind_speed_10m&timezone=UTC", convert_cities),
    "noaa-metar": ("json", "https://aviationweather.gov/api/data/metar?ids="
                   + ",".join(AIRPORTS) + "&format=json", convert_airports),
}


def raw_path(folder, source):
    return folder / f"{source}.{SOURCES[source][0]}.gz"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=35) as response:
        return response.read() or (b"[]" if response.status == 204 else b"")


def write_bytes(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_bytes(content)
    temp.replace(path)


def build(data):
    rows, dates = [], set()
    for folder in data.joinpath("raw").glob("????-??-??"):
        if not folder.is_dir() or date.fromisoformat(folder.name).isoformat() != folder.name:
            continue
        for source, (_, _, converter) in SOURCES.items():
            path = raw_path(folder, source)
            if path.is_file():
                dates.add(folder.name)
                rows.extend(dict(date=folder.name, **row) for row in converter(gzip.decompress(path.read_bytes())))
    rows.sort(key=lambda row: (row["date"], row["item_id"]))
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    write_bytes(data / "history.csv", output.getvalue().encode())
    return rows, sorted(dates)


def compare(rows, today, previous):
    old = {r["item_id"]: r for r in rows if r["date"] == previous}
    new = {r["item_id"]: r for r in rows if r["date"] == today}
    moves = []
    for key in old.keys() & new.keys():
        candidates = []
        for metric, (_, _, scale) in METRICS.items():
            before, after = old[key][metric], new[key][metric]
            if before is not None and after is not None and before != after:
                candidates.append((abs(after - before) / scale, metric, before, after))
        if candidates:
            score, metric, before, after = max(candidates, key=lambda move: move[0])
            moves.append((score, key, metric, before, after, new[key]["item"]))
    moves.sort(key=lambda move: (-move[0], move[1]))
    return new, moves[:5], [new[key] for key in sorted(new.keys() - old.keys())], [
        old[key] for key in sorted(old.keys() - new.keys())
    ]


def issue_body(previous, moves, appeared, disappeared, results):
    lines = [ISSUE_MARKER, f"Comparison run: {previous or 'first run'} (UTC)", "", "## Biggest moves"]
    for _, _, metric, before, after, name in moves:
        label, unit, _ = METRICS[metric]
        lines.append(f"- {name} · {label}: {before:g} → {after:g} {unit}")
    if not moves:
        lines.append("No comparable values changed.")
    for heading, items in (("Appeared", appeared), ("Disappeared", disappeared)):
        lines.extend(["", f"## {heading}"])
        for row in items:
            values = ", ".join(f"{value:g} {METRICS[key][1]}" for key in METRICS
                               if (value := row[key]) is not None)
            lines.append(f'- {row["item"]}' + (f" · {values}" if values else ""))
        if not items:
            lines.append("None.")
    lines.extend(["", "## Sources"])
    lines.extend(f'- {s["name"]}: {"OK" if s["ok"] else "Failed"} ({s["count"]} items)' for s in results)
    return "\n".join(lines) + "\n"


def publish(day, body):
    def gh(*args, input_text=None):
        return subprocess.run(["gh", *args], input=input_text, text=True, encoding="utf-8",
                              capture_output=True, check=True).stdout

    pages = json.loads(gh("api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues?state=open&per_page=100"))
    issues = [item for page in pages for item in page if ISSUE_MARKER in (item.get("body") or "")
              and "pull_request" not in item]
    same_day = next((item for item in issues if item["title"] == day), None)
    if same_day:
        gh("issue", "edit", str(same_day["number"]), "--body-file", "-", input_text=body)
    else:
        gh("issue", "create", "--title", day, "--body-file", "-", input_text=body)
    for item in issues:
        if item["title"] < day:
            gh("issue", "close", str(item["number"]))


def run(data, now, fetcher=fetch, publish_issue=None):
    day = now.astimezone(timezone.utc).date().isoformat()
    path = data / "status.json"
    prior = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    last = (prior.get("run_time") or "")[:10]
    previous = prior.get("previous_run_date") if last == day else last or None
    folder = data / "raw" / day
    results = []
    for name, (_, url, converter) in SOURCES.items():
        target = raw_path(folder, name)
        try:
            payload = fetcher(url)
            count = len(converter(payload))
        except Exception as exc:
            print(f"{name}: {exc}")
            target.unlink(missing_ok=True)
            results.append(dict(name=name, ok=False, count=0))
        else:
            write_bytes(target, gzip.compress(payload, mtime=0))
            results.append(dict(name=name, ok=True, count=count))
    rows, dates = build(data)
    latest, moves, appeared, disappeared = compare(rows, day, previous)
    status = dict(run_time=now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                  first_run_date=dates[0] if dates else None, days_with_success=len(dates),
                  items=len(latest), new_today=len(appeared), gone_today=len(disappeared),
                  sources=results, previous_run_date=previous)
    write_bytes(path, (json.dumps(status, indent=2) + "\n").encode())
    if publish_issue:
        publish_issue(day, issue_body(previous, moves, appeared, disappeared, results))
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["run", "build"])
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parent / "data")
    parser.add_argument("--issue", action="store_true", help="Publish the report through the authenticated GitHub CLI")
    args = parser.parse_args()
    if args.command == "build":
        build(args.data)
    else:
        run(args.data, datetime.now(timezone.utc), publish_issue=publish if args.issue else None)
