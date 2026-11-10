"""G3 cut-over and G4 Access lock (PLAN.md section 8, rows G3 and G4; section 4).

Usage (from a venv with bitwarden-sdk, as owner via owner-ops):
  python tools/cutover.py              # print the plan; contacts nothing
  python tools/cutover.py --preflight  # read-only checks (GET only)
  python tools/cutover.py --apply      # run every step, stopping twice for a typed go-ahead

Steps, in order:
  a. preflight (read-only): POLAR_API_BASE is Polar production; the tcg-api-gateway
     script exists; api.dyzzyscards.com is a Workers Custom Domain on sourcery-gateway
     (or already on tcg-api-gateway). A zone Worker route instead stops the run.
  b. G3 go-ahead, then push PRICING_APP_TOKEN and CATALOG_APP_TOKEN (tools/push_secrets.py).
  c. Detach the domain from sourcery-gateway and attach it to
     tcg-api-gateway as one step; if the attach fails it is re-attached to sourcery-gateway.
  d. G4 prep: create the Access service token, store both halves in Bitwarden first,
     then push ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET to the Worker.
  e. G4 go-ahead, then create a self-hosted Access app per origin hostname with a
     non_identity policy allowing only that service token.
Re-running skips what is already done. Secret values are never printed.
"""

import argparse
import pathlib
import sys
import tomllib
import urllib.parse

import push_secrets
from cloudflare_api import ACCOUNT_ID, WORKER_NAME, ZONE_NAME, CloudflareError
from push_secrets import API_GATEWAY_PROJECT_ID, SecretStoreError

CUSTOM_DOMAIN = "api.dyzzyscards.com"
OLD_WORKER = "sourcery-gateway"
POLAR_PRODUCTION = "https://api.polar.sh"
APP_TOKEN_SECRETS = ["PRICING_APP_TOKEN", "CATALOG_APP_TOKEN"]
SERVICE_TOKEN_NAME = "tcg-api-gateway"
ACCESS_POLICY_NAME = "tcg-api-gateway service token only"
ACCESS_ID_KEY = push_secrets.WORKER_SECRETS["ACCESS_CLIENT_ID"]
ACCESS_SECRET_KEY = push_secrets.WORKER_SECRETS["ACCESS_CLIENT_SECRET"]
G3_PHRASE = "move api.dyzzyscards.com"
G4_PHRASE = "lock the origins"
WRANGLER_TOML = pathlib.Path(__file__).resolve().parents[1] / "wrangler.toml"

A = f"/accounts/{ACCOUNT_ID}"
DOMAINS_PATH = f"{A}/workers/domains"
TOKENS_PATH = f"{A}/access/service_tokens"
POLICIES_PATH = f"{A}/access/policies"
APPS_PATH = f"{A}/access/apps"


class CutoverStop(Exception):
    """The run stops here; the message says why and what state things are in."""


def read_vars(path=WRANGLER_TOML) -> dict:
    with open(path, "rb") as file:
        return tomllib.load(file).get("vars", {})


def polar_gate(variables: dict) -> tuple[bool, str]:
    base = str(variables.get("POLAR_API_BASE", "")).strip().rstrip("/")
    if base == POLAR_PRODUCTION:
        return True, f"POLAR_API_BASE is Polar production ({base})"
    return False, f"POLAR_API_BASE is {base or '(unset)'}, not Polar production {POLAR_PRODUCTION}; fix wrangler.toml and deploy first"


def origin_hosts(variables: dict) -> list[str]:
    hosts = []
    for name in ("PRICING_ORIGIN", "CATALOG_ORIGIN"):
        host = urllib.parse.urlparse(str(variables.get(name, ""))).hostname
        if not host:
            raise CutoverStop(f"{name} in wrangler.toml has no hostname")
        hosts.append(host)
    return hosts


def confirm(phrase: str, input_fn) -> None:
    print(f"Owner go-ahead required. Type exactly: {phrase}")
    try:
        answer = input_fn("> ")
    except EOFError:
        answer = ""
    if answer.strip() != phrase:
        raise CutoverStop("confirmation did not match; nothing was changed in this step")


# a. Preflight -------------------------------------------------------------------------

def preflight(cloudflare, variables: dict) -> dict:
    """Read-only checks; returns the domain's Custom Domain record. Raises CutoverStop."""
    ok, message = polar_gate(variables)
    print(f"{'ok  ' if ok else 'FAIL'} {message}")
    if not ok:
        raise CutoverStop("build gate failed: " + message)

    scripts = {s.get("id") for s in cloudflare.get(f"{A}/workers/scripts") or []}
    if WORKER_NAME not in scripts:
        raise CutoverStop(f"Worker script {WORKER_NAME} does not exist; deploy it first")
    print(f"ok   Worker script {WORKER_NAME} exists")

    records = [d for d in cloudflare.get(f"{DOMAINS_PATH}?hostname={CUSTOM_DOMAIN}") or []
               if d.get("hostname") == CUSTOM_DOMAIN]
    if len(records) > 1:
        raise CutoverStop(f"{len(records)} Custom Domain records for {CUSTOM_DOMAIN}; resolve by hand")
    if records:
        service = records[0].get("service")
        if service in (OLD_WORKER, WORKER_NAME):
            print(f"ok   {CUSTOM_DOMAIN} is a Custom Domain on {service}")
            return records[0]
        raise CutoverStop(f"{CUSTOM_DOMAIN} is a Custom Domain on unexpected Worker {service}; not touching it")

    zones = cloudflare.get(f"/zones?name={ZONE_NAME}") or []
    if len(zones) != 1:
        raise CutoverStop(f"{CUSTOM_DOMAIN} is not a Custom Domain and zone {ZONE_NAME} is not readable")
    routes = cloudflare.get(f"/zones/{zones[0]['id']}/workers/routes") or []
    matching = [r for r in routes if str(r.get("pattern", "")).split("/")[0] == CUSTOM_DOMAIN]
    if matching:
        found = ", ".join(f"{r.get('pattern')} -> {r.get('script')}" for r in matching)
        raise CutoverStop(f"{CUSTOM_DOMAIN} is attached as a zone Worker route ({found}), not a Custom Domain; "
                          "this script only moves Custom Domains. Move it by hand or update the plan.")
    raise CutoverStop(f"{CUSTOM_DOMAIN} is not attached to any Worker; not guessing")


# c. G3 domain move --------------------------------------------------------------------

def attach(cloudflare, service: str, zone_id: str) -> None:
    cloudflare.put(DOMAINS_PATH, {"hostname": CUSTOM_DOMAIN, "service": service,
                                  "zone_id": zone_id})


def move_domain(cloudflare, record: dict) -> None:
    """Detach from sourcery-gateway and attach to tcg-api-gateway; roll back if the attach fails."""
    cloudflare.delete(f"{DOMAINS_PATH}/{record['id']}")
    print(f"detached {CUSTOM_DOMAIN} from {OLD_WORKER}")
    try:
        attach(cloudflare, WORKER_NAME, record["zone_id"])
    except CloudflareError as error:
        print(f"attach to {WORKER_NAME} failed: {error}", file=sys.stderr)
        try:
            attach(cloudflare, OLD_WORKER, record["zone_id"])
        except CloudflareError as rollback_error:
            raise CutoverStop(f"attach failed AND rollback failed ({rollback_error}): {CUSTOM_DOMAIN} is "
                              f"attached to NO Worker; re-attach it to {OLD_WORKER} in the dashboard now") from None
        raise CutoverStop(f"attach failed; rolled back: {CUSTOM_DOMAIN} is on {OLD_WORKER} again") from None
    print(f"attached {CUSTOM_DOMAIN} to {WORKER_NAME}")


# d. G4 prep ---------------------------------------------------------------------------

def prepare_service_token(cloudflare, store) -> str:
    """Ensure the Access service token exists with both halves in Bitwarden; returns its id."""
    tokens = [t for t in cloudflare.get(TOKENS_PATH) or [] if t.get("name") == SERVICE_TOKEN_NAME]
    if len(tokens) > 1:
        raise CutoverStop(f"{len(tokens)} Access service tokens are named {SERVICE_TOKEN_NAME}; resolve by hand")
    if tokens:
        stored_id = store.get(ACCESS_ID_KEY)
        if not stored_id or not store.get(ACCESS_SECRET_KEY):
            raise CutoverStop(f"service token {SERVICE_TOKEN_NAME} exists but Bitwarden lacks {ACCESS_ID_KEY} or "
                              f"{ACCESS_SECRET_KEY}; its secret cannot be read again. Delete the token in "
                              "Zero Trust and re-run.")
        if stored_id != tokens[0].get("client_id"):
            raise CutoverStop(f"Bitwarden {ACCESS_ID_KEY} does not match service token {SERVICE_TOKEN_NAME}; resolve by hand")
        print(f"skip     service token {SERVICE_TOKEN_NAME} already exists (halves in Bitwarden)")
        return tokens[0]["id"]

    created = cloudflare.post(TOKENS_PATH, {"name": SERVICE_TOKEN_NAME})
    print(f"created  Access service token {SERVICE_TOKEN_NAME}")
    note = f"Cloudflare Access service token {SERVICE_TOKEN_NAME} (PLAN.md section 4); created by tools/cutover.py"
    try:
        store.put(ACCESS_ID_KEY, created["client_id"], API_GATEWAY_PROJECT_ID, note)
        store.put(ACCESS_SECRET_KEY, created["client_secret"], API_GATEWAY_PROJECT_ID, note)
    except (SecretStoreError, KeyError) as error:
        detail = error if isinstance(error, SecretStoreError) else "Cloudflare response lacked a client half"
        try:
            cloudflare.delete(f"{TOKENS_PATH}/{created['id']}")
            undone = "the token was deleted again; re-run"
        except CloudflareError:
            undone = f"deleting the token failed; delete {SERVICE_TOKEN_NAME} in Zero Trust, then re-run"
        raise CutoverStop(f"could not store the service token in Bitwarden ({detail}); {undone}") from None
    print(f"stored   {ACCESS_ID_KEY}, {ACCESS_SECRET_KEY} in Bitwarden project api-gateway")
    return created["id"]


# e. G4 lock ---------------------------------------------------------------------------

def missing_apps(cloudflare, hosts: list[str]) -> list[str]:
    domains = {str(app.get("domain", "")).split("/")[0] for app in cloudflare.get(APPS_PATH) or []}
    return [h for h in hosts if h not in domains]


def lock_origins(cloudflare, token_id: str, hosts: list[str]) -> None:
    policies = [p for p in cloudflare.get(POLICIES_PATH) or [] if p.get("name") == ACCESS_POLICY_NAME]
    if policies:
        policy_id = policies[0]["id"]
        print(f"skip     Access policy '{ACCESS_POLICY_NAME}' already exists")
    else:
        policy_id = cloudflare.post(POLICIES_PATH, {
            "name": ACCESS_POLICY_NAME,
            "decision": "non_identity",
            "include": [{"service_token": {"token_id": token_id}}],
        })["id"]
        print(f"created  Access policy '{ACCESS_POLICY_NAME}'")
    for host in hosts:
        cloudflare.post(APPS_PATH, {
            "name": f"{host} (gateway only)",
            "domain": host,
            "type": "self_hosted",
            "session_duration": "24h",
            "policies": [{"id": policy_id, "precedence": 1}],
        })
        print(f"created  Access app for {host}")


# Driver -------------------------------------------------------------------------------

def print_plan(variables: dict) -> None:
    ok, message = polar_gate(variables)
    hosts = origin_hosts(variables)
    print("plan (nothing contacted; --preflight runs the read-only checks, --apply runs everything):")
    print(f"  a. preflight  [{'ok' if ok else 'WILL REFUSE'}] {message}")
    print(f"                GET {A}/workers/scripts  ({WORKER_NAME} exists)")
    print(f"                GET {DOMAINS_PATH}?hostname={CUSTOM_DOMAIN}  (on {OLD_WORKER}; a zone route stops the run)")
    print(f"  b. G3         stop for '{G3_PHRASE}'; PUT {push_secrets.SECRETS_PATH}  {', '.join(APP_TOKEN_SECRETS)}")
    print(f"  c. G3         DELETE {DOMAINS_PATH}/<id> ({OLD_WORKER}), "
          f"PUT {DOMAINS_PATH} ({WORKER_NAME}); on failure PUT back to {OLD_WORKER}")
    print(f"  d. G4 prep    POST {TOKENS_PATH} ({SERVICE_TOKEN_NAME}); store {ACCESS_ID_KEY}, {ACCESS_SECRET_KEY} "
          f"in Bitwarden; PUT {push_secrets.SECRETS_PATH} ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET")
    print(f"  e. G4 lock    stop for '{G4_PHRASE}'; POST {POLICIES_PATH} (non_identity, that token only); "
          f"POST {APPS_PATH} for {', '.join(hosts)}")


def run(cloudflare, store, variables: dict, input_fn) -> None:
    hosts = origin_hosts(variables)
    record = preflight(cloudflare, variables)

    domain_done = record.get("service") == WORKER_NAME
    if not domain_done:
        confirm(G3_PHRASE, input_fn)
    failed = push_secrets.push(cloudflare, store, APP_TOKEN_SECRETS)
    if failed:
        raise CutoverStop(f"app tokens not pushed ({', '.join(failed)}); domain not moved")
    if domain_done:
        print(f"skip     {CUSTOM_DOMAIN} is already on {WORKER_NAME}")
    else:
        move_domain(cloudflare, record)

    token_id = prepare_service_token(cloudflare, store)
    failed = push_secrets.push(cloudflare, store, list(push_secrets.ACCESS_PAIR))
    if failed:
        raise CutoverStop(f"Access secrets not pushed ({', '.join(failed)}); origins not locked")

    todo = missing_apps(cloudflare, hosts)
    if not todo:
        print("skip     Access apps already exist for " + ", ".join(hosts))
    else:
        confirm(G4_PHRASE, input_fn)
        lock_origins(cloudflare, token_id, todo)
    for host in hosts:
        print(f"verify:  curl -s -o /dev/null -w \"%{{http_code}}\" https://{host}/  -> expect 403 or 302, not 200")


def main(argv=None, *, open_store=push_secrets.open_bitwarden_store, open_cloudflare=push_secrets.open_cloudflare,
         input_fn=input, config_path=WRANGLER_TOML, variables=None) -> int:
    parser = argparse.ArgumentParser(description="G3 cut-over and G4 Access lock for tcg-api-gateway.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true", help="run the read-only checks only")
    mode.add_argument("--apply", action="store_true", help="run every step (stops twice for a go-ahead)")
    args = parser.parse_args(argv)
    try:
        if variables is None:
            variables = read_vars(config_path)
        if not (args.apply or args.preflight):
            print_plan(variables)
            return 0
        store = open_store()
        cloudflare = open_cloudflare(store)
        if args.preflight:
            preflight(cloudflare, variables)
            print("preflight passed")
        else:
            run(cloudflare, store, variables, input_fn)
            print("done")
        return 0
    except (CutoverStop, SecretStoreError, CloudflareError) as error:
        print(f"stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
