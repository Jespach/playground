"""Fallback: run the ingest on this PC and upload to the Databricks volume.

Use this if Garmin blocks requests from Databricks' cloud IPs. Same code,
same secrets, same state file as the job, so you can mix the two freely.

    .venv\\Scripts\\python scripts\\run_local.py [--sources garmin]
"""
import argparse
import base64
import datetime as dt
import io
import json
import sys
from pathlib import Path

from databricks.sdk import WorkspaceClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "ingest"))
import fitness_sources as fs  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--sources", default="garmin")
p.add_argument("--backfill-days", type=int, default=730)
p.add_argument("--max-days-per-run", type=int, default=365)
args = p.parse_args()

PROFILE, SCOPE = "free", "fitness"
ROOT = "/Volumes/workspace/fitness/raw"
w = WorkspaceClient(profile=PROFILE)


def write(rel: str, text: str) -> None:
    w.files.upload(f"{ROOT}/{rel}", io.BytesIO(text.encode()), overwrite=True)


def secret(key):
    try:
        return base64.b64decode(w.secrets.get_secret(SCOPE, key).value).decode()
    except Exception:
        return None


try:
    state = json.loads(w.files.download(f"{ROOT}/_state/state.json").contents.read())
except Exception:
    state = {}

run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-local"
sources = set(args.sources.split(","))

if "garmin" in sources:
    tokens = secret("garmin_tokens")
    if tokens:
        g = fs.garmin_client(tokens)
        try:
            print("garmin:", fs.ingest_garmin(write, state, g, run_id, args.backfill_days, args.max_days_per_run))
        finally:
            new = fs.garmin_dump_tokens(g)
            if json.loads(new).get("di_refresh_token") and new != tokens:
                w.secrets.put_secret(SCOPE, "garmin_tokens", string_value=new)
    else:
        print("garmin: not linked, skipping")

write("_state/state.json", json.dumps(state, indent=2))
print("state:", state)
