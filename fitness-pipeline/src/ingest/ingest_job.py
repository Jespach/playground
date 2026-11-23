"""Databricks job task: pull Garmin Connect into the raw volume.

Reads credentials from the `fitness` secret scope, lands JSONL under
/Volumes/<catalog>/<schema>/raw/landing/, keeps incremental state in
raw/_state/state.json, and writes rotated tokens back to the scope.

Args (from the job): --catalog --schema [--backfill-days N] [--max-days-per-run N]
"""
import argparse
import datetime as dt
import json
import os
import sys

from databricks.sdk import WorkspaceClient
from databricks.sdk.runtime import dbutils

# Serverless exec()s this file, so __file__ is undefined; the code object's filename is not.
import inspect  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(inspect.currentframe().f_code.co_filename)))
import fitness_sources as fs  # noqa: E402

SCOPE = "fitness"

p = argparse.ArgumentParser()
p.add_argument("--catalog", default="workspace")
p.add_argument("--schema", default="fitness")
p.add_argument("--backfill-days", type=int, default=730)
p.add_argument("--max-days-per-run", type=int, default=365)
p.add_argument("--sources", default="garmin")
args = p.parse_args()

ROOT = f"/Volumes/{args.catalog}/{args.schema}/raw"
STATE = f"{ROOT}/_state/state.json"
w = WorkspaceClient()


def write(rel: str, text: str) -> None:
    path = f"{ROOT}/{rel}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def secret(key: str):
    try:
        return dbutils.secrets.get(SCOPE, key)
    except Exception:
        return None


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(state, f, indent=2)


state = json.load(open(STATE)) if os.path.exists(STATE) else {}
run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
sources = set(args.sources.split(","))
summary, failures = {}, []

if "garmin" in sources:
    tokens = secret("garmin_tokens")
    if tokens:
        g = None
        try:
            g = fs.garmin_client(tokens)
            summary["garmin"] = fs.ingest_garmin(
                write, state, g, run_id,
                backfill_days=args.backfill_days,
                max_days_per_run=args.max_days_per_run,
            )
            save_state(state)
        except Exception as e:
            failures.append(f"garmin: {type(e).__name__}: {e}")
        finally:
            # Garmin rotates the refresh token on every refresh; always persist it.
            if g is not None:
                new = fs.garmin_dump_tokens(g)
                if json.loads(new).get("di_refresh_token") and new != tokens:
                    w.secrets.put_secret(SCOPE, "garmin_tokens", string_value=new)
    else:
        summary["garmin"] = "skipped (not linked)"

print(json.dumps({"run_id": run_id, "summary": summary, "state": state}, indent=2, default=str))
if failures:
    raise RuntimeError("; ".join(failures))
