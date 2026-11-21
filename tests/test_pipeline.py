import gzip
import json
from datetime import datetime, timezone

import pytest

from pipeline import COLUMNS, build, compare, convert_airports, convert_cities, run


def payload(entries):
    return json.dumps(entries).encode()


def cities(temp=6, wind=10):
    return payload([{"current": {"temperature_2m": temp, "wind_speed_10m": wind}},
                    {"location_id": 2, "current": {"temperature_2m": None, "wind_speed_10m": 0}}])


def airports(temp=14):
    return payload([
        {"icaoId": "KORD", "reportTime": "2026-01-01T12:00:00Z", "temp": temp, "wspd": 10},
        {"icaoId": "KORD", "reportTime": "2026-01-01T11:00:00Z", "temp": 9, "wspd": None},
        {"icaoId": "KJFK", "reportTime": "2026-01-01T12:00:00Z", "temp": 5},
    ])


def test_open_meteo_conversion():
    london, berlin = convert_cities(cities())
    assert london == {"item_id": "city:london", "item": "London", "source": "open-meteo",
                      "category": "City estimate", "temperature_c": 6.0, "wind_kmh": 10.0}
    assert berlin["item_id"] == "city:berlin"
    assert berlin["temperature_c"] is None
    assert berlin["wind_kmh"] == 0


def test_metar_conversion():
    chicago, new_york = convert_airports(airports())
    assert chicago == {"item_id": "airport:KORD", "item": "Chicago O’Hare", "source": "noaa-metar",
                       "category": "Airport observation", "temperature_c": 14, "wind_kmh": 18.52}
    assert new_york["wind_kmh"] is None
    assert convert_airports(b"") == []


def test_biggest_move():
    def row(day, key, temperature, wind):
        return dict(date=day, item_id=key, item=key, temperature_c=temperature, wind_kmh=wind)

    rows = [row("old", "a", 0, 0), row("new", "a", 3, 15),
            row("old", "b", 6, 5), row("new", "b", 7, 25),
            row("old", "c", None, 0), row("new", "c", 100, 0),
            row("old", "d", 0, 0), row("new", "e", 0, 0)]
    _, moves, appeared, disappeared = compare(rows, "new", "old")
    assert moves == [(4, "b", "wind_kmh", 5, 25, "b"), (3, "a", "temperature_c", 0, 3, "a")]
    assert [r["item_id"] for r in appeared] == ["e"]
    assert [r["item_id"] for r in disappeared] == ["d"]


def test_move_limit_and_ties():
    rows = [dict(date=day, item_id=key, item=key, temperature_c=temp, wind_kmh=None)
            for key in "gfedcba" for day, temp in [("old", 0), ("new", 1)]]
    _, moves, _, _ = compare(rows, "new", "old")
    assert [move[1] for move in moves] == list("abcde")


def test_history_rebuild_and_same_day_replacement(tmp_path):
    def collect(day, hour=15, temp=6, fail=False):
        def fetch(url):
            if "open-meteo" in url:
                return cities(temp)
            if fail:
                raise TimeoutError("source unavailable")
            return airports()
        return run(tmp_path, datetime(2026, 1, day, hour, tzinfo=timezone.utc), fetch, report)

    reports = []
    def report(day, body):
        reports.append((day, body))

    collect(1)
    collect(2)
    status = collect(2, hour=16, temp=8, fail=True)
    assert status["days_with_success"] == 2
    assert status["first_run_date"] == "2026-01-01"
    assert status["previous_run_date"] == "2026-01-01"
    assert status["items"] == status["gone_today"] == 2
    assert status["sources"][1] == {"name": "noaa-metar", "ok": False, "count": 0}
    assert reports[-1][0] == reports[-2][0] == "2026-01-02"
    assert "6 → 8 °C" in reports[-1][1]
    assert "Chicago O’Hare" in reports[-1][1]
    raw = tmp_path / "raw/2026-01-02"
    assert gzip.decompress((raw / "open-meteo.json.gz").read_bytes()) == cities(8)
    assert not (raw / "noaa-metar.json.gz").exists()
    history = tmp_path / "history.csv"
    expected = history.read_bytes()
    history.unlink()
    rows, _ = build(tmp_path)
    assert history.read_bytes() == expected
    assert expected.decode().splitlines()[0].split(",") == COLUMNS
    assert [(r["date"], r["item_id"]) for r in rows] == [
        ("2026-01-01", "airport:KJFK"), ("2026-01-01", "airport:KORD"),
        ("2026-01-01", "city:berlin"), ("2026-01-01", "city:london"),
        ("2026-01-02", "city:berlin"), ("2026-01-02", "city:london"),
    ]


def test_comparison_after_a_run_with_no_raw_files(tmp_path):
    def unavailable(_):
        raise OSError("offline")

    run(tmp_path, datetime(2026, 1, 1, tzinfo=timezone.utc), lambda _: b"[]")
    status = run(tmp_path, datetime(2026, 1, 2, tzinfo=timezone.utc), unavailable)
    assert status["items"] == 0
    assert status["days_with_success"] == 1
    assert all(not source["ok"] for source in status["sources"])
    status = run(tmp_path, datetime(2026, 1, 3, tzinfo=timezone.utc),
                 lambda url: cities() if "open-meteo" in url else airports())
    assert status["previous_run_date"] == "2026-01-02"
    assert status["new_today"] == 4


@pytest.mark.parametrize("convert", [convert_cities, convert_airports])
def test_error_documents_are_not_archived(convert):
    with pytest.raises(ValueError):
        convert(b'{"error":"upstream failure"}')
