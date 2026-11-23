"""One-time Garmin Connect link: log in here, store session tokens as a Databricks secret.

    .venv\\Scripts\\python scripts\\link_garmin.py

Your email/password are only sent to Garmin and are never saved. The resulting
session tokens (refreshed automatically for about a year) go into the
`fitness` secret scope as `garmin_tokens`.
"""
import getpass
import json

from databricks.sdk import WorkspaceClient
from garminconnect import Garmin

PROFILE, SCOPE = "free", "fitness"

email = input("Garmin email: ").strip()
password = getpass.getpass("Garmin password (hidden): ")

g = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: ").strip())
g.login()
tokens = g.client.dumps()
if not json.loads(tokens).get("di_refresh_token"):
    raise SystemExit(
        "Logged in, but Garmin didn't issue a refresh token (web-cookie fallback). "
        "Wait a few minutes and try again."
    )

w = WorkspaceClient(profile=PROFILE)
w.secrets.put_secret(SCOPE, "garmin_tokens", string_value=tokens)
print(f"Linked Garmin account '{g.get_full_name()}'. Tokens saved to scope '{SCOPE}'.")
