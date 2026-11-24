"""Workout analysis MCP server.

Finds and analyses individual Garmin workouts stored by the fitness pipeline in
Databricks (workspace.fitness). Read-only: every tool runs SELECT statements on
the SQL warehouse as the CLI profile's user.

Run:  .venv/Scripts/python.exe mcp/workout_server.py   (stdio transport)
Env:  FITNESS_DATABRICKS_PROFILE (default "free"), FITNESS_WAREHOUSE_ID,
      FITNESS_SCHEMA (default "workspace.fitness")
"""
from __future__ import annotations

import math
import os
import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Any

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import (Disposition, Format, StatementParameterListItem,
                                        StatementState)
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

PROFILE = os.environ.get("FITNESS_DATABRICKS_PROFILE", "free")
WAREHOUSE = os.environ.get("FITNESS_WAREHOUSE_ID", "a6fa70a1aff7a539")
SCHEMA = os.environ.get("FITNESS_SCHEMA", "workspace.fitness")
RO = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

mcp = MCPServer(
    name="fitness-workouts",
    instructions=(
        "Garmin workouts from the user's Databricks fitness pipeline. Use find_workouts to "
        "locate a session (filter by date, sport, name, distance), get_workout for the full "
        "analysis plus chart-ready streams, compare_workouts to overlay sessions, and "
        "query_fitness for ad-hoc read-only SQL. Paces are min/km, distances km, HR bpm."
    ),
)


# ---------------------------------------------------------------- SQL helpers
@lru_cache(1)
def _client() -> WorkspaceClient:
    return WorkspaceClient(profile=PROFILE)


def _ptype(v: Any) -> str:
    if isinstance(v, bool):
        return "BOOLEAN"
    if isinstance(v, int):
        return "BIGINT"
    if isinstance(v, float):
        return "DOUBLE"
    return "STRING"


def _convert(v: Any, t: str) -> Any:
    if v is None:
        return None
    if t in ("INT", "LONG", "SHORT", "BYTE"):
        return int(v)
    if t in ("DOUBLE", "FLOAT", "DECIMAL"):
        return float(v)
    if t == "BOOLEAN":
        return v == "true"
    return v


def q(sql: str, **params: Any) -> list[dict]:
    """Run a statement on the warehouse; {S} expands to the fitness schema."""
    w = _client()
    plist = [StatementParameterListItem(name=k, value=None if v is None else str(v), type=_ptype(v))
             for k, v in params.items()]
    r = w.statement_execution.execute_statement(
        warehouse_id=WAREHOUSE, statement=sql.replace("{S}", SCHEMA), parameters=plist or None,
        wait_timeout="50s", disposition=Disposition.INLINE, format=Format.JSON_ARRAY)
    while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(1)
        r = w.statement_execution.get_statement(r.statement_id)
    if r.status.state != StatementState.SUCCEEDED:
        msg = r.status.error.message if r.status.error else ""
        raise RuntimeError(f"SQL {r.status.state.value}: {msg}")
    cols = [(c.name, c.type_name.value if c.type_name else "STRING") for c in r.manifest.schema.columns]
    rows = list(r.result.data_array or []) if r.result else []
    nxt = r.result.next_chunk_index if r.result else None
    while nxt is not None:
        c = w.statement_execution.get_statement_result_chunk_n(r.statement_id, nxt)
        rows += c.data_array or []
        nxt = c.next_chunk_index
    return [{n: _convert(v, t) for (n, t), v in zip(cols, row)} for row in rows]


def parallel(**jobs):
    """Run several q() calls at once: parallel(a=(sql, params), ...) -> {a: rows}."""
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {k: ex.submit(q, sql, **p) for k, (sql, p) in jobs.items()}
        return {k: f.result() for k, f in futs.items()}


def pace_str(p: float | None) -> str | None:
    if p is None or p <= 0 or p > 60:
        return None
    m, s = divmod(round(p * 60), 60)
    return f"{m}:{s:02d}"


def dur_str(minutes: float | None) -> str | None:
    if minutes is None:
        return None
    s = round(minutes * 60)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def r1(v, n=1):
    return None if v is None else round(v, n)


# Lap classification shared by get_workout and the similar-session search.
# Structured workouts carry Garmin's lap intensityType (WARMUP/ACTIVE/RECOVERY/...);
# when a session has RECOVERY/REST laps, ACTIVE/INTERVAL laps are the reps. Otherwise a
# lap is a rep candidate when it is >8% faster than the session's median lap pace.
LAPS_CTE = """
li AS (
  SELECT CAST(key AS BIGINT) AS garmin_activity_id, x.lapIndex AS lap_index, x.intensityType AS intensity
  FROM {S}.raw_latest
  LATERAL VIEW explode(from_json(payload:lapDTOs, 'array<struct<lapIndex:int,intensityType:string>>')) t AS x
  WHERE source = 'garmin' AND entity = 'activity_laps' AND CAST(key AS BIGINT) IN (SELECT garmin_activity_id FROM ids)
),
lx AS (
  SELECT l.*, li.intensity,
         median(l.pace_min_km) OVER (PARTITION BY l.garmin_activity_id) AS med_pace,
         max(CASE WHEN li.intensity IN ('RECOVERY', 'REST') THEN 1 ELSE 0 END)
           OVER (PARTITION BY l.garmin_activity_id) AS structured,
         min(CASE WHEN li.intensity IN ('RECOVERY', 'REST') THEN l.lap_index END)
           OVER (PARTITION BY l.garmin_activity_id) AS first_rec,
         max(CASE WHEN li.intensity IN ('RECOVERY', 'REST') THEN l.lap_index END)
           OVER (PARTITION BY l.garmin_activity_id) AS last_rec,
         avg(CASE WHEN abs(l.distance_km - 1) <= 0.012 THEN 1.0 ELSE 0.0 END)
           OVER (PARTITION BY l.garmin_activity_id) AS autolap_share
  FROM {S}.activity_laps l
  JOIN ids USING (garmin_activity_id)
  LEFT JOIN li USING (garmin_activity_id, lap_index)
),
lr AS (
  SELECT *, coalesce(CASE WHEN structured = 1
                            THEN intensity IN ('ACTIVE', 'INTERVAL') AND lap_index BETWEEN first_rec - 1 AND last_rec + 1
                          WHEN autolap_share >= 0.7 THEN false
                          ELSE pace_min_km < med_pace * 0.92 AND duration_min >= 0.5 END, false) AS is_rep
  FROM lx
)"""


def _is_interval(reps: int, structured: bool, rep_pace, other_pace) -> bool:
    if reps < 2:
        return False
    if structured:
        return True
    return reps >= 3 and rep_pace and other_pace and other_pace / rep_pace >= 1.15


# ---------------------------------------------------------------- tools
@mcp.tool(annotations=RO)
def find_workouts(date_from: str | None = None, date_to: str | None = None, sport: str | None = None,
                  text: str | None = None, min_km: float | None = None, max_km: float | None = None,
                  limit: int = 15) -> dict:
    """Find workouts to analyse. All filters optional and combined with AND.

    date_from / date_to: ISO dates (YYYY-MM-DD), inclusive. With no filters at all, the
    last 14 days are returned. sport: run, ride, swim, walk_hike, strength, golf... or a
    Garmin type fragment such as "trail", "indoor". text: matched against the activity
    name. Returns newest first, plus total_matches so you can tell whether to narrow down.
    Only run/ride sessions have streams and laps (has_streams).
    """
    if not any([date_from, date_to, sport, text, min_km, max_km]):
        date_from = time.strftime("%Y-%m-%d", time.localtime(time.time() - 14 * 86400))
    limit = max(1, min(int(limit), 50))
    rows = q(f"""
      WITH l AS (SELECT garmin_activity_id, count(*) AS laps FROM {{S}}.activity_laps GROUP BY 1)
      SELECT a.garmin_activity_id AS id, CAST(a.activity_date AS STRING) AS date,
             date_format(a.start_time_local, 'EEE HH:mm') AS start, a.name, a.sport, a.activity_type AS type,
             round(a.distance_km, 2) AS km, a.moving_minutes AS minutes, a.pace_min_per_km AS pace,
             round(a.avg_hr) AS avg_hr, round(a.training_load) AS load, round(a.elevation_gain_m) AS elev_m,
             coalesce(l.laps, 0) AS laps, l.laps IS NOT NULL AS has_streams, count(*) OVER () AS total
      FROM {{S}}.activities a LEFT JOIN l USING (garmin_activity_id)
      WHERE (:dfrom IS NULL OR a.activity_date >= CAST(:dfrom AS DATE))
        AND (:dto IS NULL OR a.activity_date <= CAST(:dto AS DATE))
        AND (:sport IS NULL OR lower(a.sport) = lower(:sport)
             OR lower(a.activity_type) LIKE concat('%', lower(:sport), '%'))
        AND (:text IS NULL OR lower(a.name) LIKE concat('%', lower(:text), '%'))
        AND (:mink IS NULL OR a.distance_km >= CAST(:mink AS DOUBLE))
        AND (:maxk IS NULL OR a.distance_km <= CAST(:maxk AS DOUBLE))
      ORDER BY a.start_time_local DESC LIMIT {limit}""",
             dfrom=date_from, dto=date_to, sport=sport, text=text,
             mink=None if min_km is None else float(min_km), maxk=None if max_km is None else float(max_km))
    total = rows[0]["total"] if rows else 0
    for r in rows:
        r.pop("total")
        r["pace"] = pace_str(r["pace"]) if r["sport"] in ("run", "walk_hike") else None
        r["duration"] = dur_str(r.pop("minutes"))
    return {"total_matches": total, "returned": len(rows), "filters": {
        "date_from": date_from, "date_to": date_to, "sport": sport, "text": text,
        "min_km": min_km, "max_km": max_km}, "workouts": rows}


def _downsample(samples: list[dict], points: int, by: str = "elapsed_s") -> list[dict]:
    """Average samples into `points` equal-width bins along `by`."""
    pts = [s for s in samples if s.get(by) is not None]
    if not pts:
        return []
    lo, hi = pts[0][by], pts[-1][by]
    width = (hi - lo) / points or 1
    bins: dict[int, list[dict]] = {}
    for s in pts:
        bins.setdefault(min(int((s[by] - lo) / width), points - 1), []).append(s)

    def avg(rows, k, pos=False):
        v = [r[k] for r in rows if r.get(k) is not None and (not pos or r[k] > 0)]
        return sum(v) / len(v) if v else None

    out = []
    for i in sorted(bins):
        b = bins[i]
        mid = b[len(b) // 2]
        spd = avg(b, "speed_kmh")
        out.append({
            "t": r1((b[-1]["elapsed_s"] or 0) / 60, 2), "km": r1(b[-1]["distance_km"], 3),
            "hr": r1(avg(b, "hr", True), 0), "spd": r1(spd, 2),
            "pace": r1(60 / spd, 2) if spd and spd > 4 else None,
            "ele": r1(avg(b, "elevation_m"), 1), "cad": r1(avg(b, "cadence", True), 0),
            "pwr": r1(avg(b, "power", True), 0), "tmp": r1(avg(b, "temp_c"), 1),
            "lat": r1(mid["lat"], 5), "lon": r1(mid["lon"], 5), "lap": mid["lap_index"],
        })
    return out


def _columnar(rows: list[dict]) -> dict:
    keys = ["t", "km", "hr", "pace", "spd", "ele", "cad", "pwr", "tmp", "lat", "lon", "lap"]
    cols = {k: [r[k] for r in rows] for k in keys}
    return {k: v for k, v in cols.items() if any(x is not None for x in v)}


def _best_efforts(samples: list[dict]) -> list[dict]:
    pts = [(s["distance_km"] * 1000, s["elapsed_s"]) for s in samples
           if s["distance_km"] is not None and s["elapsed_s"] is not None]
    if len(pts) < 10:
        return []
    total = pts[-1][0]
    out = []
    for name, d in [("400 m", 400), ("1 km", 1000), ("1 mile", 1609.34), ("5 km", 5000),
                    ("10 km", 10000), ("Half", 21097.5), ("Marathon", 42195)]:
        if d > total:
            break
        best, j = None, 0
        for i in range(len(pts)):
            while j < len(pts) and pts[j][0] - pts[i][0] < d:
                j += 1
            if j == len(pts):
                break
            t = pts[j][1] - pts[i][1]
            if t > 0 and (best is None or t < best[0]):
                best = (t, pts[i][0] / 1000)
        if best:
            out.append({"distance": name, "time": dur_str(best[0] / 60),
                        "pace": pace_str(best[0] / 60 / (d / 1000)), "starts_at_km": r1(best[1], 2)})
    return out


def _zones(samples: list[dict], max_hr: float) -> list[dict]:
    edges = [("Z1 recovery", 0.0, 0.6), ("Z2 easy", 0.6, 0.7), ("Z3 aerobic", 0.7, 0.8),
             ("Z4 threshold", 0.8, 0.9), ("Z5 max", 0.9, 9.0)]
    secs = [0.0] * len(edges)
    for a, b in zip(samples, samples[1:]):
        if a["hr"] is None or a["elapsed_s"] is None or b["elapsed_s"] is None:
            continue
        dt = b["elapsed_s"] - a["elapsed_s"]
        if not 0 < dt <= 30:
            continue
        f = a["hr"] / max_hr
        for i, (_, lo, hi) in enumerate(edges):
            if lo <= f < hi:
                secs[i] += dt
    tot = sum(secs) or 1
    return [{"zone": n, "bpm": f"{round(lo * max_hr)}–{round(hi * max_hr) if hi < 9 else 'max'}",
             "minutes": r1(s / 60), "pct": r1(100 * s / tot)} for (n, lo, hi), s in zip(edges, secs)]


def _decoupling(samples: list[dict]) -> dict | None:
    pts = [s for s in samples if s["hr"] and s["speed_kmh"] and s["speed_kmh"] > 3 and s["elapsed_s"]]
    if len(pts) < 60:
        return None
    t0 = pts[0]["elapsed_s"] + min(600, 0.15 * (pts[-1]["elapsed_s"] - pts[0]["elapsed_s"]))
    pts = [s for s in pts if s["elapsed_s"] >= t0]
    if len(pts) < 40:
        return None
    mid = pts[len(pts) // 2]["elapsed_s"]
    halves = [[s for s in pts if s["elapsed_s"] < mid], [s for s in pts if s["elapsed_s"] >= mid]]
    res = []
    for h in halves:
        spd = statistics.fmean(s["speed_kmh"] for s in h)
        hr = statistics.fmean(s["hr"] for s in h)
        ele = [s["elevation_m"] for s in h if s["elevation_m"] is not None]
        gain = sum(max(0, b - a) for a, b in zip(ele, ele[1:])) if ele else None
        res.append({"pace": pace_str(60 / spd), "avg_hr": round(hr), "ef": round(spd * 1000 / 60 / hr, 3),
                    "climb_m": r1(gain, 0)})
    pct = 100 * (1 - res[1]["ef"] / res[0]["ef"])
    c1, c2 = res[0]["climb_m"] or 0, res[1]["climb_m"] or 0
    skewed = abs(c1 - c2) > 40 and max(c1, c2) > 1.8 * max(min(c1, c2), 1)
    return {"first_half": res[0], "second_half": res[1], "decoupling_pct": r1(pct),
            "reliable": not skewed,
            **({"warning": "Halves have very different climbing, so this number mostly reflects terrain."}
               if skewed else {}),
            "note": "EF = metres per minute per heartbeat (higher is better). Under ~5% drift = good "
                    "aerobic durability. Only meaningful for steady efforts; climbing skews it."}


def _hr_recovery(samples: list[dict], end_s: float) -> dict:
    end_hr = [s["hr"] for s in samples if s["hr"] and s["elapsed_s"] is not None and end_s - 10 <= s["elapsed_s"] <= end_s + 2]
    after = [s["hr"] for s in samples if s["hr"] and s["elapsed_s"] is not None and end_s + 50 <= s["elapsed_s"] <= end_s + 70]
    if not end_hr or not after:
        return {}
    return {"hr_end": round(max(end_hr)), "hr_60s": round(min(after)), "drop_60s": round(max(end_hr) - min(after))}


@mcp.tool(annotations=RO)
def get_workout(activity_id: int, points: int = 160, max_hr: int | None = None) -> dict:
    """Full analysis of one workout (run or ride with streams), ready to chart.

    Returns: summary; laps (with Garmin intensity and rep flag); analysis (workout type
    guess, rep-by-rep breakdown with pace fade, HR creep and 60 s HR recovery, HR zones,
    aerobic decoupling, best efforts); context (fitness/fatigue/form going in, HRV,
    resting HR and sleep that morning); similar (comparable past sessions with the same
    rep structure or distance, for progress trends); chart (columnar streams downsampled
    to `points` time bins: t=min, km, hr, pace=min/km, spd=km/h, ele=m, cad, pwr, tmp=°C,
    lat, lon, lap). max_hr overrides the estimated max HR used for zones.
    """
    aid = int(activity_id)
    points = max(40, min(int(points), 400))
    res = parallel(
        summary=("""SELECT a.*, CAST(a.activity_date AS STRING) AS date_s,
                           date_format(a.start_time_local, 'EEEE d MMM yyyy, HH:mm') AS when_s
                    FROM {S}.activities a WHERE garmin_activity_id = :id""", {"id": aid}),
        laps=(f"WITH ids AS (SELECT CAST(:id AS BIGINT) AS garmin_activity_id), {LAPS_CTE} "
              "SELECT * FROM lr ORDER BY lap_index", {"id": aid}),
        samples=("""SELECT seq, elapsed_s, distance_km, speed_kmh, hr, cadence, power, elevation_m, temp_c,
                           lat, lon, lap_index, performance_condition
                    FROM {S}.activity_samples WHERE garmin_activity_id = :id ORDER BY seq""", {"id": aid}),
        context=("""SELECT CAST(f.day AS STRING) AS day, f.fitness_ctl, f.fatigue_atl, f.form_tsb, f.acwr, f.form_zone,
                           f.hrv_last_night, f.hrv_baseline, f.hrv_z, f.hrv_status, f.resting_hr, f.rhr_baseline,
                           f.rhr_z, f.sleep_hours, f.sleep_score, f.body_battery_high
                    FROM {S}.fitness_daily f, {S}.activities a
                    WHERE a.garmin_activity_id = :id AND f.day BETWEEN date_sub(a.activity_date, 1) AND a.activity_date
                    ORDER BY f.day""", {"id": aid}),
        maxhr=("""SELECT percentile(a.max_hr, 0.99) AS mx FROM {S}.activities a, {S}.activities t
                  WHERE t.garmin_activity_id = :id AND a.sport = t.sport
                    AND a.activity_date BETWEEN date_sub(t.activity_date, 730) AND t.activity_date""", {"id": aid}),
    )
    if not res["summary"]:
        return {"error": f"No activity with id {aid}. Use find_workouts to look one up."}
    a = res["summary"][0]
    laps, samples = res["laps"], res["samples"]
    is_run = a["sport"] in ("run", "walk_hike")
    mx = float(max_hr or (res["maxhr"][0]["mx"] if res["maxhr"] and res["maxhr"][0]["mx"] else 190))

    summary = {
        "id": aid, "name": a["name"], "when": a["when_s"], "date": a["date_s"], "sport": a["sport"],
        "type": a["activity_type"], "distance_km": r1(a["distance_km"], 2), "moving_time": dur_str(a["moving_minutes"]),
        "avg_pace": pace_str(a["pace_min_per_km"]) if is_run else None,
        "avg_speed_kmh": r1(a["distance_km"] / (a["moving_minutes"] / 60), 1) if a["moving_minutes"] else None,
        "avg_hr": r1(a["avg_hr"], 0), "max_hr": r1(a["max_hr"], 0), "avg_power": r1(a["avg_watts"], 0),
        "elevation_gain_m": r1(a["elevation_gain_m"], 0), "training_load": r1(a["training_load"], 0),
        "aerobic_te": r1(a["aerobic_te"]), "anaerobic_te": r1(a["anaerobic_te"]), "calories": a["calories"],
        "avg_temp_c": r1(statistics.fmean([s["temp_c"] for s in samples if s["temp_c"] is not None]), 1)
        if any(s["temp_c"] is not None for s in samples) else None,
        "has_streams": bool(samples),
    }
    if not samples and not laps:
        return {"summary": summary, "note": "No laps or streams stored for this activity "
                "(only runs and rides are fetched in detail)."}

    lap_out = [{
        "lap": l["lap_index"], "km": r1(l["distance_km"], 2), "time": dur_str(l["duration_min"]),
        "pace": pace_str(l["pace_min_km"]), "pace_num": r1(l["pace_min_km"], 3), "speed_kmh": l["avg_speed_kmh"],
        "avg_hr": r1(l["avg_hr"], 0), "max_hr": r1(l["max_hr"], 0), "cadence": r1(l["avg_cadence"], 0),
        "power": r1(l["avg_power"], 0), "up_m": l["elevation_gain_m"], "down_m": l["elevation_loss_m"],
        "temp_c": l["avg_temp_c"], "intensity": l["intensity"], "is_rep": l["is_rep"],
    } for l in laps]

    reps_l = [l for l in laps if l["is_rep"]]
    other = [l["pace_min_km"] for l in laps if not l["is_rep"] and l["pace_min_km"]]
    rep_pace = statistics.fmean([l["pace_min_km"] for l in reps_l if l["pace_min_km"]]) if reps_l else None
    structured = bool(laps and laps[0]["structured"])
    interval = _is_interval(len(reps_l), structured, rep_pace, statistics.fmean(other) if other else None)

    reps = []
    if interval:
        first = reps_l[0]
        for i, l in enumerate(reps_l, 1):
            nxt = next((x for x in laps if x["lap_index"] == l["lap_index"] + 1), None)
            reps.append({
                "rep": i, "lap": l["lap_index"], "km": r1(l["distance_km"], 2), "time": dur_str(l["duration_min"]),
                "pace": pace_str(l["pace_min_km"]), "pace_num": r1(l["pace_min_km"], 3),
                "avg_hr": r1(l["avg_hr"], 0), "max_hr": r1(l["max_hr"], 0), "cadence": r1(l["avg_cadence"], 0),
                "power": r1(l["avg_power"], 0),
                "pace_vs_rep1_pct": r1(100 * (l["pace_min_km"] / first["pace_min_km"] - 1))
                if l["pace_min_km"] and first["pace_min_km"] else None,
                "hr_vs_rep1": r1((l["avg_hr"] or 0) - (first["avg_hr"] or 0), 0) if l["avg_hr"] and first["avg_hr"] else None,
                **(_hr_recovery(samples, l["lap_end_s"]) if nxt and l["lap_end_s"] else {}),
                "recovery_after": {"time": dur_str(nxt["duration_min"]), "pace": pace_str(nxt["pace_min_km"]),
                                   "avg_hr": r1(nxt["avg_hr"], 0)} if nxt and not nxt["is_rep"] else None,
            })

    km, mins = a["distance_km"] or 0, a["moving_minutes"] or 0
    if interval:
        kind = "intervals"
    elif re.search(r"race|parkrun|marathon|tt\b|time trial", (a["name"] or "").lower()):
        kind = "race"
    elif (is_run and (km >= 18 or mins >= 95)) or (not is_run and mins >= 150):
        kind = "long"
    else:
        zones = _zones(samples, mx) if samples else []
        hard = sum(z["pct"] or 0 for z in zones[3:]) if zones else None
        if (hard is not None and hard < 15) or (hard is None and a["avg_hr"] and a["avg_hr"] < 0.75 * mx):
            kind = "easy"
        else:
            kind = "steady / tempo"
    climb_per_km = (a["elevation_gain_m"] or 0) / km if km else 0
    if climb_per_km >= 25:
        kind += " (hilly)"

    paces = [l["pace_min_km"] for l in reps_l if l["pace_min_km"]]
    rep_summary = None
    if reps:
        rep_summary = {
            "count": len(reps), "structured_workout": structured, "avg_rep_pace": pace_str(rep_pace),
            "avg_rep_hr": r1(statistics.fmean([r["avg_hr"] for r in reps if r["avg_hr"]]), 0) if any(r["avg_hr"] for r in reps) else None,
            "pace_spread_s": round((max(paces) - min(paces)) * 60) if paces else None,
            "pace_cv_pct": r1(100 * statistics.pstdev(paces) / statistics.fmean(paces)) if len(paces) > 1 else None,
            "fade_last_vs_first_pct": reps[-1]["pace_vs_rep1_pct"],
            "hr_creep_last_vs_first": reps[-1]["hr_vs_rep1"],
            "avg_hr_drop_60s": r1(statistics.fmean([r["drop_60s"] for r in reps if r.get("drop_60s")]), 0)
            if any(r.get("drop_60s") for r in reps) else None,
        }

    ctx = {}
    for row in res["context"]:
        if row["day"] == a["date_s"]:
            ctx["morning_of"] = {k: (r1(v, 2) if isinstance(v, float) else v) for k, v in row.items()
                                 if k in ("hrv_last_night", "hrv_baseline", "hrv_z", "hrv_status", "resting_hr",
                                          "rhr_baseline", "rhr_z", "sleep_hours", "sleep_score", "body_battery_high")}
        else:
            ctx["going_in"] = {"fitness_ctl": r1(row["fitness_ctl"]), "fatigue_atl": r1(row["fatigue_atl"]),
                               "form_tsb": r1(row["form_tsb"]), "acwr": r1(row["acwr"], 2), "form_zone": row["form_zone"]}

    analysis = {
        "workout_type_guess": kind,
        "max_hr_used_for_zones": round(mx), "max_hr_source": "given" if max_hr else "99th pct of max HR, last 2 years",
        "hr_zones": _zones(samples, mx) if samples else None,
        "efficiency_factor": r1((a["distance_km"] * 1000 / a["moving_minutes"]) / a["avg_hr"], 3)
        if a["avg_hr"] and a["moving_minutes"] else None,
        "climb_m_per_km": r1(climb_per_km),
        "decoupling": _decoupling(samples) if kind.split(" (")[0] in ("long", "easy", "steady / tempo") else None,
        "best_efforts": _best_efforts(samples) if is_run else None,
        "rep_summary": rep_summary, "reps": reps or None,
    }

    similar = _similar(aid, summary, interval, len(reps), rep_summary, reps)
    return {
        "summary": summary, "analysis": analysis, "context": ctx, "similar": similar, "laps": lap_out,
        "widget_data": _widget_data(summary, analysis, ctx, similar, lap_out, interval, is_run,
                                    _columnar(_downsample(samples, points))),
    }


def _widget_data(summary, analysis, ctx, similar, laps, interval, is_run, chart) -> dict:
    """Compact payload for the skill's workout.html template (paste verbatim as D)."""
    def spd(p):
        return r1(60 / p, 2) if p else None
    rep_pace = (analysis.get("rep_summary") or {}).get("avg_rep_pace")
    sim_pts = [[s["date"], spd(s.get("rep_pace_num") if interval else s["pace_num"]),
                s.get("rep_hr") if interval else s["avg_hr"], s["id"], 0] for s in similar["sessions"]]
    my_speed, my_hr = None, summary["avg_hr"]
    if interval and analysis["reps"]:
        my_speed = spd(statistics.fmean([r["pace_num"] for r in analysis["reps"] if r["pace_num"]]))
        my_hr = (analysis.get("rep_summary") or {}).get("avg_rep_hr") or my_hr
    elif summary["distance_km"] and summary["avg_speed_kmh"]:
        my_speed = summary["avg_speed_kmh"]
    sim_pts.append([summary["date"], my_speed, my_hr, summary["id"], 1])
    sim_pts.sort(key=lambda p: p[0])
    going = ctx.get("going_in") or {}
    return {
        "run": is_run, "id": summary["id"],
        "s": {"name": summary["name"], "when": summary["when"], "kind": analysis["workout_type_guess"],
              "km": summary["distance_km"], "time": summary["moving_time"],
              "pace": summary["avg_pace"] if is_run else f"{summary['avg_speed_kmh']} km/h",
              "hr": summary["avg_hr"], "load": summary["training_load"], "elev": summary["elevation_gain_m"],
              "tsb": going.get("form_tsb"), "reps": analysis["rep_summary"]["count"] if analysis["rep_summary"] else 0,
              "rep_pace": rep_pace},
        "c": chart,
        "laps": [[l["lap"], l["speed_kmh"], l["avg_hr"], 1 if l["is_rep"] else 0, l["km"], l["time"]] for l in laps],
        "zones": [[z["zone"], z["bpm"], z["pct"]] for z in (analysis["hr_zones"] or [])],
        "sim": {"label": "Avg rep pace" if interval else ("Avg pace" if is_run else "Avg speed"), "pts": sim_pts},
    }


def _similar(aid: int, summary: dict, interval: bool, n_reps: int, rep_summary, reps) -> dict:
    rows = q(f"""
      WITH t AS (SELECT sport, activity_type, distance_km, activity_date, elevation_gain_m
                 FROM {{S}}.activities WHERE garmin_activity_id = :id),
      c AS (SELECT a.* FROM {{S}}.activities a, t
            WHERE a.sport = t.sport AND a.garmin_activity_id <> :id
              AND a.activity_date BETWEEN date_sub(t.activity_date, 730) AND date_add(t.activity_date, 365)
              AND a.distance_km BETWEEN t.distance_km * {0.6 if interval else 0.8} AND t.distance_km * {1.4 if interval else 1.2}),
      ids AS (SELECT garmin_activity_id FROM c),
      {LAPS_CTE},
      r AS (SELECT garmin_activity_id, max(structured) AS structured, count_if(is_rep) AS reps,
                   avg(CASE WHEN is_rep THEN pace_min_km END) AS rep_pace,
                   avg(CASE WHEN NOT is_rep THEN pace_min_km END) AS other_pace,
                   avg(CASE WHEN is_rep THEN avg_hr END) AS rep_hr,
                   avg(CASE WHEN is_rep THEN distance_km END) AS rep_km
            FROM lr GROUP BY 1)
      SELECT c.garmin_activity_id AS id, CAST(c.activity_date AS STRING) AS date, c.name, c.activity_type AS type,
             c.distance_km, c.moving_minutes, c.pace_min_per_km, c.avg_hr, c.training_load, c.elevation_gain_m,
             r.structured, r.reps, r.rep_pace, r.other_pace, r.rep_hr, r.rep_km
      FROM c LEFT JOIN r USING (garmin_activity_id)
      ORDER BY c.activity_date DESC""", id=aid)
    my_rep_km = statistics.fmean([r["km"] for r in reps if r["km"]]) if reps else None
    my_climb = (summary["elevation_gain_m"] or 0) / max(summary["distance_km"] or 1, 0.1)
    keep = []
    for r in rows:
        r_int = _is_interval(r["reps"] or 0, bool(r["structured"]), r["rep_pace"], r["other_pace"])
        if r["type"] != summary["type"]:
            continue
        if interval:
            if not r_int or abs((r["reps"] or 0) - n_reps) > max(1, round(0.2 * n_reps)):
                continue
            if my_rep_km and r["rep_km"] and not (0.7 <= r["rep_km"] / my_rep_km <= 1.3):
                continue
        else:
            if r_int:
                continue
            climb = (r["elevation_gain_m"] or 0) / max(r["distance_km"] or 1, 0.1)
            if abs(climb - my_climb) > max(8, 0.5 * my_climb):
                continue
        speed = r["distance_km"] * 1000 / r["moving_minutes"] if r["moving_minutes"] else None
        keep.append({
            "id": r["id"], "date": r["date"], "name": r["name"], "km": r1(r["distance_km"], 2),
            "time": dur_str(r["moving_minutes"]), "pace": pace_str(r["pace_min_per_km"]),
            "pace_num": r1(r["pace_min_per_km"], 3), "avg_hr": r1(r["avg_hr"], 0),
            "ef": r1(speed / r["avg_hr"], 3) if speed and r["avg_hr"] else None,
            "load": r1(r["training_load"], 0), "elev_m": r1(r["elevation_gain_m"], 0),
            **({"reps": r["reps"], "rep_pace": pace_str(r["rep_pace"]), "rep_pace_num": r1(r["rep_pace"], 3),
                "rep_hr": r1(r["rep_hr"], 0), "rep_km": r1(r["rep_km"], 2)} if interval else {}),
        })
        if len(keep) >= 12:
            break
    basis = (f"{summary['type']} interval sessions with {n_reps}±{max(1, round(0.2 * n_reps))} reps of ~{r1(my_rep_km, 2)} km"
             if interval else f"non-interval {summary['type']} sessions within ±20% distance and similar climbing")
    return {"basis": basis + " (last 2 years)", "count": len(keep), "sessions": keep}


@mcp.tool(annotations=RO)
def compare_workouts(activity_ids: list[int], points: int = 120) -> dict:
    """Overlay 2–5 workouts. Returns each one's summary plus streams binned by distance
    (km, hr, pace, ele, cad) so they share an x-axis, and per-km splits."""
    ids = [int(i) for i in activity_ids][:5]
    if len(ids) < 2:
        return {"error": "Give at least two activity ids."}
    points = max(30, min(int(points), 300))
    id_list = ",".join(str(i) for i in ids)
    res = parallel(
        summ=(f"""SELECT garmin_activity_id AS id, CAST(activity_date AS STRING) AS date, name, activity_type AS type,
                         distance_km, moving_minutes, pace_min_per_km, avg_hr, training_load, elevation_gain_m
                  FROM {{S}}.activities WHERE garmin_activity_id IN ({id_list})""", {}),
        samp=(f"""SELECT garmin_activity_id AS id, seq, elapsed_s, distance_km, speed_kmh, hr, cadence, power,
                         elevation_m, temp_c, lat, lon, lap_index
                  FROM {{S}}.activity_samples WHERE garmin_activity_id IN ({id_list}) ORDER BY id, seq""", {}),
    )
    by_id: dict[int, list] = {}
    for s in res["samp"]:
        by_id.setdefault(s["id"], []).append(s)
    out = []
    for s in sorted(res["summ"], key=lambda r: r["date"]):
        sm = by_id.get(s["id"], [])
        splits, last_t, k = [], None, 1
        for p in sm:
            if p["distance_km"] is None or p["elapsed_s"] is None:
                continue
            if last_t is None:
                last_t = p["elapsed_s"]
            if p["distance_km"] >= k:
                splits.append(r1((p["elapsed_s"] - last_t) / 60, 3))
                last_t, k = p["elapsed_s"], k + 1
        d = _downsample(sm, points, by="distance_km") if sm else []
        out.append({
            "id": s["id"], "date": s["date"], "name": s["name"], "type": s["type"], "km": r1(s["distance_km"], 2),
            "time": dur_str(s["moving_minutes"]), "pace": pace_str(s["pace_min_per_km"]), "avg_hr": r1(s["avg_hr"], 0),
            "load": r1(s["training_load"], 0), "elev_m": r1(s["elevation_gain_m"], 0),
            "km_splits_min": splits,
            "stream": {k2: [r[k2] for r in d] for k2 in ("km", "hr", "pace", "ele", "cad")},
        })
    return {"workouts": out}


_WRITE = re.compile(r"\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|copy|"
                    r"optimize|vacuum|refresh|call|set|use|restore|msck|analyze)\b", re.I)


@mcp.tool(annotations=RO)
def query_fitness(sql: str, max_rows: int = 200) -> dict:
    """Read-only ad-hoc SQL for follow-up questions. One SELECT/WITH statement; tables
    live in workspace.fitness (write {S}.table or the full name). Key tables:
    activities, activity_laps, activity_samples (per-second streams, filter by
    garmin_activity_id!), fitness_daily (CTL/ATL/TSB, HRV, sleep), training_weeks,
    garmin_daily, goals, race_predictions."""
    s = sql.strip().rstrip(";")
    if ";" in s or not re.match(r"(?is)^\s*(select|with)\b", s) or _WRITE.search(re.sub(r"'[^']*'", "''", s)):
        return {"error": "Only a single read-only SELECT/WITH statement is allowed."}
    max_rows = max(1, min(int(max_rows), 2000))
    rows = q(f"SELECT * FROM ({s}) LIMIT {max_rows + 1}")
    return {"rows": rows[:max_rows], "truncated": len(rows) > max_rows}


if __name__ == "__main__":
    mcp.run("stdio")
