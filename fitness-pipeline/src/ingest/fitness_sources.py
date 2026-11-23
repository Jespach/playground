"""Pull raw data from Garmin Connect and land it as JSONL files.

Shared by the Databricks ingest notebook and scripts/run_local.py, so the same
code runs on serverless compute or on your PC. Every landed line has the shape

    {"source", "entity", "key", "fetched_at", "payload"}

where `payload` is the untouched API response (as a JSON string). Parsing into
typed columns happens later in the Lakeflow pipeline, so API changes never
break ingestion.
"""
from __future__ import annotations

import datetime as dt
import json
import time
from typing import Callable, Iterable

# Re-fetch a short trailing window every run: activities get edited (titles,
# gear) and Garmin finalises sleep/HRV after you wake up.
ACTIVITY_LOOKBACK_DAYS = 7
DAILY_LOOKBACK_DAYS = 3

WriteFn = Callable[[str, str], None]  # (relative_path, text) -> None
Log = Callable[[str], None]


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _record(source: str, entity: str, key, payload) -> str:
    return json.dumps(
        {
            "source": source,
            "entity": entity,
            "key": str(key),
            "fetched_at": _now(),
            "payload": json.dumps(payload, separators=(",", ":")),
        },
        separators=(",", ":"),
    )


def land(write: WriteFn, source: str, entity: str, rows: Iterable[tuple], run_id: str) -> int:
    """Write (key, payload) rows to landing/<source>/<entity>/<run_id>.jsonl."""
    lines = [_record(source, entity, k, p) for k, p in rows]
    if lines:
        write(f"landing/{source}/{entity}/{run_id}.jsonl", "\n".join(lines) + "\n")
    return len(lines)


# --------------------------------------------------------------------------- Garmin


def garmin_client(token_json: str):
    from garminconnect import Garmin

    g = Garmin()
    g.login(token_json)  # inline JSON tokens; refreshes the access token if needed
    return g


def garmin_dump_tokens(g) -> str:
    return g.client.dumps()


def _daterange(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def ingest_garmin(
    write: WriteFn,
    state: dict,
    g,
    run_id: str,
    backfill_days: int = 730,
    max_days_per_run: int = 365,
    pause_s: float = 0.25,
    log: Log = print,
) -> dict:
    today = dt.date.today()
    counts = {}

    # Activities: one paged call covers any date range.
    since = state.get("garmin_activities_since")
    start = (
        dt.date.fromisoformat(since) - dt.timedelta(days=ACTIVITY_LOOKBACK_DAYS)
        if since
        else dt.date(2000, 1, 1)
    )
    acts = g.get_activities_by_date(start.isoformat(), today.isoformat(), sortorder="asc")
    counts["activities"] = land(write, "garmin", "activities", ((a["activityId"], a) for a in acts), run_id)
    state["garmin_activities_since"] = today.isoformat()
    log(f"garmin: {counts['activities']} activities since {start}")

    # Daily metrics: one call per metric per day, so backfill oldest-first in
    # chunks of max_days_per_run and remember how far we got.
    done = state.get("garmin_daily_done_through")
    d0 = (
        dt.date.fromisoformat(done) - dt.timedelta(days=DAILY_LOOKBACK_DAYS)
        if done
        else today - dt.timedelta(days=backfill_days)
    )
    d1 = min(today, d0 + dt.timedelta(days=max_days_per_run - 1))
    daily = {"daily_summary": [], "sleep": [], "hrv": []}
    fetchers = {
        "daily_summary": g.get_user_summary,
        "sleep": g.get_sleep_data,
        "hrv": g.get_hrv_data,
    }
    for day in _daterange(d0, d1):
        ds = day.isoformat()
        for entity, fn in fetchers.items():
            try:
                payload = fn(ds)
            except Exception as e:  # one bad day shouldn't sink the run
                log(f"garmin: {entity} {ds} failed: {type(e).__name__}: {e}")
                continue
            if payload:
                daily[entity].append((ds, payload))
            time.sleep(pause_s)
        if day.day == 1:
            log(f"garmin: daily metrics through {ds}")
    for entity, rows in daily.items():
        counts[entity] = land(write, "garmin", entity, rows, run_id)
    state["garmin_daily_done_through"] = d1.isoformat()
    counts["backfill_complete"] = d1 >= today
    log(f"garmin: daily metrics {d0}..{d1} -> {counts}")
    return counts
